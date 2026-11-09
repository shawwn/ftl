// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMove, claimedCells, crewRoom, crewInRoom, assignTasks } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { FIX, duel, shippedWorld, command, run, crewNamed } from './helpers/fixtures.js';

// trio: W (0,0)-(1,1), S (2,0)-(3,1), E (4,0)-(4,1); doors W|S at (1,0), S|E at (3,0).
// Ada (c5) starts at (0,0) in W, Bo (c6) at (2,0) in S, Cy (c7) at (4,0) in E.

test('spawn places crew on the first free cell of their room; queries are view-safe', () => {
  const s1 = duel().ships.s1;
  assert.deepEqual(s1.crew.map((c) => [c.id, c.name, c.cell, c.task]), [
    ['c5', 'Ada', [0, 0], 'man'], ['c6', 'Bo', [2, 0], 'man'], ['c7', 'Cy', [4, 0], 'man']]);
  assert.equal(crewRoom(FIX, s1, s1.crew[1]), 'S');
  assert.deepEqual(crewInRoom(FIX, s1, 'E').map((c) => c.id), ['c7']);
  assert.deepEqual([...claimedCells(s1)], ['0,0', '2,0', '4,0']);
});

test('planMove picks the first free cell row-major and respects claims', () => {
  const s1 = duel().ships.s1;
  assert.equal(planMove(s1, ['c5', 'c7'], 'S', FIX), 2);
  const ada = crewNamed(s1, 'Ada');
  const cy = crewNamed(s1, 'Cy');
  assert.deepEqual(ada.path, [[1, 0], [2, 0], [3, 0]]);         // (2,0) is Bo's
  assert.deepEqual(cy.path, [[3, 0], [3, 1], [2, 1]]);          // (3,0) is now Ada's claim
  assert.deepEqual([...claimedCells(s1)].sort(), ['2,0', '2,1', '3,0']);
  assert.equal(planMove(s1, ['c5'], 'S', FIX), 1, 'already heading there: counts, path unchanged');
  assert.deepEqual(ada.path, [[1, 0], [2, 0], [3, 0]]);
});

test('planMove returns 0 when the room is full; moveCrew reports room-full', () => {
  const w = duel();
  const s1 = w.ships.s1;
  assert.equal(planMove(s1, ['c5'], 'E', FIX), 1);               // E has two cells
  assert.equal(planMove(s1, ['c6'], 'E', FIX), 0);
  assert.deepEqual(crewNamed(s1, 'Bo').path, []);
  assert.deepEqual(command(w, 's1', [{ type: 'moveCrew', crew: ['c6'], room: 'E' }]).results, ['room-full']);
  assert.deepEqual(command(w, 's1', [{ type: 'moveCrew', crew: ['c6', 'c7'], room: 'E' }]).results, [null], 'partial is accepted');
});

test('mid-step continuity: a new plan starts with the cell being stepped into and keeps progress', () => {
  const w = duel();
  const s1 = w.ships.s1;
  const ada = crewNamed(s1, 'Ada');
  command(w, 's1', [{ type: 'moveCrew', crew: ['c5'], room: 'S' }]);
  run(w, 1);
  assert.equal(ada.walk.v, 5000);
  command(w, 's1', [{ type: 'moveCrew', crew: ['c5'], room: 'E' }]);
  assert.deepEqual(ada.path, [[1, 0], [2, 0], [3, 0], [4, 0], [4, 1]]);
  assert.equal(ada.walk.v, 5000);
  assert.deepEqual(ada.cell, [0, 0]);
  run(w, 1);
  assert.deepEqual(ada.cell, [1, 0]);
  assert.equal(ada.walk.v, 0);
});

test('a step that has not started is not mid-step: turning back is immediate', () => {
  const w = duel();
  const ada = crewNamed(w.ships.s1, 'Ada');
  command(w, 's1', [{ type: 'moveCrew', crew: ['c5'], room: 'S' }]);
  assert.equal(ada.task, 'walk');
  command(w, 's1', [{ type: 'moveCrew', crew: ['c5'], room: 'W' }]);
  assert.deepEqual(ada.path, []);
  assert.deepEqual(ada.cell, [0, 0]);
  assert.equal(ada.task, 'man');
});

test('walking: one cell per walkMs at walkPct; the walk meter idles at rate 0', () => {
  const w = duel();
  const s1 = w.ships.s1;
  const ada = crewNamed(s1, 'Ada');
  command(w, 's1', [{ type: 'moveCrew', crew: ['c5'], room: 'S' }]);
  run(w, 5);
  assert.deepEqual([ada.cell, ada.path.length, ada.task], [[2, 0], 1, 'walk']);
  run(w, 1);
  assert.deepEqual([ada.cell, ada.path.length], [[3, 0], 0]);
  assert.equal(ada.task, 'man', 'first in array order mans the room');
  assert.equal(crewNamed(s1, 'Bo').task, 'idle');
  run(w, 1);
  assert.deepEqual(ada.walk, { v: 0, max: 10000, rate: 0 });
});

test('tasks: repair when the room system is damaged (everyone there), idle in corridors', () => {
  const w = duel();
  const s1 = w.ships.s1;
  command(w, 's1', [{ type: 'moveCrew', crew: ['c5'], room: 'S' }]);
  run(w, 6);
  s1.systems.shields.damage = 1;
  assignTasks(s1, FIX);
  assert.deepEqual(s1.crew.map((c) => c.task), ['repair', 'repair', 'man']);
  const cw = shippedWorld();
  command(cw, 's1', [{ type: 'moveCrew', crew: ['c4'], room: 'a' }], CONTENT);
  run(cw, 40, CONTENT);
  assert.equal(crewNamed(cw.ships.s1, 'Tomo Reyk').task, 'idle');
});

test('repair: one bar per repairMs per crew member; repairers stack', () => {
  const w = duel();
  const s1 = w.ships.s1;
  const shields = s1.systems.shields;
  shields.damage = 1;
  command(w, 's1', []);
  run(w, 19);
  assert.equal(shields.damage, 1);
  assert.deepEqual(shields.repair, { v: 95000, max: 100000, rate: 100 });
  const ev = run(w, 1);
  assert.equal(shields.damage, 0);
  assert.ok(ev.some((e) => e.type === 'systemRepaired' && e.system === 'shields' && e.damage === 0));
  run(w, 1);
  assert.deepEqual(shields.repair, { v: 0, max: 100000, rate: 0 });

  command(w, 's1', [{ type: 'moveCrew', crew: ['c5'], room: 'S' }]);
  run(w, 6);
  shields.damage = 2;
  command(w, 's1', []);
  run(w, 10);
  assert.equal(shields.damage, 1, 'two crew repair at twice the speed');
  assert.equal(shields.repair.rate, 200);
  run(w, 10);
  assert.equal(shields.damage, 0);
});

test('repair progress holds while nobody repairs', () => {
  const w = duel();
  const s1 = w.ships.s1;
  s1.systems.shields.damage = 1;
  command(w, 's1', []);
  run(w, 5);
  command(w, 's1', [{ type: 'moveCrew', crew: ['c6'], room: 'W' }]);
  run(w, 3);
  assert.equal(s1.systems.shields.repair.v, 25000);
  assert.equal(s1.systems.shields.repair.rate, 0);
});
