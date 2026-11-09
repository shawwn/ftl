// @ts-check
// Devices: powered, charging, targetable things hosted by a system (design doc 9.10). Firing is "set a
// target on a charged device"; a charged device with no target simply stays charged.

import { isFull, meter, tickMeter } from './time.js';
import { geometry } from './geometry.js';
import { newId } from './world.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Device} Device */
/** @typedef {import('./types.js').DeviceBp} DeviceBp */
/** @typedef {import('./types.js').Target} Target */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').Ctx} Ctx */

/** @type {Record<string, { launch: (world: World, ship: Ship, dev: Device, bp: DeviceBp, ctx: Ctx) => void }>} */
export const DELIVERIES = {
  projectile: {
    launch(world, ship, dev, bp, ctx) {
      const shots = [];
      for (let i = 0; i < bp.shots; i++) {
        const id = newId(world, 'p');
        // `0 - x` rather than `-x`, so the first shot starts at +0, never -0. Born at the rate tickShots
        // applies, so a client extrapolates its flight before its first tick.
        const flight = meter(bp.travelMs, 0 - i * bp.gapMs * 100, 100);
        world.shots.push({ id, bp: dev.bp, from: { ship: ship.id, device: dev.id }, to: { ship: dev.target.ship, room: dev.target.room }, flight });
        shots.push(id);
      }
      ctx.emit({ type: 'fired', ship: ship.id, device: dev.id, bp: dev.bp, shots });
    },
  },
};

/**
 * Target legality for bp.target 'enemyRoom' (the only kind in M1) (view-safe).
 * @param {World} world @param {Ship} ship @param {DeviceBp} bp @param {Target | null | undefined} target @param {Content} content
 * @returns {string | null} reason, or null when valid
 */
export function validTarget(world, ship, bp, target, content) {
  if (!target) return 'no-target';
  if (!Object.hasOwn(world.ships, target.ship)) return 'no-ship';
  const foe = world.ships[target.ship];
  if (foe.side === ship.side) return 'friendly';
  if (foe.out) return 'ship-out';
  if (!Object.hasOwn(geometry(content, foe.bp).rooms, target.room)) return 'no-room';
  return null;
}

/** Every store covers its cost (view-safe). @param {Ship} ship @param {Record<string, number>} cost */
export function canPay(ship, cost) {
  return Object.entries(cost).every(([k, n]) => (ship.stores[k] ?? 0) >= n);
}

/**
 * The one rule for whether a charged device fires at `target` (view-safe): null when it would fire, else the
 * first failing condition (a validTarget reason, or 'no-ammo'). tickDevices, setTarget.check and the HUD
 * all ask this, so nothing restates it.
 * @param {World} world @param {Ship} ship @param {DeviceBp} bp @param {Target | null | undefined} target @param {Content} content
 * @returns {string | null}
 */
export function fireBlock(world, ship, bp, target, content) {
  return validTarget(world, ship, bp, target, content) ?? (canPay(ship, bp.cost) ? null : 'no-ammo');
}

/**
 * Phase body for one living ship: charge (or drain when unpowered), then fire if full and fireBlock allows.
 * @param {World} world @param {Ship} ship @param {Ctx} ctx
 */
export function tickDevices(world, ship, ctx) {
  const { content } = ctx;
  for (const dev of ship.devices) {
    const bp = content.devices[dev.bp];
    tickMeter(dev.charge, dev.powered ? ship.stats.chargePct : 0 - content.base.drainPct);
    if (!isFull(dev.charge) || fireBlock(world, ship, bp, dev.target, content)) continue;
    for (const [k, n] of Object.entries(bp.cost)) if (n) ship.stores[k] -= n;
    dev.charge.v = 0;   // a restart: the rate stays, so the charge bar keeps moving on screen
    DELIVERIES[bp.delivery].launch(world, ship, dev, bp, ctx);
    if (!dev.auto) dev.target = null;
  }
}
