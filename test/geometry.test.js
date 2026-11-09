// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap, geometry, cellKey, roomAt, roomCells, systemAt, roomOfSystem, findPath } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { shippedWorld } from './helpers/fixtures.js';

const rect = (r) => [r.id, r.x, r.y, r.w, r.h];

test('Candlewick parses exactly as in 9.2', () => {
  const geo = geometry(CONTENT, 'candlewick');
  assert.equal(geo.w, 8);
  assert.equal(geo.h, 3);
  assert.deepEqual(geo.roomIds, ['W', 'S', 'E', 'a', 'H', 'b', 'c']);
  assert.deepEqual(geo.roomIds.map((id) => rect(geo.rooms[id])), [
    ['W', 1, 0, 2, 2], ['S', 4, 0, 2, 2], ['E', 0, 1, 1, 2], ['a', 3, 1, 1, 2],
    ['H', 6, 1, 2, 2], ['b', 1, 2, 2, 1], ['c', 4, 2, 2, 1],
  ]);
  assert.deepEqual(geo.roomIds.map((id) => geo.rooms[id].system), ['weapons', 'shields', 'engines', null, 'piloting', null, null]);
  assert.deepEqual(geo.doors[0], { id: 'd0', a: 'E', b: 'W', x: 0, y: 1, dir: 'v' });
  assert.deepEqual(geo.doors.map((d) => [d.id, d.a + d.b, d.x, d.y, d.dir]), [
    ['d0', 'EW', 0, 1, 'v'], ['d1', 'Wb', 1, 1, 'h'], ['d2', 'Wa', 2, 1, 'v'], ['d3', 'aS', 3, 1, 'v'],
    ['d4', 'Sc', 4, 1, 'h'], ['d5', 'SH', 5, 1, 'v'], ['d6', 'Eb', 0, 2, 'v'], ['d7', 'ba', 2, 2, 'v'],
    ['d8', 'ac', 3, 2, 'v'], ['d9', 'cH', 5, 2, 'v'],
  ]);
});

test('Lampblack rooms and doors follow the same rules', () => {
  const geo = geometry(CONTENT, 'lampblack');
  assert.deepEqual(geo.roomIds.map((id) => rect(geo.rooms[id])), [
    ['S', 1, 0, 2, 1], ['a', 3, 0, 2, 1], ['E', 0, 1, 2, 2], ['W', 2, 1, 2, 2], ['H', 4, 1, 1, 2],
  ]);
  assert.deepEqual(geo.doors.map((d) => [d.id, d.a + d.b, d.x, d.y, d.dir]), [
    ['d0', 'SE', 1, 0, 'h'], ['d1', 'Sa', 2, 0, 'v'], ['d2', 'SW', 2, 0, 'h'], ['d3', 'aW', 3, 0, 'h'],
    ['d4', 'aH', 4, 0, 'h'], ['d5', 'EW', 1, 1, 'v'], ['d6', 'WH', 3, 1, 'v'],
  ]);
});

test('cellRoom and the walk graph: within rooms, plus across doors only', () => {
  const geo = geometry(CONTENT, 'candlewick');
  assert.equal(geo.cellRoom['0,1'], 'E');
  assert.equal(roomAt(geo, 0, 0), null);
  assert.equal(roomAt(geo, 6, 2), 'H');
  assert.equal(roomAt(geo, 99, 99), null);
  assert.deepEqual(geo.edges['0,1'], ['1,1', '0,2']);              // right through door d0, down in E
  assert.deepEqual(geo.edges['2,1'], ['3,1', '1,1', '2,0']);        // right through d2; no door down to b here
  assert.deepEqual(geo.edges['1,1'], ['2,1', '1,2', '0,1', '1,0']); // right, down through d1, left through d0, up
  assert.equal(Object.keys(geo.edges).length, Object.keys(geo.cellRoom).length);
});

test('roomCells is row-major; unknown rooms have none', () => {
  const geo = geometry(CONTENT, 'candlewick');
  assert.deepEqual(roomCells(geo, 'H'), [[6, 1], [7, 1], [6, 2], [7, 2]]);
  assert.deepEqual(roomCells(geo, 'Z'), []);
  assert.deepEqual(roomCells(geo, 'constructor'), []);
});

