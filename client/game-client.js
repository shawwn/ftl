// @ts-check
// (pure) The client side of the protocol (design doc 17.2): hello, requests with rids, commands with
// pending state, pings, and reconnect with backoff. DOM-free; it only needs a Connector, so it runs over
// a WebSocket, over an in-memory Link to an in-page Lobby, and in Node tests.
//
// Doc choices:
// - Extra constructor option `contentHash` (default CONTENT_HASH) for tests; extra members `preset`,
//   `round`, `rtt`, `welcome`, and `close()` (stops reconnecting and pings).
// - A 'snap' event's detail is { snap, fresh }, where fresh marks the first snap of a new match or round
//   (pending is cleared then; main.js clears FX and selection).
// - An `error` reply to a request rejects that request's promise; every other error (pushes, errors about
//   a cmd, which also leave pending) fires an 'error' event.
// - Requests made while offline reject at once with { code: 'disconnected' }; cmd() while offline is
//   dropped (absolute setters: a loss is visible and harmless).
// - Snaps that arrive while not in a match (after leave) are ignored.
// - Timers are unref'd when the runtime supports it, so a forgotten client never holds Node open.
// - Membership intent: `intent` is the match the client means to be in. It is set by every joined it
//   adopts and cleared (null) by leave() and forget(), at once, even offline. A fresh client has no intent
//   yet (undefined) and adopts the seat the server resumes after its first hello. On every welcome (the
//   first too: Menu may be pressed while still connecting), the client reasserts an intent it has with
//   one idempotent request and treats the reply as truth:
//   join(code) when it means a match (a surviving seat comes back unchanged; no-match means the match is
//   gone, so it forgets it and emits 'left' { reason: 'gone' }), else leave, which releases a seat the
//   server kept while the client was away. A pushed joined (no `re`) is ignored while the intent is null.
// - A rejected ack clears its pending entry at once: nothing changed, so no snapshot will confirm it (a
//   refinement of 17.2's "pending until the first snap after its ack").
// - Liveness: every received message stamps lastRecv. Pongs come every PING_MS even while paused, so a
//   link silent for three ping periods is dead (a half-open socket after a network change or sleep can
//   stay OPEN for minutes); ping() then closes it and reconnects.
// - Status: 'connecting' only for the very first attempt; every retry is 'reconnecting' (main.js words the
//   banner by whether a welcome ever arrived), so a server that is down at first load is reported.

import { PROTOCOL_VERSION, encode, parseServer } from '../shared/net/protocol.js';
import { CONTENT_HASH } from '../shared/content/index.js';

/** @typedef {import('../shared/net/link.js').Link} Link */
/** @typedef {() => Promise<Link>} Connector */
/** @typedef {{ get(): string | null, set(token: string): void }} TokenStore */
/** @typedef {'connecting' | 'online' | 'reconnecting' | 'outdated'} Status */
/** @typedef {{ t: string } & Record<string, any>} Msg */
/** @typedef {{ c: object, ackTick?: number }} Pending */

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const PING_MS = 2000;
const NAME_MAX = 24;

/** @param {() => void} fn @param {number} ms */
function later(fn, ms) {
  const t = globalThis.setTimeout(fn, ms);
  /** @type {any} */ (t)?.unref?.();
  return t;
}

/** @returns {TokenStore} */
function memoryTokens() {
  let token = null;
  return { get: () => token, set: (t) => { token = t; } };
}

