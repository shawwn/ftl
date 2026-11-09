// @ts-check
// The AI's decisions (design doc 16.2). think reads only the projected snapshot and returns the same
// absolute commands a human sends. Every choice is a counterfactual scored by one utility (estimate.js),
// so the brain never names a system: shields-first, ion on shields and helm hits all emerge from stats.
//
// Doc fixes and choices:
// - Power candidates are runs: k more bars on one system (k = 1 up to what fits; the doc's +1 and +2 are
//   k = 1, 2), or one off device followed by the next off devices in slot order that fit. Single steps
//   cannot see that two Flint Bolts and a Hush Pulse only get through two layers together, so a single
//   step greedy never powers Lampblack's weapons; runs are the same lookahead the doc uses for shields.
// - Power hysteresis: a run that restores the current intent scores SWITCH_RATIO (1.2) times, the doc's
//   crew hysteresis applied to power, so near ties do not flip devices off and on (unpowered devices
//   drain their charge at 3x).
// - Room scores are utility(after hit) - utility(now). The doc's formula has the sign reversed, which
//   with exp weighting would favor the least useful room.
// - Volley sync waits only for devices that are not yet full (a full meter has msToFull 0, so two full,
//   untargeted weapons would otherwise wait for each other forever), and only for devices that can pay.
// - A crew task is a room to work: whoever goes repairs its system, then mans it. A repair is worth
//   potential(fully repaired and manned) - potential(now), where potential is the utility of the best
//   power plan. The doc's utility(damage - 1) - utility(now) values most repairs at zero: the power plan
//   has already rerouted a damaged system's bars, one shield bar of two adds no layer, and a repaired
//   helm nobody mans gives no evasion. Manning is worth utility(manned) - utility(empty) at planned power.
// - Hit gains: think scores, once per blueprint, what one hit in each foe room is worth (the counterfactual
//   planWeapons aims with). The power plan maximizes utility plus, for every powered device that can pay,
//   its hit chance times its best hit gain: the expected utility after each device's next hit. So a weapon
//   is powered for whatever its payload does (hull, systems, ion, crew), never for one effect key.

import { capacity, freeReactor, isFull, msToFull, canPay, enemiesOf, geometry, roomCells, roomAt,
  roomOfSystem, findPath, crewRoom, claimOf, takesWant } from '../sim/index.js';
import { utility, imagine, hitGains, threatOf, volley } from './estimate.js';

/** @typedef {import('../sim/types.js').Ship} Ship */
/** @typedef {import('../sim/types.js').Device} Device */
/** @typedef {import('../sim/types.js').Crew} Crew */
/** @typedef {import('../sim/types.js').View} View */
/** @typedef {import('../sim/types.js').Content} Content */
/** @typedef {import('../sim/types.js').AiProfile} AiProfile */
/** @typedef {import('./estimate.js').Weights} Weights */
/** @typedef {{ type: string } & Record<string, any>} Order   a Command before the host stamps `ship` */
/** @typedef {{ rng: () => number, nextThink: number }} Memory */
/** @typedef {Map<string, import('./estimate.js').Gain>} Gains   per blueprint: what one landed or blocked shot is worth */
/** @typedef {{ t: 'snap', round: number, tick: number, phase: string, paused: boolean, view: View } & Record<string, any>} Snap */

/** Hysteresis: a crew member leaves its task, and power leaves its current intent, only for something worth this much more. */
const SWITCH_RATIO = 1.2;

/**
 * @param {Snap} snap @param {{ ship: string, side?: string }} me @param {Memory} mem
 * @param {AiProfile} profile @param {Content} content
 * @returns {Order[]} pure except for mem (nextThink, rng draws)
 */
export function think(snap, me, mem, profile, content) {
  const { view } = snap;
  if (profile.passive || snap.tick < mem.nextThink || snap.phase !== 'running' || snap.paused || view.outcome) return [];
  const my = Object.hasOwn(view.ships, me.ship) ? view.ships[me.ship] : null;
  if (!my || my.out) return [];
  mem.nextThink = snap.tick + profile.thinkEveryTicks;
  const foe = enemiesOf(view, my).reduce((a, s) => (a && a.pools.hull.v <= s.pools.hull.v ? a : s), null);
  if (!foe) return [];
  const gains = hitGains(my, foe, content, profile.weights);
  const plan = bestPower(my, foe, content, profile.weights, gains);
  return [
    ...planPower(my, foe, content, profile, plan),
    ...planWeapons(view, my, foe, content, profile, mem, gains),
    ...(profile.crew ? planCrew(my, foe, content, profile, plan, gains) : []),
  ];
}

