// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT, CONTENT_HASH } from '../shared/content/index.js';
import { validateContent } from '../shared/content/validate.js';
import { fnv1a } from '../shared/sim/index.js';
import { FIX } from './helpers/fixtures.js';

test('shipped content and the test fixture validate', () => {
  assert.deepEqual(validateContent(CONTENT), []);
  assert.deepEqual(validateContent(FIX), []);
});

test('CONTENT is deep-frozen and CONTENT_HASH is stable', () => {
  assert.ok(Object.isFrozen(CONTENT) && Object.isFrozen(CONTENT.ships.candlewick.map) && Object.isFrozen(CONTENT.devices.ember.onHit));
  assert.match(CONTENT_HASH, /^[0-9a-f]{8}$/);
  assert.equal(CONTENT_HASH, fnv1a(JSON.stringify(CONTENT)));
  assert.equal(CONTENT_HASH, fnv1a(JSON.stringify(structuredClone(CONTENT))));
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
});

test('content uses only original names', () => {
  assert.deepEqual(Object.keys(CONTENT.ships), ['candlewick', 'lampblack']);
  assert.deepEqual(Object.keys(CONTENT.devices), ['flint', 'ember', 'needle', 'hush']);
});

/**
 * Each case mutates a clone of CONTENT and expects an error containing the text.
 * @type {[string, (c: any) => void, string][]}
 */
