// @ts-check
// Host tests, headless (design doc 19.3): presets, Match rules (join, authorization, pause, phases,
// rematch, broadcast, acks), Lobby (codes, idle disposal, isolation) and Session over memory links, all
// driven by manualClock. Clocks are covered at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT, CONTENT_HASH } from '../shared/content/index.js';
import { PRESETS, buildSpec } from '../shared/host/presets.js';
import { Lobby } from '../shared/host/lobby.js';
import { manualClock, realClock } from '../shared/host/clock.js';
import { memoryLinkPair } from '../shared/net/link.js';
import { ERROR_TEXT, LIMITS, encode, parseServer } from '../shared/net/protocol.js';
import { LOG_LIMIT } from '../shared/host/match.js';
import { TICK_MS } from '../shared/sim/index.js';

/** @typedef {import('../shared/host/match.js').Match} Match */
/** @typedef {import('../shared/host/match.js').Member} Member */

/** buildSpec that throws on error. @param {string} preset @param {object} [opts] @returns {import('../shared/host/presets.js').MatchSpec} */
function specOf(preset, opts = {}) {
  const spec = buildSpec(preset, opts, CONTENT);
  if ('error' in spec) throw new Error(spec.error);
  return spec;
}

const lobbyOf = (opts = {}) => new Lobby({ content: CONTENT, clock: manualClock(), ...opts });

/** @param {Lobby} lobby @param {string} preset @param {object} [opts] @returns {Match} */
function create(lobby, preset, opts = {}) {
  const m = lobby.create(null, preset, { seed: 5, ...opts });
  if ('error' in m) throw new Error(m.error);
  return m;
}

/** A recording human occupant. */
function human() {
  /** @type {string[]} */
  const texts = [];
  return { kind: /** @type {'human'} */ ('human'), texts, deliver: (t) => texts.push(t), msgs: () => texts.map((t) => JSON.parse(t)) };
}

/** Join and attach a recording occupant. @param {Match} match @param {string} id @param {object} [want] */
function seat(match, id, want = {}) {
  const member = match.join({ id, name: id }, want);
  if ('error' in member) throw new Error(member.error);
  const occ = human();
  match.attach(member.id, occ);
  return { member, occ };
}

/** @param {Match} match @param {number} [n] */
const ticks = (match, n = 1) => { for (let i = 0; i < n; i++) match.tick(); };

/** End a match by emptying the foe's hull (test-only world surgery). @param {Match} match */
function finish(match, loser = 's2') {
  match.manualPause = false;
  match.world.ships[loser].pools.hull.v = 0;
  ticks(match);
  assert.equal(match.phase, 'ended');
}

// ---- presets ----

test('presets build the specs of the 14.2 table', () => {
  const vsAi = buildSpec('vsAi', {}, CONTENT);
  assert.deepEqual(vsAi, {
    preset: 'vsAi', name: 'Skirmish',
    rules: { pause: 'crew', pauseWhenEmpty: true, snapEvery: 2, idleTtlMs: 600000 },
    ships: [
      { id: 's1', bp: 'candlewick', side: 'blue', seats: { min: 1, max: 4 }, ai: null },
      { id: 's2', bp: 'lampblack', side: 'red', seats: { min: 0, max: 0 }, ai: 'captain' },
    ],
  });
  const ai = specOf('aiVsAi', { aiB: 'drifter' });
  assert.deepEqual(ai.rules, { pause: 'any', pauseWhenEmpty: false, snapEvery: 2, idleTtlMs: 120000 });
  assert.deepEqual(ai.ships.map((s) => [s.id, s.side, s.seats.max, s.ai]), [['s1', 'blue', 0, 'captain'], ['s2', 'red', 0, 'drifter']]);
  const pvp = specOf('pvp', { a: 'lampblack' });
  assert.deepEqual(pvp.rules, { pause: 'none', pauseWhenEmpty: false, snapEvery: 2, idleTtlMs: 600000 });
  assert.deepEqual(pvp.ships.map((s) => [s.bp, s.seats, s.ai]), [['lampblack', { min: 1, max: 3 }, null], ['lampblack', { min: 1, max: 3 }, null]]);
  assert.deepEqual(Object.keys(PRESETS), ['vsAi', 'aiVsAi', 'pvp']);
});

test('buildSpec rejects unknown presets and invalid opts', () => {
  assert.deepEqual(buildSpec('coop', {}, CONTENT), { error: 'bad-preset' });
  assert.deepEqual(buildSpec('toString', {}, CONTENT), { error: 'bad-preset' });
  assert.deepEqual(buildSpec(7, {}, CONTENT), { error: 'bad-preset' });
  for (const opts of [{ ship: 'nope' }, { foe: 7 }, { ai: 'genius' }, { ai: null }, { ai: 'constructor' },
    { seed: -1 }, { seed: 1.5 }, { seed: '3' }, [], 'x']) {
    assert.deepEqual(buildSpec('vsAi', opts, CONTENT), { error: 'bad-opts' }, JSON.stringify(opts));
  }
  assert.ok(!('error' in buildSpec('vsAi', { seed: 0, extra: 'ignored' }, CONTENT)));
  assert.ok(!('error' in buildSpec('vsAi', undefined, CONTENT)));
});

// ---- Match: members and join rules ----

test('AI members come first, with their side, all grants and the persona name', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'captain' });
  const ai = match.members.get('m1');
  assert.equal(ai.kind, 'ai');
  assert.equal(ai.name, 'Gloam (Captain)');
  assert.deepEqual([ai.ship, ai.side, ai.role, ai.player], ['s2', 'red', 'crew', null]);
  assert.deepEqual(ai.grants, ['*']);
  assert.deepEqual(ai.perspective, { kind: 'side', side: 'red' });
  assert.equal(ai.occupant?.kind, 'ai');
  const { member } = seat(match, 'p1');
  assert.equal(member.id, 'm2');
});

