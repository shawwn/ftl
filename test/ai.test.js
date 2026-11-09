// @ts-check
// AI tests (design doc 19.3): estimates and planners on tiny fixture ships, and the occupant's cadence and
// reaction delay. AI-vs-AI games through the real Match are in duel.test.js and determinism.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, project, applyCommands, advance, makeRng, freeReactor } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { validateContent } from '../shared/content/validate.js';
import { think, bestPower, planPower, planWeapons, planCrew } from '../shared/ai/brain.js';
import { dps, utility, imagine, imagineHit, poweredDevices, threatOf, hitGains } from '../shared/ai/estimate.js';
import { aiOccupant } from '../shared/ai/occupant.js';
import { FIX, command } from './helpers/fixtures.js';

/** @typedef {import('../shared/sim/types.js').World} World */
/** @typedef {import('../shared/sim/types.js').Content} Content */
/** @typedef {import('../shared/sim/types.js').AiProfile} AiProfile */

const { captain, drifter, ace } = CONTENT.ai;

/**
 * FIX plus two ships built for AI decisions. Zap never misses, so evasion is worthless against it.
 * duo:  'SSEW' / 'SSEW'; shields 4 (none wanted), engines 2 (both wanted), weapons 2 with two zaps on,
 *       reactor 4 (all used); Ann mans S, Ben mans E, W is empty.
 * fort: 'SSWC' / 'SSWC'; shields 4 at full power (2 layers), an empty weapons room, corridor C; no threat.
 * @type {Content}
 */
const AIFIX = {
  ...FIX,
  ships: {
    ...FIX.ships,
    duo: {
      name: 'Duo', map: ['SSEW', 'SSEW'], legend: { S: 'shields', E: 'engines', W: 'weapons' }, reactor: 4,
      systems: { shields: { level: 4, power: 0 }, engines: { level: 2, power: 2 }, weapons: { level: 2 } },
      devices: [{ bp: 'zap', on: true }, { bp: 'zap', on: true }], stores: {},
      crew: [{ name: 'Ann', room: 'S' }, { name: 'Ben', room: 'E' }],
    },
    fort: {
      name: 'Fort', map: ['SSWC', 'SSWC'], legend: { S: 'shields', W: 'weapons' }, reactor: 4,
      systems: { shields: { level: 4, power: 4 }, weapons: { level: 1 } }, devices: [], stores: {},
      crew: [{ name: 'Cal', room: 'C' }],
    },
  },
  ai: { captain, drifter, ace },
};

/** s1 (blue) vs s2 (red) on AIFIX. duo s1 gets w1, w2, c3 Ann, c4 Ben. */
const world2 = (a = 'duo', b = 'duo', seed = 1) =>
  createWorld({ seed, ships: [{ id: 's1', bp: a, side: 'blue' }, { id: 's2', bp: b, side: 'red' }] }, AIFIX);

/** The snapshot message a host would send to a side, parsed back from its text. */
const snapOf = (/** @type {World} */ w, side = 'blue', extra = {}) => JSON.parse(JSON.stringify({
  t: 'snap', round: 1, tick: w.tick, phase: 'running', paused: false, roster: [],
  view: project(w, { kind: 'side', side }), ev: [], ...extra,
}));

const mem = (seed = 1) => ({ rng: makeRng(seed), nextThink: 0 });
const freeReactorOf = (/** @type {World} */ w) => freeReactor(w.ships.s1, AIFIX);
const W = AIFIX.base.stats.hullMax;   // 10: both fixture hulls

test('the AI fixture is valid content', () => {
  assert.deepEqual(validateContent(AIFIX), []);
});