test('findPath: BFS with right, down, left, up order is deterministic', () => {
  const geo = geometry(CONTENT, 'candlewick');
  assert.deepEqual(findPath(geo, [0, 1], [2, 2]), [[1, 1], [1, 2], [2, 2]]);
  assert.deepEqual(findPath(geo, [1, 1], [0, 1]), [[0, 1]]);
  assert.deepEqual(findPath(geo, [3, 3], [0, 1]), null);
  assert.deepEqual(findPath(geo, [0, 1], [0, 1]), []);
  const long = findPath(geo, [0, 2], [7, 2]);
  assert.deepEqual(long, findPath(geo, [0, 2], [7, 2]));
  let at = '0,2';
  for (const [x, y] of long) {
    assert.ok(geo.edges[at].includes(cellKey(x, y)), `${at} -> ${x},${y}`);
    at = cellKey(x, y);
  }
  assert.equal(at, '7,2');
});

test('geometry is memoized per blueprint and frozen', () => {
  assert.equal(geometry(CONTENT, 'candlewick'), geometry(CONTENT, 'candlewick'));
  assert.ok(Object.isFrozen(geometry(CONTENT, 'candlewick').rooms.W));
  assert.throws(() => geometry(CONTENT, 'nope'), /unknown ship blueprint/);
});

test('systemAt and roomOfSystem (view-safe)', () => {
  const ship = shippedWorld().ships.s1;
  assert.equal(systemAt(CONTENT, ship, 'S'), 'shields');
  assert.equal(systemAt(CONTENT, ship, 'a'), null);
  assert.equal(systemAt(CONTENT, ship, 'Z'), null);
  assert.equal(systemAt(CONTENT, ship, null), null);
  assert.equal(roomOfSystem(CONTENT, ship, 'piloting'), 'H');
  assert.equal(roomOfSystem(CONTENT, ship, 'cloak'), null);
  const bare = { ...ship, systems: { shields: ship.systems.shields } };
  assert.equal(systemAt(CONTENT, bare, 'W'), null);
  assert.equal(roomOfSystem(CONTENT, bare, 'weapons'), null);
});

test('bad maps throw', () => {
  assert.throws(() => parseMap(['AAB', 'AA']), /row 1 has length 2, expected 3/);
  assert.throws(() => parseMap(['AA', 'A.']), /room A is not a rectangle/);
  assert.throws(() => parseMap(['ABA']), /room A is not a rectangle/);
  assert.throws(() => parseMap(['A.B']), /not connected/);
  assert.throws(() => parseMap(['AB.C', 'DDDC'], {}, [['A', 'B'], ['C', 'D']]), /not connected/);
  assert.throws(() => parseMap(['A.B', 'CCC'], {}, [['A', 'B']]), /door .* does not join two adjacent rooms/);
  assert.throws(() => parseMap(['..']), /no rooms/);
  assert.throws(() => parseMap([]), /non-empty array/);
});

test('explicit doors: only listed pairs get doors; ids follow discovery order', () => {
  const geo = parseMap(['ABC'], { A: 'weapons' }, ['CB', ['A', 'B']]);
  assert.deepEqual(geo.doors, [
    { id: 'd0', a: 'A', b: 'B', x: 0, y: 0, dir: 'v' },
    { id: 'd1', a: 'B', b: 'C', x: 1, y: 0, dir: 'v' },
  ]);
  const one = parseMap(['AB', 'CC'], {}, [['A', 'C'], ['B', 'C']]);
  assert.deepEqual(one.doors.map((d) => d.a + d.b), ['AC', 'BC']);
  assert.deepEqual(one.edges['0,0'], ['0,1']);
  assert.equal(one.rooms.A.system, null);
});

test('middle shared edge is floor((n - 1) / 2), and digit rooms keep first-appearance order', () => {
  const geo = parseMap(['A1', 'A1', 'A1', 'A1']);
  assert.deepEqual(geo.roomIds, ['A', '1']);
  assert.deepEqual(geo.doors, [{ id: 'd0', a: 'A', b: '1', x: 0, y: 1, dir: 'v' }]);
});
