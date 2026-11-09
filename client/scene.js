// @ts-check
// (pure) Screen layout and hit testing (design doc 17.2). Geometry on screen is defined once, here:
// render.js, fx.js and input all read the scene, so what is drawn is exactly what is tapped.
//
// Doc choices:
// - The home bay holds every ship of `you.side` (spectators: the side of the first ship, so s1); the away
//   bay holds every other ship. Several ships in one bay stack vertically, one slot each.
// - Each slot reserves a LABEL_H band above the ship for its name, hull and evasion, and a one-cell
//   margin around the hull for the shield halos.
// - Crew regions are at least CREW_HIT px but never larger than their cell, so every room center picks
//   its room at any size (the HUD chips are the primary crew targets).
// - Extras beyond the doc's fields: `content` (what the scene was laid out with, so render and fx need
//   nothing else), `home` (the home side), and per ship `own`, `home`, `w`, `h`, `label`, `outline`
//   (hull silhouette polygon) and `mounts` (a hardpoint on the hull per device, where its shots leave).

import { geometry, roomOfSystem, shipsInOrder } from '../shared/sim/index.js';

/** @typedef {import('../shared/sim/types.js').View} View */
/** @typedef {import('../shared/sim/types.js').Ship} Ship */
/** @typedef {import('../shared/sim/types.js').Shot} Shot */
/** @typedef {import('../shared/sim/types.js').Content} Content */
/** @typedef {import('../shared/sim/types.js').Geometry} Geometry */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x: number, y: number, nx: number, ny: number }} Mount   position and outward normal */
/** @typedef {{ ship: string | null, side: string | null } | null} You */
/** @typedef {import('./ui-state.js').Intent} Intent */

/**
 * @typedef {object} SceneShip
 * @property {number} x            left edge of the ship grid
 * @property {number} y            top edge of the ship grid
 * @property {number} w            grid width in px
 * @property {number} h            grid height in px
 * @property {boolean} mirror      enemies face left so bows meet
 * @property {Geometry} geo
 * @property {boolean} own         the ship you crew
 * @property {boolean} home        in the home bay
 * @property {{ x: number, y: number, w: number }} label   left end of the label band's baseline, and its room
 * @property {Record<string, Rect>} rooms
 * @property {[number, number][]} outline        hull silhouette, px, clockwise
 * @property {Record<string, Mount>} mounts      device id -> hardpoint
 */

/**
 * @typedef {object} Scene
 * @property {number} w
 * @property {number} h
 * @property {boolean} portrait
 * @property {number} cell
 * @property {string | null} home
 * @property {Content} content
 * @property {Record<string, SceneShip>} ships
 * @property {{ x: number, y: number, w: number, h: number, intent: Intent }[]} regions   later is on top
 */

const CELL_MAX = 48;
const CELL_MIN = 6;
export const LABEL_H = 38;
const CREW_HIT = 32;
/** Hull padding around the room grid, in cells. */
export const HULL_PAD = 0.38;

/**
 * @param {View} view @param {You} you @param {{ w: number, h: number }} viewport CSS px of the stage
 * @param {Content} content
 * @returns {Scene}
 */
export function layoutScene(view, you, viewport, content) {
  const { w, h } = viewport;
  const portrait = w / h < 1;
  const all = shipsInOrder(view);
  const home = you?.side ?? all[0]?.side ?? null;
  const bays = portrait
    ? { away: { x: 0, y: 0, w, h: h / 2 }, home: { x: 0, y: h / 2, w, h: h / 2 } }
    : { home: { x: 0, y: 0, w: w / 2, h }, away: { x: w / 2, y: 0, w: w / 2, h } };
  const homeShips = all.filter((s) => s.side === home);
  const awayShips = all.filter((s) => s.side !== home);
  const placed = [
    ...stack(homeShips, bays.home).map((p) => ({ ...p, isHome: true })),
    ...stack(awayShips, bays.away).map((p) => ({ ...p, isHome: false })),
  ].map((p) => ({ ...p, geo: geometry(content, p.ship.bp) }));

  const fit = placed.map(({ slot, geo }) => Math.min(slot.w / (geo.w + 2), (slot.h - LABEL_H) / (geo.h + 2)));
  const cell = Math.max(CELL_MIN, Math.floor(Math.min(CELL_MAX, ...fit)));

  /** @type {Record<string, SceneShip>} */
  const ships = {};
  for (const { ship, slot, geo, isHome } of placed) {
    ships[ship.id] = placeShip(ship, slot, geo, cell, isHome, you, content);
  }

  /** @type {Scene['regions']} */
  const regions = [];
  for (const ship of all) {
    for (const [room, r] of Object.entries(ships[ship.id].rooms)) {
      regions.push({ ...r, intent: { kind: 'tapRoom', ship: ship.id, room } });
    }
  }
  const mine = you?.ship && Object.hasOwn(view.ships, you.ship) ? view.ships[you.ship] : null;
  // At least CREW_HIT px, but strictly inside its own cell (the region test is half-open, so a box exactly
  // one cell wide would still catch the shared corner): on small cells a larger box would swallow the room
  // center, and a tap meant to move the selection there would toggle a crew member instead.
  const size = Math.min(cell - 2, Math.max(CREW_HIT, Math.round(cell * 0.7)));
  for (const c of mine?.crew ?? []) {
    const p = cellCenter({ ships }, mine.id, c.cell);
    regions.push({ x: p.x - size / 2, y: p.y - size / 2, w: size, h: size, intent: { kind: 'tapCrew', crew: c.id } });
  }
  return { w, h, portrait, cell, home, content, ships, regions };
}

