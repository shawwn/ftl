// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, freeReactor, settlePower, addStatus, checkInvariants, project, deriveShip } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { FIX, duel, shippedWorld, command, dev, run } from './helpers/fixtures.js';

const powers = (ship) => Object.fromEntries(Object.entries(ship.systems).map(([t, s]) => [t, s.power]));
const lit = (ship) => ship.devices.map((d) => d.powered);
const settle = (ship, content = FIX) => {
  const events = [];
  settlePower(ship, content, (e) => events.push(e));
  return events;
};

test('createWorld is settled: intents granted from the reactor in systemOrder', () => {
  const w = duel();
  const s1 = w.ships.s1;
  assert.deepEqual(powers(s1), { shields: 2, engines: 1, weapons: 4 });
  assert.deepEqual(lit(s1), [true, true, true, false]);
  assert.equal(freeReactor(s1, FIX), 1);
  assert.deepEqual(checkInvariants(w, FIX), []);
  const c = shippedWorld().ships.s1;
  assert.deepEqual(powers(c), { piloting: 1, shields: 2, engines: 2, weapons: 2 });
  assert.equal(freeReactor(c, CONTENT), 1);   // 6 of 7 bars used
});

test('capacity subtracts damage and status penalties, never below 0', () => {
  const sys = { level: 4, power: 0, damage: 1, repair: { v: 0, max: 1, rate: 0 }, status: {} };
  assert.equal(capacity(sys), 3);
  addStatus(sys, 'ion', 2, FIX);
  assert.equal(capacity(sys), 1);
  addStatus(sys, 'ion', 5, FIX);
  assert.equal(capacity(sys), 0);
});

test('damage frees bars at once; repair restores toward want from free bars', () => {
  const w = duel();
  const s1 = w.ships.s1;
  command(w, 's1', [{ type: 'setPower', system: 'shields', level: 3 }]);
  assert.equal(s1.systems.shields.power, 3);
  assert.equal(freeReactor(s1, FIX), 0);
  s1.systems.shields.damage = 2;
  const ev = settle(s1);
  assert.equal(s1.systems.shields.power, 2);
  assert.equal(s1.systems.shields.want, 3);
  assert.equal(freeReactor(s1, FIX), 1);
  assert.deepEqual(ev, [{ type: 'depowered', ship: 's1', system: 'shields' }]);
  s1.systems.shields.damage = 1;
  assert.deepEqual(settle(s1), []);
  assert.equal(s1.systems.shields.power, 3);
  assert.equal(freeReactor(s1, FIX), 0);
});

test('ion frees bars at once and they return as stacks decay', () => {
  const w = duel();
  const s1 = w.ships.s1;
  command(w, 's1', [{ type: 'setPower', system: 'shields', level: 3 }]);
  addStatus(s1.systems.shields, 'ion', 2, FIX);
  settle(s1);
  assert.equal(s1.systems.shields.power, 2);
  assert.equal(freeReactor(s1, FIX), 1);
  run(w, 20);                                   // one stack decays (1000 ms)
  assert.equal(s1.systems.shields.status.ion.n, 1);
  assert.equal(s1.systems.shields.power, 3);
  run(w, 20);
  assert.deepEqual(s1.systems.shields.status, {});
});

test('restoration only from free bars: rerouted bars stay rerouted', () => {
  const w = duel();
  const s1 = w.ships.s1;
  command(w, 's1', [{ type: 'setPower', system: 'shields', level: 3 }]);
  s1.systems.shields.damage = 2;
  settle(s1);
  assert.deepEqual(command(w, 's1', [{ type: 'setPower', system: 'engines', level: 2 }]).results, [null]);
  assert.equal(s1.systems.engines.power, 2);
  assert.equal(freeReactor(s1, FIX), 0);
  s1.systems.shields.damage = 0;
  settle(s1);
  assert.equal(s1.systems.shields.power, 2, 'no bar is taken from engines');
  assert.equal(s1.systems.engines.power, 2);
  command(w, 's1', [{ type: 'setPower', system: 'engines', level: 1 }]);
  assert.equal(s1.systems.shields.power, 3, 'the freed bar flows back to shields want');
});

