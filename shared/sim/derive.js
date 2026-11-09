// @ts-check
// Derive (design doc 9.12): makes a ship "settled" (power, crew tasks, stats, pool maxima consistent).
// deriveShip is view-safe: the AI calls it on cloned, redacted ships.

import { settlePower } from './power.js';
import { assignTasks } from './crew.js';
import { computeStats } from './stats.js';
import { updatePoolMaxima } from './pools.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').Ctx} Ctx */
/** @typedef {import('./types.js').Emit} Emit */

/** @param {Ship} ship @param {Content} content @param {Emit} [emit] */
export function deriveShip(ship, content, emit = () => {}) {
  settlePower(ship, content, emit);
  assignTasks(ship, content);
  ship.stats = computeStats(ship, content);
  updatePoolMaxima(ship, content);
}

/** deriveShip for every ship, in spawn order. @param {World} world @param {Ctx} ctx */
export function deriveAll(world, ctx) {
  for (const ship of Object.values(world.ships)) deriveShip(ship, ctx.content, ctx.emit);
}
