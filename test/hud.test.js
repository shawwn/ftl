// @ts-check
// The HUD's pure helpers (client/hud.js). A weapon card asks the sim's own fire rule (fireBlock) instead of
// restating it, so a weapon that cannot pay never reads Firing or Ready (elegance-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { weaponState, pendingKeys } from '../client/hud.js';
import { shippedWorld, command, run } from './helpers/fixtures.js';

/** Candlewick's Long Needle (w2) on auto at Lampblack's shields, Ember off, with `missiles` left. */
function needleWorld(missiles) {
  const w = shippedWorld();
  w.ships.s1.stores.missiles = missiles;
  command(w, 's1', [
    { type: 'setDevicePower', device: 'w1', on: false },
    { type: 'setDevicePower', device: 'w2', on: true },
    { type: 'setAuto', device: 'w2', on: true },
  ], CONTENT);
  return w;
}

/** @param {any} w */
const cardOf = (w) => {
  const view = project(w, { kind: 'side', side: 'blue' });
  const ship = view.ships.s1;
  return weaponState(view, ship, ship.devices[1], CONTENT, 0);
};

test('a charged Needle with a target and missiles reads Firing; without a target, Ready', () => {
  const w = needleWorld(8);
  run(w, 300, CONTENT);
  assert.deepEqual([cardOf(w).state, cardOf(w).word], ['ready', 'Ready']);
  w.ships.s1.devices[1].charge.v = w.ships.s1.devices[1].charge.max;
  w.ships.s1.devices[1].target = { ship: 's2', room: 'S' };
  assert.deepEqual([cardOf(w).state, cardOf(w).word], ['ready', 'Firing']);
});

test('a charged Needle on auto with no missiles never reads Firing or Ready', () => {
  const w = needleWorld(1);
  command(w, 's1', [{ type: 'setTarget', device: 'w2', target: { ship: 's2', room: 'S' } }], CONTENT);
  w.ships.s1.devices[1].charge.v = w.ships.s1.devices[1].charge.max;
  run(w, 400, CONTENT);
  const needle = w.ships.s1.devices[1];
  assert.equal(w.ships.s1.stores.missiles, 0, 'the last missile was spent');
  assert.deepEqual(needle.target, { ship: 's2', room: 'S' }, 'auto keeps the target');
  assert.equal(needle.charge.v, needle.charge.max, 'charged, but it cannot pay');
  const card = cardOf(w);
  assert.equal(card.state, 'empty');
  assert.notEqual(card.word, 'Firing');
  assert.notEqual(card.word, 'Ready');
});

test('pendingKeys names the controls a pending command touches', () => {
  const pending = new Map([[1, { c: { type: 'setPower', system: 'shields', level: 2 } }],
    [2, { c: { type: 'moveCrew', crew: ['c3', 'c4'], room: 'E' } }]]);
  assert.deepEqual([...pendingKeys(pending)], ['sys:shields', 'crew:c3', 'crew:c4']);
});
