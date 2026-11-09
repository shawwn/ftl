// @ts-check
// The AI as a match occupant (design doc 16.3): it receives the same snapshot text a human on its side
// receives and submits the same commands. Tick-driven (never wall-clock), so AI-vs-AI is deterministic.
// Doc choices: the ship's side is read from the snapshot; text that is not valid JSON, and every message
// other than snap, is ignored; a new round re-seeds the RNG from the same seed and empties the queue.

import { makeRng } from '../sim/index.js';
import { think } from './brain.js';

/** @typedef {import('../sim/types.js').Content} Content */
/** @typedef {import('../sim/types.js').AiProfile} AiProfile */
/** @typedef {import('./brain.js').Order} Order */
/** @typedef {import('./brain.js').Memory} Memory */
/** @typedef {{ kind: 'human' | 'ai', deliver(text: string): void }} Occupant */

/**
 * @param {{ profile: AiProfile, seed: number, content: Content, ship: string, submit: (cmd: Order) => void }} opts
 * @returns {Occupant}
 */
export function aiOccupant({ profile, seed, content, ship, submit }) {
  /** @type {Memory} */
  let mem;
  /** @type {{ due: number, cmd: Order }[]} */
  let queue;
  let round = null;
  const reset = () => {
    mem = { rng: makeRng(seed), nextThink: 0 };
    queue = [];
  };
  reset();
  return {
    kind: 'ai',
    deliver(text) {
      let snap;
      try {
        snap = JSON.parse(text);
      } catch {
        return;
      }
      if (snap?.t !== 'snap' || !snap.view) return;
      if (snap.round !== round) {
        round = snap.round;
        reset();
      }
      const ready = queue.filter((q) => q.due <= snap.tick);
      queue = queue.filter((q) => q.due > snap.tick);
      for (const q of ready) submit(q.cmd);
      const side = snap.view.ships?.[ship]?.side;
      const due = snap.tick + profile.reactionTicks;
      for (const cmd of think(snap, { ship, side }, mem, profile, content)) queue.push({ due, cmd });
    },
  };
}
