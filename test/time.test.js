// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICK_MS, meter, tickMeter, isFull, resetMeter, meterAt, msToFull } from '../shared/sim/index.js';

test('TICK_MS and meter shape', () => {
  assert.equal(TICK_MS, 50);
  assert.deepEqual(meter(12000), { v: 0, max: 1200000, rate: 0 });
  assert.deepEqual(meter(1000, -25000), { v: -25000, max: 100000, rate: 0 });
  assert.deepEqual(meter(1000, 0, 100), { v: 0, max: 100000, rate: 100 }, 'born at the rate its owner applies next');
});

test('tickMeter adds TICK_MS * ratePct, stores the rate, reports fullness', () => {
  const m = meter(1000);
  assert.equal(tickMeter(m, 100), false);
  assert.deepEqual(m, { v: 5000, max: 100000, rate: 100 });
  for (let i = 0; i < 18; i++) assert.equal(tickMeter(m, 100), false);
  assert.equal(tickMeter(m, 100), true);
  assert.equal(m.v, 100000);
  assert.ok(isFull(m));
});

test('tickMeter clamps at max', () => {
  const m = meter(1000, 99000);
  assert.equal(tickMeter(m, 300), true);
  assert.equal(m.v, 100000);
  tickMeter(m, 300);
  assert.equal(m.v, 100000);
});

test('Ember Volley manned (110 percent) is full after 219 ticks', () => {
  const m = meter(12000);
  let ticks = 0;
  while (!tickMeter(m, 110)) ticks++;
  assert.equal(ticks + 1, 219);
  assert.equal(m.rate, 110);
});

test('negative start expresses delay', () => {
  const m = meter(1000, -25000);
  for (let i = 0; i < 5; i++) tickMeter(m, 100);
  assert.equal(m.v, 0);
  let ticks = 0;
  while (!tickMeter(m, 100)) ticks++;
  assert.equal(ticks + 1, 20);
});

test('negative rate drains and clamps at 0 without disturbing a delayed meter', () => {
  const m = meter(1000, 20000);
  tickMeter(m, -300);
  assert.deepEqual(m, { v: 5000, max: 100000, rate: -300 });
  tickMeter(m, -300);
  assert.equal(m.v, 0);
  assert.ok(!Object.is(m.v, -0));
  const delayed = meter(1000, -5000);
  tickMeter(delayed, -300);
  assert.equal(delayed.v, -5000);
});

test('resetMeter zeroes v and rate', () => {
  const m = { v: 70000, max: 100000, rate: 110 };
  resetMeter(m);
  assert.deepEqual(m, { v: 0, max: 100000, rate: 0 });
});

test('meterAt extrapolates v + rate * elapsedMs and clamps to 0..1', () => {
  const m = { v: 50000, max: 100000, rate: 100 };
  assert.equal(meterAt(m), 0.5);
  assert.equal(meterAt(m, 250), 0.75);
  assert.equal(meterAt(m, 10000), 1);
  assert.equal(meterAt({ v: -50000, max: 100000, rate: 100 }, 100), 0);
  assert.equal(meterAt({ v: 50000, max: 100000, rate: -300 }, 100), 0.2);
});

test('msToFull', () => {
  assert.equal(msToFull({ v: 50000, max: 100000, rate: 100 }), 500);
  assert.equal(msToFull({ v: 0, max: 1200000, rate: 110 }), 1200000 / 110);
  assert.equal(msToFull({ v: 50000, max: 100000, rate: 0 }), Infinity);
  assert.equal(msToFull({ v: 50000, max: 100000, rate: -300 }), Infinity);
  assert.equal(msToFull({ v: 100000, max: 100000, rate: 100 }), 0);
});
