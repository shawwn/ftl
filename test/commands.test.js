// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandScope, applyCommands, freeReactor, hashWorld, project } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { FIX, duel, shippedWorld, command, dev } from './helpers/fixtures.js';

// trio s1: w1 zap, w2 burst, w3 zap (on), w4 pin (off, costs a missile); crew c5 Ada, c6 Bo, c7 Cy.
// dot s2: crew c8 Pell, room A. trio starts with shields 2, engines 1, weapons 4: 1 reactor bar free.

/** Results of one command on a fresh (or given) duel world. */
const one = (cmd, w = duel(), ship = 's1') => command(w, ship, [cmd]).results[0];

test('scopes', () => {
  assert.deepEqual(Object.keys(COMMANDS), ['setPower', 'setDevicePower', 'setTarget', 'setAuto', 'moveCrew']);
  assert.deepEqual(Object.keys(COMMANDS).map(commandScope), ['power', 'weapons', 'weapons', 'weapons', 'crew']);
  assert.equal(commandScope('jump'), null);
  assert.equal(commandScope('constructor'), null);
  assert.equal(commandScope(undefined), null);
});

test('applyCommands: envelope reasons and results aligned with input', () => {
  const w = duel();
  w.ships.s2.out = 'hull';
  const { results, events } = applyCommands(w, [
    { type: 'setPower', ship: 's1', system: 'shields', level: 3 },
    { type: 'warp', ship: 's1' },
    { type: 'toString', ship: 's1' },
    null,
    { type: 'setAuto', ship: 's9', device: 'w1', on: true },
    { type: 'setAuto', ship: 'constructor', device: 'w1', on: true },
    /** @type {any} */ ({ type: 'setAuto', device: 'w1', on: true }),
    { type: 'setAuto', ship: 's2', device: 'w1', on: true },
    { type: 'setPower', ship: 's1', system: 'nope', level: 1 },
    { type: 'setAuto', ship: 's1', device: 'w1', on: true },
  ], FIX);
  assert.deepEqual(results, [null, 'unknown-command', 'unknown-command', 'unknown-command', 'no-ship', 'no-ship', 'no-ship', 'ship-out', 'no-system', null]);
  assert.equal(dev(w.ships.s1, 'w1').auto, true);
  assert.deepEqual(applyCommands(w, [], FIX), { results: [], events: [] });
  assert.ok(events.every((e) => e.tick === w.tick));
});

test('setPower: valid raise, partial grant, lower, and idempotence', () => {
  const w = duel();
  const sh = w.ships.s1.systems.shields;
  assert.equal(one({ type: 'setPower', system: 'shields', level: 3 }, w), null);
  assert.deepEqual([sh.want, sh.power, freeReactor(w.ships.s1, FIX)], [3, 3, 0]);
  const h = hashWorld(w);
  assert.equal(one({ type: 'setPower', system: 'shields', level: 3 }, w), null);
  assert.equal(hashWorld(w), h, 'absolute setter: repeating it changes nothing');
  const { results, events } = command(w, 's1', [{ type: 'setPower', system: 'shields', level: 1 }]);
  assert.deepEqual(results, [null]);
  assert.deepEqual([sh.want, sh.power], [1, 1]);
  assert.deepEqual(events, [{ tick: 0, type: 'depowered', ship: 's1', system: 'shields' }]);
  const w2 = duel();
  assert.equal(one({ type: 'setPower', system: 'shields', level: 4 }, w2), null);
  assert.deepEqual([w2.ships.s1.systems.shields.want, w2.ships.s1.systems.shields.power], [3, 3], 'want = granted');
  assert.equal(one({ type: 'setPower', system: 'engines', level: 0 }, w2), null);
  assert.equal(w2.ships.s1.systems.shields.power, 3, 'a clipped request does not climb later');
});

test('setPower: no-reactor and damaged', () => {
  const w = duel();
  one({ type: 'setPower', system: 'shields', level: 3 }, w);
  assert.equal(one({ type: 'setPower', system: 'shields', level: 4 }, w), 'no-reactor');
  assert.equal(w.ships.s1.systems.shields.want, 3, 'a rejected command changes nothing');
  const d = duel();
  d.ships.s1.systems.shields.damage = 2;
  command(d, 's1', []);
  assert.equal(one({ type: 'setPower', system: 'shields', level: 3 }, d), 'damaged');
  const ion = duel();
  ion.ships.s1.systems.shields.status.ion = { n: 2, timer: { v: 0, max: 100000, rate: 0 } };
  command(ion, 's1', []);
  assert.equal(one({ type: 'setPower', system: 'shields', level: 4 }, ion), 'damaged');
});

