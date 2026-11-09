// @ts-check
// Replay (design doc 14.7): spec + seed + command log reproduce a match. Commands logged at a tick apply
// before that tick's advance; a paused or waiting stretch is several batches at one tick. Every command
// mutates only its own ship and ends with a derive of that ship (idempotent), so a batch boundary carries
// no information and one merged batch equals them all. The log holds only accepted commands (a rejected
// one changed nothing); a record marked `truncated` stopped logging and cannot reproduce its round.
// Doc choice: Match logs each command already stamped with its ship, so no member table is needed.

import { createWorld, applyCommands, advance } from '../sim/index.js';

/** @typedef {import('../sim/types.js').World} World */
/** @typedef {import('../sim/types.js').Content} Content */
/** @typedef {import('./match.js').ReplayRecord} ReplayRecord */

/** @param {ReplayRecord} record @param {Content} content @returns {World} */
export function replay({ spec, seed, log, finalTick }, content) {
  const world = createWorld({ seed, ships: spec.ships }, content);
  let next = 0;
  const loggedAt = (/** @type {number} */ tick) => {
    const batch = [];
    while (next < log.length && log[next][0] <= tick) batch.push(log[next++][2]);
    return batch;
  };
  while (world.tick < finalTick && !world.outcome) {
    applyCommands(world, loggedAt(world.tick), content);
    advance(world, content);
  }
  applyCommands(world, loggedAt(finalTick), content);
  return world;
}
