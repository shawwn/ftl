// @ts-check
// Status tunables (design doc 8.4); behavior lives in the sim's STATUSES registry.

/** @type {Record<string, { decayMs: number }>} */
export default {
  ion: { decayMs: 5000 },   // each stack lasts 5 s; a new hit resets the timer
};