test('dps: volleys strip layers first, pierce passes, chargePct sets the cycle, no ammo means no damage', () => {
  const w = createWorld({ seed: 1, ships: [{ id: 's1', bp: 'trio', side: 'blue' }, { id: 's2', bp: 'dot', side: 'red' }] }, FIX);
  const [trio, dot] = [w.ships.s1, w.ships.s2];
  assert.equal(dot.stats.shieldLayers, 2);
  assert.equal(trio.stats.chargePct, 110, 'Ada mans weapons');
  const [zap, burst, zap2, pin] = trio.devices;
  // zap + burst + zap = 5 never-missing shots; 2 are blocked; the slowest (burst, 2000 ms) sets the cycle.
  assert.ok(Math.abs(dps(trio, dot, FIX, [zap, burst, zap2]) - 3 / (2000 / 1.1 / 1000)) < 1e-9);
  assert.equal(dps(trio, dot, FIX, [zap]), 0, 'one shot into two layers does nothing');
  assert.ok(Math.abs(dps(trio, dot, FIX, [pin]) - 2 * 1.1) < 1e-9, 'pierce 99 ignores layers');
  assert.equal(dps(trio, dot, FIX, []), 0);
  assert.deepEqual(poweredDevices(trio), [zap, burst, zap2]);
  const dry = imagine(trio, FIX, (s) => { s.stores.missiles = 0; });
  assert.equal(dps(dry, dot, FIX, [dry.devices[3]]), 0, 'a launcher without missiles is worth nothing');
  assert.equal(dps(dot, trio, FIX), 0, 'no devices');
});

test('utility scores both terms against the foe as it could stand within one command (threatOf)', () => {
  const w = world2('duo', 'duo');
  const v = snapOf(w).view;
  const [me, foe] = [v.ships.s1, v.ships.s2];
  assert.equal(dps(me, foe, AIFIX), 2, 'two zaps into no shields');
  const threat = threatOf(foe, AIFIX);
  // Reactor 4: its two zaps first (2 bars), then shields take the 2 left (one layer); engines get none.
  assert.deepEqual([threat.systems.weapons.power, threat.systems.shields.power, threat.systems.engines.power], [2, 2, 0]);
  assert.equal(threat.stats.shieldLayers, 1);
  assert.equal(threatOf(foe, AIFIX), threat, 'memoized per foe object');
  assert.ok(Math.abs(utility(me, foe, AIFIX, captain.weights) - (1 / W - 2 / W)) < 1e-12, 'my zaps meet the layer it can raise');
  const disarmed = imagine(foe, AIFIX, (s) => { for (const d of s.devices) d.powered = false; });
  assert.equal(dps(disarmed, me, AIFIX), 0, 'nothing powered right now');
  assert.equal(utility(me, disarmed, AIFIX, captain.weights), utility(me, foe, AIFIX, captain.weights), 'but it can power both within one command');
  const bare = imagine(foe, AIFIX, (s) => { s.systems.shields.want = 0; s.systems.engines.want = 0; for (const d of s.devices) d.on = false; });
  assert.equal(bare.stats.shieldLayers, 0);
  assert.equal(utility(me, bare, AIFIX, captain.weights), utility(me, foe, AIFIX, captain.weights),
    'momentarily dropped shields and weapons change nothing: they are one command away (sim-2)');
  const broken = imagine(foe, AIFIX, (s) => { s.systems.weapons.damage = 1; });
  assert.equal(threatOf(broken, AIFIX).devices.filter((d) => d.powered).length, 1, 'damage lowers the threat');
  assert.ok(utility(me, broken, AIFIX, captain.weights) > utility(me, foe, AIFIX, captain.weights));
});

test('imagine works on a copy; imagineHit runs the sim effects and settles power (ion sheds shields)', () => {
  const w = world2('duo', 'fort');
  const fort = snapOf(w).view.ships.s2;
  const before = JSON.stringify(fort);
  assert.ok(!('want' in fort.systems.shields), 'enemy intent is redacted');
  const ioned = imagineHit(fort, 'S', { ion: 2 }, AIFIX);
  assert.equal(JSON.stringify(fort), before, 'input untouched');
  assert.equal(ioned.systems.shields.power, 2);
  assert.equal(ioned.stats.shieldLayers, 1);
  const holed = imagineHit(fort, 'C', { hull: 3 }, AIFIX);
  assert.equal(holed.pools.hull.v, W - 3);
  assert.equal(holed.stats.shieldLayers, 2);
});