test('setPower: no-system, not-powerable, bad-level', () => {
  for (const system of ['piloting', 'nope', 'constructor', 5, undefined]) {
    assert.equal(one({ type: 'setPower', system, level: 1 }), 'no-system', String(system));
  }
  assert.equal(one({ type: 'setPower', system: 'weapons', level: 1 }), 'not-powerable', 'host system');
  const c = shippedWorld();
  assert.equal(command(c, 's1', [{ type: 'setPower', system: 'piloting', level: 1 }], CONTENT).results[0], 'not-powerable', 'subsystem');
  for (const level of [-1, 5, 1.5, '2', null, undefined, NaN]) {
    assert.equal(one({ type: 'setPower', system: 'shields', level }), 'bad-level', String(level));
  }
});

test('setDevicePower: off, on, already on, no-device, bad-arg', () => {
  const w = duel();
  const s1 = w.ships.s1;
  const { results, events } = command(w, 's1', [{ type: 'setDevicePower', device: 'w3', on: false }]);
  assert.deepEqual(results, [null]);
  assert.deepEqual([dev(s1, 'w3').on, dev(s1, 'w3').powered, s1.systems.weapons.power], [false, false, 3]);
  assert.deepEqual(events.map((e) => e.device ?? e.system), ['weapons', 'w3']);
  assert.equal(one({ type: 'setDevicePower', device: 'w3', on: false }, w), null, 'off again is harmless');
  assert.equal(one({ type: 'setDevicePower', device: 'w3', on: true }, w), null);
  assert.deepEqual([dev(s1, 'w3').on, dev(s1, 'w3').powered], [true, true]);
  const h = hashWorld(w);
  assert.equal(one({ type: 'setDevicePower', device: 'w1', on: true }, w), null);
  assert.equal(hashWorld(w), h, 'on and already on: no-op');
  assert.equal(one({ type: 'setDevicePower', device: 'w99', on: true }), 'no-device');
  for (const on of ['yes', 1, null, undefined]) assert.equal(one({ type: 'setDevicePower', device: 'w1', on }), 'bad-arg');
});

test('setDevicePower: no-capacity and no-reactor', () => {
  const w = duel();
  assert.equal(one({ type: 'setDevicePower', device: 'w4', on: true }, w), 'no-capacity', 'weapons 4 of 4 used');
  one({ type: 'setDevicePower', device: 'w3', on: false }, w);
  w.ships.s1.systems.weapons.damage = 1;
  command(w, 's1', []);
  assert.equal(one({ type: 'setDevicePower', device: 'w3', on: true }, w), 'no-capacity', 'damage leaves 3, all used');
  const r = duel();
  one({ type: 'setDevicePower', device: 'w3', on: false }, r);
  one({ type: 'setPower', system: 'shields', level: 4 }, r);
  assert.equal(freeReactor(r.ships.s1, FIX), 0);
  assert.equal(one({ type: 'setDevicePower', device: 'w3', on: true }, r), 'no-reactor');
  assert.equal(dev(r.ships.s1, 'w3').on, false);
});

test('setTarget: set, clear, no-device, bad-arg', () => {
  const w = duel();
  const w1 = dev(w.ships.s1, 'w1');
  assert.equal(one({ type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'A', extra: 1 } }, w), null);
  assert.deepEqual(w1.target, { ship: 's2', room: 'A' });
  assert.equal(one({ type: 'setTarget', device: 'w1', target: null }, w), null);
  assert.equal(w1.target, null);
  assert.equal(one({ type: 'setTarget', device: 'w9', target: null }), 'no-device');
  for (const target of [undefined, 'A', { ship: 's2' }, { ship: 1, room: 'A' }, { ship: 's2', room: ['A'] }]) {
    assert.equal(one({ type: 'setTarget', device: 'w1', target }), 'bad-arg', JSON.stringify(target));
  }
});

test('setTarget: validTarget reasons and no-ammo', () => {
  const t = (target, w) => one({ type: 'setTarget', device: 'w1', target }, w);
  assert.equal(t({ ship: 's9', room: 'A' }), 'no-ship');
  assert.equal(t({ ship: 'constructor', room: 'A' }), 'no-ship');
  assert.equal(t({ ship: 's1', room: 'W' }), 'friendly');
  assert.equal(t({ ship: 's2', room: 'Z' }), 'no-room');
  assert.equal(t({ ship: 's2', room: 'constructor' }), 'no-room');
  const out = duel();
  out.ships.s2.out = 'crew';
  assert.equal(t({ ship: 's2', room: 'A' }, out), 'ship-out');
  const w = duel();
  assert.equal(one({ type: 'setTarget', device: 'w4', target: { ship: 's2', room: 'A' } }, w), null, 'an unpowered device can aim');
  w.ships.s1.stores.missiles = 0;
  assert.equal(one({ type: 'setTarget', device: 'w4', target: { ship: 's2', room: 'A' } }, w), 'no-ammo');
  assert.equal(one({ type: 'setTarget', device: 'w4', target: null }, w), null, 'clearing never needs ammo');
});

