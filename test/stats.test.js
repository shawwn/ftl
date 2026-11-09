// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, isManned, STATUSES, addStatus, freeReactor } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { FIX, duel, shippedWorld, command, crewNamed, fixtureWorld } from './helpers/fixtures.js';

/** computeStats on a clone after mutate (computeStats is pure and reads sys.power and crew tasks). */
const statsAfter = (ship, content, mutate) => {
  const s = structuredClone(ship);
  mutate(s);
  return computeStats(s, content);
};

test('tables are indexed by power', () => {
  const s1 = duel().ships.s1;
  const layers = [0, 1, 2, 3, 4].map((p) => statsAfter(s1, FIX, (s) => { s.systems.shields.power = p; }).shieldLayers);
  assert.deepEqual(layers, [0, 0, 1, 1, 2]);
  const evasion = [0, 1, 2].map((p) => statsAfter(s1, FIX, (s) => { s.systems.engines.power = p; }).evasion);
  assert.deepEqual(evasion, [0, 15, 25]);   // engines manned: +5 when powered; mul 0 at power 0
});

test('base stats, blueprint overrides and manned bonuses', () => {
  const s1 = duel().ships.s1;
  assert.deepEqual(s1.stats, { evasion: 15, shieldLayers: 1, shieldRegenPct: 110, chargePct: 110, repairPct: 100, walkPct: 100, hullMax: 12 });
  assert.ok(['weapons', 'shields', 'engines'].every((t) => isManned(s1, t, FIX)));
  const idle = statsAfter(s1, FIX, (s) => s.crew.forEach((c) => { c.task = 'idle'; }));
  assert.deepEqual(idle, { evasion: 10, shieldLayers: 1, shieldRegenPct: 100, chargePct: 100, repairPct: 100, walkPct: 100, hullMax: 12 });
  const dark = statsAfter(s1, FIX, (s) => { s.systems.weapons.power = 0; s.systems.shields.power = 0; });
  assert.equal(dark.chargePct, 100, 'manned bonus needs power > 0');
  assert.equal(dark.shieldRegenPct, 100);
  assert.equal(duel().ships.s2.stats.hullMax, 10, 'base hullMax without an override');
});

test('only a crew member with task man mans a system', () => {
  const s1 = duel().ships.s1;
  const ada = crewNamed(s1, 'Ada');
  assert.equal(ada.task, 'man');
  ada.task = 'repair';
  assert.equal(isManned(s1, 'weapons', FIX), false);
  assert.equal(isManned(s1, 'piloting', FIX), false, 'a system the ship lacks');
});

test('helm as data: manned +5 and x100; unmanned uses its autopilot table; power 0 zeroes evasion', () => {
  const s1 = shippedWorld().ships.s1;
  assert.equal(s1.stats.evasion, 15);                         // engines 2 -> 10, helm manned +5
  const unmanned = (s) => { crewNamed(s, 'Ines Calder').task = 'idle'; };
  assert.equal(statsAfter(s1, CONTENT, unmanned).evasion, 0, 'level 1 autopilot is 0 percent');
  const level = (n, manned) => statsAfter(s1, CONTENT, (s) => {
    s.systems.piloting.level = n;
    s.systems.piloting.power = n;
    if (!manned) unmanned(s);
  }).evasion;
  assert.equal(level(2, false), 5);                           // floor(10 * 50 / 100)
  assert.equal(level(3, false), 8);                           // floor(10 * 80 / 100)
  assert.equal(level(2, true), 15);
  assert.equal(statsAfter(s1, CONTENT, (s) => { s.systems.piloting.power = 0; }).evasion, 0);
  assert.equal(statsAfter(s1, CONTENT, (s) => { s.systems.piloting.power = 0; unmanned(s); }).evasion, 0);
});

test('unmanned tables apply only while unmanned, at any power (the seam the helm uses)', () => {
  const content = structuredClone(FIX);
  content.systems.shields.unmanned = { add: { shieldRegenPct: [-50, -50, -50, -50, -50] } };
  const s1 = fixtureWorld({ content }).ships.s1;
  assert.equal(computeStats(s1, content).shieldRegenPct, 110, 'manned: the manned bonus, no unmanned table');
  assert.equal(statsAfter(s1, content, (s) => { crewNamed(s, 'Bo').task = 'idle'; }).shieldRegenPct, 50);
  assert.equal(statsAfter(s1, content, (s) => { crewNamed(s, 'Bo').task = 'idle'; s.systems.shields.power = 0; }).shieldRegenPct, 50);
});

test('engines off: the engines mul table zeroes evasion even with a manned helm', () => {
  const w = shippedWorld();
  command(w, 's1', [{ type: 'setPower', system: 'engines', level: 0 }], CONTENT);
  assert.equal(w.ships.s1.systems.engines.power, 0);
  assert.equal(w.ships.s1.stats.evasion, 0);
});

test('the 7.2 worked numbers', () => {
  const w = shippedWorld(7);
  const s1 = w.ships.s1;
  command(w, 's1', [
    { type: 'setPower', system: 'shields', level: 3 },
    { type: 'moveCrew', crew: ['c4'], room: 'E' },            // Tomo leaves weapons to repair engines
  ], CONTENT);
  addStatus(s1.systems.shields, 'ion', 2, CONTENT);         // level 4: capacity 2
  s1.systems.engines.damage = 1;
  command(w, 's1', [], CONTENT);                              // derive
  assert.deepEqual(s1.systems.shields.want, 3);
  assert.deepEqual([s1.systems.shields.power, s1.systems.engines.power, s1.systems.weapons.power], [2, 2, 2]);
  assert.equal(freeReactor(s1, CONTENT), 1);
  assert.deepEqual(s1.crew.map((c) => [c.id, c.name, c.task]), [
    ['c3', 'Ines Calder', 'man'], ['c4', 'Tomo Reyk', 'walk'], ['c5', 'Wen Sato', 'man']]);
  assert.deepEqual(s1.crew[1].path, [[1, 1], [0, 1]]);
  assert.deepEqual(s1.stats, { evasion: 15, shieldLayers: 1, shieldRegenPct: 110, chargePct: 100, repairPct: 100, walkPct: 100, hullMax: 20 });
  const s2 = w.ships.s2;
  assert.deepEqual(s2.crew.map((c) => [c.id, c.cell, c.task]), [['c9', [4, 1], 'man'], ['c10', [2, 1], 'man'], ['c11', [0, 1], 'man']]);
  assert.deepEqual(s2.stats, { evasion: 20, shieldLayers: 1, shieldRegenPct: 100, chargePct: 110, repairPct: 100, walkPct: 100, hullMax: 17 });
  assert.deepEqual(s2.devices.map((d) => d.id), ['w6', 'w7', 'w8']);
});

test('status shipMods merge into the fold (registry seam; none in M1)', () => {
  const s1 = duel().ships.s1;
  STATUSES.glow = { shipMods: (st) => ({ add: { evasion: st.n }, mul: { evasion: 200 } }) };
  try {
    s1.systems.shields.status.glow = { n: 3, timer: { v: 0, max: 100000, rate: 0 } };
    assert.equal(computeStats(s1, FIX).evasion, (15 + 3) * 2);
  } finally {
    delete STATUSES.glow;
  }
  assert.equal(computeStats(s1, FIX).evasion, 15, 'unknown statuses contribute nothing');
});