test('planPower emits only differences, lowers before raises, and the batch applies cleanly', () => {
  const w = world2('duo', 'duo');
  const s1 = w.ships.s1;
  assert.deepEqual([s1.systems.shields.want, s1.systems.engines.want], [0, 2]);
  const v = snapOf(w).view;
  const cmds = planPower(v.ships.s1, v.ships.s2, AIFIX, captain);
  // Engines are worthless against zaps; one shield layer halves the threat. Both zaps stay on (no command).
  assert.deepEqual(cmds, [
    { type: 'setPower', system: 'engines', level: 0 },
    { type: 'setPower', system: 'shields', level: 2 },
  ]);
  assert.deepEqual(command(w, 's1', cmds, AIFIX).results, [null, null], 'the raise uses the bars the lower freed');
  assert.deepEqual([s1.systems.shields.power, s1.systems.engines.power, s1.systems.weapons.power], [2, 0, 2]);
  const again = snapOf(w).view;
  assert.deepEqual(planPower(again.ships.s1, again.ships.s2, AIFIX, captain), [], 'absolute commands do not drift');
});

test('planPower powers devices last, after the lowers that free their bars', () => {
  const w = world2('duo', 'duo');
  command(w, 's1', [
    { type: 'setDevicePower', device: 'w1', on: false }, { type: 'setDevicePower', device: 'w2', on: false },
    { type: 'setPower', system: 'shields', level: 2 },
  ], AIFIX);
  assert.equal(freeReactorOf(w), 0, 'shields 2 and engines 2 use the whole reactor');
  const v = snapOf(w).view;
  const cmds = planPower(v.ships.s1, v.ships.s2, AIFIX, captain);
  assert.deepEqual(cmds, [
    { type: 'setPower', system: 'engines', level: 0 },
    { type: 'setDevicePower', device: 'w1', on: true },
    { type: 'setDevicePower', device: 'w2', on: true },
  ]);
  assert.deepEqual(command(w, 's1', cmds, AIFIX).results, [null, null, null]);
  const reversed = world2('duo', 'duo');
  command(reversed, 's1', [
    { type: 'setDevicePower', device: 'w1', on: false }, { type: 'setDevicePower', device: 'w2', on: false },
    { type: 'setPower', system: 'shields', level: 2 },
  ], AIFIX);
  assert.deepEqual(command(reversed, 's1', [...cmds].reverse(), AIFIX).results, ['no-reactor', 'no-reactor', null], 'reversed, the ons find no free bars');
});

test('planPower turns devices off before lowering systems, and back on when they pay', () => {
  const w = world2('duo', 'fort');
  // Against an unarmed fort with two layers, two zaps do nothing, so nothing is worth power at all.
  const v = snapOf(w).view;
  const cmds = planPower(v.ships.s1, v.ships.s2, AIFIX, captain);
  assert.deepEqual(cmds, [
    { type: 'setDevicePower', device: 'w1', on: false },
    { type: 'setDevicePower', device: 'w2', on: false },
    { type: 'setPower', system: 'engines', level: 0 },
  ]);
  // Ion opens the fort to one layer: one zap now gets through, so power returns, devices last.
  command(w, 's1', cmds, AIFIX);
  w.ships.s2.systems.shields.status.ion = { n: 1, timer: { v: 0, max: 100000, rate: 0 } };
  applyCommands(w, [], AIFIX);
  const u = snapOf(w).view;
  assert.equal(u.ships.s2.stats.shieldLayers, 1);
  assert.deepEqual(planPower(u.ships.s1, u.ships.s2, AIFIX, captain), [
    { type: 'setDevicePower', device: 'w1', on: true },
    { type: 'setDevicePower', device: 'w2', on: true },
  ]);
});

