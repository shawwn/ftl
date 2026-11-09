// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, projectEvent, perspectiveKey, hashWorld, computeStats, capacity, freeReactor, validTarget, deriveShip, applyEffects } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { shippedWorld, command } from './helpers/fixtures.js';

/** @type {import('../shared/sim/types.js').Perspective} */
const BLUE = { kind: 'side', side: 'blue' };

/** A mid-fight world with intent set on both sides. */
function fight() {
  const w = shippedWorld();
  command(w, 's1', [{ type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' } }, { type: 'setAuto', device: 'w1', on: true }], CONTENT);
  command(w, 's2', [{ type: 'setTarget', device: 'w6', target: { ship: 's1', room: 'S' } }], CONTENT);
  return w;
}

test('perspectiveKey', () => {
  assert.equal(perspectiveKey({ kind: 'all' }), 'all');
  assert.equal(perspectiveKey(BLUE), 'side:blue');
});

test('seed and rng are stripped for every perspective', () => {
  const w = fight();
  /** @type {import('../shared/sim/types.js').Perspective[]} */
  const all = [BLUE, { kind: 'side', side: 'red' }, { kind: 'all' }];
  for (const p of all) {
    const v = project(w, p);
    assert.ok(!('seed' in v) && !('rng' in v));
    assert.deepEqual(Object.keys(v), ['v', 'tick', 'nextId', 'ships', 'shots', 'outcome']);
  }
});

test('enemy want, on, target and auto are absent; own fields and everything else are present', () => {
  const w = fight();
  const v = project(w, BLUE);
  for (const sys of Object.values(v.ships.s2.systems)) assert.ok(!('want' in sys));
  for (const d of v.ships.s2.devices) for (const k of ['on', 'target', 'auto']) assert.ok(!(k in d), k);
  assert.deepEqual(v.ships.s2.devices[0], { id: 'w6', bp: 'hush', host: 'weapons', powered: true, charge: w.ships.s2.devices[0].charge });
  assert.equal(v.ships.s1.systems.shields.want, 2);
  assert.deepEqual(v.ships.s1.devices[0].target, { ship: 's2', room: 'S' });
  assert.equal(v.ships.s1.devices[0].auto, true);
  assert.equal(v.ships.s1.devices[1].on, false);
  const enemyRest = (ship) => ({ ...ship, systems: Object.fromEntries(Object.entries(ship.systems).map(([t, s]) => [t, { ...s, want: undefined }])), devices: undefined });
  assert.deepEqual(JSON.parse(JSON.stringify(enemyRest(v.ships.s2))), JSON.parse(JSON.stringify(enemyRest(w.ships.s2))), 'crew, power, stats, damage stay visible');
  const all = project(w, { kind: 'all' });
  assert.equal(all.ships.s2.systems.shields.want, 2);
  assert.deepEqual(all.ships.s2.devices[0].target, { ship: 's1', room: 'S' });
});

test('an unknown perspective kind fails closed', () => {
  const v = project(fight(), /** @type {any} */ ({ kind: 'spy' }));
  assert.ok(!('want' in v.ships.s1.systems.shields) && !('want' in v.ships.s2.systems.shields));
});

test('a view never aliases the world', () => {
  const w = fight();
  const h = hashWorld(w);
  const v = project(w, BLUE);
  v.ships.s1.systems.shields.power = 99;
  v.ships.s1.crew[0].cell[0] = 42;
  v.ships.s2.pools.hull.v = 0;
  v.shots.push(/** @type {any} */ ({}));
  v.ships.s1.devices[0].target.room = 'W';
  assert.equal(hashWorld(w), h);
});

test('view-safe helpers work on a serialized view, as the AI and UI use them', () => {
  const w = fight();
  const v = JSON.parse(JSON.stringify(project(w, BLUE)));
  for (const id of ['s1', 's2']) assert.deepEqual(computeStats(v.ships[id], CONTENT), w.ships[id].stats);
  assert.equal(capacity(v.ships.s2.systems.shields), 2);
  assert.equal(freeReactor(v.ships.s2, CONTENT), 0);
  assert.equal(validTarget(v, v.ships.s1, CONTENT.devices.ember, { ship: 's2', room: 'W' }, CONTENT), null);
  const foe = structuredClone(v.ships.s2);
  applyEffects(foe, 'S', CONTENT.devices.hush.onHit, { content: CONTENT, emit: () => {} });
  deriveShip(foe, CONTENT);
  assert.equal(foe.systems.shields.power, 0);
  assert.equal(foe.stats.shieldLayers, 0);
  assert.equal(w.ships.s2.systems.shields.power, 2);
});

test('projectEvent is the identity in M1', () => {
  const e = { type: 'hit', tick: 3, shot: 'p1', bp: 'flint', from: 's2', ship: 's1', room: 'W' };
  assert.equal(projectEvent(e, BLUE, shippedWorld()), e);
});