// ---- Power ----

/** Systems that take a `want` (the sim's takesWant). @param {Content} content @param {string} type */
const settable = (content, type) => takesWant(content.systems[type]);

/** @typedef {{ levels: Record<string, number>, on: Set<string> }} Intent   wanted levels and devices on */
/** @typedef {{ bars: number, incumbent: boolean, apply: (s: Ship) => void }} Run */

/** @param {Ship} ship @param {Content} content @returns {Intent} */
function intentOf(ship, content) {
  /** @type {Record<string, number>} */
  const levels = {};
  for (const type of Object.keys(ship.systems)) if (settable(content, type)) levels[type] = ship.systems[type].want ?? ship.systems[type].power;
  return { levels, on: new Set(ship.devices.filter((d) => d.on ?? d.powered).map((d) => d.id)) };
}

/**
 * Candidate runs on a settled plan, in systemOrder then slot order, shortest first: k more bars on a
 * system, or an off device that fits followed by each later off device that still fits. A run is
 * incumbent when every step of it is already in `was`.
 * @param {Ship} plan @param {Intent} was @param {Content} content
 * @returns {Run[]}
 */
function powerRuns(plan, was, content) {
  const free = freeReactor(plan, content);
  /** @type {Run[]} */
  const runs = [];
  for (const type of content.systemOrder) {
    if (!Object.hasOwn(plan.systems, type) || !content.systems[type].reactor) continue;
    const sys = plan.systems[type];
    const limit = Math.min(free, capacity(sys) - sys.power);
    if (settable(content, type)) {
      for (let k = 1; k <= limit; k++) {
        runs.push({ bars: k, incumbent: sys.power + k <= was.levels[type], apply: (s) => { s.systems[type].want = sys.power + k; } });
      }
      continue;
    }
    const off = plan.devices.filter((d) => d.host === type && !d.on);
    const cost = (/** @type {Device} */ d) => content.devices[d.bp].power;
    off.forEach((first, i) => {
      if (cost(first) > limit) return;
      const ids = new Set();
      let bars = 0;
      for (const d of off.slice(i)) {
        if (bars + cost(d) > limit) continue;
        bars += cost(d);
        ids.add(d.id);
        const run = new Set(ids);
        runs.push({ bars, incumbent: [...run].every((id) => was.on.has(id)), apply: (s) => { for (const e of s.devices) if (run.has(e.id)) e.on = true; } });
      }
    });
  }
  return runs;
}

/**
 * What a plan is worth: utility, plus for each powered, payable device the expected gain of its next
 * volley, its landed shots times its best hit gain and its blocked shots times its block gain (volley's
 * counts against the foe's threatOf).
 * @param {Ship} plan @param {Ship} foe @param {Content} content @param {Weights} weights @param {Gains} gains
 */
function planValue(plan, foe, content, weights, gains) {
  let v = utility(plan, foe, content, weights);
  for (const [id, { land, block }] of volley(plan, threatOf(foe, content), content).shots) {
    const g = gains.get(plan.devices.find((d) => d.id === id).bp);
    if (g) v += land * g.best + block * g.block;
  }
  return v;
}

/**
 * Greedy power plan from scratch: every settable system at 0 and every device off, then repeatedly take
 * the run with the best value gain per bar while it is positive (planValue). Runs that restore the ship's
 * current intent count SWITCH_RATIO times, so near ties do not flip power (and drain charge) every think.
 * @param {Ship} ship @param {Ship} foe @param {Content} content @param {Weights} weights
 * @param {Gains} [gains] hitGains(ship, foe), when the caller already has it
 * @returns {Ship} the imagined, settled ship
 */
