// @ts-check
// World creation and ship queries (design doc 9.3).
// Doc choices: world.seed is stored as seed >>> 0 (a u32, as typed); a blueprint device without `on`
// starts off; spawning a duplicate ship id or a device no system can host throws.

import { meter } from './time.js';
import { seedRng } from './rng.js';
import { cellKey, geometry, roomCells } from './geometry.js';
import { deriveAll } from './derive.js';
import { fillPools } from './pools.js';
import { takesWant } from './power.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {{ id: string, bp: string, side: string, name?: string }} ShipSpec */

/**
 * @param {{ seed: number, ships: ShipSpec[] }} setup
 * @param {Content} content
 * @returns {World} settled, pools full
 */
export function createWorld(setup, content) {
  /** @type {World} */
  const world = {
    v: 1, seed: setup.seed >>> 0, tick: 0, rng: seedRng(setup.seed), nextId: 1,
    ships: {}, shots: [], outcome: null,
  };
  for (const spec of setup.ships) spawnShip(world, spec, content);
  deriveAll(world, { content, emit: () => {} });
  for (const ship of shipsInOrder(world)) fillPools(ship, content);
  return world;
}

/**
 * Build a ship from its blueprint and append it to world.ships (not yet derived).
 * @param {World} world @param {ShipSpec} spec @param {Content} content
 * @returns {Ship}
 */
export function spawnShip(world, spec, content) {
  const bp = content.ships[spec.bp];
  if (!bp) throw new Error(`unknown ship blueprint ${spec.bp}`);
  if (Object.hasOwn(world.ships, spec.id)) throw new Error(`duplicate ship id ${spec.id}`);
  const { base } = content;
  /** @type {Ship} */
  const ship = {
    id: spec.id, bp: spec.bp, name: spec.name ?? bp.name, side: spec.side, out: null,
    reactor: bp.reactor, stores: { ...bp.stores }, pools: {}, systems: {}, devices: [], crew: [], stats: {},
  };
  for (const id of base.poolOrder) {
    const def = base.pools[id];
    ship.pools[id] = def.regenMs ? { v: 0, max: 0, regen: meter(def.regenMs) } : { v: 0, max: 0 };
  }
  for (const type of content.systemOrder) {
    if (!Object.hasOwn(bp.systems, type)) continue;
    const def = content.systems[type];
    const want = takesWant(def) ? { want: bp.systems[type].power ?? 0 } : {};
    ship.systems[type] = {
      level: bp.systems[type].level, ...want, power: 0, damage: 0, repair: meter(base.repairMs), status: {},
    };
  }
  for (const d of bp.devices) {
    const dbp = content.devices[d.bp];
    const host = content.systemOrder.find((t) => Object.hasOwn(ship.systems, t) && content.systems[t].hosts === dbp.kind);
    if (!host) throw new Error(`no system on ${spec.bp} hosts ${dbp.kind}`);
    ship.devices.push({
      id: newId(world, 'w'), bp: d.bp, host, on: d.on === true, powered: false,
      charge: meter(dbp.chargeMs), target: null, auto: false,
    });
  }
  const geo = geometry(content, spec.bp);
  const taken = new Set();
  for (const c of bp.crew) {
    const cell = roomCells(geo, c.room).find(([x, y]) => !taken.has(cellKey(x, y)));
    if (!cell) throw new Error(`no free cell in room ${c.room} of ${spec.bp}`);
    taken.add(cellKey(...cell));
    ship.crew.push({
      id: newId(world, 'c'), name: c.name, cell, path: [], walk: meter(base.walkMs),
      hp: base.crewHp, maxHp: base.crewHp, task: 'idle',
    });
  }
  world.ships[spec.id] = ship;
  return ship;
}

/** @param {World} world @param {string} prefix @returns {string} unique across the world */
export function newId(world, prefix) {
  return prefix + world.nextId++;
}

/** @param {World} world @returns {Ship[]} spawn order (view-safe) */
export function shipsInOrder(world) {
  return Object.values(world.ships);
}

/** Ships of another side that are not out (view-safe). @param {World} world @param {Ship} ship */
export function enemiesOf(world, ship) {
  return shipsInOrder(world).filter((s) => s.side !== ship.side && s.out === null);
}
