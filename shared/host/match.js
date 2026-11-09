// @ts-check
// A match (design doc 14.4): spec, members, inbox, command log and broadcast around one World. Humans and
// AI are both members; both receive the identical snapshot string for their perspective and submit
// through the same authorization.
// Doc choices and fixes:
// - The log stores each command as the sim saw it (with `ship` stamped), so replay needs no member table.
// - A joiner with no ship preference fills ships below `seats.min` first, then any free seat; otherwise a
//   pvp friend joining by code would land on s1 as co-op crew and the duel would never start.
// - tick() still drains the inbox once ended (acking `ended`, which the doc's early return made
//   unreachable) and broadcasts roster changes, but applies and advances nothing.
// - Rematch is open to crew members, or to anyone when the spec has no human seats (aiVsAi).
// - Submitted commands are cloned, so the log is plain data nobody else holds.
// - The log keeps only commands the sim accepted (a rejected command changes nothing, so replay is the
//   same) and at most LOG_LIMIT entries per round; past that it stops recording and the record says
//   `truncated` (it can no longer reproduce the round).
// - pauseWhenEmpty counts online crew, not spectators: a stranger watching must not let the AI destroy a
//   ship whose crew is away. Idle disposal still counts every online human, so a watcher keeps it alive.
// - The rematch seed comes from `nextSeed(seed, round)`, host policy injected by the Lobby: the formula
//   below by default (deterministic, for tools and explicit seeds), fresh randomness for secret seeds.

import {
  createWorld, applyCommands, advance, project, projectEvent, perspectiveKey, commandScope, fnv1a,
} from '../sim/index.js';
import { encode } from '../net/protocol.js';
import { aiOccupant } from '../ai/occupant.js';

/** @typedef {import('../sim/types.js').World} World */
/** @typedef {import('../sim/types.js').Content} Content */
/** @typedef {import('../sim/types.js').Perspective} Perspective */
/** @typedef {import('../sim/types.js').SimEvent} SimEvent */
/** @typedef {import('./presets.js').MatchSpec} MatchSpec */
/** @typedef {import('./presets.js').SpecShip} SpecShip */

/** @typedef {{ kind: 'human' | 'ai', deliver(text: string): void }} Occupant */
/**
 * @typedef {{
 *   id: string, name: string, kind: 'human' | 'ai',
 *   player: string | null,
 *   ship: string | null, side: string | null,
 *   role: 'crew' | 'spectator',
 *   grants: string[],
 *   perspective: Perspective,
 *   occupant: Occupant | null
 * }} Member
 */
/** @typedef {{ id: string, name: string }} PlayerRef */
/** @typedef {{ member: Member, rid: number | null, cmd: any }} Queued */
/** @typedef {[number, string, object]} LogEntry   [tick, memberId, command as applied] */
/** @typedef {{ spec: MatchSpec, seed: number, log: LogEntry[], finalTick: number, truncated: boolean }} ReplayRecord */

/** Most log entries kept per round (a few MB of canonical commands). */
export const LOG_LIMIT = 20000;

/** The default rematch seed: a public function of the last seed, for tools and explicit seeds. @param {number} seed @param {number} round */
export const rematchSeed = (seed, round) => (seed + 0x9E3779B9 * round) >>> 0;

/** Match actions: protocol-level, never in the sim or the log. @type {Record<string, (m: Match, member: Member, arg: unknown) => string | null>} */
const CONTROLS = {
  pause(match, member, on) {
    const policy = match.spec.rules.pause;
    if (!(policy === 'any' || (policy === 'crew' && member.role === 'crew'))) return 'forbidden';
    match.manualPause = on === true;
    match.dirty = true;
    return null;
  },
  rematch(match, member) {
    if (match.phase !== 'ended') return 'not-ended';
    if (member.role !== 'crew' && match.spec.ships.some((s) => s.seats.max > 0)) return 'forbidden';
    match.restart();
    return null;
  },
};

export class Match {
  /**
   * @param {{ code: string, spec: MatchSpec, seed: number, content: Content,
   *           nextSeed?: (seed: number, round: number) => number }} opts
   */
  constructor({ code, spec, seed, content, nextSeed = rematchSeed }) {
    this.code = code;
    this.spec = spec;
    this.seed = seed;
    this.content = content;
    this.nextSeed = nextSeed;
    this.round = 1;
    /** @type {Map<string, Member>} */
    this.members = new Map();
    this.nextMember = 1;
    /** @type {Queued[]} */
    this.inbox = [];
    /** @type {SimEvent[]} */
    this.outbox = [];
    this.dirty = false;
    this.manualPause = false;
    /** @type {LogEntry[]} */
    this.log = [];
    this.truncated = false;
    /** @type {World} */
    this.world = createWorld({ seed, ships: spec.ships }, content);
    /** @type {'waiting' | 'running' | 'ended'} */
    this.phase = 'waiting';
    for (const s of spec.ships) {
      if (!s.ai) continue;
      const p = content.ai[s.ai];
      const member = this.addMember(`${p.persona} (${p.label})`, 'ai', null, s);
      member.occupant = this.aiFor(member);
    }
    this.updatePhase();
  }