test('join rules: same player, requested ship, seat-full, bad-ship, spectate, overflow to spectator', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const a = seat(match, 'p1').member;
  assert.deepEqual([a.ship, a.side, a.role], ['s1', 'blue', 'crew']);
  assert.deepEqual(a.grants, ['*']);
  assert.equal(match.join({ id: 'p1', name: 'p1' }, { spectate: true }), a, 'the same player gets the existing member back');
  assert.deepEqual(match.join({ id: 'p2', name: 'p2' }, { ship: 's2' }), { error: 'seat-full' });
  assert.deepEqual(match.join({ id: 'p2', name: 'p2' }, { ship: 's9' }), { error: 'bad-ship' });
  const spec = seat(match, 'p2', { spectate: true }).member;
  assert.deepEqual([spec.ship, spec.side, spec.role, spec.grants], [null, null, 'spectator', []]);
  assert.deepEqual(spec.perspective, { kind: 'all' });
  for (const id of ['p3', 'p4', 'p5']) assert.equal(seat(match, id).member.ship, 's1');
  assert.deepEqual(match.join({ id: 'p6', name: 'p6' }, { ship: 's1' }), { error: 'seat-full' });
  assert.equal(seat(match, 'p6').member.role, 'spectator', 'no free seat and no request: spectator');
  assert.deepEqual(match.summary().ships.map((s) => s.open), [0, 0]);
  assert.equal(match.summary().spectators, 2);
});

test('pvp waits until both ships have crew; a joiner without a preference fills the empty ship', () => {
  const match = create(lobbyOf(), 'pvp');
  assert.equal(match.phase, 'waiting');
  const a = seat(match, 'p1');
  assert.equal(a.member.ship, 's1');
  match.submit(a.member.id, 1, { type: 'setPower', system: 'engines', level: 1 });
  ticks(match, 3);
  assert.equal(match.world.tick, 0, 'time does not advance while waiting');
  assert.equal(match.world.ships.s1.systems.engines.power, 1, 'but commands apply');
  assert.deepEqual(a.occ.msgs().find((m) => m.t === 'ack'), { t: 'ack', re: 1, ok: true, tick: 0 });
  const b = seat(match, 'p2');
  assert.equal(b.member.ship, 's2');
  assert.equal(match.phase, 'running');
  ticks(match, 4);
  assert.equal(match.world.tick, 4);
});

// ---- authorization ----

test('authorization: spectator, forbidden scope, ended; the host stamps the ship', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const crew = seat(match, 'p1');
  const watcher = seat(match, 'p2', { spectate: true });
  match.submit(watcher.member.id, 1, { type: 'setPower', system: 'engines', level: 1 });
  crew.member.grants = ['crew'];   // a narrowed grant (later: a `grant` match action)
  match.submit(crew.member.id, 2, { type: 'setPower', system: 'engines', level: 1 });
  match.submit(crew.member.id, 3, { type: 'moveCrew', crew: ['c3'], room: 'S' });
  crew.member.grants = ['*'];
  ticks(match);
  const ack = (occ, re) => occ.msgs().find((m) => m.t === 'ack' && m.re === re);
  assert.equal(ack(watcher.occ, 1).why, 'spectator');
  assert.equal(ack(crew.occ, 2).why, undefined, 'grants are read at tick time');
  crew.member.grants = ['crew'];
  match.submit(crew.member.id, 4, { type: 'setPower', system: 'engines', level: 3 });
  match.submit(crew.member.id, 5, { type: 'moveCrew', crew: ['c3'], room: 'S' });
  match.submit(crew.member.id, 6, { type: 'setPower', ship: 's2', system: 'engines', level: 0 });
  ticks(match);
  assert.equal(ack(crew.occ, 4).why, 'forbidden');
  assert.equal(ack(crew.occ, 5).ok, true);
  assert.equal(ack(crew.occ, 6).why, 'forbidden');
  crew.member.grants = ['*'];
  match.submit(crew.member.id, 7, { type: 'setPower', ship: 's2', system: 'engines', level: 0 });
  ticks(match);
  assert.equal(ack(crew.occ, 7).ok, true);
  assert.equal(match.world.ships.s2.systems.engines.want, 2, 'a client can never name the acting ship');
  assert.equal(match.world.ships.s1.systems.engines.want, 0);
  assert.deepEqual(match.log.map(([, who, c]) => [who, c.type, c.ship]),
    [['m2', 'setPower', 's1'], ['m2', 'moveCrew', 's1'], ['m2', 'moveCrew', 's1'], ['m2', 'setPower', 's1']],
    'only authorized commands are logged, stamped');
  finish(match);
  match.submit(crew.member.id, 8, { type: 'setPower', system: 'engines', level: 1 });
  ticks(match);
  assert.equal(ack(crew.occ, 8).why, 'ended');
});

test('sim rejections are acked with their reason and not logged; accepted commands are (host-6)', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member, occ } = seat(match, 'p1');
  match.submit(member.id, 1, { type: 'setPower', system: 'nope', level: 1 });
  match.submit(member.id, 2, { type: 'warp' });
  match.submit(member.id, 3, { type: 'setAuto', device: 'w1', on: true });
  ticks(match);
  const acks = occ.msgs().filter((m) => m.t === 'ack');
  assert.deepEqual(acks.map((a) => [a.re, a.ok, a.why]), [[1, false, 'no-system'], [2, false, 'unknown-command'], [3, true, undefined]]);
  assert.deepEqual(match.log, [[0, member.id, { type: 'setAuto', device: 'w1', on: true, ship: 's1' }]]);
});

