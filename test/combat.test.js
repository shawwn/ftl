// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHit, tickShots, applyEffects, EFFECT_ORDER, meter, deriveShip, rngNext } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { FIX, duel, shippedWorld, recorder, command, run, runUntil, dev, types } from './helpers/fixtures.js';

let n = 0;
/** A shot from s1 (or `from`) about to be resolved. */
const shot = (bp, to = { ship: 's2', room: 'A' }, from = 's1') =>
  ({ id: 'p' + (900 + n++), bp, from: { ship: from, device: 'w1' }, to, flight: meter(FIX.devices[bp].travelMs) });

test('evasion 0 always hits, and canMiss still draws one value per shot', () => {
  const w = duel();
  const dot = w.ships.s2;
  assert.equal(dot.stats.evasion, 0);
  const ctx = recorder();
  const rng0 = w.rng;
  for (let i = 0; i < 200; i++) {
    dot.pools.shield.v = 0;
    dot.pools.hull.v = 10;
    resolveHit(w, shot('dart'), ctx);
  }
  assert.deepEqual([...new Set(types(ctx.events))].sort(), ['hit', 'hullDamaged']);
  const ref = { rng: rng0 };
  for (let i = 0; i < 200; i++) rngNext(ref);
  assert.equal(w.rng, ref.rng);
});

test('canMiss false never rolls and never misses; canMiss true at evasion 100 always misses', () => {
  const w = duel();
  const trio = w.ships.s1;
  trio.stats.evasion = 100;
  trio.pools.shield.v = 0;
  const ctx = recorder();
  const rng0 = w.rng;
  resolveHit(w, shot('zap', { ship: 's1', room: 'W' }, 's2'), ctx);
  assert.equal(w.rng, rng0);
  assert.equal(ctx.events.at(-1).type, 'hit');
  trio.pools.shield.v = 1;
  const miss = shot('dart', { ship: 's1', room: 'W' }, 's2');
  resolveHit(w, miss, ctx);
  assert.notEqual(w.rng, rng0);
  assert.deepEqual(ctx.events.at(-1), { type: 'miss', shot: miss.id, bp: 'dart', from: 's2', ship: 's1', room: 'W' });
  assert.equal(trio.pools.shield.v, 1, 'the evasion roll comes before the shield');
});

test('a blocked shot pops one layer and applies onBlock at the shields room', () => {
  const w = duel();
  const dot = w.ships.s2;
  assert.deepEqual([dot.pools.shield.v, dot.pools.shield.max], [2, 2]);
  const ctx = recorder();
  const s = shot('fizz');
  resolveHit(w, s, ctx);
  assert.equal(dot.pools.shield.v, 1);
  assert.equal(dot.pools.hull.v, 10);
  assert.equal(dot.systems.shields.status.ion.n, 1);
  assert.deepEqual(ctx.events, [
    { type: 'ionized', ship: 's2', system: 'shields', n: 1 },
    { type: 'shieldHit', shot: s.id, bp: 'fizz', from: 's1', ship: 's2' },
  ]);
  deriveShip(dot, FIX);                                     // ion lowers capacity at the next derive
  assert.equal(dot.systems.shields.power, 3);
  assert.deepEqual([dot.pools.shield.v, dot.pools.shield.max], [1, 1]);
  resolveHit(w, shot('zap'), ctx);                          // empty onBlock: only the layer
  assert.equal(dot.pools.shield.v, 0);
  assert.equal(dot.pools.hull.v, 10);
});

test('pierce passes through without popping a layer', () => {
  const w = duel();
  const dot = w.ships.s2;
  const ctx = recorder();
  const s = shot('pin');
  resolveHit(w, s, ctx);
  assert.equal(dot.pools.shield.v, 2);
  assert.equal(dot.pools.hull.v, 8);
  assert.deepEqual(ctx.events, [
    { type: 'hullDamaged', ship: 's2', n: 2, hull: 8 },
    { type: 'hit', shot: s.id, bp: 'pin', from: 's1', ship: 's2', room: 'A' },
  ]);
});

test('a 3-shot volley against 2 layers strips both and lands 1', () => {
  const w = duel();
  const dot = w.ships.s2;
  assert.deepEqual(command(w, 's1', [{ type: 'setTarget', device: 'w2', target: { ship: 's2', room: 'A' } }]).results, [null]);
  const events = [];
  let fired = null;
  while (!fired) {
    events.push(...run(w, 1));
    fired = events.find((e) => e.type === 'fired');
  }
  assert.equal(fired.tick, 36);                              // 2000 ms at 110 percent: full on the 37th tick
  assert.equal(fired.shots.length, 3);
  assert.deepEqual(w.shots.map((s) => s.flight.v), [0, -10000, -20000]);
  assert.equal(dev(w.ships.s1, 'w2').target, null, 'not auto: target clears after firing');
  events.push(...run(w, 6));
  const pipeline = events.filter((e) => ['miss', 'shieldHit', 'hit'].includes(e.type));
  assert.deepEqual(pipeline.map((e) => [e.type, e.shot, e.tick]), [
    ['shieldHit', fired.shots[0], 38], ['shieldHit', fired.shots[1], 40], ['hit', fired.shots[2], 42]]);
  assert.equal(dot.pools.shield.v, 0);
  assert.equal(dot.pools.hull.v, 9);
  assert.equal(w.shots.length, 0);
});