  get paused() {
    return this.manualPause || (this.spec.rules.pauseWhenEmpty && this.humansOnline('crew') === 0);
  }

  /**
   * @param {PlayerRef} player @param {{ ship?: string, spectate?: boolean }} [want]
   * @returns {Member | { error: 'bad-ship' | 'seat-full' }}
   */
  join(player, want = {}) {
    const existing = [...this.members.values()].find((m) => m.player === player.id);
    if (existing) return existing;
    const seat = this.seatFor(want);
    if (seat && 'error' in seat) return seat;
    const member = this.addMember(player.name, 'human', player.id, /** @type {SpecShip | null} */ (seat));
    this.updatePhase();
    this.dirty = true;
    return member;
  }

  /** Sends nothing; the caller sends joined, then calls sendSnapshot. @param {string} memberId @param {Occupant} occupant */
  attach(memberId, occupant) {
    this.setOccupant(memberId, occupant);
  }

  /** The seat stays reserved. @param {string} memberId */
  detach(memberId) {
    this.setOccupant(memberId, null);
  }

  /** @param {string} memberId */
  leave(memberId) {
    const member = this.members.get(memberId);
    if (!member || member.kind !== 'human') return;
    this.members.delete(memberId);
    this.inbox = this.inbox.filter((q) => q.member !== member);
    this.dirty = true;
  }

  /** Queue for the next tick; rid is null for AI. @param {string} memberId @param {number | null} rid @param {unknown} cmd */
  submit(memberId, rid, cmd) {
    const member = this.members.get(memberId);
    if (member) this.inbox.push({ member, rid, cmd: structuredClone(cmd) });
  }

  /** @param {string} memberId @param {string} action @param {unknown} [arg] @returns {string | null} error code */
  control(memberId, action, arg) {
    const member = this.members.get(memberId);
    if (!member) return 'not-in-match';
    return Object.hasOwn(CONTROLS, action) ? CONTROLS[action](this, member, arg) : 'bad-message';
  }

  /** One fixed step. */
  tick() {
    this.updatePhase();
    /** @type {Queued[]} */
    const ok = [];
    for (const q of this.inbox.splice(0)) {
      const why = this.authorize(q.member, q.cmd);
      if (why) this.ack(q, why);
      else ok.push(q);
    }
    if (this.phase === 'ended') {
      if (this.dirty) this.broadcast();
      return;
    }
    const t = this.world.tick;
    const cmds = ok.map((q) => ({ ...q.cmd, ship: q.member.ship }));
    const applied = applyCommands(this.world, cmds, this.content);
    cmds.forEach((cmd, i) => { if (applied.results[i] === null) this.record([t, ok[i].member.id, cmd]); });
    this.outbox.push(...applied.events);
    const running = this.phase === 'running' && !this.paused;
    if (running) this.outbox.push(...advance(this.world, this.content));
    ok.forEach((q, i) => this.ack(q, applied.results[i]));   // after advance: ack.tick is post-tick
    if (this.world.outcome) this.phase = 'ended';
    const due = running ? this.world.tick % this.spec.rules.snapEvery === 0 : ok.length > 0 || this.dirty;
    if (due || this.phase === 'ended') this.broadcast();
  }

  /** Immediate snapshot to one member (join, reconnect). @param {string} memberId */
  sendSnapshot(memberId) {
    const member = this.members.get(memberId);
    member?.occupant?.deliver(this.snapText(member.perspective, []));
  }

  /** Online human members, or only those with `role`. @param {'crew' | 'spectator'} [role] */
  humansOnline(role) {
    return this.humans((m) => m.occupant !== null && (role === undefined || m.role === role));
  }

  /** Human members (online or not) for which pred holds. @param {(m: Member) => boolean} [pred] */
  humans(pred = () => true) {
    let n = 0;
    for (const m of this.members.values()) if (m.kind === 'human' && pred(m)) n++;
    return n;
  }

  /** Lobby entry. */
  summary() {
    let spectators = 0;
    for (const m of this.members.values()) if (m.role === 'spectator') spectators++;
    return {
      code: this.code, preset: this.spec.preset, name: this.spec.name, phase: this.phase,
      ships: this.spec.ships.map((s) => ({ id: s.id, bp: s.bp, side: s.side, open: s.seats.max - this.humansOn(s.id) })),
      spectators,
    };
  }

  /** @returns {ReplayRecord} */
  replayRecord() {
    return structuredClone({ spec: this.spec, seed: this.seed, log: this.log, finalTick: this.world.tick, truncated: this.truncated });
  }

  // ---- internals ----

