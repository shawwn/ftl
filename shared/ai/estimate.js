// @ts-check
// What the AI believes (design doc 16.1): expected hull damage rates, the one utility it maximizes, and
// counterfactuals ("imagine") on copies of projected ships, settled by the sim's own deriveShip.
// Floats are fine here; shared/ai is not the sim. Every function is view-safe: it reads only what a
// projection of the AI's side shows (enemy intent is absent, actual power and charge are visible).
// Doc choices:
// - dps counts only devices that can pay their cost (canPay), so a missile launcher with no missiles is
//   worth nothing, both in the AI's own power plan and when it sizes up the enemy.
// - The foe in utility is threatOf(foe): one allocation it can actually reach within one command, not its
//   momentary power. Weapons get reactor bars first (slot order, within capacity), then every other
//   system climbs to its level in systemOrder with what is left. Both terms use it: my offense is scored
//   against the shields and evasion it can raise, its threat is the weapons it can power. With momentary
//   flags two AIs best-respond to each other's power and oscillate forever (its weapons are off, so my
//   shields are worthless, so I drop them; its shields are down, so my ion weapon is worthless, so I cut
//   it mid-charge...). Damage and ion still bind through capacity, and the reactor is respected.
// - imagine copies with a plain-data deep copy instead of structuredClone: identical on views (parsed
//   JSON), about four times faster, and imagine is the AI's inner loop.

import { applyEffects, blockRoom, canPay, deriveShip, geometry, takesWant } from '../sim/index.js';

/** @typedef {import('../sim/types.js').Ship} Ship */
/** @typedef {import('../sim/types.js').Device} Device */
/** @typedef {import('../sim/types.js').Content} Content */
/** @typedef {import('../sim/types.js').Payload} Payload */
/** @typedef {import('../sim/types.js').AiProfile} AiProfile */
/** @typedef {AiProfile['weights']} Weights */

const QUIET = () => {};

/** Deep copy of plain JSON data. @template T @param {T} v @returns {T} */
function copy(v) {
  if (Array.isArray(v)) return /** @type {T} */ (v.map(copy));
  if (v === null || typeof v !== 'object') return v;
  const o = {};
  for (const k of Object.keys(v)) o[k] = copy(v[k]);
  return /** @type {T} */ (o);
}

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** @param {Ship} ship @returns {Device[]} */
export function poweredDevices(ship) {
  return ship.devices.filter((d) => d.powered);
}

/** @type {WeakMap<Ship, { content: Content, threat: Ship }>} */
const threats = new WeakMap();

/**
 * The foe as it could stand within one command (memoized per foe object; views are not mutated): every
 * device on and powered first, in slot order, as far as capacity and the reactor allow; then every system
 * that takes a want asks for its level, filled in systemOrder from the bars left.
 * @param {Ship} foe @param {Content} content @returns {Ship}
 */
export function threatOf(foe, content) {
  const memo = threats.get(foe);
  if (memo?.content === content) return memo.threat;
  const wants = (/** @type {Ship} */ s, /** @type {(level: number) => number} */ f) => {
    for (const [type, sys] of Object.entries(s.systems)) if (takesWant(content.systems[type])) sys.want = f(sys.level);
  };
  const armed = imagine(foe, content, (s) => {
    wants(s, () => 0);
    for (const d of s.devices) Object.assign(d, { on: true, powered: false });
  });
  const threat = imagine(armed, content, (s) => wants(s, (level) => level));
  threats.set(foe, { content, threat });
  return threat;
}

/** Chance that one shot of bp is not evaded by def. @param {import('../sim/types.js').DeviceBp} bp @param {Ship} def */
function hitChance(bp, def) {
  return bp.canMiss ? 1 - clamp(def.stats.evasion - bp.accuracy, 0, 100) / 100 : 1;
}

/**
 * att's devices against def as one volley per cycle of the slowest device: blockable shots strip def's
 * shield layers first, in device order. Returns the expected hull damage per second, and per device the
 * expected shots per volley that land (hit and get through) and that are blocked.
 * @param {Ship} att @param {Ship} def @param {Content} content @param {Device[]} [devices]
 * @returns {{ dps: number, shots: Map<string, { land: number, block: number }> }}
 */
