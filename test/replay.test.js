// @ts-check
// Replay (design doc 19.2, 14.7): spec + seed + command log reproduce a match's final hash, across waiting
// and paused stretches (several batches at one tick), and for AI-vs-AI matches played to the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT } from '../shared/content/index.js';
import { Lobby } from '../shared/host/lobby.js';
import { buildSpec } from '../shared/host/presets.js';
import { manualClock } from '../shared/host/clock.js';
import { replay } from '../shared/host/replay.js';
import { hashWorld } from '../shared/sim/index.js';

/** @typedef {import('../shared/host/match.js').Match} Match */

const MAX_TICKS = 12000;
const lobby = new Lobby({ content: CONTENT, clock: manualClock() });
const quiet = { kind: /** @type {'human'} */ ('human'), deliver() {} };

/** @param {string} preset @param {object} opts @param {(spec: any) => void} [edit] */
function specOf(preset, opts, edit = () => {}) {
  const spec = buildSpec(preset, opts, CONTENT);
  if ('error' in spec) throw new Error(spec.error);
  edit(spec);
  return spec;
}

/** Join that throws on error. @param {Match} match @param {string} id */
function joinAs(match, id) {
  const member = match.join({ id, name: id });
  if ('error' in member) throw new Error(member.error);
  return member;
}

/**
 * Tick until ended, calling script(match, step) before each tick; a step is one call to tick(), so steps
 * taken while paused or waiting share a world tick.
 * @param {Match} match @param {(m: Match, step: number) => void} [script]
 */
function playToEnd(match, script = () => {}) {
  for (let step = 0; step < MAX_TICKS && match.phase !== 'ended'; step++) {
    script(match, step);
    match.tick();
  }
  assert.equal(match.phase, 'ended', 'the match ended');
}

/** @param {Match} match */
function assertReplays(match) {
  const record = match.replayRecord();
  assert.equal(record.finalTick, match.world.tick);
  assert.equal(hashWorld(replay(record, CONTENT)), hashWorld(match.world));
  assert.equal(hashWorld(replay(JSON.parse(JSON.stringify(record)), CONTENT)), hashWorld(match.world), 'the record survives JSON');
}

test('a scripted human match with waiting, pauses and commands while paused replays to the same hash', () => {
  const spec = specOf('pvp', {}, (s) => { s.rules.pause = 'any'; });
  const match = lobby.createFromSpec(spec, 7);
  const blue = joinAs(match, 'p1');
  match.attach(blue.id, quiet);
  const fire = (member, device, ship, room) => {
    match.submit(member, null, { type: 'setTarget', device, target: { ship, room } });
    match.submit(member, null, { type: 'setAuto', device, on: true });
  };
  // While waiting: commands apply, time stands still, several batches land at tick 0.
  fire(blue.id, 'w1', 's2', 'S');
  match.tick();
  match.submit(blue.id, null, { type: 'setPower', system: 'engines', level: 1 });
  match.tick();
  match.submit(blue.id, null, { type: 'setDevicePower', device: 'w2', on: true });
  match.tick();
  assert.equal(match.world.tick, 0);
  const red = joinAs(match, 'p2');
  match.attach(red.id, quiet);
  /** @type {Record<number, () => void>} */
  const steps = {
    0: () => ['w6', 'w7', 'w8'].forEach((d) => fire(red.id, d, 's1', d === 'w6' ? 'S' : 'W')),
    100: () => fire(blue.id, 'w2', 's2', 'W'),
    400: () => match.control(red.id, 'pause', true),
    401: () => match.submit(blue.id, null, { type: 'moveCrew', crew: ['c4'], room: 'E' }),
    402: () => match.submit(blue.id, null, { type: 'setPower', system: 'shields', level: 2 }),
    403: () => match.submit(red.id, null, { type: 'setPower', system: 'engines', level: 1 }),
    404: () => match.control(blue.id, 'pause', false),
    405: () => match.submit(blue.id, null, { type: 'setPower', system: 'shields', level: 4 }),
    900: () => match.submit(red.id, null, { type: 'moveCrew', crew: ['c11', 'c10'], room: 'S' }),
  };
  playToEnd(match, (m, step) => steps[step]?.());
  const pausedAt = match.log.find(([, , c]) => /** @type {any} */ (c).type === 'moveCrew')[0];
  assert.equal(match.log.filter(([t]) => t === pausedAt).length, 3, 'three paused batches at one tick');
  assert.equal(match.log.filter(([t]) => t === 0).length, 10, 'waiting and starting batches at tick 0');
  assert.ok(match.world.outcome);
  assertReplays(match);
});

