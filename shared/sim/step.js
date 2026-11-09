// @ts-check
// Tick ordering (design doc section 10). step = applyCommands then advance; both end with derive, so every
// observed world is settled.
// Doc choices: cleanup handles every ship (wrecks included) for crew removal and stale targets; a world
// whose living ships share one side ends at its first advance.

import { tickStatuses } from './statuses.js';
import { tickCrew } from './crew.js';
import { tickPools } from './pools.js';
import { tickShots } from './combat.js';
import { tickDevices, validTarget } from './devices.js';
import { deriveAll } from './derive.js';
import { shipsInOrder } from './world.js';
import { applyCommands } from './commands.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').SystemState} SystemState */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').Command} Command */
/** @typedef {import('./types.js').SimEvent} SimEvent */
/** @typedef {import('./types.js').Ctx} Ctx */

/** @param {World} w @param {(s: Ship) => void} fn */
const forLiving = (w, fn) => {
  for (const s of shipsInOrder(w)) if (!s.out) fn(s);
};
/** @param {Ship} s @param {(sys: SystemState) => void} fn */
const forSystems = (s, fn) => {
  for (const sys of Object.values(s.systems)) fn(sys);
};

/** @type {[string, (w: World, ctx: Ctx) => void][]} */
export const PHASES = [
  ['statuses', (w, ctx) => forLiving(w, (s) => forSystems(s, tickStatuses))],   // ion stacks decay
  ['crew',     (w, ctx) => forLiving(w, (s) => tickCrew(w, s, ctx))],            // walk, then repair
  ['pools',    (w, ctx) => forLiving(w, (s) => tickPools(s, ctx.content))],      // shield regen
  ['shots',    tickShots],                                                     // fly; arrivals run the hit pipeline
  ['cleanup',  cleanup],                                                       // deaths, wrecks, stale targets, outcome
  ['devices',  (w, ctx) => forLiving(w, (s) => tickDevices(w, s, ctx))],         // charge; fire new shots
  ['derive',   deriveAll],                                                     // settle power, tasks, stats, pool maxima
];

/** Deaths, wrecks, stale targets, outcome. @param {World} world @param {Ctx} ctx */
function cleanup(world, ctx) {
  const { content, emit } = ctx;
  const ships = shipsInOrder(world);
  for (const ship of ships) {
    for (const c of ship.crew) if (c.hp <= 0) emit({ type: 'crewDied', ship: ship.id, crew: c.id, name: c.name });
    ship.crew = ship.crew.filter((c) => c.hp > 0);
  }
  for (const ship of ships) {
    if (ship.out) continue;
    ship.out = ship.pools.hull.v <= 0 ? 'hull' : ship.crew.length === 0 ? 'crew' : null;
    if (ship.out) emit({ type: 'shipOut', ship: ship.id, reason: ship.out });
  }
  for (const ship of ships) {
    for (const dev of ship.devices) {
      if (dev.target && validTarget(world, ship, content.devices[dev.bp], dev.target, content)) dev.target = null;
    }
  }
  const sides = new Set(ships.filter((s) => !s.out).map((s) => s.side));
  if (sides.size <= 1) {
    const winner = sides.size ? [...sides][0] : null;
    world.outcome = { winner, tick: world.tick };
    emit({ type: 'outcome', winner });
  }
}

/**
 * One tick of time. A world with an outcome no longer advances.
 * @param {World} world @param {Content} content
 * @returns {SimEvent[]}
 */
export function advance(world, content) {
  if (world.outcome) return [];
  /** @type {SimEvent[]} */
  const events = [];
  const ctx = { content, emit: (e) => events.push({ tick: world.tick, ...e }) };
  for (const [, phase] of PHASES) phase(world, ctx);
  world.tick += 1;
  return events;
}

/**
 * @param {World} world @param {Command[]} cmds @param {Content} content
 * @returns {{ results: (string | null)[], events: SimEvent[] }}
 */
export function step(world, cmds, content) {
  const a = applyCommands(world, cmds, content);
  return { results: a.results, events: [...a.events, ...advance(world, content)] };
}
