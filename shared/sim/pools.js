// @ts-check
// Pools: bounded integer reserves whose max is a stat (design doc 9.6). M1: hull and shield.

import { resetMeter, tickMeter } from './time.js';

/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Content} Content */

/** pool.max = stats[def.max]; v is clamped to the new max. @param {Ship} ship @param {Content} content */
export function updatePoolMaxima(ship, content) {
  for (const id of content.base.poolOrder) {
    const pool = ship.pools[id];
    pool.max = ship.stats[content.base.pools[id].max] ?? 0;
    pool.v = Math.min(pool.v, pool.max);
  }
}

/** v = max for every pool (spawn only). @param {Ship} ship @param {Content} content */
export function fillPools(ship, content) {
  for (const id of content.base.poolOrder) ship.pools[id].v = ship.pools[id].max;
}

/** Regen phase: below max the regen meter ticks at stats[ratePct] and each fill restores one unit. */
export function tickPools(/** @type {Ship} */ ship, /** @type {Content} */ content) {
  for (const id of content.base.poolOrder) {
    const def = content.base.pools[id];
    if (!def.regenMs) continue;
    const pool = ship.pools[id];
    if (pool.v < pool.max) {
      if (tickMeter(pool.regen, ship.stats[def.ratePct])) {
        pool.v += 1;
        pool.regen.v = 0;
      }
    } else {
      resetMeter(pool.regen);
    }
  }
}

/**
 * v = max(0, v - n).
 * @param {Ship} ship @param {string} id @param {number} n
 * @returns {number} the amount drained
 */
export function drainPool(ship, id, n) {
  const pool = ship.pools[id];
  const drained = Math.min(pool.v, Math.max(0, n));
  pool.v -= drained;
  return drained;
}
