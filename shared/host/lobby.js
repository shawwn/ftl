// @ts-check
// The Lobby (design doc 14.6): players, tokens, sessions, live matches and the clock that ticks them.
// Runs unchanged in Node and in the browser (?local).
// Doc choices: players are tracked here (login, seat, unseat), so "a player is in at most one match" has
// one home; `create` ignores its player argument (Session joins after creating); match codes are looked up
// case-insensitively; a match whose tick throws is reported through onError and disposed, so one broken
// match cannot stop the others; a disposed match sends `left { reason }` to its online humans.
// Lifetime rule: drop what has nothing to resume. A match whose last human member leaves is disposed at
// once ('empty'; idle TTL is for seats of disconnected humans), so one identity holds at most one live
// match; a player with no session and no match is forgotten (its token then simply starts a new player).
// Seed policy lives here: opts.seed is honored only when at most one side has human seats (vsAi, aiVsAi),
// since every roll is predictable from the seed; otherwise the seed is secret and each rematch draws a
// fresh one. list() shows only matches with no human seats (exhibitions to spectate): a code for a match
// with human seats is an invitation, shared out of band.

import { TICK_MS, fnv1a } from '../sim/index.js';
import { validateContent } from '../content/validate.js';
import { PRESETS, buildSpec } from './presets.js';
import { Match } from './match.js';
import { Session, newToken } from './session.js';

/** @typedef {import('../sim/types.js').Content} Content */
/** @typedef {import('../net/link.js').Link} Link */
/** @typedef {import('./clock.js').Clock} Clock */
/** @typedef {import('./presets.js').MatchSpec} MatchSpec */
/** @typedef {import('./presets.js').Preset} Preset */
/** @typedef {import('./match.js').Member} Member */
/**
 * @typedef {{ id: string, token: string, name: string, session: Session | null,
 *             match: Match | null, member: string | null }} Player
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;
const MAX_MATCHES = 500;

/** @returns {number} random u32 */
const randomU32 = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0];

export class Lobby {
  /**
   * @param {{ content: Content, clock: Clock, presets?: Record<string, Preset>,
   *           onError?: (err: unknown, match: Match | undefined) => void }} opts
   */
  constructor({ content, clock, presets = PRESETS, onError = (err) => console.error(err) }) {
    const errors = validateContent(content);
    if (errors.length) throw new Error(`invalid content:\n${errors.join('\n')}`);
    this.content = content;
    this.contentHash = fnv1a(JSON.stringify(content));
    this.clock = clock;
    this.presets = presets;
    this.onError = onError;
    /** @type {Map<string, Match>} */
    this.matches = new Map();
    /** @type {Map<string, number>} code -> clock time when its last human went offline */
    this.idleSince = new Map();
    /** @type {Map<string, Player>} by token */
    this.players = new Map();
    /** @type {Set<Session>} */
    this.sessions = new Set();
    this.nextPlayer = 1;
    this.stop = clock.every(TICK_MS, () => this.tickAll());
  }

  /** @param {Link} link @returns {Session} */
  connect(link) {
    const session = new Session(this, link);
    this.sessions.add(session);
    return session;
  }

  /**
   * @param {Player | null} player   unused: the Session joins the creator after creating
   * @param {unknown} preset @param {unknown} opts
   * @returns {Match | { error: string }}
   */
  create(player, preset, opts) {
    if (this.matches.size >= MAX_MATCHES) return { error: 'busy' };
    const spec = buildSpec(preset, opts, this.content, this.presets);
    if ('error' in spec) return spec;
    const humanSides = new Set(spec.ships.filter((s) => s.seats.max > 0).map((s) => s.side));
    const seed = humanSides.size <= 1 ? /** @type {any} */ (opts)?.seed : undefined;
    return seed === undefined ? this.createFromSpec(spec, randomU32(), () => randomU32()) : this.createFromSpec(spec, seed);
  }

  /**
   * Tools and tests only; not reachable from the protocol. Rematch seeds follow Match's public formula
   * unless `nextSeed` says otherwise.
   * @param {MatchSpec} spec @param {number} seed @param {(seed: number, round: number) => number} [nextSeed]
   */
  createFromSpec(spec, seed, nextSeed) {
    let code;
    do code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomU32() % CODE_ALPHABET.length]).join('');
    while (this.matches.has(code));
    const match = new Match({ code, spec, seed, content: this.content, nextSeed });
    this.matches.set(code, match);
    return match;
  }

  /** @param {unknown} code @returns {Match | undefined} */
  get(code) {
    return typeof code === 'string' ? this.matches.get(code.toUpperCase()) : undefined;
  }

  /** Lobby entries for live exhibitions: non-ended matches with no human seats (codes of others are invitations). */
  list() {
    return [...this.matches.values()]
      .filter((m) => m.phase !== 'ended' && m.spec.ships.every((s) => s.seats.max === 0))
      .map((m) => m.summary());
  }

  /** Tick every match; dispose idle ones. */
  tickAll() {
    const now = this.clock.now();
    for (const match of [...this.matches.values()]) {
      try {
        match.tick();
      } catch (err) {
        this.onError(err, match);
        this.dispose(match, 'error');
        continue;
      }
      if (match.humansOnline() > 0) this.idleSince.delete(match.code);
      else if (!this.idleSince.has(match.code)) this.idleSince.set(match.code, now);
      else if (now - this.idleSince.get(match.code) >= match.spec.rules.idleTtlMs) this.dispose(match, 'idle');
    }
  }

  /** Stop the clock, close sessions. */
  close() {
    this.stop();
    for (const s of [...this.sessions]) s.close();
  }

  // ---- players (used by Session) ----

  /** Resume the player holding `token`, or register a new one. @param {unknown} token @param {string} name */
  login(token, name) {
    const known = typeof token === 'string' ? this.players.get(token) : undefined;
    if (known) return known;
    /** @type {Player} */
    const player = { id: 'p' + this.nextPlayer++, token: newToken(), name, session: null, match: null, member: null };
    this.players.set(player.token, player);
    return player;
  }

  /**
   * Join `match`, leaving any other match only once the join succeeded.
   * @param {Player} player @param {Match} match @param {{ ship?: string, spectate?: boolean }} want
   * @returns {Member | { error: string }}
   */
  seat(player, match, want) {
    const member = match.join(player, want);
    if ('error' in member) return member;
    if (player.match !== match) this.unseat(player);
    player.match = match;
    player.member = member.id;
    return member;
  }

  /**
   * Leave the player's match. A match that a request leaves with no human member is disposed at once; a
   * disconnect (`chosen` false: a spectator's link closed) leaves that to the idle TTL, so a watcher whose
   * network blips can come back. The player's fields are cleared first, so a player moving to another
   * match is not told it `left`.
   * @param {Player} player @param {boolean} [chosen]
   */
  unseat(player, chosen = true) {
    const { match, member } = player;
    player.match = null;
    player.member = null;
    if (!match) return;
    match.leave(member);
    if (chosen && match.humans() === 0) this.dispose(match, 'empty');
  }

  /** Drop a player with nothing to resume (no session, no match). @param {Player} player */
  forgetPlayer(player) {
    if (!player.session && !player.match && this.players.get(player.token) === player) this.players.delete(player.token);
  }

  /** @param {Match} match @param {string} reason */
  dispose(match, reason) {
    this.matches.delete(match.code);
    this.idleSince.delete(match.code);
    for (const p of [...this.players.values()]) {
      if (p.match !== match) continue;
      p.match = null;
      p.member = null;
      if (p.session) p.session.send({ t: 'left', reason });
      else this.forgetPlayer(p);
    }
  }
}
