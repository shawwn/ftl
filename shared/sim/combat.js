// @ts-check
// Shots in flight and the hit pipeline (design doc 9.9): evasion roll -> shield check (pierce) ->
// onBlock or onHit payload. Weapon types differ only by data.

import { tickMeter } from './time.js';
import { roll } from './rng.js';
import { roomOfSystem } from './geometry.js';
import { drainPool } from './pools.js';
import { applyEffects } from './effects.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Shot} Shot */
/** @typedef {import('./types.js').Ctx} Ctx */

/**
 * Phase: every shot flies one tick; arrivals resolve in spawn order (each sees the shield left by the
 * previous one) and are then filtered out.
 * @param {World} world @param {Ctx} ctx
 */
export function tickShots(world, ctx) {
  const landed = new Set(world.shots.filter((shot) => tickMeter(shot.flight, 100)));
  for (const shot of landed) resolveHit(world, shot, ctx);
  if (landed.size) world.shots = world.shots.filter((shot) => !landed.has(shot));
}

/**
 * The room where a blocked shot's onBlock payload lands: the shields room (view-safe; the AI values
 * onBlock payloads with it, so the hit pipeline's rule lives here once).
 * @param {import('./types.js').Content} content @param {import('./types.js').Ship} ship
 */
export function blockRoom(content, ship) {
  return roomOfSystem(content, ship, 'shields');
}

/** @param {World} world @param {Shot} shot @param {Ctx} ctx */
export function resolveHit(world, shot, ctx) {
  const { content, emit } = ctx;
  const target = Object.hasOwn(world.ships, shot.to.ship) ? world.ships[shot.to.ship] : null;
  if (!target || target.out) {
    emit({ type: 'fizzled', shot: shot.id, ship: shot.to.ship });
    return;
  }
  const bp = content.devices[shot.bp];
  const about = { shot: shot.id, bp: shot.bp, from: shot.from.ship, ship: target.id };
  if (bp.canMiss && roll(world, target.stats.evasion - bp.accuracy)) {
    emit({ type: 'miss', ...about, room: shot.to.room });
    return;
  }
  if (target.pools.shield.v > bp.pierce) {
    drainPool(target, 'shield', 1);
    applyEffects(target, blockRoom(content, target), bp.onBlock, ctx);
    emit({ type: 'shieldHit', ...about });
    return;
  }
  applyEffects(target, shot.to.room, bp.onHit, ctx);
  emit({ type: 'hit', ...about, room: shot.to.room });
}