/** Lampblack's (red) view of a shipped duel after `mutate` edits the world, settled. */
function lampblackView(/** @type {Content} */ content, /** @type {(w: World) => void} */ mutate = () => {}) {
  const w = createWorld({ seed: 1, ships: [{ id: 's1', bp: 'candlewick', side: 'blue' }, { id: 's2', bp: 'lampblack', side: 'red' }] }, content);
  mutate(w);
  applyCommands(w, [], content);
  return snapOf(w, 'red').view;
}

test('Lampblack keeps Hush Pulse powered while the foe shows no shield layer (sim-2, elegance-2)', () => {
  const v = lampblackView(CONTENT, (w) => applyCommands(w, [{ type: 'setPower', ship: 's1', system: 'shields', level: 0 }], CONTENT));
  assert.equal(v.ships.s1.stats.shieldLayers, 0, 'Candlewick dropped its shields');
  const plan = bestPower(v.ships.s2, v.ships.s1, CONTENT, captain.weights);
  assert.deepEqual(plan.devices.map((d) => [d.bp, d.powered]), [['hush', true], ['flint', true], ['flint', true]]);
  assert.ok(!planPower(v.ships.s2, v.ships.s1, CONTENT, captain).some((c) => c.type === 'setDevicePower'), 'no device is cut');
});

test('a data-only weapon whose payload has no hull key is valued by what it does, and powered (elegance-2)', () => {
  const content = structuredClone(CONTENT);
  content.devices.quench = { ...content.devices.needle, name: 'Quench', onHit: { sysDamage: 3, ion: 2, crew: 40 } };
  content.ships.lampblack.devices = [{ bp: 'quench', on: false }, { bp: 'flint', on: true }, { bp: 'flint', on: true }];
  content.ships.lampblack.systems.shields.power = 1;
  content.ships.lampblack.stores = { missiles: 8 };
  assert.deepEqual(validateContent(content), []);
  const v = lampblackView(content);
  const gains = hitGains(v.ships.s2, v.ships.s1, content, captain.weights);
  assert.ok(gains.get('quench').best > 0, 'its best hit is worth something');
  assert.equal(dps(v.ships.s2, v.ships.s1, content, [v.ships.s2.devices[0]]), 0, 'though it deals no hull damage');
  const plan = bestPower(v.ships.s2, v.ships.s1, content, captain.weights);
  assert.equal(plan.devices[0].powered, true);
});

test('a blocked shot is valued by its onBlock payload where the sim lands it (elegance-2)', () => {
  // Candlewick can raise shields 4 (two layers): one ion stack on a blocked Hush takes one away.
  const v = lampblackView(CONTENT);
  const gains = hitGains(v.ships.s2, v.ships.s1, CONTENT, captain.weights);
  assert.ok(gains.get('hush').block > 0, 'the blocked Hush ionizes a layer away');
  assert.equal(gains.get('flint').block, 0, 'Flint has no onBlock payload');
  // With one shield bar damaged (capacity 3, one layer), one ion stack only takes the spare bar.
  const spare = lampblackView(CONTENT, (w) => { w.ships.s1.systems.shields.damage = 1; });
  assert.equal(hitGains(spare.ships.s2, spare.ships.s1, CONTENT, captain.weights).get('hush').block, 0);
});

/** duo vs fort after one tick (meters have rates), with w1 full and w2 `msLeft` from full. */
function charged(msLeft) {
  const w = world2('duo', 'fort');
  advance(w, AIFIX);
  const snap = snapOf(w);
  const [w1, w2] = snap.view.ships.s1.devices;
  w1.charge.v = w1.charge.max;
  w2.charge.v = w2.charge.max - msLeft * w2.charge.rate;
  return snap;
}
const fire = (snap, profile, seed = 1) =>
  planWeapons(snap.view, snap.view.ships.s1, snap.view.ships.s2, AIFIX, profile, mem(seed));