test('the log stops at LOG_LIMIT entries per round and the record says it is truncated (host-6)', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member } = seat(match, 'p1');
  match.control(member.id, 'pause', true);
  match.log.length = LOG_LIMIT - 1;
  match.log.fill([0, member.id, { type: 'setAuto', device: 'w1', on: true, ship: 's1' }]);
  match.submit(member.id, null, { type: 'setAuto', device: 'w1', on: false });
  ticks(match);
  assert.equal(match.log.length, LOG_LIMIT);
  assert.equal(match.replayRecord().truncated, false);
  match.submit(member.id, null, { type: 'setAuto', device: 'w1', on: true });
  ticks(match);
  assert.equal(match.log.length, LOG_LIMIT, 'no further growth');
  assert.equal(match.replayRecord().truncated, true);
  assert.equal(match.world.ships.s1.devices[0].auto, true, 'the command still applied');
});

// ---- acks, broadcast ----

test('acks carry the post-tick tick and arrive before the snapshot that reflects them', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member, occ } = seat(match, 'p1');
  ticks(match, 3);
  const t = match.world.tick;
  occ.texts.length = 0;
  match.submit(member.id, 9, { type: 'setPower', system: 'engines', level: 1 });
  ticks(match, 2);
  const msgs = occ.msgs();
  assert.deepEqual(msgs[0], { t: 'ack', re: 9, ok: true, tick: t + 1 });
  const snap = msgs.find((m) => m.t === 'snap');
  assert.ok(msgs.indexOf(snap) > 0);
  assert.equal(snap.view.ships.s1.systems.engines.want, 1, 'the first snapshot after the ack has the effect');
  assert.ok(snap.tick >= t + 1);
});

test('snapshots: every snapEvery ticks while running; on change while paused; the seed once ended', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member, occ } = seat(match, 'p1');
  occ.texts.length = 0;
  ticks(match, 6);
  const snaps = occ.msgs().filter((m) => m.t === 'snap');
  assert.deepEqual(snaps.map((s) => s.tick), [2, 4, 6]);
  assert.equal(snaps[0].seed, undefined);
  assert.equal(match.control(member.id, 'pause', true), null);
  occ.texts.length = 0;
  ticks(match, 4);
  assert.equal(occ.msgs().length, 1, 'one snapshot for the pause, then silence');
  assert.equal(occ.msgs()[0].paused, true);
  match.submit(member.id, 1, { type: 'setAuto', device: 'w1', on: true });
  ticks(match);
  assert.deepEqual(occ.msgs().slice(1).map((m) => m.t), ['ack', 'snap']);
  finish(match);
  const last = occ.msgs().at(-1);
  assert.deepEqual([last.t, last.phase, last.seed], ['snap', 'ended', 5]);
  assert.equal(last.view.outcome.winner, 'blue');
});

test('one projection and one string per perspective key; the AI gets the same string as its side', () => {
  const lobby = lobbyOf();
  const spec = specOf('vsAi', { ai: 'drifter' });
  spec.ships[1].seats = { min: 0, max: 2 };   // an AI ship with room for human crewmates
  const match = lobby.createFromSpec(spec, 3);
  const blue1 = seat(match, 'p1', { ship: 's1' });
  const blue2 = seat(match, 'p2', { ship: 's1' });
  const red = seat(match, 'p3', { ship: 's2' });
  const all1 = seat(match, 'p4', { spectate: true });
  const all2 = seat(match, 'p5', { spectate: true });
  const aiMember = match.members.get('m1');
  const ai = human();
  aiMember.occupant = { kind: 'ai', deliver: ai.deliver };
  const offline = seat(match, 'p6', { ship: 's1' });
  match.detach(offline.member.id);
  for (const o of [blue1, blue2, red, all1, all2, ai, offline]) ('occ' in o ? o.occ : o).texts.length = 0;

  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = (/** @type {any[]} */ ...args) => (calls++, stringify.apply(JSON, args));
  try {
    match.broadcast();
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(calls, 3, 'one stringify per key: side:blue, side:red, all');
  const [b1] = blue1.occ.texts;
  assert.equal(blue2.occ.texts[0], b1);
  assert.equal(red.occ.texts[0], ai.texts[0], 'AI and human on the red side get the identical text');
  assert.equal(all1.occ.texts[0], all2.occ.texts[0]);
  assert.notEqual(b1, red.occ.texts[0]);
  assert.notEqual(b1, all1.occ.texts[0]);
  assert.equal(offline.occ.texts.length, 0, 'offline members get nothing');
  const blueView = JSON.parse(b1).view;
  assert.equal(blueView.rng, undefined);
  assert.equal(blueView.ships.s2.systems.shields.want, undefined, 'enemy intent is redacted');
  assert.equal(blueView.ships.s1.systems.shields.want, 2);
  assert.equal(JSON.parse(all1.occ.texts[0]).view.ships.s2.systems.shields.want, 2);
  const snap = parseServer(b1);
  assert.equal(snap.ok, true);
  assert.deepEqual(JSON.parse(b1).roster.find((r) => r.id === 'm1'), { id: 'm1', name: 'Drifter (Target practice)', kind: 'ai', ship: 's2', online: true });
});

test('events reach every perspective once, with the snapshot that follows them', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member, occ } = seat(match, 'p1');
  match.submit(member.id, 1, { type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' } });
  for (let i = 0; i < 400 && !occ.msgs().some((m) => m.t === 'snap' && m.ev.some((e) => e.type === 'fired')); i++) ticks(match);
  const fired = occ.msgs().filter((m) => m.t === 'snap').flatMap((s) => s.ev).filter((e) => e.type === 'fired');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].device, 'w1');
});

// ---- pause, pauseWhenEmpty, rematch ----

