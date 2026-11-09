// @ts-check
// Every row of the reducer table (design doc 17.2); spectators never produce commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../shared/sim/index.js';
import { shippedWorld } from './helpers/fixtures.js';
import { initialUi, reduceUi, REASON_TEXT } from '../client/ui-state.js';

const YOU = { ship: 's1', side: 'blue' };
const SPECTATOR = { ship: null, side: null };

function blueView() {
  return project(shippedWorld(), { kind: 'side', side: 'blue' });
}

/** @param {any} ui @param {any} intent @param {any} [view] @param {any} [you] */
function reduce(ui, intent, view = blueView(), you = YOU) {
  return reduceUi(ui, intent, { view, you });
}

const IDLE = { mode: 'idle' };
const AIM_W1 = { mode: 'aiming', device: 'w1' };

test('initialUi is idle', () => {
  assert.deepEqual(initialUi(), IDLE);
});

test('idle, tapWeapon without a target: aiming', () => {
  assert.deepEqual(reduce(IDLE, { kind: 'tapWeapon', device: 'w1' }), { ui: AIM_W1, cmds: [] });
});

test('idle, tapWeapon with a target: clears it and stays idle', () => {
  const view = blueView();
  view.ships.s1.devices[0].target = { ship: 's2', room: 'S' };
  assert.deepEqual(reduce(IDLE, { kind: 'tapWeapon', device: 'w1' }, view), {
    ui: IDLE, cmds: [{ type: 'setTarget', device: 'w1', target: null }],
  });
});

test('aiming d, tapWeapon d: idle', () => {
  assert.deepEqual(reduce(AIM_W1, { kind: 'tapWeapon', device: 'w1' }), { ui: IDLE, cmds: [] });
});

test('aiming d, tapWeapon e: aiming e', () => {
  assert.deepEqual(reduce(AIM_W1, { kind: 'tapWeapon', device: 'w2' }), { ui: { mode: 'aiming', device: 'w2' }, cmds: [] });
});

