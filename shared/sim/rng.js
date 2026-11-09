// @ts-check
// mulberry32 on an explicit u32 state (design doc 9.1). The sim draws only from world.rng; the AI gets
// its own standalone generator from makeRng.
// Doc choice: roll maps a draw to 0..99 with floor(r * 100 / 2^32) (exact in doubles), true when below pct.

const GOLDEN = 0x9e3779b9;   // fixed state for seed 0

/** @param {number} seed @returns {number} u32 initial state */
export function seedRng(seed) {
  return (seed >>> 0) || GOLDEN;
}

/**
 * One mulberry32 step on holder.rng.
 * @param {{ rng: number }} holder   a World, or any object carrying a u32 state
 * @returns {number} u32
 */
export function rngNext(holder) {
  const a = (holder.rng + 0x6d2b79f5) >>> 0;
  holder.rng = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

/**
 * Draws exactly one value whatever pct is, so RNG consumption never depends on stats.
 * @param {{ rng: number }} world
 * @param {number} pct
 * @returns {boolean} true with probability clamp(pct, 0, 100) / 100
 */
export function roll(world, pct) {
  const r = Math.floor((rngNext(world) * 100) / 4294967296);
  return r < Math.min(100, Math.max(0, pct));
}

/**
 * Standalone generator for the AI (never touches a world).
 * @param {number} seed
 * @returns {() => number} float in [0, 1)
 */
export function makeRng(seed) {
  const state = { rng: seedRng(seed) };
  return () => rngNext(state) / 4294967296;
}