test('pause policy per preset', () => {
  const vsAi = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const crew = seat(vsAi, 'p1').member;
  const watcher = seat(vsAi, 'p2', { spectate: true }).member;
  assert.equal(vsAi.control(watcher.id, 'pause', true), 'forbidden');
  assert.equal(vsAi.control(crew.id, 'pause', true), null);
  assert.equal(vsAi.paused, true);
  const t = vsAi.world.tick;
  ticks(vsAi, 5);
  assert.equal(vsAi.world.tick, t);
  assert.equal(vsAi.control(crew.id, 'pause', false), null);
  ticks(vsAi, 5);
  assert.equal(vsAi.world.tick, t + 5);

  const pvp = create(lobbyOf(), 'pvp');
  const p1 = seat(pvp, 'p1').member;
  assert.equal(pvp.control(p1.id, 'pause', true), 'forbidden');

  const show = create(lobbyOf(), 'aiVsAi', { aiA: 'drifter', aiB: 'drifter' });
  const fan = seat(show, 'p1').member;
  assert.equal(fan.role, 'spectator', 'aiVsAi has no human seats');
  assert.equal(show.control(fan.id, 'pause', true), null);
  assert.equal(show.control(fan.id, 'warp'), 'bad-message');
  assert.equal(show.control('m99', 'pause', true), 'not-in-match');
});

test('pauseWhenEmpty counts online crew: a spectator watching does not unpause a vsAi whose crew is away (host-4)', () => {
  const vsAi = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const crew = seat(vsAi, 'p1');
  seat(vsAi, 'p2', { spectate: true });
  ticks(vsAi, 2);
  vsAi.detach(crew.member.id);
  assert.equal(vsAi.humansOnline(), 1, 'the spectator is online');
  assert.equal(vsAi.paused, true);
  ticks(vsAi, 5);
  assert.equal(vsAi.world.tick, 2);
  vsAi.attach(crew.member.id, crew.occ);
  assert.equal(vsAi.paused, false);
});

test('pauseWhenEmpty: vsAi stops while its human is offline; pvp keeps running', () => {
  const vsAi = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member, occ } = seat(vsAi, 'p1');
  ticks(vsAi, 2);
  vsAi.detach(member.id);
  assert.equal(vsAi.paused, true);
  ticks(vsAi, 5);
  assert.equal(vsAi.world.tick, 2);
  vsAi.attach(member.id, occ);
  ticks(vsAi, 5);
  assert.equal(vsAi.world.tick, 7);

  const pvp = create(lobbyOf(), 'pvp');
  const a = seat(pvp, 'p1').member;
  const b = seat(pvp, 'p2').member;
  pvp.detach(a.id);
  pvp.detach(b.id);
  ticks(pvp, 5);
  assert.equal(pvp.world.tick, 5);
});

test('rematch: only once ended; new round and seed, fresh world, same members, fresh AI', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const crew = seat(match, 'p1');
  const watcher = seat(match, 'p2', { spectate: true });
  assert.equal(match.control(crew.member.id, 'rematch'), 'not-ended');
  match.submit(crew.member.id, 1, { type: 'setAuto', device: 'w1', on: true });
  match.control(crew.member.id, 'pause', true);
  ticks(match, 3);
  finish(match);
  assert.equal(match.control(watcher.member.id, 'rematch'), 'forbidden');
  const oldAi = match.members.get('m1').occupant;
  assert.equal(match.control(crew.member.id, 'rematch'), null);
  assert.equal(match.round, 2);
  assert.equal(match.seed, (5 + 0x9E3779B9 * 1) >>> 0, 'an explicit vsAi seed rematches by the public formula');
  assert.equal(match.world.tick, 0);
  assert.equal(match.world.outcome, null);
  assert.deepEqual(match.log, []);
  assert.equal(match.manualPause, false);
  assert.equal(match.phase, 'running');
  assert.deepEqual([...match.members.keys()], ['m1', 'm2', 'm3']);
  assert.notEqual(match.members.get('m1').occupant, oldAi);
  ticks(match, 2);
  const snap = crew.occ.msgs().at(-1);
  assert.deepEqual([snap.t, snap.round, snap.tick], ['snap', 2, 2]);

  const show = create(lobbyOf(), 'aiVsAi', { aiA: 'drifter', aiB: 'drifter' });
  const fan = seat(show, 'p9').member;
  finish(show);
  assert.equal(show.control(fan.id, 'rematch'), null, 'anyone may rematch a match without crew seats');
  assert.equal(show.round, 2);
});

test('leave frees the seat and drops queued commands; summary counts open seats', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member, occ } = seat(match, 'p1');
  match.submit(member.id, 1, { type: 'setAuto', device: 'w1', on: true });
  match.leave(member.id);
  match.leave('m1');   // AI members never leave
  ticks(match);
  assert.equal(match.members.size, 1);
  assert.equal(occ.msgs().filter((m) => m.t === 'ack').length, 0);
  assert.deepEqual(match.summary(), {
    code: match.code, preset: 'vsAi', name: 'Skirmish', phase: 'running',
    ships: [{ id: 's1', bp: 'candlewick', side: 'blue', open: 4 }, { id: 's2', bp: 'lampblack', side: 'red', open: 0 }],
    spectators: 0,
  });
  assert.equal(seat(match, 'p1').member.id, 'm3', 'rejoining makes a new member');
});

test('replayRecord is a detached copy of spec, seed, log, final tick and the truncated flag', () => {
  const match = create(lobbyOf(), 'vsAi', { ai: 'drifter' });
  const { member } = seat(match, 'p1');
  match.submit(member.id, 1, { type: 'setAuto', device: 'w1', on: true });
  ticks(match, 3);
  const rec = match.replayRecord();
  assert.deepEqual(rec.log, [[0, 'm2', { type: 'setAuto', device: 'w1', on: true, ship: 's1' }]]);
  assert.equal(rec.finalTick, 3);
  assert.equal(rec.seed, 5);
  assert.equal(rec.truncated, false);
  rec.log.length = 0;
  assert.equal(match.log.length, 1);
});

