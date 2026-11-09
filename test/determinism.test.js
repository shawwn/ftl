// @ts-check
// Determinism (design doc 19.2): same seed and same scripted command log -> same hashWorld after 2000
// ticks; a different seed diverges; checkInvariants is empty after every tick, of the scripted run and of
// an AI-vs-AI match through the real host (tools/duel.js runs Match directly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, step, hashWorld, checkInvariants, project } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { runDuel } from '../tools/duel.js';

const TICKS = 2000;
const SHIPS = [{ id: 's1', bp: 'candlewick', side: 'blue' }, { id: 's2', bp: 'lampblack', side: 'red' }];

/** [tick, ship, command]: targets on both sides, rerouting, crew moves and a few rejected commands. */
const SCRIPT = [
  [0, 's1', { type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' } }],
  [0, 's1', { type: 'setAuto', device: 'w1', on: true }],
  [0, 's2', { type: 'setTarget', device: 'w6', target: { ship: 's1', room: 'S' } }],
  [0, 's2', { type: 'setAuto', device: 'w6', on: true }],
  [0, 's2', { type: 'setTarget', device: 'w7', target: { ship: 's1', room: 'W' } }],
  [0, 's2', { type: 'setAuto', device: 'w7', on: true }],
  [0, 's2', { type: 'setTarget', device: 'w8', target: { ship: 's1', room: 'H' } }],
  [120, 's1', { type: 'setPower', system: 'engines', level: 1 }],
  [120, 's1', { type: 'setDevicePower', device: 'w2', on: true }],
  [120, 's1', { type: 'setTarget', device: 'w2', target: { ship: 's2', room: 'W' } }],
  [121, 's1', { type: 'setAuto', device: 'w2', on: true }],
  [300, 's2', { type: 'setTarget', device: 'w8', target: { ship: 's1', room: 'E' } }],
  [300, 's2', { type: 'setAuto', device: 'w8', on: true }],
  [400, 's1', { type: 'moveCrew', crew: ['c4'], room: 'E' }],
  [450, 's1', { type: 'setPower', system: 'shields', level: 4 }],
  [500, 's2', { type: 'moveCrew', crew: ['c11', 'c10'], room: 'S' }],
  [600, 's1', { type: 'setPower', system: 'nope', level: 1 }],
  [700, 's1', { type: 'moveCrew', crew: ['c3', 'c5'], room: 'W' }],
  [800, 's2', { type: 'setPower', system: 'engines', level: 4 }],
  [900, 's1', { type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'H' } }],
  [1000, 's1', { type: 'moveCrew', crew: ['c3'], room: 'H' }],
  [1100, 's2', { type: 'moveCrew', crew: ['c9'], room: 'W' }],
  [1300, 's1', { type: 'setDevicePower', device: 'w1', on: false }],
  [1301, 's1', { type: 'setDevicePower', device: 'w1', on: true }],
];

/** @returns {Map<number, object[]>} */
function byTick(script) {
  const m = new Map();
  for (const [t, ship, c] of script) m.set(t, [...(m.get(t) ?? []), { ...c, ship }]);
  return m;
}

/** Run TICKS steps with the scripted log, checking invariants after every tick. */
function play(seed) {
  const world = createWorld({ seed, ships: SHIPS }, CONTENT);
  const log = byTick(SCRIPT);
  const violations = [];
  const counts = {};
  for (let i = 0; i < TICKS; i++) {
    const { events } = step(world, log.get(i) ?? [], CONTENT);
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const v = checkInvariants(world, CONTENT);
    if (v.length) violations.push([world.tick, v]);
  }
  return { world, violations, counts };
}

test('same seed and same command log give the same hash; invariants hold every tick', () => {
  const a = play(7);
  const b = play(7);
  assert.deepEqual(a.violations, []);
  assert.equal(hashWorld(a.world), hashWorld(b.world));
  assert.deepEqual(a.counts, b.counts);
  for (const type of ['fired', 'hit', 'shieldHit', 'miss', 'systemDamaged', 'ionized']) assert.ok(a.counts[type] > 0, type);
});

test('a different seed gives a different world, beyond the seed itself', () => {
  const a = play(7);
  const b = play(8);
  assert.deepEqual(b.violations, []);
  assert.notEqual(hashWorld(a.world), hashWorld(b.world));
  const view = (w) => JSON.stringify(project(w, { kind: 'all' }));
  assert.notEqual(view(a.world), view(b.world), 'evasion rolls diverge');
});

test('checkInvariants is empty after every tick of an AI-vs-AI run', () => {
  const violations = [];
  const { games } = runDuel({
    aiA: 'captain', aiB: 'captain', seed: 7,
    onTick: (m) => { const v = checkInvariants(m.world, CONTENT); if (v.length) violations.push([m.world.tick, v]); },
  });
  assert.ok(games[0].winner, 'the match ends');
  assert.ok(games[0].commands.s1 > 0 && games[0].commands.s2 > 0, 'both AIs commanded');
  assert.deepEqual(violations.slice(0, 3), []);
});