test('aiming d, tapRoom on an enemy ship: setTarget, idle', () => {
  assert.deepEqual(reduce(AIM_W1, { kind: 'tapRoom', ship: 's2', room: 'S' }), {
    ui: IDLE, cmds: [{ type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' } }],
  });
});

test('aiming d, tapRoom on own ship: idle', () => {
  assert.deepEqual(reduce(AIM_W1, { kind: 'tapRoom', ship: 's1', room: 'S' }), { ui: IDLE, cmds: [] });
});

test('idle, tapCrew: crew selection', () => {
  assert.deepEqual(reduce(IDLE, { kind: 'tapCrew', crew: 'c3' }), { ui: { mode: 'crew', crew: ['c3'] }, cmds: [] });
});

test('crew sel, tapCrew toggles membership; an empty selection is idle', () => {
  const two = reduce({ mode: 'crew', crew: ['c3'] }, { kind: 'tapCrew', crew: 'c4' });
  assert.deepEqual(two, { ui: { mode: 'crew', crew: ['c3', 'c4'] }, cmds: [] });
  const one = reduce(two.ui, { kind: 'tapCrew', crew: 'c3' });
  assert.deepEqual(one, { ui: { mode: 'crew', crew: ['c4'] }, cmds: [] });
  assert.deepEqual(reduce(one.ui, { kind: 'tapCrew', crew: 'c4' }), { ui: IDLE, cmds: [] });
});

test('crew sel, tapRoom on own ship: moveCrew, idle', () => {
  assert.deepEqual(reduce({ mode: 'crew', crew: ['c4', 'c5'] }, { kind: 'tapRoom', ship: 's1', room: 'E' }), {
    ui: IDLE, cmds: [{ type: 'moveCrew', crew: ['c4', 'c5'], room: 'E' }],
  });
});

test('crew sel, tapRoom on an enemy ship: idle', () => {
  assert.deepEqual(reduce({ mode: 'crew', crew: ['c4'] }, { kind: 'tapRoom', ship: 's2', room: 'W' }), { ui: IDLE, cmds: [] });
});

test('crew selection drops crew no longer aboard', () => {
  const view = blueView();
  view.ships.s1.crew = view.ships.s1.crew.filter((c) => c.id !== 'c4');
  assert.deepEqual(reduce({ mode: 'crew', crew: ['c4', 'c5'] }, { kind: 'tapRoom', ship: 's1', room: 'E' }, view), {
    ui: IDLE, cmds: [{ type: 'moveCrew', crew: ['c5'], room: 'E' }],
  });
});

test('any, tapEmpty: idle', () => {
  for (const ui of [IDLE, AIM_W1, { mode: 'crew', crew: ['c3'] }]) {
    assert.deepEqual(reduce(ui, { kind: 'tapEmpty' }), { ui: IDLE, cmds: [] });
  }
});

test('any, power: setPower, state unchanged', () => {
  for (const ui of [IDLE, AIM_W1, { mode: 'crew', crew: ['c3'] }]) {
    assert.deepEqual(reduce(ui, { kind: 'power', system: 'shields', level: 3 }), {
      ui, cmds: [{ type: 'setPower', system: 'shields', level: 3 }],
    });
  }
});

test('any, toggleDevice: setDevicePower to the opposite of on', () => {
  assert.deepEqual(reduce(AIM_W1, { kind: 'toggleDevice', device: 'w1' }).cmds, [{ type: 'setDevicePower', device: 'w1', on: false }]);
  assert.deepEqual(reduce(IDLE, { kind: 'toggleDevice', device: 'w2' }).cmds, [{ type: 'setDevicePower', device: 'w2', on: true }]);
  assert.deepEqual(reduce(AIM_W1, { kind: 'toggleDevice', device: 'w1' }).ui, AIM_W1);
});

test('any, toggleAuto: setAuto to the opposite of auto', () => {
  assert.deepEqual(reduce(IDLE, { kind: 'toggleAuto', device: 'w1' }).cmds, [{ type: 'setAuto', device: 'w1', on: true }]);
  const view = blueView();
  view.ships.s1.devices[0].auto = true;
  assert.deepEqual(reduce(IDLE, { kind: 'toggleAuto', device: 'w1' }, view).cmds, [{ type: 'setAuto', device: 'w1', on: false }]);
});

test("any, key '1'..'9': as tapWeapon on the device at that index", () => {
  assert.deepEqual(reduce(IDLE, { kind: 'key', key: '2' }), { ui: { mode: 'aiming', device: 'w2' }, cmds: [] });
  assert.deepEqual(reduce(AIM_W1, { kind: 'key', key: '1' }), { ui: IDLE, cmds: [] });
  assert.deepEqual(reduce(AIM_W1, { kind: 'key', key: '9' }), { ui: AIM_W1, cmds: [] });
});

test("any, key 'Escape': as tapEmpty", () => {
  assert.deepEqual(reduce(AIM_W1, { kind: 'key', key: 'Escape' }), { ui: IDLE, cmds: [] });
  assert.deepEqual(reduce({ mode: 'crew', crew: ['c3'] }, { kind: 'key', key: 'Escape' }), { ui: IDLE, cmds: [] });
});

test('unknown intents and devices change nothing', () => {
  assert.deepEqual(reduce(AIM_W1, { kind: 'wave' }), { ui: AIM_W1, cmds: [] });
  assert.deepEqual(reduce(IDLE, { kind: 'tapWeapon', device: 'w6' }), { ui: IDLE, cmds: [] });
  assert.deepEqual(reduce(IDLE, { kind: 'tapCrew', crew: 'c9' }), { ui: IDLE, cmds: [] });
});

test('spectators never produce commands', () => {
  const view = project(shippedWorld(), { kind: 'all' });
  view.ships.s1.devices[0].target = { ship: 's2', room: 'S' };
  const intents = [
    { kind: 'tapWeapon', device: 'w1' }, { kind: 'tapRoom', ship: 's2', room: 'S' }, { kind: 'tapCrew', crew: 'c3' },
    { kind: 'power', system: 'shields', level: 2 }, { kind: 'toggleDevice', device: 'w1' },
    { kind: 'toggleAuto', device: 'w1' }, { kind: 'tapEmpty' }, { kind: 'key', key: '1' }, { kind: 'key', key: 'Escape' },
  ];
  for (const ui of [IDLE, AIM_W1, { mode: 'crew', crew: ['c3'] }]) {
    for (const intent of intents) assert.deepEqual(reduce(ui, intent, view, SPECTATOR), { ui: IDLE, cmds: [] });
  }
});

test('every reason has text without em or en dashes', () => {
  const reasons = ['unknown-command', 'no-ship', 'ship-out', 'no-system', 'not-powerable', 'bad-level', 'damaged',
    'no-reactor', 'no-device', 'bad-arg', 'no-capacity', 'no-target', 'friendly', 'no-room', 'no-ammo', 'no-crew',
    'room-full', 'forbidden', 'spectator', 'ended', 'bad-message', 'hello-first', 'upgrade-required', 'rate-limited',
    'bad-preset', 'bad-opts', 'busy', 'no-match', 'bad-ship', 'seat-full', 'not-in-match', 'not-ended'];
  for (const r of reasons) assert.ok(REASON_TEXT[r], r);
  for (const text of Object.values(REASON_TEXT)) assert.doesNotMatch(text, /[\u2013\u2014]/);
  assert.equal(REASON_TEXT['no-reactor'], 'No free reactor power');
});