// ---- Lobby ----

test('lobby: validated content, codes, case-insensitive get, list of live matches', () => {
  assert.throws(() => new Lobby({ content: { ...CONTENT, systemOrder: [] }, clock: manualClock() }), /invalid content/);
  const lobby = lobbyOf();
  assert.equal(lobby.contentHash, CONTENT_HASH);
  const a = create(lobby, 'vsAi', { ai: 'drifter' });
  const b = create(lobby, 'pvp');
  assert.match(a.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(lobby.get(a.code.toLowerCase()), a);
  assert.equal(lobby.get('ZZZZZ'), undefined);
  assert.equal(lobby.get(7), undefined);
  assert.deepEqual(lobby.create(null, 'nope', {}), { error: 'bad-preset' });
  assert.deepEqual(lobby.create(null, 'vsAi', { ship: 'nope' }), { error: 'bad-opts' });
  const show = create(lobby, 'aiVsAi', { aiA: 'drifter', aiB: 'drifter' });
  const done = create(lobby, 'aiVsAi', { aiA: 'drifter', aiB: 'drifter' });
  seat(a, 'p1');
  finish(done);
  assert.deepEqual(lobby.list().map((m) => m.code), [show.code], 'only live matches without human seats are listed (host-3)');
  assert.equal(lobby.list()[0].preset, 'aiVsAi');
  const random = lobby.create(null, 'pvp', {});
  assert.ok(!('error' in random) && Number.isInteger(random.seed) && random.seed >= 0 && random.seed < 2 ** 32);
});

test('seed policy: a pvp seed is never the creator\'s and each rematch draws a fresh one (host-5)', () => {
  const lobby = lobbyOf();
  const pvp = /** @type {Match} */ (lobby.create(null, 'pvp', { seed: 4242 }));
  assert.notEqual(pvp.seed, 4242, 'opts.seed is ignored when two sides have human seats');
  const a = seat(pvp, 'p1').member;
  seat(pvp, 'p2');
  finish(pvp);
  const revealed = pvp.seed;
  assert.equal(pvp.control(a.id, 'rematch'), null);
  assert.notEqual(pvp.seed, (revealed + 0x9E3779B9 * 1) >>> 0, 'the next seed is not a public function of the revealed one');
  const vsAi = create(lobby, 'vsAi', { ai: 'drifter', seed: 9 });
  assert.equal(vsAi.seed, 9, 'one human side: the seed is honored (tests, tools, ?seed=)');
  const show = create(lobby, 'aiVsAi', { seed: 11 });
  assert.equal(show.seed, 11);
});

test('lobby: the clock ticks every match and disposes idle ones after idleTtlMs', () => {
  const clock = manualClock();
  const lobby = new Lobby({ content: CONTENT, clock });
  const pvp = create(lobby, 'pvp');
  const a = seat(pvp, 'p1');
  seat(pvp, 'p2');
  clock.advance(TICK_MS * 10);
  assert.equal(pvp.world.tick, 10);
  const show = create(lobby, 'aiVsAi', { aiA: 'drifter', aiB: 'drifter' });
  clock.advance(120000);   // idle counts from its first tick without humans
  assert.equal(lobby.get(show.code), show, 'not yet idle long enough');
  clock.advance(TICK_MS);
  assert.equal(lobby.get(show.code), undefined, 'disposed after 2 minutes without humans');
  assert.equal(lobby.get(pvp.code), pvp);
  pvp.detach(a.member.id);
  pvp.detach('m2');
  clock.advance(600000 - TICK_MS);
  assert.equal(lobby.get(pvp.code), pvp);
  pvp.attach(a.member.id, a.occ);
  clock.advance(600000);
  assert.equal(lobby.get(pvp.code), pvp, 'a returning human resets the idle timer');
  lobby.close();
  const t = pvp.world.tick;
  clock.advance(TICK_MS * 10);
  assert.equal(pvp.world.tick, t, 'close stops the clock');
});

test('lobby: a match that throws is reported and disposed; the others keep ticking', () => {
  const errors = [];
  const clock = manualClock();
  const lobby = new Lobby({ content: CONTENT, clock, onError: (err, m) => errors.push([String(err), m.code]) });
  const bad = create(lobby, 'pvp');
  const good = create(lobby, 'pvp');
  seat(good, 'p1');
  seat(good, 'p2');
  bad.tick = () => { throw new Error('boom'); };
  clock.advance(TICK_MS * 3);
  assert.deepEqual(errors, [['Error: boom', bad.code]]);
  assert.equal(lobby.get(bad.code), undefined);
  assert.equal(good.world.tick, 3);
});

test('lobby: at most 500 live matches', () => {
  const lobby = lobbyOf();
  for (let i = 0; i < 500; i++) create(lobby, 'pvp');
  assert.deepEqual(lobby.create(null, 'pvp', {}), { error: 'busy' });
});

// ---- Session over memory links ----

/** A protocol client on a memory link into the lobby. @param {Lobby} lobby */
function client(lobby) {
  const [mine, theirs] = memoryLinkPair();
  lobby.connect(theirs);
  /** @type {any[]} */
  const got = [];
  let closed = false;
  /** @type {((v?: unknown) => void)[]} */
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
  mine.onMessage((text) => {
    const r = parseServer(text);
    assert.equal(r.ok, true, `server sent an invalid message: ${text}`);
    got.push(JSON.parse(text));
    wake();
  });
  mine.onClose(() => { closed = true; wake(); });
  let cursor = 0;
  return {
    got,
    get closed() { return closed; },
    send: (msg) => mine.send(typeof msg === 'string' ? msg : encode(msg)),
    close: () => mine.close(),
    /** Next unread message matching pred (skipping others). @param {(m: any) => boolean} [pred] */
    async next(pred = () => true) {
      for (;;) {
        while (cursor < got.length) if (pred(got[cursor++])) return got[cursor - 1];
        if (closed) throw new Error('link closed');
        await new Promise((r) => waiters.push(r));
      }
    },
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

test('session: hello-first, version check, welcome with a token and the content hash', async () => {
  const lobby = lobbyOf();
  const c = client(lobby);
  c.send({ t: 'list', rid: 1 });
  assert.deepEqual(await c.next(), { t: 'error', re: 1, code: 'hello-first', msg: ERROR_TEXT['hello-first'] });
  c.send({ t: 'hello', v: 1, name: '  \u0007Ines\nCalder of the Long Watch Fleet  ' });
  const w = await c.next();
  assert.equal(w.t, 'welcome');
  assert.match(w.token, /^[0-9a-f]{32}$/);
  assert.equal(w.content, CONTENT_HASH);
  assert.equal(w.v, 1);
  assert.equal(w.name, 'InesCalder of the Long W');
  assert.ok(w.name.length <= LIMITS.nameLen);
  c.send({ t: 'hello', v: 1 });
  assert.equal((await c.next()).code, 'bad-message', 'one hello per session');

  const old = client(lobby);
  old.send({ t: 'hello', v: 0 });
  assert.equal((await old.next()).code, 'upgrade-required');
  await old.settle();
  assert.equal(old.closed, true);

  const anon = client(lobby);
  anon.send({ t: 'hello', v: 1 });
  assert.equal((await anon.next()).name, 'Captain');
});

test('session: create, cmd and ack, list, ping, leave; bad input keeps the link open', async () => {
  const clock = manualClock();
  const lobby = new Lobby({ content: CONTENT, clock });
  const c = client(lobby);
  c.send({ t: 'hello', v: 1, name: 'shawn' });
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'cmd', rid: 1, c: { type: 'setAuto', device: 'w1', on: true } });
  assert.equal((await c.next()).code, 'not-in-match');
  c.send({ t: 'create', rid: 2, preset: 'chess' });
  assert.deepEqual(await c.next(), { t: 'error', re: 2, code: 'bad-preset', msg: ERROR_TEXT['bad-preset'] });
  c.send({ t: 'create', rid: 3, preset: 'vsAi', opts: { ai: 'drifter', seed: 1 } });
  const joined = await c.next();
  assert.deepEqual(joined.you, { member: 'm2', ship: 's1', side: 'blue', role: 'crew', grants: ['*'] });
  assert.deepEqual([joined.re, joined.preset, joined.round], [3, 'vsAi', 1]);
  assert.deepEqual(joined.rules, { pause: 'crew', pauseWhenEmpty: true, snapEvery: 2, idleTtlMs: 600000, tickMs: 50 });
  const first = await c.next();
  assert.deepEqual([first.t, first.tick, first.phase], ['snap', 0, 'running']);
  c.send({ t: 'cmd', rid: 4, c: { type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' } } });
  c.send('{"t":"cmd","rid":5,"c":{"type":"selfDestruct"}}');
  c.send('{oops');
  await c.settle();
  clock.advance(TICK_MS);
  assert.deepEqual(await c.next((m) => m.re === 5), { t: 'error', re: 5, code: 'bad-message', msg: ERROR_TEXT['bad-message'] });
  assert.deepEqual(await c.next((m) => m.t === 'error' && m.re === undefined), { t: 'error', code: 'bad-message', msg: ERROR_TEXT['bad-message'] });
  assert.deepEqual(await c.next((m) => m.t === 'ack'), { t: 'ack', re: 4, ok: true, tick: 1 });
  c.send({ t: 'ping', ct: 777 });
  assert.deepEqual(await c.next((m) => m.t === 'pong'), { t: 'pong', ct: 777, tick: 1 });
  c.send({ t: 'list', rid: 6 });
  const list = await c.next((m) => m.t === 'lobby');
  assert.deepEqual(list.matches, [], 'a match with human seats is not listed; its code is an invitation');
  c.send({ t: 'pause', rid: 7, on: true });
  assert.deepEqual(await c.next((m) => m.re === 7), { t: 'ok', re: 7 });
  c.send({ t: 'rematch', rid: 8 });
  assert.equal((await c.next((m) => m.re === 8)).code, 'not-ended');
  c.send({ t: 'leave', rid: 9 });
  assert.deepEqual(await c.next((m) => m.re === 9), { t: 'ok', re: 9 });
  assert.equal(lobby.get(joined.code), undefined, 'its last human left, so it is gone at once (host-7)');
  assert.equal(c.closed, false);
});

test('session: join by code as co-op crew or spectator; errors for unknown codes and full seats', async () => {
  const lobby = lobbyOf();
  const a = client(lobby);
  a.send({ t: 'hello', v: 1, name: 'A' });
  a.send({ t: 'create', rid: 1, preset: 'vsAi', opts: { ai: 'drifter' } });
  const { code } = await a.next((m) => m.t === 'joined');
  const b = client(lobby);
  b.send({ t: 'hello', v: 1, name: 'B' });
  b.send({ t: 'join', rid: 1, code: 'NOPE1' });
  assert.equal((await b.next((m) => m.t === 'error')).code, 'no-match');
  b.send({ t: 'join', rid: 2, code, ship: 's2' });
  assert.deepEqual(await b.next((m) => m.t === 'error'), { t: 'error', re: 2, code: 'seat-full', msg: ERROR_TEXT['seat-full'] });
  b.send({ t: 'join', rid: 3, code: code.toLowerCase() });
  const joined = await b.next((m) => m.t === 'joined');
  assert.deepEqual([joined.re, joined.you.ship, joined.you.role], [3, 's1', 'crew']);
  assert.equal((await b.next()).t, 'snap');
  const c = client(lobby);
  c.send({ t: 'hello', v: 1, name: 'C' });
  c.send({ t: 'join', rid: 1, code, spectate: true });
  const watch = await c.next((m) => m.t === 'joined');
  assert.deepEqual(watch.you, { member: 'm4', ship: null, side: null, role: 'spectator', grants: [] });
});

test('session: a player is in one match at a time; create moves them', async () => {
  const lobby = lobbyOf();
  const a = client(lobby);
  a.send({ t: 'hello', v: 1 });
  a.send({ t: 'create', rid: 1, preset: 'pvp' });
  const first = await a.next((m) => m.t === 'joined');
  a.send({ t: 'create', rid: 2, preset: 'vsAi', opts: { ai: 'drifter' } });
  const second = await a.next((m) => m.t === 'joined');
  assert.notEqual(first.code, second.code);
  assert.equal(lobby.get(first.code), undefined, 'the match it left had no human left and was disposed');
  assert.deepEqual(a.got.filter((m) => m.t === 'left'), [], 'the mover is not told it left');
  a.send({ t: 'join', rid: 3, code: second.code });
  assert.equal((await a.next((m) => m.t === 'joined')).you.member, second.you.member, 'rejoining the same match is idempotent');
});

test('session: reconnect with the token resumes the seat; the replaced session is closed', async () => {
  const lobby = lobbyOf();
  const a = client(lobby);
  a.send({ t: 'hello', v: 1, name: 'A' });
  const { token, player } = await a.next((m) => m.t === 'welcome');
  a.send({ t: 'create', rid: 1, preset: 'vsAi', opts: { ai: 'drifter' } });
  const { code, you } = await a.next((m) => m.t === 'joined');
  const match = lobby.get(code);
  a.close();
  await a.settle();
  assert.equal(match.members.get(you.member).occupant, null, 'detached, seat kept');

  const b = client(lobby);
  b.send({ t: 'hello', v: 1, token, name: 'ignored' });
  const w = await b.next();
  assert.deepEqual([w.t, w.player, w.token, w.name], ['welcome', player, token, 'A']);
  const rejoined = await b.next();
  assert.deepEqual([rejoined.t, rejoined.re, rejoined.code, rejoined.you.member], ['joined', undefined, code, you.member]);
  assert.equal((await b.next()).t, 'snap');

  const c = client(lobby);
  c.send({ t: 'hello', v: 1, token });
  await c.next((m) => m.t === 'snap');
  await c.settle();
  assert.equal(b.closed, true, 'the older session is closed');
  assert.equal(c.closed, false);
  const occ = match.members.get(you.member).occupant;
  assert.ok(occ && occ !== null, 'the replaced session closing does not detach the new one');
  assert.equal(match.humansOnline(), 1);
});

test('session: rate limit drops over-budget messages, then closes after 200 drops', async () => {
  const clock = manualClock();
  const lobby = new Lobby({ content: CONTENT, clock });
  const c = client(lobby);
  c.send({ t: 'hello', v: 1 });
  for (let i = 0; i < 70; i++) c.send({ t: 'ping', ct: i });
  await c.settle();
  const pongs = c.got.filter((m) => m.t === 'pong').length;
  const limited = c.got.filter((m) => m.code === 'rate-limited').length;
  assert.deepEqual([pongs, limited], [LIMITS.burst - 1, 71 - LIMITS.burst]);
  clock.advance(1000);
  c.send({ t: 'ping', ct: 1000 });
  await c.settle();
  assert.equal(c.got.at(-1).t, 'pong', 'the bucket refills with time');
  for (let i = 0; i < 300; i++) c.send({ t: 'ping', ct: i });
  await c.settle();
  assert.equal(c.closed, true);
});

test('session: a disposed match tells its online humans they left', async () => {
  const clock = manualClock();
  const lobby = new Lobby({ content: CONTENT, clock });
  const a = client(lobby);
  a.send({ t: 'hello', v: 1 });
  a.send({ t: 'create', rid: 1, preset: 'vsAi', opts: { ai: 'drifter' } });
  const { code } = await a.next((m) => m.t === 'joined');
  lobby.dispose(lobby.get(code), 'idle');
  assert.deepEqual(await a.next((m) => m.t === 'left'), { t: 'left', reason: 'idle' });
  a.send({ t: 'cmd', rid: 2, c: { type: 'setAuto', device: 'w1', on: true } });
  assert.equal((await a.next((m) => m.t === 'error')).code, 'not-in-match');
});

test('session: a handler that throws is reported, answered bad-message, and the link stays open (host-2)', async () => {
  const errors = [];
  const presets = { ...PRESETS, boom: () => { throw new Error('boom'); } };
  const lobby = lobbyOf({ presets, onError: (err, m) => errors.push([String(err), m]) });
  const c = client(lobby);
  c.send({ t: 'hello', v: 1 });
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'create', rid: 4, preset: 'boom' });
  assert.deepEqual(await c.next((m) => m.t === 'error'), { t: 'error', re: 4, code: 'bad-message', msg: ERROR_TEXT['bad-message'] });
  assert.deepEqual(errors, [['Error: boom', undefined]]);
  c.send({ t: 'ping', ct: 3 });
  assert.equal((await c.next((m) => m.t === 'pong')).ct, 3);
  assert.equal(c.closed, false);
});

test('session: a command is rebuilt from its declared args, so junk never reaches the host or its log (host-2, host-6)', async () => {
  const clock = manualClock();
  const lobby = new Lobby({ content: CONTENT, clock });
  const c = client(lobby);
  c.send({ t: 'hello', v: 1 });
  c.send({ t: 'create', rid: 1, preset: 'vsAi', opts: { ai: 'drifter' } });
  const { code } = await c.next((m) => m.t === 'joined');
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  c.send(`{"t":"cmd","rid":2,"c":{"type":"setAuto","device":"w1","on":true,"x":${deep},"__proto__":{"a":1},"constructor":7}}`);
  c.send({ t: 'cmd', rid: 3, c: { type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S', pad: 'x'.repeat(9000) } } });
  c.send({ t: 'cmd', rid: 4, c: { type: 'setPower', system: 'shields', level: 'lots' } });
  c.send({ t: 'cmd', rid: 5, c: { type: 'moveCrew', crew: [[['c3']]], room: 'E' } });
  await c.settle();
  clock.advance(TICK_MS);
  const acks = [];
  for (let i = 0; i < 4; i++) acks.push(await c.next((m) => m.t === 'ack'));
  assert.deepEqual(acks.map((a) => [a.re, a.ok, a.why]), [[2, true, undefined], [3, true, undefined], [4, false, 'bad-level'], [5, false, 'bad-arg']],
    'a field that does not fit is dropped, and check answers with its sim reason');
  assert.deepEqual(lobby.get(code).log.map(([, , cmd]) => cmd), [
    { type: 'setAuto', device: 'w1', on: true, ship: 's1' },
    { type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' }, ship: 's1' },
  ]);
  c.send({ t: 'ping', ct: 1 });
  assert.equal((await c.next((m) => m.t === 'pong')).ct, 1);
});

test('lobby: a match left by its last human is disposed at once, so one identity holds one live match (host-7)', async () => {
  const lobby = lobbyOf();
  const a = client(lobby);
  a.send({ t: 'hello', v: 1 });
  for (let i = 0; i < 20; i++) {
    a.send({ t: 'create', rid: i + 1, preset: i % 2 ? 'aiVsAi' : 'vsAi', opts: { ai: 'drifter' } });
    await a.next((m) => m.t === 'joined' && m.re === i + 1);
  }
  assert.equal(lobby.matches.size, 1);
  assert.deepEqual(a.got.filter((m) => m.t === 'left' || m.t === 'error'), []);
  const b = client(lobby);
  b.send({ t: 'hello', v: 1 });
  b.send({ t: 'join', rid: 1, code: [...lobby.matches.keys()][0], spectate: true });
  await b.next((m) => m.t === 'joined');
  a.send({ t: 'leave', rid: 99 });
  await a.next((m) => m.re === 99);
  assert.equal(lobby.matches.size, 1, 'a spectator is a human member: the match stays');
});

test('session: a closed spectator is unseated and forgotten; closed crew keep their seat (host-8, host-9)', async () => {
  const lobby = lobbyOf();
  const a = client(lobby);
  a.send({ t: 'hello', v: 1 });
  a.send({ t: 'create', rid: 1, preset: 'vsAi', opts: { ai: 'drifter' } });
  const { code } = await a.next((m) => m.t === 'joined');
  const match = lobby.get(code);
  for (let i = 0; i < 30; i++) {
    const s = client(lobby);
    s.send({ t: 'hello', v: 1 });
    s.send({ t: 'join', rid: 1, code, spectate: true });
    await s.next((m) => m.t === 'joined');
    s.close();
    await s.settle();
  }
  assert.equal(match.members.size, 2, 'no ghost spectators: the AI and the crew member');
  assert.equal(match.roster().length, 2);
  assert.equal(lobby.players.size, 1, 'players with nothing to resume are dropped');
  for (let i = 0; i < 10; i++) {
    const s = client(lobby);
    s.send({ t: 'hello', v: 1 });
    await s.next((m) => m.t === 'welcome');
    s.close();
    await s.settle();
  }
  assert.equal(lobby.players.size, 1, 'tokenless hellos leave nothing behind');
  a.close();
  await a.settle();
  assert.equal(lobby.players.size, 1, 'a disconnected crew member keeps its player and seat');
  assert.equal(match.members.size, 2);
  lobby.dispose(match, 'idle');
  assert.equal(lobby.players.size, 0, 'once its match is gone, an offline player is dropped too');
});

test('lobby: a lone spectator whose link drops leaves the exhibition to its idle TTL, not instant disposal', async () => {
  const lobby = lobbyOf();
  const s = client(lobby);
  s.send({ t: 'hello', v: 1 });
  s.send({ t: 'create', rid: 1, preset: 'aiVsAi', opts: { aiA: 'drifter', aiB: 'drifter' } });
  const { code } = await s.next((m) => m.t === 'joined');
  s.close();
  await s.settle();
  assert.equal(lobby.get(code).members.size, 2, 'the spectator is gone');
  assert.ok(lobby.get(code), 'the match waits for its idle TTL');
});

// ---- clocks ----

test('manualClock runs due callbacks synchronously, in due order, and stops', () => {
  const clock = manualClock();
  const log = [];
  const stopA = clock.every(50, () => log.push(['a', clock.now()]));
  clock.every(30, () => log.push(['b', clock.now()]));
  clock.advance(100);
  assert.deepEqual(log, [['b', 30], ['a', 50], ['b', 60], ['b', 90], ['a', 100]]);
  assert.equal(clock.now(), 100);
  stopA();
  log.length = 0;
  clock.advance(50);
  assert.deepEqual(log, [['b', 120], ['b', 150]]);
  assert.throws(() => clock.every(0, () => {}), RangeError);
});

test('realClock fires on a fixed cadence and stops', async () => {
  const clock = realClock();
  const t0 = clock.now();
  let n = 0;
  const stop = clock.every(10, () => n++);
  await new Promise((r) => setTimeout(r, 120));
  stop();
  const seen = n;
  assert.ok(seen >= 5 && seen <= 13, `fired ${seen} times in 120 ms`);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, seen);
  assert.ok(clock.now() - t0 >= 150);
});
