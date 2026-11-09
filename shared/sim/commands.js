// @ts-check
// The one command vocabulary (design doc section 11). Commands are absolute, idempotent setters.
// check is pure (the UI imports it to gray out controls; it works on views); apply mutates only its own
// ship. Every command, accepted or not, ends with deriveShip of its ship, so each command leaves the world
// settled and a batch boundary carries no information: one merged batch equals several small ones (replay).
// Doc choices: a non-string `system` is 'no-system' and a non-string `room` is 'no-room'; a missing
// (undefined) setTarget target is 'bad-arg' (only an explicit null clears).
// `args` declares each command's argument shapes (types.js ArgShape). The protocol rebuilds a client's
// command from them, keeping only declared fields whose values fit, so a command that reaches the host is
// small, flat, known data; a field that does not fit is dropped and check still answers with its reason.

import { capacity, freeReactor, takesWant } from './power.js';
import { fireBlock } from './devices.js';
import { planMove } from './crew.js';
import { geometry } from './geometry.js';
import { deriveAll, deriveShip } from './derive.js';

/** @typedef {import('./types.js').World} World */
/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').Command} Command */
/** @typedef {import('./types.js').CommandDef} CommandDef */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').SimEvent} SimEvent */

/** @param {Ship} ship @param {unknown} id */
const deviceOf = (ship, id) => ship.devices.find((d) => d.id === id) ?? null;
/** @param {unknown} v */
const isBool = (v) => typeof v === 'boolean';

/** @type {CommandDef} */
const setPower = {
  scope: 'power',
  args: { system: 'str', level: 'int' },
  check(world, ship, cmd, content) {
    if (typeof cmd.system !== 'string' || !Object.hasOwn(ship.systems, cmd.system)) return 'no-system';
    const def = content.systems[cmd.system];
    if (!takesWant(def)) return 'not-powerable';
    const { level } = cmd;
    if (!Number.isInteger(level) || level < 0 || level > ship.systems[cmd.system].level) return 'bad-level';
    return null;
  },
  apply(world, ship, cmd, ctx) {
    const sys = ship.systems[cmd.system];
    const cap = capacity(sys);
    const granted = Math.min(cmd.level, cap, sys.power + freeReactor(ship, ctx.content));
    if (cmd.level > sys.power && granted === sys.power) return cap <= sys.power ? 'damaged' : 'no-reactor';
    sys.want = granted;
    return null;
  },
};

/** @type {CommandDef} */
const setDevicePower = {
  scope: 'weapons',
  args: { device: 'str', on: 'bool' },
  check(world, ship, cmd) {
    if (!deviceOf(ship, cmd.device)) return 'no-device';
    return isBool(cmd.on) ? null : 'bad-arg';
  },
  apply(world, ship, cmd, ctx) {
    const dev = deviceOf(ship, cmd.device);
    if (cmd.on && dev.on) return null;
    if (cmd.on) {
      const host = ship.systems[dev.host];
      const p = ctx.content.devices[dev.bp].power;
      if (host.power + p > capacity(host)) return 'no-capacity';
      if (p > freeReactor(ship, ctx.content)) return 'no-reactor';
    }
    dev.on = cmd.on;
    return null;
  },
};

/** @type {CommandDef} */
const setTarget = {
  scope: 'weapons',
  args: { device: 'str', target: { ship: 'str', room: 'str' } },
  check(world, ship, cmd, content) {
    const dev = deviceOf(ship, cmd.device);
    if (!dev) return 'no-device';
    const t = cmd.target;
    if (t === null) return null;
    if (!t || typeof t !== 'object' || typeof t.ship !== 'string' || typeof t.room !== 'string') return 'bad-arg';
    return fireBlock(world, ship, content.devices[dev.bp], t, content);
  },
  apply(world, ship, cmd) {
    const t = cmd.target;
    deviceOf(ship, cmd.device).target = t ? { ship: t.ship, room: t.room } : null;
    return null;
  },
};

/** @type {CommandDef} */
const setAuto = {
  scope: 'weapons',
  args: { device: 'str', on: 'bool' },
  check(world, ship, cmd) {
    if (!deviceOf(ship, cmd.device)) return 'no-device';
    return isBool(cmd.on) ? null : 'bad-arg';
  },
  apply(world, ship, cmd) {
    deviceOf(ship, cmd.device).auto = cmd.on;
    return null;
  },
};

/** @type {CommandDef} */
const moveCrew = {
  scope: 'crew',
  args: { crew: ['str'], room: 'str' },
  check(world, ship, cmd, content) {
    const ids = cmd.crew;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16 || !ids.every((id) => typeof id === 'string')) return 'bad-arg';
    if (!ids.every((id) => ship.crew.some((c) => c.id === id))) return 'no-crew';
    if (typeof cmd.room !== 'string' || !Object.hasOwn(geometry(content, ship.bp).rooms, cmd.room)) return 'no-room';
    return null;
  },
  apply(world, ship, cmd, ctx) {
    return planMove(ship, cmd.crew, cmd.room, ctx.content) === 0 ? 'room-full' : null;
  },
};

/** @type {Record<string, CommandDef>} */
export const COMMANDS = { setPower, setDevicePower, setTarget, setAuto, moveCrew };

/** @param {unknown} type @returns {string | null} scope, or null for unknown types */
export function commandScope(type) {
  return typeof type === 'string' && Object.hasOwn(COMMANDS, type) ? COMMANDS[type].scope : null;
}

/**
 * Apply a batch in order (each command ends with a derive of its ship), then deriveAll, which settles a
 * world that was edited by hand. results[i] is the reason command i was rejected, or null.
 * @param {World} world @param {Command[]} cmds @param {Content} content
 * @returns {{ results: (string | null)[], events: SimEvent[] }}
 */
export function applyCommands(world, cmds, content) {
  /** @type {SimEvent[]} */
  const events = [];
  const ctx = { content, emit: (e) => events.push({ tick: world.tick, ...e }) };
  const results = cmds.map((cmd) => applyOne(world, cmd, ctx));
  deriveAll(world, ctx);
  return { results, events };
}

/** @param {World} world @param {Command} cmd @param {import('./types.js').Ctx} ctx */
function applyOne(world, cmd, ctx) {
  if (!cmd || typeof cmd !== 'object' || commandScope(cmd.type) === null) return 'unknown-command';
  if (typeof cmd.ship !== 'string' || !Object.hasOwn(world.ships, cmd.ship)) return 'no-ship';
  const ship = world.ships[cmd.ship];
  if (ship.out) return 'ship-out';
  const def = COMMANDS[cmd.type];
  const why = def.check(world, ship, cmd, ctx.content) ?? def.apply(world, ship, cmd, ctx);
  deriveShip(ship, ctx.content, ctx.emit);
  return why;
}
