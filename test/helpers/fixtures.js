// @ts-check
// Tiny injected content and world builders for unit tests (design doc 19). Sim tests use FIX so they do
// not move when shipped content is rebalanced; tests of the doc's worked numbers use shippedWorld().
//
// FIX timing at 100 percent: repair 1000 ms (20 ticks), walk 100 ms (2 ticks per cell), ion decay
// 1000 ms (20 ticks). Ships:
//   dot  (1 room):  'AA' / 'AA', shields level 4 (2 layers), reactor 4, no evasion, crew Pell in A.
//   trio (3 rooms): 'WWSSE' / 'WWSSE'; W weapons 4, S shields 4 (power 2), E engines 2 (power 1),
//                   reactor 8; devices zap, burst, zap (on) and pin (off); missiles 1; crew Ada (W),
//                   Bo (S), Cy (E). Spawned first, its ids are w1..w4 and c5..c7.
// Weapons (all canMiss false except dart): zap 1 shot; burst 3 shots 100 ms apart; pin pierce 99, costs a
// missile; fizz ion (onBlock 1, onHit 2); dart canMiss true.

import { createWorld, advance, applyCommands, deepFreeze } from '../../shared/sim/index.js';
import { CONTENT } from '../../shared/content/index.js';

/** @typedef {import('../../shared/sim/types.js').Content} Content */
/** @typedef {import('../../shared/sim/types.js').World} World */
/** @typedef {import('../../shared/sim/types.js').Ship} Ship */
/** @typedef {import('../../shared/sim/types.js').SimEvent} SimEvent */

const weapon = (over) => ({
  kind: 'weapon', name: 'Test', blurb: '', power: 1, chargeMs: 1000, target: 'enemyRoom', cost: {},
  delivery: 'projectile', shots: 1, gapMs: 0, travelMs: 100, accuracy: 0, pierce: 0, canMiss: false,
  onBlock: {}, onHit: { hull: 1 }, look: 'spark', ...over,
});

/** @type {Content} */
export const FIX = deepFreeze({
  base: {
    stats: { evasion: 0, shieldLayers: 0, shieldRegenPct: 100, chargePct: 100, repairPct: 100, walkPct: 100, hullMax: 10 },
    pools: { hull: { max: 'hullMax' }, shield: { max: 'shieldLayers', regenMs: 2000, ratePct: 'shieldRegenPct' } },
    poolOrder: ['hull', 'shield'],
    repairMs: 1000, walkMs: 100, drainPct: 300, crewHp: 100,
  },
  systems: {
    piloting: { label: 'Helm', maxLevel: 2, reactor: false, mannable: true, byPower: { mul: { evasion: [0, 100, 100] } },
      unmanned: { mul: { evasion: [100, 0, 50] } }, manned: { add: { evasion: 5 } } },
    shields: { label: 'Shields', maxLevel: 4, reactor: true, mannable: true,
      byPower: { add: { shieldLayers: [0, 0, 1, 1, 2] } }, manned: { add: { shieldRegenPct: 10 } } },
    engines: { label: 'Engines', maxLevel: 4, reactor: true, mannable: true,
      byPower: { add: { evasion: [0, 10, 20, 30, 40] }, mul: { evasion: [0, 100, 100, 100, 100] } },
      manned: { add: { evasion: 5 } } },
    weapons: { label: 'Weapons', maxLevel: 4, reactor: true, mannable: true, hosts: 'weapon',
      manned: { add: { chargePct: 10 } } },
  },
  systemOrder: ['piloting', 'shields', 'engines', 'weapons'],
  statuses: { ion: { decayMs: 1000 } },
  devices: {
    zap: weapon({ name: 'Zap', onHit: { hull: 1, sysDamage: 1, crew: 10 } }),
    burst: weapon({ name: 'Burst', power: 2, chargeMs: 2000, shots: 3, gapMs: 100 }),
    pin: weapon({ name: 'Pin', travelMs: 200, pierce: 99, cost: { missiles: 1 }, onHit: { hull: 2 } }),
    fizz: weapon({ name: 'Fizz', onBlock: { ion: 1 }, onHit: { ion: 2 } }),
    dart: weapon({ name: 'Dart', canMiss: true }),
  },
  ships: {
    dot: {
      name: 'Dot', map: ['AA', 'AA'], legend: { A: 'shields' }, reactor: 4,
      systems: { shields: { level: 4, power: 4 } }, devices: [], stores: {},
      crew: [{ name: 'Pell', room: 'A' }],
    },
    trio: {
      name: 'Trio', map: ['WWSSE', 'WWSSE'], legend: { W: 'weapons', S: 'shields', E: 'engines' }, reactor: 8,
      stats: { hullMax: 12 },
      systems: { weapons: { level: 4 }, shields: { level: 4, power: 2 }, engines: { level: 2, power: 1 } },
      devices: [{ bp: 'zap', on: true }, { bp: 'burst', on: true }, { bp: 'zap', on: true }, { bp: 'pin', on: false }],
      stores: { missiles: 1 },
      crew: [{ name: 'Ada', room: 'W' }, { name: 'Bo', room: 'S' }, { name: 'Cy', room: 'E' }],
    },
  },
  ai: {
    idle: { label: 'Idle', persona: 'Test', passive: true, thinkEveryTicks: 1, reactionTicks: 0,
      temperature: 0, patienceMs: 0, crew: false, weights: { offense: 1, defense: 1 } },
  },
});

