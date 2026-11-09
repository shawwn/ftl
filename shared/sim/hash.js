// @ts-check
// Hashing and invariants (design doc 9.15).
// Doc choices: fnv1a hashes UTF-16 code units (content and state are ASCII, so this equals hashing bytes).
// checkInvariants also checks two consequences the doc states elsewhere: the settle invariant of 9.4, and
// unique crew claims (destinations are exclusive, which implies no two standing crew share a cell);
// stores are non-negative.

import { cellKey, geometry, roomAt } from './geometry.js';
import { capacity, freeReactor } from './power.js';
import { computeStats } from './stats.js';
import { validTarget } from './devices.js';
import { claimOf } from './crew.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Meter} Meter */
/** @typedef {import('./types.js').Content} Content */

/** @param {string} str @returns {string} 8-char lowercase hex of FNV-1a 32-bit */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** @param {World} world */
export function hashWorld(world) {
  return fnv1a(JSON.stringify(world));
}

/**
 * @param {World} world @param {Content} content
 * @returns {string[]} violations (empty is good)
 */
export function checkInvariants(world, content) {
  /** @type {string[]} */
  const out = [];
  numbers(world, 'world', out);
  for (const ship of Object.values(world.ships)) checkShip(world, ship, content, out);
  for (const shot of world.shots) checkMeter(shot.flight, `shot ${shot.id} flight`, out);
  return out;
}

/** Every number is a safe integer. */
function numbers(value, path, out) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) out.push(`${path} is not a safe integer: ${value}`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) numbers(v, `${path}.${k}`, out);
  }
}

/** @param {Meter} m @param {string} path @param {string[]} out */
function checkMeter(m, path, out) {
  if (m.v > m.max) out.push(`${path}: v ${m.v} > max ${m.max}`);
}

/** @param {World} world @param {Ship} ship @param {Content} content @param {string[]} out */
function checkShip(world, ship, content, out) {
  const id = ship.id;
  const free = freeReactor(ship, content);
  if (free < 0) out.push(`${id}: reactor draw exceeds reactor ${ship.reactor}`);
  for (const [type, sys] of Object.entries(ship.systems)) {
    const def = content.systems[type];
    const cap = capacity(sys);
    if (sys.power < 0 || sys.power > cap) out.push(`${id}.${type}: power ${sys.power} outside 0..${cap}`);
    if (sys.damage < 0 || sys.damage > sys.level) out.push(`${id}.${type}: damage ${sys.damage} outside 0..${sys.level}`);
    checkMeter(sys.repair, `${id}.${type} repair`, out);
    for (const [sid, st] of Object.entries(sys.status)) checkMeter(st.timer, `${id}.${type} ${sid}`, out);
    if (def.hosts) {
      let used = 0;
      for (const dev of ship.devices.filter((d) => d.host === type)) {
        const p = content.devices[dev.bp].power;
        if (dev.powered) used += p;
        else if (dev.on && sys.power + p <= cap && p <= free) out.push(`${id}.${dev.id}: on, fits, but unpowered`);
      }
      if (used !== sys.power) out.push(`${id}.${type}: power ${sys.power} != powered devices ${used}`);
    } else if (def.reactor && sys.power !== Math.min(sys.want ?? sys.power, cap) && free !== 0) {
      out.push(`${id}.${type}: not settled (power ${sys.power}, want ${sys.want}, free ${free})`);
    }
  }
  for (const [pid, pool] of Object.entries(ship.pools)) {
    if (pool.v < 0 || pool.v > pool.max) out.push(`${id}.${pid}: ${pool.v} outside 0..${pool.max}`);
    if (pool.regen) checkMeter(pool.regen, `${id}.${pid} regen`, out);
  }
  for (const [k, n] of Object.entries(ship.stores)) if (n < 0) out.push(`${id}.stores.${k} is negative`);
  for (const dev of ship.devices) {
    checkMeter(dev.charge, `${id}.${dev.id} charge`, out);
    const why = dev.target ? validTarget(world, ship, content.devices[dev.bp], dev.target, content) : null;
    if (why && why !== 'ship-out') out.push(`${id}.${dev.id}: invalid target (${why})`);
  }
  const geo = geometry(content, ship.bp);
  const claims = new Set();
  for (const c of ship.crew) {
    checkMeter(c.walk, `${id}.${c.id} walk`, out);
    if (roomAt(geo, c.cell[0], c.cell[1]) === null) out.push(`${id}.${c.id}: cell ${c.cell} is outside every room`);
    const claim = cellKey(...claimOf(c));
    if (claims.has(claim)) out.push(`${id}.${c.id}: claims cell ${claim} already claimed`);
    claims.add(claim);
  }
  if (JSON.stringify(ship.stats) !== JSON.stringify(computeStats(ship, content))) out.push(`${id}: stats are stale`);
}