/** Slots stacked vertically inside a bay, one per ship. @param {Ship[]} ships @param {Rect} bay */
function stack(ships, bay) {
  const h = bay.h / Math.max(1, ships.length);
  return ships.map((ship, i) => ({ ship, slot: { x: bay.x, y: bay.y + i * h, w: bay.w, h } }));
}

/**
 * @param {Ship} ship @param {Rect} slot @param {Geometry} geo @param {number} cell @param {boolean} isHome
 * @param {You} you @param {Content} content
 * @returns {SceneShip}
 */
function placeShip(ship, slot, geo, cell, isHome, you, content) {
  const gw = geo.w * cell;
  const gh = geo.h * cell;
  const x = Math.round(slot.x + (slot.w - gw) / 2);
  const y = Math.round(slot.y + LABEL_H + (slot.h - LABEL_H - gh) / 2);
  const base = { x, y, w: gw, h: gh, mirror: !isHome, geo, own: ship.id === you?.ship, home: isHome };
  /** @param {number} gx @param {number} gy @returns {[number, number]} */
  const at = (gx, gy) => [x + (base.mirror ? geo.w - gx : gx) * cell, y + gy * cell];

  /** @type {Record<string, Rect>} */
  const rooms = {};
  for (const id of geo.roomIds) {
    const r = geo.rooms[id];
    const [ax] = at(r.x, r.y);
    const [bx] = at(r.x + r.w, r.y);
    rooms[id] = { x: Math.min(ax, bx), y: y + r.y * cell, w: r.w * cell, h: r.h * cell };
  }
  const outline = hullOutline(geo).map(([gx, gy]) => at(gx, gy));
  if (base.mirror) outline.reverse();
  return {
    ...base,
    label: { x: Math.round(x - HULL_PAD * cell), y: Math.round(y - cell * 0.95), w: Math.round(slot.x + slot.w - (x - HULL_PAD * cell) - 8) },
    rooms,
    outline,
    mounts: mounts(ship, geo, content, at),
  };
}

/** Bounding box of a placed ship's hull outline (render and fx). @param {SceneShip} s @returns {Rect} */
export function hullBox(s) {
  const xs = s.outline.map((p) => p[0]);
  const ys = s.outline.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Occupied [min, max] cell columns of each row (null for an empty row). @param {Geometry} geo */
function rowSpans(geo) {
  return Array.from({ length: geo.h }, (_, y) => {
    const xs = [];
    for (let x = 0; x < geo.w; x++) if (Object.hasOwn(geo.cellRoom, x + ',' + y)) xs.push(x);
    return xs.length ? [xs[0], xs[xs.length - 1]] : null;
  });
}

/**
 * Hull silhouette in grid units: the stepped outline of each row's occupied span, padded by HULL_PAD,
 * clockwise from the top-left, collinear points removed. render.js rounds its corners.
 * @param {Geometry} geo @returns {[number, number][]}
 */
export function hullOutline(geo) {
  const rows = rowSpans(geo).map((s, y) => (s ? { y, l: s[0] - HULL_PAD, r: s[1] + 1 + HULL_PAD } : null)).filter(Boolean);
  const top = (i) => (i === 0 ? rows[i].y - HULL_PAD : rows[i].y);
  const bottom = (i) => (i === rows.length - 1 ? rows[i].y + 1 + HULL_PAD : rows[i].y + 1);
  /** @type {[number, number][]} */
  const pts = [];
  rows.forEach((row, i) => pts.push([row.r, top(i)], [row.r, bottom(i)]));
  for (let i = rows.length - 1; i >= 0; i--) pts.push([rows[i].l, bottom(i)], [rows[i].l, top(i)]);
  return pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[(i + 1) % pts.length];
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
}

/**
 * A hardpoint for every device: spread along its host room's width, on the hull edge (top or bottom,
 * whichever is nearer the room) of that column.
 * @param {Ship} ship @param {Geometry} geo @param {Content} content
 * @param {(gx: number, gy: number) => [number, number]} at
 * @returns {Record<string, Mount>}
 */
function mounts(ship, geo, content, at) {
  /** @type {Record<string, Mount>} */
  const out = {};
  const byHost = new Map();
  for (const dev of ship.devices) byHost.set(dev.host, [...(byHost.get(dev.host) ?? []), dev]);
  for (const [host, devs] of byHost) {
    const roomId = roomOfSystem(content, ship, host);
    if (!roomId) continue;
    const r = geo.rooms[roomId];
    const up = r.y + r.h / 2 <= geo.h / 2;
    devs.forEach((dev, i) => {
      const gx = r.x + (r.w * (i + 1)) / (devs.length + 1);
      const col = Math.min(geo.w - 1, Math.floor(gx));
      let y0 = geo.h;
      let y1 = 0;
      for (let y = 0; y < geo.h; y++) {
        if (Object.hasOwn(geo.cellRoom, col + ',' + y)) {
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y + 1);
        }
      }
      const [x, y] = at(gx, up ? y0 - HULL_PAD : y1 + HULL_PAD);
      out[dev.id] = { x, y, nx: 0, ny: up ? -1 : 1 };
    });
  }
  return out;
}