test('section 6: a manned Ember Volley fires on its 219th tick, three shots 250 ms apart', () => {
  const w = shippedWorld();
  const ember = dev(w.ships.s1, 'w1');
  assert.equal(w.ships.s1.stats.chargePct, 110);
  command(w, 's1', [{ type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' } }], CONTENT);
  const ticks = runUntil(w, (x) => x.shots.length > 0, CONTENT);
  assert.equal(ticks, 219);
  assert.deepEqual(ember.charge, { v: 0, max: 1200000, rate: 110 }, 'a restart keeps its rate, so the bar keeps moving');
  assert.deepEqual(w.shots.map((s) => [s.bp, s.flight.v, s.flight.max]), [['ember', 0, 110000], ['ember', -25000, 110000], ['ember', -50000, 110000]]);
  assert.ok(w.shots.every((s) => s.flight.rate === 100), 'a shot is born at the rate tickShots applies (elegance-6)');
});

test('a status timer is born and restarted at the rate tickStatuses applies (elegance-6)', () => {
  const w = duel();
  const shields = w.ships.s2.systems.shields;
  applyEffects(w.ships.s2, 'A', { ion: 2 }, recorder());
  assert.equal(shields.status.ion.timer.rate, 100, 'born between ticks, it already advertises its rate');
  run(w, 20);
  assert.equal(shields.status.ion.n, 1, 'one stack decayed');
  assert.deepEqual([shields.status.ion.timer.v, shields.status.ion.timer.rate], [0, 100], 'the restart keeps the rate');
});

test('shots arriving in one tick resolve in spawn order, each seeing the shield left by the previous', () => {
  const w = duel();
  const a = shot('zap');
  const b = shot('zap');
  const c = shot('zap');
  const later = shot('pin');
  for (const s of [a, b, c]) s.flight.v = s.flight.max - 5000;
  w.shots.push(a, b, c, later);
  const ctx = recorder();
  tickShots(w, ctx);
  const pipeline = ctx.events.filter((e) => ['shieldHit', 'hit'].includes(e.type));
  assert.deepEqual(pipeline.map((e) => [e.type, e.shot]), [['shieldHit', a.id], ['shieldHit', b.id], ['hit', c.id]]);
  assert.deepEqual(w.shots, [later]);
  assert.equal(later.flight.v, 5000);
});

test('ion on an unshielded hit locks capacity at the end of the same tick', () => {
  const w = duel();
  const dot = w.ships.s2;
  dot.pools.shield.v = 0;
  const s = shot('fizz');
  s.flight.v = s.flight.max - 5000;
  w.shots.push(s);
  const ev = run(w, 1);
  assert.equal(dot.systems.shields.status.ion.n, 2);
  assert.equal(dot.systems.shields.power, 2);
  assert.equal(dot.stats.shieldLayers, 1);
  assert.ok(ev.some((e) => e.type === 'depowered' && e.ship === 's2' && e.system === 'shields'));
});

test('a shot at a wreck or a missing ship fizzles', () => {
  const w = duel();
  const ctx = recorder();
  w.ships.s2.out = 'hull';
  const s = shot('zap');
  resolveHit(w, s, ctx);
  resolveHit(w, shot('zap', { ship: 'nobody', room: 'A' }), ctx);
  assert.deepEqual(ctx.events[0], { type: 'fizzled', shot: s.id, ship: 's2' });
  assert.deepEqual(types(ctx.events), ['fizzled', 'fizzled']);
  assert.equal(w.ships.s2.pools.shield.v, 2);
});

test('applyEffects runs in EFFECT_ORDER whatever the payload key order', () => {
  const w = duel();
  const trio = w.ships.s1;
  const ctx = recorder();
  applyEffects(trio, 'W', { crew: 30, ion: 1, sysDamage: 9, hull: 2 }, ctx);
  assert.deepEqual(EFFECT_ORDER, ['hull', 'sysDamage', 'ion', 'crew']);
  assert.deepEqual(ctx.events, [
    { type: 'hullDamaged', ship: 's1', n: 2, hull: 10 },
    { type: 'systemDamaged', ship: 's1', system: 'weapons', damage: 4 },   // clamped at level
    { type: 'ionized', ship: 's1', system: 'weapons', n: 1 },
    { type: 'crewHurt', ship: 's1', crew: 'c5', hp: 70 },
  ]);
});

test('effects without a room system only reach the hull; hull never goes below 0', () => {
  const w = duel();
  const dot = w.ships.s2;
  const ctx = recorder();
  applyEffects(dot, null, { hull: 25, sysDamage: 1, ion: 1, crew: 10 }, ctx);
  assert.deepEqual(ctx.events, [{ type: 'hullDamaged', ship: 's2', n: 10, hull: 0 }]);
  assert.equal(dot.systems.shields.damage, 0);
});
