// @ts-check
// Perspective projection (design doc 9.14): the only way state leaves the host. A view has the world's
// shape, so every view-safe helper works on it.
// Doc choice: redaction fails closed: any perspective other than { kind: 'all' } redacts every ship not
// on perspective.side.

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').View} View */
/** @typedef {import('./types.js').Perspective} Perspective */
/** @typedef {import('./types.js').SimEvent} SimEvent */

/** @param {Perspective} p @returns {string} 'all' or 'side:<side>' */
export function perspectiveKey(p) {
  return p.kind === 'all' ? 'all' : 'side:' + p.side;
}

/**
 * Deep copy without seed and rng; enemy intent (want, on, target, auto) removed for side perspectives.
 * Enemy crew, power, charge, stats and damage stay visible (the M1 baseline "sensors").
 * @param {World} world @param {Perspective} perspective
 * @returns {View}
 */
export function project(world, perspective) {
  const view = structuredClone(world);
  delete view.seed;
  delete view.rng;
  if (perspective.kind === 'all') return view;
  const side = perspective.kind === 'side' ? perspective.side : null;
  for (const ship of Object.values(view.ships)) {
    if (ship.side === side) continue;
    for (const sys of Object.values(ship.systems)) delete sys.want;
    for (const dev of ship.devices) {
      delete dev.on;
      delete dev.target;
      delete dev.auto;
    }
  }
  return view;
}

/**
 * The seam for fog of war; identity in M1.
 * @param {SimEvent} event @param {Perspective} perspective @param {World} world
 * @returns {SimEvent | null}
 */
export function projectEvent(event, perspective, world) {
  return event;
}
