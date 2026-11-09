// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRng, rngNext, roll, makeRng } from '../shared/sim/index.js';

/** Reference mulberry32 (the published algorithm), scaled back to u32. */
function reference(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

test('rngNext matches reference mulberry32 for a fixed seed', () => {
  const world = { rng: seedRng(7) };
  const ref = reference(7);
  const seq = Array.from({ length: 1000 }, () => rngNext(world));
  assert.deepEqual(seq, Array.from({ length: 1000 }, ref));
  assert.ok(seq.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32));
  assert.ok(Number.isSafeInteger(world.rng) && world.rng >= 0 && world.rng < 2 ** 32);
});

test('fixed sequence for seed 1 (starts at the published mulberry32 value 0.6270739405881613)', () => {
  const world = { rng: seedRng(1) };
  assert.deepEqual([rngNext(world), rngNext(world), rngNext(world)], [2693262067, 11749833, 2265367787]);
  assert.equal(2693262067 / 2 ** 32, 0.6270739405881613);
});

test('seedRng: u32, and a fixed nonzero constant for 0', () => {
  assert.equal(seedRng(5), 5);
  assert.equal(seedRng(2 ** 32 + 5), 5);
  assert.notEqual(seedRng(0), 0);
  assert.equal(seedRng(0), seedRng(0));
});

test('roll always draws exactly once, whatever pct is', () => {
  for (const pct of [-50, 0, 1, 50, 99, 100, 250]) {
    const a = { rng: seedRng(42) };
    const b = { rng: seedRng(42) };
    roll(a, pct);
    rngNext(b);
    assert.equal(a.rng, b.rng, `pct ${pct}`);
  }
});

test('roll(0) is always false and roll(100) always true', () => {
  const world = { rng: seedRng(3) };
  for (let i = 0; i < 2000; i++) {
    assert.equal(roll(world, 0), false);
    assert.equal(roll(world, 100), true);
    assert.equal(roll(world, -10), false);
    assert.equal(roll(world, 1000), true);
  }
});

test('roll(pct) hits about pct percent of the time', () => {
  const world = { rng: seedRng(11) };
  let hits = 0;
  for (let i = 0; i < 20000; i++) if (roll(world, 30)) hits++;
  assert.ok(hits > 5600 && hits < 6400, `hits ${hits}`);
});

test('makeRng: standalone, deterministic, floats in [0, 1)', () => {
  const a = makeRng(9);
  const b = makeRng(9);
  const xs = Array.from({ length: 500 }, a);
  assert.deepEqual(xs, Array.from({ length: 500 }, b));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, makeRng(10)));
});