/**
 * Topmost region containing the point, else tapEmpty.
 * @param {Scene} scene @param {number} x @param {number} y
 * @returns {Intent}
 */
export function pick(scene, x, y) {
  for (let i = scene.regions.length - 1; i >= 0; i--) {
    const r = scene.regions[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.intent;
  }
  return { kind: 'tapEmpty' };
}

/** @param {Pick<Scene, 'ships'>} scene @param {string} shipId @param {string} roomId @returns {Point} */
export function roomCenter(scene, shipId, roomId) {
  const r = scene.ships[shipId].rooms[roomId];
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Screen point of continuous grid coordinates (mirroring applied).
 * @param {Pick<Scene, 'ships'>} scene @param {string} shipId @param {number} gx @param {number} gy
 * @returns {Point}
 */
export function gridPoint(scene, shipId, gx, gy) {
  const s = scene.ships[shipId];
  const cell = s.w / s.geo.w;
  return { x: s.x + (s.mirror ? s.geo.w - gx : gx) * cell, y: s.y + gy * cell };
}

/** @param {Pick<Scene, 'ships'>} scene @param {string} shipId @param {[number, number]} cell @returns {Point} */
export function cellCenter(scene, shipId, cell) {
  return gridPoint(scene, shipId, cell[0] + 0.5, cell[1] + 0.5);
}

/**
 * Flight path of a shot: a quadratic curve from the firing device's hardpoint to the target room's
 * center, bowed outward from the hardpoint. Null when either end is not on screen.
 * @param {Scene} scene @param {Shot} shot
 * @returns {{ x0: number, y0: number, cx: number, cy: number, x1: number, y1: number } | null}
 */
export function shotPath(scene, shot) {
  const from = scene.ships[shot.from.ship];
  const to = scene.ships[shot.to.ship];
  const m = from?.mounts[shot.from.device];
  if (!m || !to?.rooms[shot.to.room]) return null;
  const end = roomCenter(scene, shot.to.ship, shot.to.room);
  const dx = end.x - m.x;
  const dy = end.y - m.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit perpendicular, flipped to lean the same way as the hardpoint's outward normal.
  let px = -dy / len;
  let py = dx / len;
  if (px * m.nx + py * m.ny < 0) {
    px = -px;
    py = -py;
  }
  const bow = 0.16 * len;
  return { x0: m.x, y0: m.y, cx: (m.x + end.x) / 2 + px * bow, cy: (m.y + end.y) / 2 + py * bow, x1: end.x, y1: end.y };
}

/**
 * Point and unit direction at t (0..1, may exceed 1 to continue past the target) along a shot path.
 * @param {{ x0: number, y0: number, cx: number, cy: number, x1: number, y1: number }} p @param {number} t
 */
export function pathAt(p, t) {
  const u = 1 - t;
  const x = u * u * p.x0 + 2 * u * t * p.cx + t * t * p.x1;
  const y = u * u * p.y0 + 2 * u * t * p.cy + t * t * p.y1;
  const tx = 2 * u * (p.cx - p.x0) + 2 * t * (p.x1 - p.cx);
  const ty = 2 * u * (p.cy - p.y0) + 2 * t * (p.y1 - p.cy);
  const n = Math.hypot(tx, ty) || 1;
  return { x, y, dx: tx / n, dy: ty / n };
}