test('7.2 ion scenario on Candlewick: shields return to want 3 as ion decays', () => {
  const w = shippedWorld();
  const s1 = w.ships.s1;
  command(w, 's1', [{ type: 'setPower', system: 'shields', level: 3 }], CONTENT);
  assert.equal(s1.systems.shields.power, 3);
  addStatus(s1.systems.shields, 'ion', 3, CONTENT);   // level 4, three stacks: capacity 1
  settle(s1, CONTENT);
  assert.deepEqual([s1.systems.shields.want, s1.systems.shields.power, freeReactor(s1, CONTENT)], [3, 1, 2]);
  run(w, 99, CONTENT);
  assert.equal(s1.systems.shields.power, 1);
  run(w, 1, CONTENT);
  assert.equal(s1.systems.shields.power, 2);
  run(w, 100, CONTENT);
  assert.equal(s1.systems.shields.power, 3);
  assert.equal(freeReactor(s1, CONTENT), 0);
});

test('7.2 ion scenario with a reroute: needle takes a freed bar, shields climb only with what is left', () => {
  const w = shippedWorld();
  const s1 = w.ships.s1;
  command(w, 's1', [{ type: 'setPower', system: 'shields', level: 3 }], CONTENT);
  addStatus(s1.systems.shields, 'ion', 2, CONTENT);
  settle(s1, CONTENT);
  assert.deepEqual(command(w, 's1', [{ type: 'setDevicePower', device: 'w2', on: true }], CONTENT).results, [null]);
  run(w, 200, CONTENT);
  assert.deepEqual([s1.systems.shields.want, s1.systems.shields.power, freeReactor(s1, CONTENT)], [3, 2, 0]);
  assert.equal(dev(s1, 'w2').powered, true);
});

test('device shedding walks slot order; repair re-powers from free bars', () => {
  const w = duel();
  const s1 = w.ships.s1;
  const weapons = s1.systems.weapons;
  weapons.damage = 1;                                        // capacity 3: zap 1 + burst 2 fit, the second zap does not
  const ev = settle(s1);
  assert.deepEqual(lit(s1), [true, true, false, false]);
  assert.equal(weapons.power, 3);
  assert.deepEqual(ev, [{ type: 'depowered', ship: 's1', system: 'weapons' }, { type: 'depowered', ship: 's1', device: 'w3' }]);
  assert.equal(dev(s1, 'w3').on, true, 'intent survives');
  weapons.damage = 0;
  settle(s1);
  assert.deepEqual(lit(s1), [true, true, true, false]);
  weapons.damage = 2;                                        // capacity 2: zap 1, burst does not fit, zap 1 does
  settle(s1);
  assert.deepEqual(lit(s1), [true, false, true, false]);
  assert.equal(weapons.power, 2);
  weapons.damage = 0;
  settle(s1);
  assert.deepEqual(lit(s1), [true, true, true, false]);
});

test('subsystems: power is capacity and draws no reactor', () => {
  const w = shippedWorld();
  const s1 = w.ships.s1;
  const free = freeReactor(s1, CONTENT);
  s1.systems.piloting.damage = 1;
  const ev = settle(s1, CONTENT);
  assert.equal(s1.systems.piloting.power, 0);
  assert.equal(freeReactor(s1, CONTENT), free);
  assert.deepEqual(ev, [{ type: 'depowered', ship: 's1', system: 'piloting' }]);
  s1.systems.piloting.damage = 0;
  settle(s1, CONTENT);
  assert.equal(s1.systems.piloting.power, 1);
});

test('settlePower is idempotent', () => {
  const w = duel();
  const s1 = w.ships.s1;
  command(w, 's1', [{ type: 'setPower', system: 'shields', level: 4 }, { type: 'setDevicePower', device: 'w4', on: true }]);
  s1.systems.weapons.damage = 1;
  addStatus(s1.systems.shields, 'ion', 1, FIX);
  settle(s1);
  const once = JSON.stringify(s1);
  assert.deepEqual(settle(s1), []);
  assert.equal(JSON.stringify(s1), once);
});

test('tolerant readers: a redacted enemy keeps its power and only sheds', () => {
  const w = shippedWorld();
  const view = project(w, { kind: 'side', side: 'blue' });
  const foe = structuredClone(view.ships.s2);
  assert.equal(foe.systems.shields.want, undefined);
  assert.equal(foe.devices[0].on, undefined);
  const before = JSON.stringify(foe);
  settlePower(foe, CONTENT);
  assert.equal(JSON.stringify(foe), before);
  addStatus(foe.systems.weapons, 'ion', 1, CONTENT);
  deriveShip(foe, CONTENT);
  assert.deepEqual(lit(foe), [true, true, false]);
  assert.equal(foe.systems.weapons.power, 2);
});
