// @ts-check
// Effect payloads applied to a ship at a room (design doc 9.8). Effects never need the world, so the AI
// can apply them to cloned views.
// Doc choices: hullDamaged.n is the amount actually drained; ionized.n is the stack count after the hit
// (like systemDamaged.damage, a resulting total). A null room (e.g. a ship without shields) affects no
// system and no crew.

import { systemAt } from './geometry.js';
import { drainPool } from './pools.js';
import { addStatus } from './statuses.js';
import { crewInRoom } from './crew.js';

/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Ctx} Ctx */
/** @typedef {import('./types.js').Payload} Payload */
/** @typedef {(ship: Ship, room: string | null, n: number, ctx: Ctx) => void} Effect */

/** Fixed application (and future RNG) order. */
export const EFFECT_ORDER = ['hull', 'sysDamage', 'ion', 'crew'];

/** @type {Record<string, Effect>} */
export const EFFECTS = {
  hull: (ship, room, n, ctx) => {
    const drained = drainPool(ship, 'hull', n);
    ctx.emit({ type: 'hullDamaged', ship: ship.id, n: drained, hull: ship.pools.hull.v });
  },
  sysDamage: (ship, room, n, ctx) => {
    const type = systemAt(ctx.content, ship, room);
    if (!type) return;
    const sys = ship.systems[type];
    sys.damage = Math.min(sys.level, sys.damage + n);
    ctx.emit({ type: 'systemDamaged', ship: ship.id, system: type, damage: sys.damage });
  },
  ion: (ship, room, n, ctx) => {
    const type = systemAt(ctx.content, ship, room);
    if (!type) return;
    const st = addStatus(ship.systems[type], 'ion', n, ctx.content);
    ctx.emit({ type: 'ionized', ship: ship.id, system: type, n: st.n });
  },
  crew: (ship, room, n, ctx) => {
    for (const c of crewInRoom(ctx.content, ship, room)) {
      c.hp = Math.max(0, c.hp - n);
      ctx.emit({ type: 'crewHurt', ship: ship.id, crew: c.id, hp: c.hp });
    }
  },
};

/**
 * Apply every effect in the payload in EFFECT_ORDER (view-safe on clones).
 * @param {Ship} ship @param {string | null} room @param {Payload} payload @param {Ctx} ctx
 */
export function applyEffects(ship, room, payload, ctx) {
  for (const k of EFFECT_ORDER) if (payload[k]) EFFECTS[k](ship, room, payload[k], ctx);
}