export function volley(att, def, content, devices = poweredDevices(att)) {
  const layers0 = def.stats.shieldLayers;
  let cycleMs = 0;
  /** @type {{ dev: string, p: number, pierce: number, hull: number }[]} */
  const shots = [];
  /** @type {Map<string, { land: number, block: number }>} */
  const per = new Map();
  for (const dev of devices) {
    const bp = content.devices[dev.bp];
    if (!canPay(att, bp.cost)) continue;
    const p = hitChance(bp, def);
    cycleMs = Math.max(cycleMs, (bp.chargeMs * 100) / att.stats.chargePct);
    per.set(dev.id, { land: 0, block: 0 });
    for (let i = 0; i < bp.shots; i++) shots.push({ dev: dev.id, p, pierce: bp.pierce, hull: bp.onHit.hull ?? 0 });
  }
  if (!shots.length) return { dps: 0, shots: per };
  const ordered = [...shots.filter((s) => s.pierce < layers0), ...shots.filter((s) => s.pierce >= layers0)];
  let layers = layers0;
  let dmg = 0;
  for (const s of ordered) {
    const b = clamp(layers - s.pierce, 0, 1);
    const d = per.get(s.dev);
    d.land += s.p * (1 - b);
    d.block += s.p * b;
    dmg += s.p * (1 - b) * s.hull;
    layers -= s.p * b;
  }
  return { dps: dmg / (cycleMs / 1000), shots: per };
}

/**
 * Expected hull damage per second of att's devices against def (volley's rate).
 * @param {Ship} att @param {Ship} def @param {Content} content @param {Device[]} [devices]
 */
export function dps(att, def, content, devices = poweredDevices(att)) {
  return volley(att, def, content, devices).dps;
}

/**
 * "Who dies first" in rate form: the fraction of the foe's hull I remove per second minus the reverse,
 * both against the foe as it could stand within one command (threatOf).
 * @param {Ship} me @param {Ship} foe @param {Content} content @param {Weights} weights
 */
export function utility(me, foe, content, weights) {
  const threat = threatOf(foe, content);
  return weights.offense * dps(me, threat, content) / Math.max(1, foe.pools.hull.v)
    - weights.defense * dps(threat, me, content) / Math.max(1, me.pools.hull.v);
}

/** @typedef {{ rooms: number[], best: number, block: number }} Gain */

/**
 * What one shot of each of my blueprints is worth, by the sim's own effects (the counterfactual that both
 * aims and powers weapons): `rooms`, the utility gained when its onHit lands in each foe room (room order
 * of its geometry); `best`, the largest of those, at least 0; `block`, the gain when a shield blocks it
 * and its onBlock lands where the sim puts it (blockRoom).
 * @param {Ship} me @param {Ship} foe @param {Content} content @param {Weights} weights
 * @returns {Map<string, Gain>}
 */
export function hitGains(me, foe, content, weights) {
  const now = utility(me, foe, content, weights);
  const gain = (/** @type {string | null} */ room, /** @type {Payload} */ payload) =>
    utility(me, imagineHit(foe, room, payload, content), content, weights) - now;
  /** @type {Map<string, Gain>} */
  const gains = new Map();
  for (const dev of me.devices) {
    if (gains.has(dev.bp)) continue;
    const bp = content.devices[dev.bp];
    const rooms = geometry(content, foe.bp).roomIds.map((room) => gain(room, bp.onHit));
    const block = Object.keys(bp.onBlock).length ? Math.max(0, gain(blockRoom(content, foe), bp.onBlock)) : 0;
    gains.set(dev.bp, { rooms, best: Math.max(0, ...rooms), block });
  }
  return gains;
}

/**
 * Clone, mutate the clone, settle it with the sim's deriveShip, return it. The input is never touched.
 * @param {Ship} ship @param {Content} content @param {(s: Ship) => void} [mutate]
 * @returns {Ship}
 */
export function imagine(ship, content, mutate = QUIET) {
  const s = copy(ship);
  mutate(s);
  deriveShip(s, content);
  return s;
}

/**
 * The ship after a payload lands in a room (effects applied silently, then settled).
 * @param {Ship} ship @param {string} room @param {Payload} payload @param {Content} content
 */
export function imagineHit(ship, room, payload, content) {
  return imagine(ship, content, (s) => applyEffects(s, room, payload, { content, emit: QUIET }));
}
