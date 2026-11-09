// @ts-check
// The stats fold (design doc 9.5): the single place where power, manning and statuses combine into
// numbers like evasion and chargePct. Every modifier is a Mods bundle { add?, mul? } merged in order.
// Per system: byPower tables, `manned` mods (manned and powered) and `unmanned` tables (not manned). The
// helm's autopilot is such a table, so no system needs code here (SYSTEM_HOOKS returns with medbay).

import { geometry, roomAt, roomOfSystem } from './geometry.js';
import { STATUSES } from './statuses.js';

/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').Stats} Stats */
/** @typedef {import('./types.js').Mods} Mods */
/** @typedef {import('./types.js').PowerTables} PowerTables */

/**
 * Some crew with task 'man' stands in the system's room (view-safe).
 * @param {Ship} ship @param {string} type @param {Content} content
 */
export function isManned(ship, type, content) {
  const room = roomOfSystem(content, ship, type);
  if (room === null) return false;
  const geo = geometry(content, ship.bp);
  return ship.crew.some((c) => c.task === 'man' && roomAt(geo, c.cell[0], c.cell[1]) === room);
}

/** Row `power` of every table. @param {PowerTables | undefined} tables @param {number} power @returns {Mods} */
function atPower(tables, power) {
  const row = (t) => Object.fromEntries(Object.entries(t ?? {}).map(([stat, col]) => [stat, col[power]]));
  return { add: row(tables?.add), mul: row(tables?.mul) };
}

/**
 * Pure fold (view-safe): adds, then every multiplier in push order, value = floor(value * m / 100).
 * @param {Ship} ship @param {Content} content
 * @returns {Stats}
 */
export function computeStats(ship, content) {
  /** @type {Stats} */
  const add = { ...content.base.stats, ...content.ships[ship.bp].stats };
  /** @type {[string, number][]} */
  const muls = [];
  /** @param {Mods | undefined} mods */
  const merge = (mods) => {
    for (const [stat, n] of Object.entries(mods?.add ?? {})) add[stat] = (add[stat] ?? 0) + n;
    for (const [stat, m] of Object.entries(mods?.mul ?? {})) muls.push([stat, m]);
  };
  const types = content.systemOrder.filter((t) => Object.hasOwn(ship.systems, t));
  for (const type of types) {
    const def = content.systems[type];
    const power = ship.systems[type].power;
    const manned = isManned(ship, type, content);
    merge(atPower(def.byPower, power));
    if (manned && power > 0) merge(def.manned);
    if (!manned) merge(atPower(def.unmanned, power));
  }
  for (const type of types) {
    for (const [id, st] of Object.entries(ship.systems[type].status)) merge(STATUSES[id]?.shipMods?.(st));
  }
  for (const [stat, m] of muls) add[stat] = Math.floor(((add[stat] ?? 0) * m) / 100);
  return add;
}