test('volley sync: a charged weapon facing shields holds while another is about to be ready', () => {
  assert.equal(charged(500).view.ships.s1.devices[1].charge.rate, 100);
  assert.deepEqual(fire(charged(500), captain), [], 'captain waits up to 3000 ms');
  assert.deepEqual(fire(charged(500), { ...captain, patienceMs: 0 }), [
    { type: 'setTarget', device: 'w1', target: { ship: 's2', room: 'S' } },
  ], 'no patience: fire now');
  assert.equal(fire(charged(500), { ...captain, patienceMs: 400 }).length, 1, 'the other is too far off');
  assert.equal(fire(charged(0), captain).length, 2, 'both full: fire together (no mutual wait)');
  const down = charged(500);
  down.view.ships.s2.pools.shield.v = 0;
  assert.equal(fire(down, captain).length, 1, 'no shield to strip: no reason to wait');
  const targeted = charged(500);
  targeted.view.ships.s1.devices[0].target = { ship: 's2', room: 'C' };
  assert.deepEqual(fire(targeted, { ...captain, patienceMs: 0 }), [], 'already targeted');
});

test('targeting prefers the shields room against a shielded foe', () => {
  const rooms = (profile, n) => {
    const m = mem(7);
    const snap = charged(0);
    const counts = {};
    for (let i = 0; i < n; i++) {
      const [cmd] = planWeapons(snap.view, snap.view.ships.s1, snap.view.ships.s2, AIFIX, profile, m);
      counts[cmd.target.room] = (counts[cmd.target.room] ?? 0) + 1;
    }
    return counts;
  };
  // Two zaps cannot pass two layers; only a hit on S (one bar of damage, one layer gone) changes that.
  assert.deepEqual(rooms({ ...ace, patienceMs: 0 }, 50), { S: 50 });
  const c = rooms({ ...captain, patienceMs: 0 }, 200);
  assert.ok(c.S >= 160, `captain mostly picks S: ${JSON.stringify(c)}`);
  assert.ok((c.W ?? 0) + (c.C ?? 0) > 0, 'but temperature still explores');
});

test('planCrew mans the most valuable empty room with the nearest crew member, once', () => {
  const w = world2('duo', 'duo');
  const v = snapOf(w).view;
  // Manning weapons charges zaps 10 percent faster; manning shields or engines buys nothing against zaps.
  const cmds = planCrew(v.ships.s1, v.ships.s2, AIFIX, captain);
  assert.deepEqual(cmds, [{ type: 'moveCrew', crew: ['c4'], room: 'W' }], 'Ben is one step from W');
  command(w, 's1', cmds, AIFIX);
  const u = snapOf(w).view;
  assert.deepEqual(planCrew(u.ships.s1, u.ships.s2, AIFIX, captain), [], 'destination unchanged: no command');
});

test('planCrew sends someone to repair a system nobody stands in', () => {
  const w = world2('duo', 'duo');
  command(w, 's1', [{ type: 'moveCrew', crew: ['c4'], room: 'S' }], AIFIX);
  for (let i = 0; i < 20; i++) advance(w, AIFIX);
  w.ships.s1.systems.weapons.damage = 2;
  applyCommands(w, [], AIFIX);
  assert.equal(w.ships.s1.systems.weapons.power, 0);
  const v = snapOf(w).view;
  assert.deepEqual(v.ships.s1.crew.map((c) => c.task), ['man', 'idle'], 'both in S');
  assert.deepEqual(planCrew(v.ships.s1, v.ships.s2, AIFIX, captain), [{ type: 'moveCrew', crew: ['c4'], room: 'W' }], 'Ben stands nearer the door');
});