export class GameClient extends EventTarget {
  /**
   * @param {Connector} connector
   * @param {{ name?: string, tokenStore?: TokenStore, now?: () => number, contentHash?: string }} [opts]
   */
  constructor(connector, { name, tokenStore = memoryTokens(), now = () => performance.now(), contentHash = CONTENT_HASH } = {}) {
    super();
    this.connector = connector;
    this.name = name ? String(name).slice(0, NAME_MAX) : undefined;
    this.tokenStore = tokenStore;
    this.now = now;
    this.contentHash = contentHash;
    /** @type {Status} */
    this.status = 'connecting';
    /** @type {Msg | null} */ this.welcome = null;
    /** @type {any} */ this.you = null;
    /** @type {any} */ this.rules = null;
    /** @type {string | null} */ this.code = null;
    /** @type {string | null} */ this.preset = null;
    /** @type {number | null} */ this.round = null;
    /** @type {Msg | null} */ this.snap = null;
    this.recvAt = 0;
    /** @type {Map<number, Pending>} */
    this.pending = new Map();
    /** @type {Msg | null} */ this.lastAck = null;
    /** @type {number | null} */ this.rtt = null;
    /** @type {Link | null} */ this.link = null;
    this.rid = 0;
    /** @type {Map<number, { resolve: (m: Msg) => void, reject: (e: { code: string, msg: string }) => void }>} */
    this.waiting = new Map();
    this.attempt = 0;
    this.closed = false;
    this.roundKey = null;
    /** @type {undefined | null | { code: string, spectate: boolean }} the match this client means to be in */
    this.intent = undefined;
    this.lastRecv = 0;
    /** @type {any} */ this.retryTimer = null;
    /** @type {any} */ this.pingTimer = null;
  }

  /** Connect and say hello. @returns {Promise<Msg>} resolves with the first welcome */
  start() {
    const welcomed = new Promise((resolve) => {
      this.addEventListener('welcome', (e) => resolve(/** @type {CustomEvent} */ (e).detail), { once: true });
    });
    this.open();
    return welcomed;
  }

  /** @param {Msg} msg @returns {Promise<Msg>} the reply; rejects with { code, msg } on error */
  request(msg) {
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      if (!this.link || this.status !== 'online') return reject({ code: 'disconnected', msg: 'Not connected.' });
      this.waiting.set(rid, { resolve, reject });
      this.send({ ...msg, rid });
    });
  }

  /** @param {string} preset @param {object} [opts] */
  create(preset, opts) {
    return this.request({ t: 'create', preset, ...(opts ? { opts } : {}) });
  }

  /** @param {string} code @param {{ ship?: string, spectate?: boolean }} [opts] */
  join(code, { ship, spectate } = {}) {
    return this.request({ t: 'join', code, ...(ship ? { ship } : {}), ...(spectate ? { spectate: true } : {}) });
  }

  list() {
    return this.request({ t: 'list' });
  }

  /** Leave the match: local state and intent clear at once (even offline); the server is told when online. */
  leave() {
    this.forget();
    return this.request({ t: 'leave' });
  }

  /** @param {boolean} on */
  pause(on) {
    return this.request({ t: 'pause', on });
  }

  rematch() {
    return this.request({ t: 'rematch' });
  }

  /**
   * Send a sim command. It stays in `pending` until its ack, then until the first snap after that ack.
   * @param {object} c @returns {number} rid
   */
  cmd(c) {
    const rid = ++this.rid;
    if (!this.link || this.status !== 'online') return rid;
    this.pending.set(rid, { c });
    this.send({ t: 'cmd', rid, c });
    return rid;
  }

  /** Stop for good: no reconnects, no pings. */
  close() {
    this.closed = true;
    globalThis.clearTimeout(this.retryTimer);
    globalThis.clearTimeout(this.pingTimer);
    this.link?.close();
  }

  // ---- internals ----

  /** @param {Status} status */
  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  /** @param {string} type @param {unknown} [detail] */
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** @param {object} msg */
  send(msg) {
    this.link?.send(encode(msg));
  }

  async open() {
    if (this.closed) return;
    /** @type {Link} */
    let link;
    try {
      link = await this.connector();
    } catch {
      return this.retry();
    }
    if (this.closed) return link.close();
    this.link = link;
    this.lastRecv = this.now();
    link.onMessage((text) => this.receive(text));
    link.onClose(() => this.lost(link));
    const token = this.tokenStore.get();
    this.send({ t: 'hello', v: PROTOCOL_VERSION, ...(token ? { token } : {}), ...(this.name ? { name: this.name } : {}) });
  }

  retry() {
    if (this.closed || this.status === 'outdated') return;
    this.setStatus('reconnecting');
    const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = later(() => this.open(), ms);
  }

  /** @param {Link} link */
  lost(link) {
    if (link !== this.link) return;
    this.link = null;
    globalThis.clearTimeout(this.pingTimer);
    this.pending.clear();
    for (const w of this.waiting.values()) w.reject({ code: 'disconnected', msg: 'Connection lost.' });
    this.waiting.clear();
    this.retry();
  }

  ping() {
    globalThis.clearTimeout(this.pingTimer);
    if (!this.link || this.status !== 'online') return;
    if (this.now() - this.lastRecv > 3 * PING_MS) {   // silent for three ping periods: the link is dead
      const link = this.link;
      link.close();
      this.lost(link);
      return;
    }
    this.send({ t: 'ping', ct: Math.round(this.now()) });
    this.pingTimer = later(() => this.ping(), PING_MS);
  }

  /** After a reconnect, make the server's membership match the intent with one idempotent request. */
  reassert() {
    const want = this.intent;
    if (want === undefined) return;
    if (want === null) {
      this.request({ t: 'leave' }).catch(() => {});
      return;
    }
    this.join(want.code, { spectate: want.spectate }).catch((err) => {
      if (err.code === 'disconnected' || this.intent !== want) return;
      this.forget();
      this.emit('left', { reason: err.code === 'no-match' ? 'gone' : err.code });
    });
  }

  /** Drop match state and the intent (after leave, or a 'left' push). */
  forget() {
    this.intent = null;
    this.you = null;
    this.rules = null;
    this.code = null;
    this.preset = null;
    this.round = null;
    this.snap = null;
    this.roundKey = null;
    this.pending.clear();
  }

  /** @param {string} text */
  receive(text) {
    this.lastRecv = this.now();
    const parsed = parseServer(text);
    if (!parsed.ok) return this.emit('error', { code: 'bad-message', msg: parsed.msg });
    const { msg } = parsed;
    RECEIVE[msg.t]?.(this, msg);
    const w = msg.re !== undefined ? this.waiting.get(msg.re) : undefined;
    if (!w) return;
    this.waiting.delete(msg.re);
    if (msg.t === 'error') w.reject({ code: msg.code, msg: msg.msg });
    else w.resolve(msg);
  }
}

