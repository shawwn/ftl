// @ts-check
// One Session per Link (design doc 14.5): the protocol handler and the human occupant. Every message is
// rate limited, parsed against MESSAGES, then dispatched through HANDLERS by its type.
// Doc choices: a second hello is bad-message; a resumed player keeps its original name; a request that
// fails parsing still gets `re` when its rid was readable; `leave` outside a match is a harmless ok; the
// token bucket reads the Lobby's clock, so tests control it; a replaced older session is closed and can no
// longer act for the player, and its close does not detach the new session.
// Error boundary: parsing and dispatch run inside one try/catch (as Lobby.tickAll does for match ticks), so
// no client message can throw out of the host; a throw is reported through lobby.onError and answered
// with error bad-message, and the connection stays open.
// On close, a spectator is unseated (it holds no seat, so it has nothing to reserve) and a player left
// with no match and no session is dropped from the Lobby; crew keep their seat and token.

import { ERROR_TEXT, LIMITS, PROTOCOL_VERSION, encode, parseClient } from '../net/protocol.js';
import { TICK_MS } from '../sim/index.js';

/** @typedef {import('../net/link.js').Link} Link */
/** @typedef {import('./match.js').Match} Match */
/** @typedef {import('./match.js').Member} Member */
/** @typedef {import('./lobby.js').Lobby} Lobby */
/** @typedef {import('./lobby.js').Player} Player */
/** @typedef {{ t: string } & Record<string, any>} Msg */

const MAX_DROPS = 200;
const TOKEN_BYTES = 16;

/** @type {Record<string, (s: Session, msg: Msg) => void>} */
const HANDLERS = {
  hello(s, msg) {
    if (s.player) return s.error(msg, 'bad-message');
    if (msg.v !== PROTOCOL_VERSION) {
      s.error(msg, 'upgrade-required');
      return s.close();
    }
    const player = s.lobby.login(msg.token, sanitizeName(msg.name));
    if (player.session && player.session !== s) player.session.replaced();
    player.session = s;
    s.player = player;
    s.send({ t: 'welcome', player: player.id, token: player.token, name: player.name, v: PROTOCOL_VERSION, content: s.lobby.contentHash });
    if (player.match) s.attach(player.match, player.match.members.get(player.member), undefined);
  },
  list(s, msg) {
    s.send({ t: 'lobby', re: msg.rid, matches: s.lobby.list() });
  },
  create(s, msg) {
    const match = s.lobby.create(s.player, msg.preset, msg.opts);
    if ('error' in match) return s.error(msg, match.error);
    s.enter(match, {}, msg.rid);
  },
  join(s, msg) {
    const match = s.lobby.get(msg.code);
    if (!match) return s.error(msg, 'no-match');
    s.enter(match, { ship: msg.ship, spectate: msg.spectate }, msg.rid);
  },
  leave(s, msg) {
    s.lobby.unseat(s.player);
    s.send({ t: 'ok', re: msg.rid });
  },
  cmd(s, msg) {
    const p = s.player;
    if (!p.match) return s.error(msg, 'not-in-match');
    p.match.submit(p.member, msg.rid, msg.c);
  },
  pause: (s, msg) => s.control(msg),
  rematch: (s, msg) => s.control(msg),
  ping(s, msg) {
    s.send({ t: 'pong', ct: msg.ct, tick: s.player.match?.world.tick ?? 0 });
  },
};

/** @param {unknown} name @returns {string} trimmed, no control characters, at most LIMITS.nameLen, default Captain */
export function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return Array.from(clean).slice(0, LIMITS.nameLen).join('').trim() || 'Captain';
}

/** @returns {string} 16 random bytes as hex */
export function newToken() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Session {
  /** @param {Lobby} lobby @param {Link} link */
  constructor(lobby, link) {
    /** @type {'human'} */
    this.kind = 'human';
    this.lobby = lobby;
    this.link = link;
    /** @type {Player | null} */
    this.player = null;
    this.tokens = LIMITS.burst;
    this.refilledAt = lobby.clock.now();
    this.drops = 0;
    link.onMessage((text) => this.receive(text));
    link.onClose(() => this.closed());
  }

  /** Occupant interface: snapshots and acks from the match. @param {string} text */
  deliver(text) {
    this.link.send(text);
  }

  /** @param {object} msg */
  send(msg) {
    this.link.send(encode(msg));
  }

  /** @param {Record<string, any>} req   the request, for its rid @param {string} code */
  error(req, code) {
    this.send({ t: 'error', ...(req.rid !== undefined ? { re: req.rid } : {}), code, msg: ERROR_TEXT[code] ?? code });
  }

  close() {
    this.link.close();
  }

  // ---- internals ----

  /** @param {string} text */
  receive(text) {
    if (!this.take()) {
      this.error({}, 'rate-limited');
      if (++this.drops >= MAX_DROPS) this.close();
      return;
    }
    /** @type {Msg | null} */
    let msg = null;
    try {
      const parsed = parseClient(text);
      if (!parsed.ok) return this.error({ rid: parsed.rid }, 'bad-message');
      msg = parsed.msg;
      if (!this.player && msg.t !== 'hello') return this.error(msg, 'hello-first');
      HANDLERS[msg.t](this, msg);
    } catch (err) {
      this.lobby.onError(err, this.player?.match ?? undefined);
      this.error(msg ?? {}, 'bad-message');
    }
  }

  /** Token bucket: LIMITS.ratePerSec refill, LIMITS.burst capacity. */
  take() {
    const now = this.lobby.clock.now();
    this.tokens = Math.min(LIMITS.burst, this.tokens + (now - this.refilledAt) * LIMITS.ratePerSec / 1000);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Join (or rejoin) a match, moving out of any other one, then attach and reply.
   * @param {Match} match @param {{ ship?: string, spectate?: boolean }} want @param {number} rid */
  enter(match, want, rid) {
    const member = this.lobby.seat(this.player, match, want);
    if ('error' in member) return this.error({ rid }, member.error);
    this.attach(match, member, rid);
  }

  /** @param {Match} match @param {Member} member @param {number | undefined} rid */
  attach(match, member, rid) {
    match.attach(member.id, this);
    this.send({
      t: 'joined', ...(rid !== undefined ? { re: rid } : {}), code: match.code, preset: match.spec.preset,
      you: { member: member.id, ship: member.ship, side: member.side, role: member.role, grants: member.grants },
      rules: { ...match.spec.rules, tickMs: TICK_MS }, round: match.round,
    });
    match.sendSnapshot(member.id);
  }

  /** A match action named by the message type; `on` is its argument when it has one. @param {Msg} msg */
  control(msg) {
    const p = this.player;
    if (!p.match) return this.error(msg, 'not-in-match');
    const why = p.match.control(p.member, msg.t, msg.on);
    if (why) this.error(msg, why);
    else this.send({ t: 'ok', re: msg.rid });
  }

  /** A newer session took over this player: stop acting for it, then close. */
  replaced() {
    this.player = null;
    this.close();
  }

  closed() {
    this.lobby.sessions.delete(this);
    const p = this.player;
    if (!p || p.session !== this) return;
    p.session = null;
    if (p.match?.members.get(p.member)?.role === 'spectator') this.lobby.unseat(p, false);
    else p.match?.detach(p.member);
    if (!p.match) this.lobby.forgetPlayer(p);
  }
}