const CASES = [
  ['ragged map row', (c) => { c.ships.candlewick.map[1] = 'EWWaSSH'; }, 'ships.candlewick: map row 1 has length 7'],
  ['room not a rectangle', (c) => { c.ships.lampblack.map[0] = '.SSaS'; }, 'room S is not a rectangle'],
  ['rooms not connected', (c) => { c.ships.lampblack.doors = [['S', 'E'], ['E', 'W']]; }, 'not connected'],
  ['explicit door not adjacent', (c) => { c.ships.lampblack.doors = [['S', 'H']]; }, 'door S,H does not join two adjacent rooms'],
  ['legend key not in map', (c) => { c.ships.candlewick.legend.Q = 'weapons'; }, 'legend: Q is not a room in the map'],
  ['legend unknown system', (c) => { c.ships.candlewick.legend.a = 'cloak'; }, 'legend: a maps to unknown system cloak'],
  ['system twice in legend', (c) => { c.ships.candlewick.legend.a = 'shields'; }, 'system shields appears more than once'],
  ['installed system without a room', (c) => { delete c.ships.candlewick.legend.H; }, 'systems.piloting has no room in the legend'],
  ['legend system not installed', (c) => { delete c.ships.candlewick.systems.piloting; }, 'legend: system piloting is not installed'],
  ['level above maxLevel', (c) => { c.ships.candlewick.systems.piloting.level = 4; }, 'systems.piloting.level must be between 1 and 3'],
  ['level 0', (c) => { c.ships.candlewick.systems.engines.level = 0; }, 'systems.engines.level must be between 1 and 8'],
  ['power above level', (c) => { c.ships.candlewick.systems.engines.power = 4; }, 'systems.engines.power must be between 0 and its level'],
  ['reactor draw too high', (c) => { c.ships.lampblack.reactor = 6; }, 'starting reactor draw 7 exceeds reactor 6'],
  ['host device power too high', (c) => { c.ships.candlewick.devices[1].on = true; c.ships.candlewick.systems.weapons.level = 2; }, 'starting device power on weapons exceeds its level'],
  ['unknown device', (c) => { c.ships.candlewick.devices.push({ bp: 'laser' }); }, 'devices[2]: unknown device laser'],
  ['device kind not hosted', (c) => { c.devices.flint.kind = 'drone'; }, 'devices[1]: no system hosts kind drone'],
  ['crew unknown room', (c) => { c.ships.candlewick.crew[0].room = 'Q'; }, 'crew[0]: unknown room Q'],
  ['too many crew in a room', (c) => { c.ships.candlewick.crew.push({ name: 'A', room: 'E' }, { name: 'B', room: 'E' }, { name: 'C', room: 'E' }); }, 'room E holds more crew than cells'],
  ['table length', (c) => { c.systems.shields.byPower.add.shieldLayers.pop(); }, 'systems.shields.byPower.add.shieldLayers has length 8, expected 9'],
  ['unmanned table length', (c) => { c.systems.piloting.unmanned.mul.evasion.push(90); }, 'systems.piloting.unmanned.mul.evasion has length 5, expected 4'],
  ['systemOrder missing', (c) => { c.systemOrder.pop(); }, 'systemOrder must list every system exactly once'],
  ['systemOrder duplicate', (c) => { c.systemOrder[3] = 'shields'; }, 'systemOrder must list every system exactly once'],
  ['unknown stat in unmanned mods', (c) => { c.systems.piloting.unmanned.mul.dodge = [0, 0, 0, 0]; }, 'systems.piloting: unknown stat dodge'],
  ['host without reactor', (c) => { c.systems.weapons.reactor = false; }, 'a system that hosts devices must draw reactor power'],
  ['unknown stat in mods', (c) => { c.systems.engines.manned.add.dodge = 5; }, 'systems.engines: unknown stat dodge'],
  ['weapon power 0', (c) => { c.devices.flint.power = 0; }, 'devices.flint.power must be a positive integer'],
  ['weapon shots missing', (c) => { delete c.devices.ember.shots; }, 'devices.ember.shots must be a positive integer'],
  ['gapMs negative', (c) => { c.devices.ember.gapMs = -1; }, 'devices.ember.gapMs must be an integer >= 0'],
  ['unknown effect', (c) => { c.devices.flint.onHit.fire = 1; }, 'devices.flint.onHit.fire is not a known effect'],
  ['effect amount', (c) => { c.devices.hush.onBlock.ion = 0; }, 'devices.hush.onBlock.ion must be a positive integer'],
  ['negative cost', (c) => { c.devices.needle.cost.missiles = -1; }, 'devices.needle.cost.missiles must be a non-negative integer'],
  ['unknown delivery', (c) => { c.devices.flint.delivery = 'beam'; }, 'devices.flint.delivery names unknown delivery beam'],
  ['bad target kind', (c) => { c.devices.flint.target = 'anyRoom'; }, "devices.flint.target must be 'enemyRoom'"],
  ['canMiss not boolean', (c) => { c.devices.flint.canMiss = 1; }, 'devices.flint.canMiss must be a boolean'],
  ['unknown status', (c) => { c.statuses.fire = { decayMs: 1000 }; }, 'statuses.fire is not a known status'],
  ['status decay', (c) => { c.statuses.ion.decayMs = 0; }, 'statuses.ion.decayMs must be a positive integer'],
  ['pool stat unknown', (c) => { c.base.pools.shield.max = 'layers'; }, 'base.pools.shield.max names unknown stat layers'],
  ['pool rate stat unknown', (c) => { c.base.pools.shield.ratePct = 'regen'; }, 'base.pools.shield.ratePct names unknown stat regen'],
  ['poolOrder', (c) => { c.base.poolOrder = ['hull']; }, 'base.poolOrder must list every pool exactly once'],
  ['base duration', (c) => { c.base.walkMs = 0; }, 'base.walkMs must be a positive integer'],
  ['blueprint stat unknown', (c) => { c.ships.lampblack.stats.armor = 2; }, 'ships.lampblack.stats: unknown stat armor'],
  ['negative store', (c) => { c.ships.candlewick.stores.missiles = -2; }, 'ships.candlewick.stores.missiles must be a non-negative integer'],
  ['ai field type', (c) => { c.ai.captain.thinkEveryTicks = '16'; }, 'ai.captain.thinkEveryTicks must be a positive integer'],
  ['ai weights', (c) => { delete c.ai.ace.weights.defense; }, 'ai.ace.weights must be { offense, defense } numbers'],
  ['ai missing field', (c) => { delete c.ai.novice.crew; }, 'ai.novice.crew must be a boolean'],
  ['non-integer number', (c) => { c.base.stats.evasion = 1.5; }, 'base.stats.evasion must be a safe integer'],
  ['non-integer table entry', (c) => { c.systems.engines.byPower.add.evasion[2] = 10.5; }, 'systems.engines.byPower.add.evasion.2 must be a safe integer'],
];

for (const [name, mutate, expected] of CASES) {
  test(`bad content: ${name}`, () => {
    const c = structuredClone(CONTENT);
    mutate(c);
    const errors = validateContent(c);
    assert.ok(errors.some((e) => e.includes(expected)), `expected "${expected}" in ${JSON.stringify(errors)}`);
  });
}

test('validateContent never throws on garbage', () => {
  assert.deepEqual(validateContent(/** @type {any} */ (null)), ['content must be an object']);
  const errors = validateContent(/** @type {any} */ ({ base: 3, systems: [], ships: { x: { map: 7 } }, devices: { d: null } }));
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes('map must be a non-empty array of strings')));
});