export function bestPower(ship, foe, content, weights, gains = hitGains(ship, foe, content, weights)) {
  const was = intentOf(ship, content);
  let plan = imagine(ship, content, (s) => {
    for (const type of Object.keys(was.levels)) s.systems[type].want = 0;
    for (const d of s.devices) d.on = false;
  });
  let now = planValue(plan, foe, content, weights, gains);
  for (;;) {
    let best = null;
    let bestU = now;
    let bestScore = 0;
    for (const run of powerRuns(plan, was, content)) {
      const next = imagine(plan, content, run.apply);
      const u = planValue(next, foe, content, weights, gains);
      const score = ((u - now) / run.bars) * (run.incumbent ? SWITCH_RATIO : 1);
      if (score > bestScore) [best, bestU, bestScore] = [next, u, score];
    }
    if (!best) return plan;
    [plan, now] = [best, bestU];
  }
}

/** The value of a ship's best power plan. @param {Ship} ship @param {Ship} foe @param {Content} content @param {Weights} weights @param {Gains} gains */
const potential = (ship, foe, content, weights, gains) => planValue(bestPower(ship, foe, content, weights, gains), foe, content, weights, gains);

/**
 * Commands that turn my current intent into the plan: devices off, systems lowered, systems raised,
 * devices on (so bars freed early in the batch are available to later commands).
 * @param {Ship} my @param {Ship} plan @param {Content} content
 * @returns {Order[]}
 */
function powerDiff(my, plan, content) {
  const was = intentOf(my, content);
  /** @type {Order[][]} */
  const [offs, lows, highs, ons] = [[], [], [], []];
  for (const type of content.systemOrder) {
    if (!Object.hasOwn(was.levels, type)) continue;
    const level = plan.systems[type].power;
    if (level !== was.levels[type]) (level < was.levels[type] ? lows : highs).push({ type: 'setPower', system: type, level });
  }
  for (const { id, on } of plan.devices) {
    if (on !== was.on.has(id)) (on ? ons : offs).push({ type: 'setDevicePower', device: id, on });
  }
  return [...offs, ...lows, ...highs, ...ons];
}

/**
 * @param {Ship} my @param {Ship} foe @param {Content} content @param {AiProfile} profile
 * @param {Ship} [plan] bestPower's result, when the caller already has it
 * @returns {Order[]} only differences from my current intent
 */
export function planPower(my, foe, content, profile, plan = bestPower(my, foe, content, profile.weights)) {
  return powerDiff(my, plan, content);
}

// ---- Weapons ----

/**
 * Volley sync: a charged device facing shields waits while another of mine will be full within patience.
 * @param {Ship} my @param {Device} dev @param {Ship} foe @param {Content} content @param {AiProfile} profile
 */
function holds(my, dev, foe, content, profile) {
  if (profile.patienceMs <= 0 || foe.pools.shield.v <= content.devices[dev.bp].pierce) return false;
  return my.devices.some((o) => o !== dev && o.powered && !isFull(o.charge)
    && canPay(my, content.devices[o.bp].cost) && msToFull(o.charge) <= profile.patienceMs);
}

/**
 * Softmax sample over scores normalized by the largest magnitude.
 * @param {number[]} scores @param {number} temperature @param {() => number} rng
 * @returns {number} index
 */
function sample(scores, temperature, rng) {
  const scale = Math.max(...scores.map(Math.abs)) || 1;
  const t = Math.max(temperature, 0.01);
  const top = Math.max(...scores);
  const weights = scores.map((s) => Math.exp((s - top) / scale / t));
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) < 0) return i;
  return weights.length - 1;
}

/**
 * Target every charged, untargeted, payable device at a foe room sampled by counterfactual value.
 * @param {View} view   the whole snapshot (unused in M1, where every target is a room of `foe`)
 * @param {Ship} my @param {Ship} foe @param {Content} content @param {AiProfile} profile @param {Memory} mem
 * @param {Gains} [gains] hitGains(my, foe), when the caller already has it
 * @returns {Order[]}
 */
