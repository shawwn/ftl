// @ts-check
// Scene layout and picking (design doc 17.2): every room's center picks that room in portrait and
// landscape, enemies are mirrored, crew regions sit above rooms, and everything fits the viewport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, geometry, createWorld } from '../shared/sim/index.js';
import { CONTENT } from '../shared/content/index.js';
import { shippedWorld } from './helpers/fixtures.js';
import { layoutScene, pick, roomCenter, cellCenter, shotPath, pathAt } from '../client/scene.js';

const YOU = { ship: 's1', side: 'blue' };
const SPECTATOR = { ship: null, side: null };
const VIEWPORTS = {
  desktop: { w: 1440, h: 672 },
  portrait: { w: 390, h: 500 },
  landscape: { w: 844, h: 270 },
};

function blueView() {
  return project(shippedWorld(), { kind: 'side', side: 'blue' });
}

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  test(`${name}: the center of every room region picks that room`, () => {
    for (const you of [SPECTATOR, YOU]) {
      const view = blueView();
      const scene = layoutScene(view, you, vp, CONTENT);
      assert.equal(scene.portrait, vp.w / vp.h < 1);
      for (const ship of Object.values(view.ships)) {
        for (const room of geometry(CONTENT, ship.bp).roomIds) {
          const c = roomCenter(scene, ship.id, room);
          assert.deepEqual(pick(scene, c.x, c.y), { kind: 'tapRoom', ship: ship.id, room });
        }
      }
    }
  });

  test(`${name}: ships and halos fit the viewport, cell is capped at 48`, () => {
    const scene = layoutScene(blueView(), YOU, vp, CONTENT);
    assert.ok(scene.cell <= 48 && scene.cell >= 6);
    for (const s of Object.values(scene.ships)) {
      assert.ok(s.x - scene.cell >= 0 && s.x + s.w + scene.cell <= vp.w, `${name} x`);
      assert.ok(s.y - scene.cell >= 0 && s.y + s.h + scene.cell <= vp.h, `${name} y`);
    }
  });
}

test('landscape: own ship left, enemy right and mirrored', () => {
  const scene = layoutScene(blueView(), YOU, VIEWPORTS.desktop, CONTENT);
  const { s1, s2 } = scene.ships;
  assert.equal(s1.mirror, false);
  assert.equal(s2.mirror, true);
  assert.ok(s1.x + s1.w <= scene.w / 2 && s2.x >= scene.w / 2);
  // Lampblack's bow (H, the highest x) faces left, toward Candlewick; Candlewick's bow faces right.
  assert.ok(s2.rooms.H.x < s2.rooms.E.x);
  assert.ok(s1.rooms.H.x > s1.rooms.E.x);
  assert.equal(scene.cell, 48);
});

test('portrait: enemy in the top bay, own ship in the bottom bay, enemy mirrored', () => {
  const scene = layoutScene(blueView(), YOU, VIEWPORTS.portrait, CONTENT);
  const { s1, s2 } = scene.ships;
  assert.ok(s2.y + s2.h <= scene.h / 2 && s1.y >= scene.h / 2);
  assert.equal(s2.mirror, true);
  assert.ok(s2.rooms.H.x < s2.rooms.E.x);
});

test('the red side sees itself at home', () => {
  const view = project(shippedWorld(), { kind: 'side', side: 'red' });
  const scene = layoutScene(view, { ship: 's2', side: 'red' }, VIEWPORTS.desktop, CONTENT);
  assert.equal(scene.ships.s2.home, true);
  assert.equal(scene.ships.s1.mirror, true);
  assert.ok(scene.ships.s2.x < scene.ships.s1.x);
});

test('spectators: s1 takes the own-ship bay, and no crew regions', () => {
  const view = project(shippedWorld(), { kind: 'all' });
  const scene = layoutScene(view, SPECTATOR, VIEWPORTS.desktop, CONTENT);
  assert.equal(scene.ships.s1.home, true);
  assert.equal(scene.ships.s1.own, false);
  assert.ok(scene.regions.every((r) => r.intent.kind === 'tapRoom'));
});

