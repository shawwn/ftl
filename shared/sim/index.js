// @ts-check
// Public API of the simulation: every sim module's exports (design doc section 9).
// The typedefs below re-export types.js by name. JSDoc typedef aliases count as module exports, so many
// modules export the same names; a local declaration here resolves that `export *` ambiguity.

/** @typedef {import('./types.js').Meter} Meter */
/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Pool} Pool */
/** @typedef {import('./types.js').SystemState} SystemState */
/** @typedef {import('./types.js').Status} Status */
/** @typedef {import('./types.js').StatusHolder} StatusHolder */
/** @typedef {import('./types.js').Device} Device */
/** @typedef {import('./types.js').Target} Target */
/** @typedef {import('./types.js').Task} Task */
/** @typedef {import('./types.js').Crew} Crew */
/** @typedef {import('./types.js').Shot} Shot */
/** @typedef {import('./types.js').Stats} Stats */
/** @typedef {import('./types.js').Command} Command */
/** @typedef {import('./types.js').SimEvent} SimEvent */
/** @typedef {import('./types.js').Perspective} Perspective */
/** @typedef {import('./types.js').View} View */
/** @typedef {import('./types.js').Emit} Emit */
/** @typedef {import('./types.js').Ctx} Ctx */
/** @typedef {import('./types.js').CommandDef} CommandDef */
/** @typedef {import('./types.js').Room} Room */
/** @typedef {import('./types.js').Door} Door */
/** @typedef {import('./types.js').Geometry} Geometry */
/** @typedef {import('./types.js').Mods} Mods */
/** @typedef {import('./types.js').PowerTables} PowerTables */
/** @typedef {import('./types.js').PoolDef} PoolDef */
/** @typedef {import('./types.js').BaseContent} BaseContent */
/** @typedef {import('./types.js').SystemDef} SystemDef */
/** @typedef {import('./types.js').Payload} Payload */
/** @typedef {import('./types.js').DeviceBp} DeviceBp */
/** @typedef {import('./types.js').ShipBp} ShipBp */
/** @typedef {import('./types.js').AiProfile} AiProfile */
/** @typedef {import('./types.js').Content} Content */

export * from './time.js';
export * from './rng.js';
export * from './geometry.js';
export * from './world.js';
export * from './power.js';
export * from './stats.js';
export * from './pools.js';
export * from './statuses.js';
export * from './effects.js';
export * from './combat.js';
export * from './devices.js';
export * from './crew.js';
export * from './derive.js';
export * from './commands.js';
export * from './step.js';
export * from './view.js';
export * from './hash.js';
