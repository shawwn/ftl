// @ts-check
// Crew: walking, derived tasks and repair (design doc 9.11). Manning is derived from where crew stand.
// Doc choice: "mid-step" means path.length > 0 && walk.v > 0. A crew member whose step has not started
// (walk.v === 0) stands exactly on its cell, so a new plan starts from that cell instead.

import { cellKey, findPath, geometry, roomAt, roomCells, roomOfSystem, systemAt } from './geometry.js';
import { resetMeter, tickMeter } from './time.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Crew} Crew */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').Ctx} Ctx */

/** Room id of the crew member's current cell (view-safe). @param {Content} content @param {Ship} ship @param {Crew} crew */
export function crewRoom(content, ship, crew) {
  return roomAt(geometry(content, ship.bp), crew.cell[0], crew.cell[1]);
}

/** Crew whose current cell is in the room (view-safe). @param {Content} content @param {Ship} ship @param {string | null} roomId */
export function crewInRoom(content, ship, roomId) {
  return ship.crew.filter((c) => crewRoom(content, ship, c) === roomId);
}

/** A crew member's destination: the last path cell if walking, else its cell (view-safe). @param {Crew} c @returns {[number, number]} */
export function claimOf(c) {
  return c.path.length ? c.path[c.path.length - 1] : c.cell;
}

/** Destinations are exclusive: one claim per crew member. @param {Ship} ship @returns {Set<string>} */
export function claimedCells(ship) {
  return new Set(ship.crew.map((c) => cellKey(...claimOf(c))));
}

/**
 * Send crew to the first free cells of a room (row-major), in the given order.
 * @param {Ship} ship @param {string[]} crewIds @param {string} roomId @param {Content} content
 * @returns {number} crew now heading to or already in the room
 */
export function planMove(ship, crewIds, roomId, content) {
  const geo = geometry(content, ship.bp);
  const claimed = claimedCells(ship);
  const cells = roomCells(geo, roomId);
  let count = 0;
  for (const id of crewIds) {
    const c = ship.crew.find((m) => m.id === id);
    if (!c) continue;
    const claim = claimOf(c);
    if (roomAt(geo, claim[0], claim[1]) === roomId) {
      count += 1;
      continue;
    }
    const dest = cells.find(([x, y]) => !claimed.has(cellKey(x, y)));
    const midStep = c.path.length > 0 && c.walk.v > 0;
    const from = midStep ? c.path[0] : c.cell;
    const rest = dest ? findPath(geo, from, dest) : null;
    if (!rest) continue;
    claimed.delete(cellKey(...claim));
    claimed.add(cellKey(...dest));
    c.path = midStep ? [from, ...rest] : rest;
    count += 1;
  }
  return count;
}

/**
 * Derive: 'walk' while moving; else 'repair' if the room's system is damaged; else 'man' for the first
 * crew member (array order) in a mannable system's room; else 'idle'.
 * @param {Ship} ship @param {Content} content
 */
export function assignTasks(ship, content) {
  const manned = new Set();
  for (const c of ship.crew) {
    if (c.path.length) {
      c.task = 'walk';
      continue;
    }
    const type = systemAt(content, ship, crewRoom(content, ship, c));
    if (type && ship.systems[type].damage > 0) c.task = 'repair';
    else if (type && content.systems[type].mannable && !manned.has(type)) {
      c.task = 'man';
      manned.add(type);
    } else c.task = 'idle';
  }
}

/**
 * Phase: walking, then repairing. Repair speed stacks: n repairing crew tick at n * repairPct.
 * @param {World} world @param {Ship} ship @param {Ctx} ctx
 */
export function tickCrew(world, ship, ctx) {
  const { content, emit } = ctx;
  for (const c of ship.crew) {
    if (!c.path.length) {
      tickMeter(c.walk, 0);
    } else if (tickMeter(c.walk, ship.stats.walkPct)) {
      c.cell = c.path.shift();
      c.walk.v = 0;
    }
  }
  for (const type of content.systemOrder) {
    if (!Object.hasOwn(ship.systems, type)) continue;
    const sys = ship.systems[type];
    if (sys.damage === 0) {
      resetMeter(sys.repair);
      continue;
    }
    const n = crewInRoom(content, ship, roomOfSystem(content, ship, type)).filter((c) => c.task === 'repair').length;
    if (tickMeter(sys.repair, n * ship.stats.repairPct)) {
      sys.damage -= 1;
      sys.repair.v = 0;
      emit({ type: 'systemRepaired', ship: ship.id, system: type, damage: sys.damage });
    }
  }
}