/** Per-message state updates; replies are settled afterwards by `receive`. */
/** @type {Record<string, (cl: GameClient, msg: Msg) => void>} */
const RECEIVE = {
  welcome(cl, msg) {
    cl.welcome = msg;
    cl.attempt = 0;
    cl.tokenStore.set(msg.token);
    if (msg.content !== cl.contentHash) {
      cl.setStatus('outdated');
      cl.link?.close();
    } else {
      cl.setStatus('online');
      cl.ping();
      cl.reassert();
    }
    cl.emit('welcome', msg);
  },
  joined(cl, msg) {
    if (msg.re === undefined && cl.intent === null) return;   // a kept seat this client left; reassert releases it
    cl.intent = { code: msg.code, spectate: msg.you.role === 'spectator' };
    cl.you = msg.you;
    cl.rules = msg.rules;
    cl.code = msg.code;
    cl.preset = msg.preset;
    cl.round = msg.round;
    cl.emit('joined', msg);
  },
  snap(cl, msg) {
    if (cl.code === null) return;   // outside a membership (for example just after leave)
    const key = cl.code + ':' + msg.round;
    const fresh = key !== cl.roundKey;
    cl.roundKey = key;
    cl.round = msg.round;
    if (fresh) cl.pending.clear();
    for (const [rid, p] of cl.pending) if (p.ackTick !== undefined) cl.pending.delete(rid);
    cl.snap = msg;
    cl.recvAt = cl.now();
    cl.emit('snap', { snap: msg, fresh });
  },
  ack(cl, msg) {
    const p = cl.pending.get(msg.re);
    if (!msg.ok) cl.pending.delete(msg.re);   // nothing changed, so no snapshot will confirm it
    else if (p) p.ackTick = msg.tick;
    cl.lastAck = msg;
    cl.emit('ack', { ...msg, c: p?.c ?? null });
  },
  error(cl, msg) {
    cl.pending.delete(msg.re);
    if (msg.code === 'upgrade-required') cl.setStatus('outdated');
    if (!cl.waiting.has(msg.re)) cl.emit('error', msg);
  },
  left(cl, msg) {
    cl.forget();
    cl.emit('left', msg);
  },
  pong(cl, msg) {
    cl.rtt = cl.now() - msg.ct;
  },
};