test('think: gates, cadence, foe choice, and it never touches the snapshot', () => {
  const w = world2('duo', 'duo');
  const snap = snapOf(w);
  const text = JSON.stringify(snap);
  const me = { ship: 's1', side: 'blue' };
  for (const s of [{ ...snap, phase: 'waiting' }, { ...snap, paused: true }, { ...snap, view: { ...snap.view, outcome: { winner: 'red', tick: 0 } } }]) {
    const m = mem();
    assert.deepEqual(think(s, me, m, captain, AIFIX), []);
    assert.equal(m.nextThink, 0, 'a gated think does not consume the cadence');
  }
  assert.deepEqual(think(snap, me, mem(), drifter, AIFIX), [], 'drifter is passive');
  const out = JSON.parse(text);
  out.view.ships.s1.out = 'hull';
  assert.deepEqual(think(out, me, mem(), captain, AIFIX), []);
  const m = mem();
  const cmds = think(snap, me, m, captain, AIFIX);
  assert.deepEqual(cmds.map((c) => c.type), ['setPower', 'setPower', 'moveCrew']);
  assert.ok(cmds.every((c) => !('ship' in c)), 'the host stamps the ship');
  assert.equal(m.nextThink, captain.thinkEveryTicks);
  assert.deepEqual(think({ ...snap, tick: 1 }, me, m, captain, AIFIX), [], 'not due yet');
  assert.equal(JSON.stringify(snap), text);
  const novice = think(snap, me, mem(), { ...captain, crew: false }, AIFIX);
  assert.deepEqual(novice.map((c) => c.type), ['setPower', 'setPower'], 'crew: false never moves crew');
});

test('think aims at the living enemy with the lowest hull, ties by spawn order', () => {
  const w = createWorld({ seed: 1, ships: [
    { id: 's1', bp: 'duo', side: 'blue' }, { id: 's2', bp: 'fort', side: 'red' },
    { id: 's3', bp: 'fort', side: 'red' }, { id: 's4', bp: 'fort', side: 'red' },
  ] }, AIFIX);
  advance(w, AIFIX);
  const aim = (/** @type {(v: any) => void} */ edit) => {
    const snap = snapOf(w);
    snap.view.ships.s1.devices[0].charge.v = snap.view.ships.s1.devices[0].charge.max;
    edit(snap.view);
    const cmd = think(snap, { ship: 's1', side: 'blue' }, mem(), { ...ace, patienceMs: 0 }, AIFIX).find((c) => c.type === 'setTarget');
    return cmd.target.ship;
  };
  assert.equal(aim(() => {}), 's2');
  assert.equal(aim((v) => { v.ships.s3.pools.hull.v = 4; }), 's3');
  assert.equal(aim((v) => { v.ships.s3.pools.hull.v = 4; v.ships.s4.pools.hull.v = 4; }), 's3');
  assert.equal(aim((v) => { v.ships.s3.pools.hull.v = 4; v.ships.s3.out = 'crew'; }), 's2');
});

test('occupant: reaction delay, ignores everything but snap, resets on a new round', () => {
  const w = world2('duo', 'duo');
  /** @type {object[]} */
  const got = [];
  const occ = aiOccupant({ profile: { ...captain, reactionTicks: 4 }, seed: 1, content: AIFIX, ship: 's1', submit: (c) => got.push(c) });
  assert.equal(occ.kind, 'ai');
  const at = (tick, extra = {}) => JSON.stringify({ ...snapOf(w), tick, ...extra });
  occ.deliver(at(0));
  assert.deepEqual(got, [], 'queued, not sent');
  occ.deliver('not json');
  occ.deliver(JSON.stringify({ t: 'ack', re: 1, ok: true, tick: 0 }));
  occ.deliver(at(2));
  assert.deepEqual(got, []);
  occ.deliver(at(4));
  assert.deepEqual(got.map((c) => c.type), ['setPower', 'setPower', 'moveCrew'], 'released in order at due');
  got.length = 0;
  occ.deliver(at(6));
  occ.deliver(at(8));
  assert.deepEqual(got, [], 'nothing new until the next think');
  occ.deliver(at(16));
  occ.deliver(at(18, { round: 2 }));
  occ.deliver(at(30, { round: 2 }));
  assert.deepEqual(got.map((c) => c.type), ['setPower', 'setPower', 'moveCrew'], 'round 2 dropped the old queue and thought afresh');
});