  /** New seed and world, same members, AI occupants with fresh memory. */
  restart() {
    this.seed = this.nextSeed(this.seed, this.round);
    this.round += 1;
    this.world = createWorld({ seed: this.seed, ships: this.spec.ships }, this.content);
    this.log = [];
    this.truncated = false;
    this.inbox = [];
    this.outbox = [];
    this.manualPause = false;
    this.phase = 'waiting';
    this.updatePhase();
    for (const m of this.members.values()) if (m.kind === 'ai') m.occupant = this.aiFor(m);
    this.dirty = true;
  }

  /**
   * The ship a new human takes: the requested one; else the first ship below its minimum crew, then the first
   * with a free seat; else none (a spectator).
   * @param {{ ship?: string, spectate?: boolean }} want
   * @returns {SpecShip | null | { error: 'bad-ship' | 'seat-full' }}
   */
  seatFor(want) {
    if (want.spectate) return null;
    if (want.ship == null) {
      const below = (/** @type {(s: SpecShip) => number} */ need) => this.spec.ships.find((s) => this.humansOn(s.id) < need(s));
      return below((s) => s.seats.min) ?? below((s) => s.seats.max) ?? null;
    }
    const ship = this.spec.ships.find((s) => s.id === want.ship);
    if (!ship) return { error: 'bad-ship' };
    return this.humansOn(ship.id) < ship.seats.max ? ship : { error: 'seat-full' };
  }

  /** @param {string} name @param {'human' | 'ai'} kind @param {string | null} player @param {SpecShip | null} ship */
  addMember(name, kind, player, ship) {
    /** @type {Member} */
    const member = {
      id: 'm' + this.nextMember++, name, kind, player,
      ship: ship ? ship.id : null, side: ship ? ship.side : null,
      role: ship ? 'crew' : 'spectator',
      grants: ship ? ['*'] : [],
      perspective: ship ? { kind: 'side', side: ship.side } : { kind: 'all' },
      occupant: null,
    };
    this.members.set(member.id, member);
    return member;
  }

  /** @param {Member} member @returns {Occupant} */
  aiFor(member) {
    const s = this.spec.ships.find((x) => x.id === member.ship);
    return aiOccupant({
      profile: this.content.ai[s.ai],
      seed: parseInt(fnv1a(this.seed + ':' + member.id), 16),
      content: this.content,
      ship: s.id,
      submit: (cmd) => this.submit(member.id, null, cmd),
    });
  }

  /** @param {string} memberId @param {Occupant | null} occupant */
  setOccupant(memberId, occupant) {
    const member = this.members.get(memberId);
    if (!member) return;
    member.occupant = occupant;
    this.dirty = true;
  }

  /** @param {string} shipId */
  humansOn(shipId) {
    return this.humans((m) => m.ship === shipId);
  }

  /** @param {LogEntry} entry */
  record(entry) {
    if (this.log.length < LOG_LIMIT) this.log.push(entry);
    else this.truncated = true;
  }

  /** 'waiting' until every ship has its minimum of human members (online or not); never goes back. */
  updatePhase() {
    if (this.phase === 'waiting' && this.spec.ships.every((s) => this.humansOn(s.id) >= s.seats.min)) this.phase = 'running';
  }

  /** @param {Member} member @param {any} cmd @returns {string | null} */
  authorize(member, cmd) {
    if (member.role !== 'crew' || member.ship === null) return 'spectator';
    if (this.phase === 'ended') return 'ended';
    const scope = commandScope(cmd?.type);
    return member.grants.includes('*') || member.grants.includes(scope) ? null : 'forbidden';
  }

  /** @param {Queued} q @param {string | null} why */
  ack(q, why) {
    if (q.rid === null || !q.member.occupant) return;
    q.member.occupant.deliver(encode({ t: 'ack', re: q.rid, ok: !why, ...(why ? { why } : {}), tick: this.world.tick }));
  }

  /** One projection and one string per perspective key, delivered to every online member with that key. */
  broadcast() {
    const roster = this.roster();
    /** @type {Map<string, Member[]>} */
    const groups = new Map();
    for (const m of this.members.values()) {
      if (!m.occupant) continue;
      const key = perspectiveKey(m.perspective);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    for (const group of groups.values()) {
      const text = this.snapText(group[0].perspective, this.outbox, roster);
      for (const m of group) m.occupant?.deliver(text);
    }
    this.outbox = [];
    this.dirty = false;
  }

  roster() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, kind: m.kind, ship: m.ship, online: m.occupant !== null }));
  }

  /** @param {Perspective} perspective @param {SimEvent[]} events @param {object[]} [roster] @returns {string} */
  snapText(perspective, events, roster = this.roster()) {
    const ev = events.map((e) => projectEvent(e, perspective, this.world)).filter((e) => e !== null);
    return encode({
      t: 'snap', round: this.round, tick: this.world.tick, phase: this.phase, paused: this.paused, roster,
      view: project(this.world, perspective), ev, ...(this.phase === 'ended' ? { seed: this.seed } : {}),
    });
  }
}
