// @ts-check
// The wire protocol (design doc section 15): JSON text frames, each an object with type `t`. MESSAGES is
// the schema; one generic validator checks both directions against it.
// Doc choices: a parsed message keeps only `t` and its schema fields (unknown fields are dropped, which is
// how they are ignored); an optional field must be absent, not null. The maxBytes limit guards untrusted
// input, so it applies to parseClient only (snapshots grow with ship count and come from the trusted
// host). A failed parse also reports the request's `rid` when one is readable, so the reply can carry `re`.
// A cmd's `c` is rebuilt from COMMANDS[type].args with the same keep-only-schema-fields rule: a declared
// field is kept only when its value fits its shape (objects rebuilt field by field, arrays element by
// element), anything else is dropped. A dropped field reaches the sim as absent, so check still answers with
// its sim reason, and whatever a client sends, the host clones and logs only small, flat, known data.

import { COMMANDS, commandScope } from '../sim/commands.js';

export const PROTOCOL_VERSION = 1;
export const LIMITS = { maxBytes: 16384, nameLen: 24, ratePerSec: 30, burst: 60 };

/** @typedef {Record<string, string>} Shape   field -> 'int' | 'str' | 'bool' | 'obj' | 'arr', '?' suffix = optional */

/** @type {{ client: Record<string, Shape>, server: Record<string, Shape> }} */
export const MESSAGES = {
  client: {
    hello:   { v: 'int', token: 'str?', name: 'str?' },
    list:    { rid: 'int' },
    create:  { rid: 'int', preset: 'str', opts: 'obj?' },
    join:    { rid: 'int', code: 'str', ship: 'str?', spectate: 'bool?' },
    leave:   { rid: 'int' },
    cmd:     { rid: 'int', c: 'obj' },
    pause:   { rid: 'int', on: 'bool' },
    rematch: { rid: 'int' },
    ping:    { ct: 'int' },
  },
  server: {
    welcome: { player: 'str', token: 'str', name: 'str', v: 'int', content: 'str' },
    joined:  { re: 'int?', code: 'str', preset: 'str', you: 'obj', rules: 'obj', round: 'int' },
    snap:    { round: 'int', tick: 'int', phase: 'str', paused: 'bool', roster: 'arr', view: 'obj', ev: 'arr', seed: 'int?' },
    ack:     { re: 'int', ok: 'bool', tick: 'int', why: 'str?' },
    ok:      { re: 'int' },
    lobby:   { re: 'int', matches: 'arr' },
    error:   { re: 'int?', code: 'str', msg: 'str' },
    left:    { reason: 'str' },
    pong:    { ct: 'int', tick: 'int' },
  },
};

/**
 * Human text for every protocol error code (section 15.3): the server's `msg`, and the client's toast
 * (client/ui-state.js REASON_TEXT spreads it). Each fits the 64-character string limit.
 * @type {Record<string, string>}
 */
export const ERROR_TEXT = {
  'bad-message': 'The server did not understand that',
  'hello-first': 'Say hello first',
  'upgrade-required': 'This client is out of date. Reload to update.',
  'rate-limited': 'Too many messages at once. Slow down.',
  'bad-preset': 'Unknown match type',
  'bad-opts': 'Those match options are not valid',
  'busy': 'The server is full. Try again soon.',
  'no-match': 'No match with that code',
  'bad-ship': 'No such ship in that match',
  'seat-full': 'That ship has no free seats',
  'not-in-match': 'You are not in a match',
  'forbidden': 'You are not allowed to do that',
  'not-ended': 'The fight is not over yet',
};

const STR_MAX = 64;
const UNBOUNDED_STRINGS = new Set(['token']);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {Record<string, any>} o @param {string} k */
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

/** @type {Record<string, (v: unknown, field: string) => boolean>} */
const FIELD_TYPES = {
  int: (v) => Number.isSafeInteger(v),
  str: (v, field) => typeof v === 'string' && (v.length <= STR_MAX || UNBOUNDED_STRINGS.has(field)),
  bool: (v) => typeof v === 'boolean',
  obj: isPlainObject,
  arr: (v) => Array.isArray(v),
};