test('commands applied after the last advance (while paused) are part of the replay', () => {
  const spec = specOf('pvp', {}, (s) => { s.rules.pause = 'any'; });
  const match = lobby.createFromSpec(spec, 11);
  const a = joinAs(match, 'p1');
  const b = joinAs(match, 'p2');
  for (let i = 0; i < 50; i++) match.tick();
  match.control(a.id, 'pause', true);
  match.submit(a.id, null, { type: 'setPower', system: 'shields', level: 0 });
  match.tick();
  match.submit(b.id, null, { type: 'moveCrew', crew: ['c9'], room: 'W' });
  match.tick();
  assert.equal(match.world.tick, 50);
  assert.equal(match.world.ships.s1.systems.shields.power, 0);
  const record = match.replayRecord();
  assert.equal(hashWorld(replay(record, CONTENT)), hashWorld(match.world));
});

// ---- AI-vs-AI (needs shared/ai) ----

test('an aiVsAi match played to the end replays to the same final hash', () => {
  const match = lobby.createFromSpec(specOf('aiVsAi', {}), 3);
  playToEnd(match);
  assert.ok(match.log.length > 0, 'the AIs issued commands');
  assertReplays(match);
});

test('an aiVsAi match with a pause injected mid-fight replays to the same final hash', () => {
  const match = lobby.createFromSpec(specOf('aiVsAi', {}), 4);
  const fan = joinAs(match, 'p1');
  match.attach(fan.id, quiet);
  /** @type {Record<number, () => void>} */
  const steps = {
    300: () => match.control(fan.id, 'pause', true),
    303: () => match.submit('m1', null, { type: 'setAuto', device: 'w1', on: true }),   // a command while paused
    320: () => match.control(fan.id, 'pause', false),
  };
  playToEnd(match, (m, step) => steps[step]?.());
  assert.ok(match.log.some(([t, who, c]) => t === 300 && who === 'm1' && /** @type {any} */ (c).type === 'setAuto'));
  assertReplays(match);
});

test('after a rematch the record replays the new round', () => {
  const match = lobby.createFromSpec(specOf('aiVsAi', {}), 5);
  playToEnd(match);
  const fan = joinAs(match, 'p1');
  assert.equal(match.control(fan.id, 'rematch'), null);
  for (let i = 0; i < 500; i++) match.tick();
  assert.equal(match.round, 2);
  assertReplays(match);
});

test('shields stepped down and back up in two host ticks while paused replay the lost layer (sim-1)', () => {
  const spec = specOf('vsAi', { ai: 'drifter' });
  const match = lobby.createFromSpec(spec, 13);
  const blue = joinAs(match, 'p1');
  match.attach(blue.id, quiet);
  for (let i = 0; i < 40; i++) match.tick();
  match.control(blue.id, 'pause', true);
  match.submit(blue.id, null, { type: 'setPower', system: 'shields', level: 0 });
  match.tick();
  match.submit(blue.id, null, { type: 'setPower', system: 'shields', level: 2 });
  match.tick();
  match.control(blue.id, 'pause', false);
  for (let i = 0; i < 5; i++) match.tick();
  assert.equal(match.log.filter(([t]) => t === 40).length, 2, 'both commands logged at one tick');
  assert.equal(match.world.ships.s1.pools.shield.v, 0, 'the layer was lost live');
  assert.equal(hashWorld(replay(match.replayRecord(), CONTENT)), hashWorld(match.world));
});