test('own crew regions are at least 32 px (or the cell, if smaller), never larger than their cell, above rooms', () => {
  const view = blueView();
  for (const vp of [VIEWPORTS.landscape, VIEWPORTS.desktop, { w: 320, h: 200 }]) {
    const scene = layoutScene(view, YOU, vp, CONTENT);
    const crew = scene.regions.filter((r) => r.intent.kind === 'tapCrew');
    assert.equal(crew.length, view.ships.s1.crew.length);
    for (const c of view.ships.s1.crew) {
      const p = cellCenter(scene, 's1', c.cell);
      assert.deepEqual(pick(scene, p.x, p.y), { kind: 'tapCrew', crew: c.id });
      const r = crew.find((q) => q.intent.kind === 'tapCrew' && q.intent.crew === c.id);
      assert.ok(r.w >= Math.min(32, scene.cell - 2) && r.w < scene.cell, `crew box ${r.w} at cell ${scene.cell}`);
    }
  }
});

test('on small phone stages every own room center still picks the room, so crew orders reach it (client-5)', () => {
  const view = blueView();
  // Stages of a 320x568 portrait phone and of 568 to 740 px wide landscape phones, then every cell size.
  const stages = [{ w: 320, h: 200 }, { w: 740, h: 192 }, { w: 568, h: 152 }, { w: 640, h: 192 }];
  for (let h = 60; h <= 700; h += 7) stages.push({ w: 2 * h, h });
  const cells = new Set();
  for (const vp of stages) {
    const scene = layoutScene(view, YOU, vp, CONTENT);
    cells.add(scene.cell);
    for (const room of geometry(CONTENT, 'candlewick').roomIds) {
      const c = roomCenter(scene, 's1', room);
      assert.deepEqual(pick(scene, c.x, c.y), { kind: 'tapRoom', ship: 's1', room }, `room ${room} at cell ${scene.cell}`);
    }
  }
  assert.ok(cells.has(16) || [...cells].some((c) => c < 20), 'small cells are covered');
});

test('points outside every region are tapEmpty', () => {
  const scene = layoutScene(blueView(), YOU, VIEWPORTS.desktop, CONTENT);
  assert.deepEqual(pick(scene, 2, 2), { kind: 'tapEmpty' });
  assert.deepEqual(pick(scene, scene.w / 2, 4), { kind: 'tapEmpty' });
});

test('cellCenter mirrors with the rooms', () => {
  const scene = layoutScene(blueView(), YOU, VIEWPORTS.desktop, CONTENT);
  const geo = geometry(CONTENT, 'lampblack');
  for (const id of geo.roomIds) {
    const r = geo.rooms[id];
    const p = cellCenter(scene, 's2', [r.x, r.y]);
    assert.deepEqual(pick(scene, p.x, p.y), { kind: 'tapRoom', ship: 's2', room: id });
  }
});

test('several ships per side stack within their bays', () => {
  const world = createWorld({ seed: 1, ships: [
    { id: 's1', bp: 'candlewick', side: 'blue' }, { id: 's2', bp: 'lampblack', side: 'red' },
    { id: 's3', bp: 'lampblack', side: 'red' },
  ] }, CONTENT);
  const scene = layoutScene(project(world, { kind: 'all' }), SPECTATOR, VIEWPORTS.desktop, CONTENT);
  const { s2, s3 } = scene.ships;
  assert.ok(s2.y + s2.h < s3.y);
  for (const ship of ['s2', 's3']) {
    const c = roomCenter(scene, ship, 'W');
    assert.deepEqual(pick(scene, c.x, c.y), { kind: 'tapRoom', ship, room: 'W' });
  }
});

test('every device has a hardpoint on its hull, and shots fly from it to the target room', () => {
  const view = blueView();
  const scene = layoutScene(view, YOU, VIEWPORTS.desktop, CONTENT);
  for (const ship of Object.values(view.ships)) {
    for (const dev of ship.devices) assert.ok(scene.ships[ship.id].mounts[dev.id], dev.id);
  }
  const shot = { id: 'p1', bp: 'ember', from: { ship: 's1', device: 'w1' }, to: { ship: 's2', room: 'S' }, flight: { v: 0, max: 1, rate: 0 } };
  const path = shotPath(scene, shot);
  const m = scene.ships.s1.mounts.w1;
  assert.deepEqual([path.x0, path.y0], [m.x, m.y]);
  const end = pathAt(path, 1);
  assert.deepEqual(pick(scene, end.x, end.y), { kind: 'tapRoom', ship: 's2', room: 'S' });
  assert.equal(shotPath(scene, { ...shot, from: { ship: 's9', device: 'w1' } }), null);
});