/**
 * World from [id, bp, side] triples.
 * @param {{ seed?: number, ships?: [string, string, string][], content?: Content }} [opts]
 * @returns {World}
 */
export function fixtureWorld({ seed = 1, ships = [['s1', 'trio', 'blue'], ['s2', 'dot', 'red']], content = FIX } = {}) {
  return createWorld({ seed, ships: ships.map(([id, bp, side]) => ({ id, bp, side })) }, content);
}

/** trio (s1, blue) vs dot (s2, red) on FIX. @param {number} [seed] */
export function duel(seed = 1) {
  return fixtureWorld({ seed });
}

/** Candlewick (s1, blue) vs Lampblack (s2, red) on shipped CONTENT. @param {number} [seed] */
export function shippedWorld(seed = 7) {
  return createWorld({ seed, ships: [{ id: 's1', bp: 'candlewick', side: 'blue' }, { id: 's2', bp: 'lampblack', side: 'red' }] }, CONTENT);
}

/** A ctx that records emitted events. @param {Content} [content] */
export function recorder(content = FIX) {
  /** @type {object[]} */
  const events = [];
  return { content, events, emit: (e) => events.push(e) };
}

/**
 * Advance n ticks (stops early at an outcome); returns every event.
 * @param {World} world @param {number} n @param {Content} [content]
 * @returns {SimEvent[]}
 */
export function run(world, n, content = FIX) {
  const events = [];
  for (let i = 0; i < n && !world.outcome; i++) events.push(...advance(world, content));
  return events;
}

/**
 * Advance until pred(world) holds (at most limit ticks); returns the ticks taken.
 * @param {World} world @param {(w: World) => boolean} pred @param {Content} [content] @param {number} [limit]
 */
export function runUntil(world, pred, content = FIX, limit = 10000) {
  let n = 0;
  while (!pred(world)) {
    if (n++ >= limit || world.outcome) throw new Error(`condition not reached in ${limit} ticks`);
    advance(world, content);
  }
  return n;
}

/**
 * Apply commands for one ship (stamps `ship`), returning results and events.
 * @param {World} world @param {string} shipId @param {object[]} cmds @param {Content} [content]
 */
export function command(world, shipId, cmds, content = FIX) {
  return applyCommands(world, cmds.map((c) => ({ ...c, ship: shipId })), content);
}

/** @param {Ship} ship @param {string} id */
export function dev(ship, id) {
  return ship.devices.find((d) => d.id === id);
}

/** @param {Ship} ship @param {string} name */
export function crewNamed(ship, name) {
  return ship.crew.find((c) => c.name === name);
}

/** @param {object[]} events @returns {string[]} */
export function types(events) {
  return events.map((e) => e.type);
}
