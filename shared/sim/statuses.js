// @ts-check
// Stacking timed statuses on any holder with a `status` map (design doc 9.7). M1: ion on systems.
// Doc choice: addStatus returns the status record so callers (the ion effect) can report its stack count.

import { meter, tickMeter } from './time.js';

/** @typedef {import('./types.js').Status} Status */
/** @typedef {import('./types.js').StatusHolder} StatusHolder */
/** @typedef {import('./types.js').Content} Content */

/**
 * Behavior per status id. Hooks: capacity(st) -> bars removed; shipMods(st) -> Mods (none in M1).
 * @type {Record<string, { capacity?: (st: Status) => number, shipMods?: (st: Status) => import('./types.js').Mods }>}
 */
export const STATUSES = {
  ion: { capacity: (st) => st.n },   // each stack removes one bar of capacity
};

/**
 * Add n stacks and restart the decay timer.
 * @param {StatusHolder} holder @param {string} id @param {number} n @param {Content} content
 * @returns {Status}
 */
export function addStatus(holder, id, n, content) {
  const timer = meter(content.statuses[id].decayMs, 0, 100);   // tickStatuses runs every timer at 100
  const st = Object.hasOwn(holder.status, id) ? holder.status[id] : (holder.status[id] = { n: 0, timer });
  st.n += n;
  st.timer = timer;
  return st;
}

/** Each timer ticks at 100; when full one stack decays; the status is removed at n <= 0. @param {StatusHolder} holder */
export function tickStatuses(holder) {
  for (const id of Object.keys(holder.status)) {
    const st = holder.status[id];
    if (tickMeter(st.timer, 100)) {
      st.n -= 1;
      st.timer.v = 0;
    }
    if (st.n <= 0) delete holder.status[id];
  }
}

/** Bars of capacity removed by the holder's statuses (view-safe). @param {StatusHolder} holder */
export function capacityPenalty(holder) {
  let bars = 0;
  for (const [id, st] of Object.entries(holder.status)) bars += STATUSES[id]?.capacity?.(st) ?? 0;
  return bars;
}