/**
 * `v` rebuilt to fit a command argument shape (types.js ArgShape), or undefined when it does not fit.
 * @param {unknown} v @param {import('../sim/types.js').ArgShape} shape @param {string} field
 * @returns {unknown}
 */
function fit(v, shape, field) {
  if (typeof shape === 'string') return FIELD_TYPES[shape](v, field) ? v : undefined;
  if (Array.isArray(shape)) {
    if (!Array.isArray(v)) return undefined;
    const out = v.map((x) => fit(x, /** @type {import('../sim/types.js').ArgShape} */ (shape[0]), field));
    return out.includes(undefined) ? undefined : out;
  }
  if (v === null) return null;
  if (!isPlainObject(v)) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, s] of Object.entries(shape)) {
    out[k] = fit(own(v, k), /** @type {import('../sim/types.js').ArgShape} */ (s), k);
    if (out[k] === undefined) return undefined;
  }
  return out;
}

/** A client command rebuilt from its type's declared args. @param {Record<string, any>} c @returns {{ type: string } & Record<string, unknown>} */
function canonicalCommand(c) {
  /** @type {{ type: string } & Record<string, unknown>} */
  const out = { type: c.type };
  for (const [k, shape] of Object.entries(COMMANDS[c.type].args)) {
    const v = fit(own(c, k), shape, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const encoder = new TextEncoder();

/** @param {string} text */
const tooLarge = (text) => text.length > LIMITS.maxBytes
  || (text.length * 3 > LIMITS.maxBytes && encoder.encode(text).length > LIMITS.maxBytes);

/**
 * { ok: true, msg } with msg the validated message, or { ok: false, code: 'bad-message', msg, rid? } with msg
 * a reason. One loose shape rather than a union: with strict off, TypeScript does not narrow on `ok`.
 * @typedef {{ ok: boolean, msg: any, code?: 'bad-message', rid?: number }} Parsed
 */

/** @param {string} msg @param {unknown} [raw] @returns {Parsed} */
function reject(msg, raw) {
  const rid = isPlainObject(raw) && Number.isSafeInteger(raw.rid) ? raw.rid : undefined;
  return rid === undefined ? { ok: false, code: 'bad-message', msg } : { ok: false, code: 'bad-message', msg, rid };
}

/**
 * @param {unknown} text @param {Record<string, Shape>} table @param {boolean} bounded
 * @returns {Parsed}
 */
function parse(text, table, bounded) {
  if (typeof text !== 'string') return reject('Messages must be text.');
  if (bounded && tooLarge(text)) return reject('Message too large.');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject('Message is not valid JSON.');
  }
  if (!isPlainObject(raw) || typeof raw.t !== 'string' || !Object.hasOwn(table, raw.t)) {
    return reject('Unknown message type.', raw);
  }
  /** @type {{ t: string } & Record<string, any>} */
  const msg = { t: raw.t };
  for (const [field, spec] of Object.entries(table[raw.t])) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const v = raw[field];
    if (v === undefined && optional) continue;
    if (!FIELD_TYPES[type](v, field)) return reject(`${raw.t}.${field} must be ${optional ? 'absent or ' : ''}${type}.`, raw);
    msg[field] = v;
  }
  if (msg.t === 'cmd') {
    if (commandScope(msg.c.type) === null) return reject('Unknown command type.', raw);
    msg.c = canonicalCommand(msg.c);
  }
  return { ok: true, msg };
}

/** @param {unknown} text @returns {Parsed} */
export function parseClient(text) {
  return parse(text, MESSAGES.client, true);
}

/** @param {unknown} text @returns {Parsed} */
export function parseServer(text) {
  return parse(text, MESSAGES.server, false);
}

/** @param {object} msg @returns {string} */
export function encode(msg) {
  return JSON.stringify(msg);
}