test('setAuto: valid, no-device, bad-arg', () => {
  const w = duel();
  assert.equal(one({ type: 'setAuto', device: 'w2', on: true }, w), null);
  assert.equal(dev(w.ships.s1, 'w2').auto, true);
  assert.equal(one({ type: 'setAuto', device: 'w2', on: false }, w), null);
  assert.equal(dev(w.ships.s1, 'w2').auto, false);
  assert.equal(one({ type: 'setAuto', device: 'nope', on: true }), 'no-device');
  assert.equal(one({ type: 'setAuto', device: 'w2', on: 'true' }), 'bad-arg');
});

test('moveCrew: valid, bad-arg, no-crew, no-room, room-full', () => {
  const w = duel();
  assert.equal(one({ type: 'moveCrew', crew: ['c5'], room: 'S' }, w), null);
  assert.equal(w.ships.s1.crew[0].task, 'walk', 'tasks refresh in the batch derive');
  assert.equal(one({ type: 'moveCrew', crew: ['c7'], room: 'E' }), null, 'already there counts');
  const many = Array.from({ length: 17 }, () => 'c5');
  for (const crew of ['c5', [], many, [5], undefined]) {
    assert.equal(one({ type: 'moveCrew', crew, room: 'S' }), 'bad-arg', JSON.stringify(crew));
  }
  assert.equal(one({ type: 'moveCrew', crew: Array.from({ length: 16 }, () => 'c5'), room: 'S' }), null);
  assert.equal(one({ type: 'moveCrew', crew: ['c8'], room: 'S' }), 'no-crew', 'crew of another ship');
  assert.equal(one({ type: 'moveCrew', crew: ['c5', 'zz'], room: 'S' }), 'no-crew');
  for (const room of ['Z', 'A', 5, 'constructor', undefined]) {
    assert.equal(one({ type: 'moveCrew', crew: ['c5'], room }), 'no-room', String(room));
  }
  const full = duel();
  one({ type: 'moveCrew', crew: ['c5'], room: 'E' }, full);
  assert.equal(one({ type: 'moveCrew', crew: ['c6'], room: 'E' }, full), 'room-full');
});

test('check is pure and works on views (UI affordances)', () => {
  const w = shippedWorld();
  const view = project(w, { kind: 'side', side: 'blue' });
  const s1 = view.ships.s1;
  const before = JSON.stringify(view);
  assert.equal(COMMANDS.setTarget.check(view, s1, { type: 'setTarget', ship: 's1', device: 'w1', target: { ship: 's2', room: 'S' } }, CONTENT), null);
  assert.equal(COMMANDS.setTarget.check(view, s1, { type: 'setTarget', ship: 's1', device: 'w1', target: { ship: 's1', room: 'S' } }, CONTENT), 'friendly');
  assert.equal(COMMANDS.setPower.check(view, s1, { type: 'setPower', ship: 's1', system: 'shields', level: 9 }, CONTENT), 'bad-level');
  assert.equal(COMMANDS.moveCrew.check(view, s1, { type: 'moveCrew', ship: 's1', crew: ['c3'], room: 'a' }, CONTENT), null);
  assert.equal(JSON.stringify(view), before);
});

test('a batch gives the same world as the same commands one at a time (replay merge property)', () => {
  const cmds = [
    { type: 'setDevicePower', ship: 's1', device: 'w3', on: false },
    { type: 'setPower', ship: 's1', system: 'shields', level: 4 },
    { type: 'moveCrew', ship: 's1', crew: ['c6', 'c7'], room: 'W' },
    { type: 'setTarget', ship: 's1', device: 'w2', target: { ship: 's2', room: 'A' } },
  ];
  const a = duel();
  const b = duel();
  applyCommands(a, cmds, FIX);
  for (const c of cmds) applyCommands(b, [c], FIX);
  assert.equal(hashWorld(a), hashWorld(b));
});

test('lowering then raising a pool-backing system loses the layer, in one batch or two (sim-1)', () => {
  const cmds = [
    { type: 'setPower', ship: 's1', system: 'shields', level: 0 },
    { type: 'setPower', ship: 's1', system: 'shields', level: 2 },
  ];
  const a = duel();
  const b = duel();
  assert.deepEqual(a.ships.s1.pools.shield, b.ships.s1.pools.shield);
  assert.equal(a.ships.s1.pools.shield.v, 1, 'one layer up to start with');
  applyCommands(a, cmds, FIX);
  for (const c of cmds) applyCommands(b, [c], FIX);
  assert.equal(hashWorld(a), hashWorld(b), 'the batch boundary carries no information');
  assert.equal(a.ships.s1.pools.shield.v, 0, 'the layer is gone and must regenerate');
  assert.equal(a.ships.s1.pools.shield.max, 1);
});