export function planWeapons(view, my, foe, content, profile, mem, gains) {
  const rooms = geometry(content, foe.bp).roomIds;
  /** @type {Order[]} */
  const cmds = [];
  for (const dev of my.devices) {
    const bp = content.devices[dev.bp];
    if (!dev.powered || !isFull(dev.charge) || dev.target || !canPay(my, bp.cost)) continue;
    if (holds(my, dev, foe, content, profile)) continue;
    gains ??= hitGains(my, foe, content, profile.weights);
    const room = rooms[sample(gains.get(dev.bp).rooms, profile.temperature, mem.rng)];
    cmds.push({ type: 'setTarget', device: dev.id, target: { ship: foe.id, room } });
  }
  return cmds;
}

// ---- Crew ----

/**
 * Empty a room of crew and, when `manned`, stand one imagined idle crew member on its first cell.
 * @param {Content} content @param {string} room @param {boolean} manned
 * @returns {(s: Ship) => void}
 */
const staffed = (content, room, manned) => (s) => {
  s.crew = s.crew.filter((c) => crewRoom(content, s, c) !== room);
  if (!manned) return;
  const [cell] = roomCells(geometry(content, s.bp), room);
  s.crew.push({ id: '', name: '', cell, path: [], walk: { v: 0, max: 0, rate: 0 }, hp: 1, maxHp: 1, task: 'idle' });
};

/**
 * One task per system room that is damaged or mannable: someone working there repairs the system, then
 * mans it. A repair changes capacity, so it is valued by potential (power re-planned); manning is valued
 * at planned power. Only tasks with positive value are returned.
 * @param {Ship} my @param {Ship} foe @param {Content} content @param {Weights} weights @param {Ship} plan
 * @param {Gains} gains
 * @returns {{ room: string, value: number }[]}
 */
function crewTasks(my, foe, content, weights, plan, gains) {
  const value = (/** @type {Ship} */ s) => planValue(s, foe, content, weights, gains);
  const now = value(plan);
  const tasks = [];
  for (const type of content.systemOrder) {
    const room = roomOfSystem(content, my, type);
    const damaged = room !== null && my.systems[type].damage > 0;
    if (room === null || (!damaged && !content.systems[type].mannable)) continue;
    const work = (/** @type {Ship} */ s) => {
      staffed(content, room, true)(s);
      s.systems[type].damage = 0;
    };
    const v = damaged
      ? potential(imagine(my, content, work), foe, content, weights, gains) - now
      : value(imagine(plan, content, work)) - value(imagine(plan, content, staffed(content, room, false)));
    if (v > 0) tasks.push({ room, value: v });
  }
  return tasks;
}

/**
 * Assign crew to tasks greedily by value / (1 + pathLength / 4), with hysteresis for crew already on a task.
 * @param {Ship} my @param {Ship} foe @param {Content} content @param {AiProfile} profile
 * @param {Ship} [plan] bestPower's result, when the caller already has it
 * @param {Gains} [gains] hitGains(my, foe), when the caller already has it
 * @returns {Order[]} moveCrew only for crew whose destination room changes
 */
export function planCrew(my, foe, content, profile, plan, gains = hitGains(my, foe, content, profile.weights)) {
  plan ??= bestPower(my, foe, content, profile.weights, gains);
  const tasks = crewTasks(my, foe, content, profile.weights, plan, gains);
  const geo = geometry(content, my.bp);
  /** @param {Crew} c */
  const dest = (c) => roomAt(geo, ...claimOf(c));
  /** @param {Crew} c @param {string} room */
  const steps = (c, room) => (crewRoom(content, my, c) === room ? 0 : findPath(geo, c.cell, roomCells(geo, room)[0])?.length ?? Infinity);
  const pairs = my.crew.flatMap((c) => tasks.map((t) => ({ c, t, prio: t.value / (1 + steps(c, t.room) / 4) })));
  pairs.sort((a, b) => b.prio - a.prio);
  const busy = new Set();
  const taken = new Set();
  /** @type {Order[]} */
  const cmds = [];
  for (const { c, t } of pairs) {
    if (busy.has(c) || taken.has(t)) continue;
    const cur = tasks.find((k) => k.room === dest(c));
    if (cur && cur !== t && !taken.has(cur) && t.value <= cur.value * SWITCH_RATIO) continue;
    busy.add(c);
    taken.add(t);
    if (dest(c) !== t.room) cmds.push({ type: 'moveCrew', crew: [c.id], room: t.room });
  }
  return cmds;
}
