// @ts-check
// Fixed ticks and integer meters (design doc section 6). A meter's v and max are in ms * 100, and its
// rate is a percent of normal speed, so one tick adds TICK_MS * ratePct. `rate` is always the rate the
// owner applies next tick: a meter born between its owner's ticks starts at that rate, a restart sets
// only v = 0 (keeping the rate), and resetMeter means idle (v = 0, rate 0).
// Doc choice: a draining meter stops at 0, but a meter that already sits below 0 (a volley delay) is
// never pulled further down or pushed up by the clamp.

/** @typedef {import('./types.js').Meter} Meter */

export const TICK_MS = 50;

/**
 * @param {number} ms      duration at 100 percent
 * @param {number} [v]     starting progress (negative expresses delay)
 * @param {number} [rate]  the rate its owner will tick it at next (0 for an idle meter)
 * @returns {Meter}
 */
export function meter(ms, v = 0, rate = 0) {
  return { v, max: ms * 100, rate };
}

/**
 * Advance one tick at ratePct and store the rate for clients.
 * @param {Meter} m
 * @param {number} ratePct
 * @returns {boolean} true when the meter is full after this tick
 */
export function tickMeter(m, ratePct) {
  m.rate = ratePct;
  m.v = Math.min(m.max, Math.max(Math.min(m.v, 0), m.v + TICK_MS * ratePct));
  return m.v >= m.max;
}

/** @param {Meter} m */
export function isFull(m) {
  return m.v >= m.max;
}

/** Idle: v = 0 and rate 0 (a restart that keeps running sets only v = 0). @param {Meter} m */
export function resetMeter(m) {
  m.v = 0;
  m.rate = 0;
}

/**
 * UI and AI only (float): fraction 0..1 after extrapolating elapsedMs at the stored rate.
 * @param {Meter} m
 * @param {number} [elapsedMs]
 */
export function meterAt(m, elapsedMs = 0) {
  if (m.max <= 0) return 1;
  return Math.min(1, Math.max(0, (m.v + m.rate * elapsedMs) / m.max));
}

/**
 * UI and AI only (float): ms until full at the current rate, Infinity if rate <= 0.
 * @param {Meter} m
 */
export function msToFull(m) {
  return m.rate > 0 ? Math.max(0, (m.max - m.v) / m.rate) : Infinity;
}
