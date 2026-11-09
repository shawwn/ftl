// @ts-check
// ASCII ship maps -> rooms, doors and the walk graph (design doc 9.2). Geometry is content, not state:
// it is memoized per blueprint object and never serialized.
// Doc choices: memoized geometry is deep-frozen (shared by every caller; never alias it into a world).
// Explicit `doors` entries are [a, b] pairs of room characters (a two-character string works too).
// parseMap checks map structure only (rows, rectangles, doors, connectivity); legend rules live in
// content/validate.js.

/** @typedef {import('./types.js').Geometry} Geometry */
/** @typedef {import('./types.js').Room} Room */
/** @typedef {import('./types.js').Door} Door */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').Ship} Ship */

/** BFS neighbor order: right, down, left, up. */
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** @param {number} x @param {number} y */
export function cellKey(x, y) {
  return x + ',' + y;
}

/** @param {string} key @returns {[number, number]} */
function parseKey(key) {
  const i = key.indexOf(',');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

/** The wall between two edge-adjacent cells, keyed like the door that would sit in it ("x,y,dir"). */
function wallKey(x1, y1, x2, y2) {
  return x1 === x2 ? `${x1},${Math.min(y1, y2)},h` : `${Math.min(x1, x2)},${y1},v`;
}

/** Unordered key for a pair of rooms. */
function pairKey(a, b) {
  return a < b ? a + '|' + b : b + '|' + a;
}

/**
 * @param {string[]} map                 equal-length rows; '.' is empty space, any other char a room
 * @param {Record<string, string>} [legend]   room char -> system type (unlisted rooms are corridors)
 * @param {(string | string[])[] | null} [doors]   explicit room pairs; null means every adjacent pair
 * @returns {Geometry}
 */
export function parseMap(map, legend = {}, doors = null) {
  if (!Array.isArray(map) || map.length === 0 || !map.every((row) => typeof row === 'string')) {
    throw new Error('map must be a non-empty array of strings');
  }
  const h = map.length;
  const w = map[0].length;
  map.forEach((row, y) => {
    if (row.length !== w) throw new Error(`map row ${y} has length ${row.length}, expected ${w}`);
  });
  /** @returns {string | null} */
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && map[y][x] !== '.' ? map[y][x] : null);

  const { rooms, roomIds } = scanRooms(w, h, at, legend ?? {});
  if (roomIds.length === 0) throw new Error('map has no rooms');
  const doorList = placeDoors(w, h, at, doors);
  const open = new Set(doorList.map((d) => `${d.x},${d.y},${d.dir}`));
  /** @type {Record<string, string>} */
  const cellRoom = {};
  /** @type {Record<string, string[]>} */
  const edges = {};
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = at(x, y);
      if (!id) continue;
      cellRoom[cellKey(x, y)] = id;
      edges[cellKey(x, y)] = DIRS
        .map(([dx, dy]) => [x + dx, y + dy])
        .filter(([nx, ny]) => at(nx, ny) && (at(nx, ny) === id || open.has(wallKey(x, y, nx, ny))))
        .map(([nx, ny]) => cellKey(nx, ny));
    }
  }
  checkConnected(roomIds, doorList);
  return { w, h, rooms, roomIds, cellRoom, doors: doorList, edges };
}

/** Rooms in order of first appearance (a Map, so digit room characters keep that order). */
function scanRooms(w, h, at, legend) {
  /** @type {Map<string, { x0: number, y0: number, x1: number, y1: number, n: number }>} */
  const box = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = at(x, y);
      if (!id) continue;
      if (!box.has(id)) box.set(id, { x0: x, y0: y, x1: x, y1: y, n: 0 });
      const b = box.get(id);
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y1 = Math.max(b.y1, y);
      b.n += 1;
    }
  }
  /** @type {Record<string, Room>} */
  const rooms = {};
  for (const [id, b] of box) {
    const rw = b.x1 - b.x0 + 1;
    const rh = b.y1 - b.y0 + 1;
    if (b.n !== rw * rh) throw new Error(`room ${id} is not a rectangle`);
    const system = Object.hasOwn(legend, id) ? legend[id] : null;
    rooms[id] = { id, x: b.x0, y: b.y0, w: rw, h: rh, system };
  }
  return { rooms, roomIds: [...box.keys()] };
}

/** One door per (allowed) adjacent room pair, at the middle shared edge, in discovery order. */
function placeDoors(w, h, at, doors) {
  /** @type {Map<string, { a: string, b: string, x: number, y: number, dir: 'v' | 'h' }[]>} */
  const shared = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = at(x, y);
      if (!a) continue;
      for (const [dx, dy, dir] of /** @type {const} */ ([[1, 0, 'v'], [0, 1, 'h']])) {
        const b = at(x + dx, y + dy);
        if (!b || b === a) continue;
        const k = pairKey(a, b);
        if (!shared.has(k)) shared.set(k, []);
        shared.get(k).push({ a, b, x, y, dir });
      }
    }
  }
  let allowed = null;
  if (doors) {
    allowed = new Set();
    for (const pair of doors) {
      const isPair = (typeof pair === 'string' || Array.isArray(pair)) && pair.length === 2;
      const [a, b] = isPair ? pair : [];
      if (!isPair || !shared.has(pairKey(a, b))) {
        throw new Error(`door ${String(pair)} does not join two adjacent rooms`);
      }
      allowed.add(pairKey(a, b));
    }
  }
  /** @type {Door[]} */
  const list = [];
  for (const [k, edgesOfPair] of shared) {
    if (allowed && !allowed.has(k)) continue;
    const e = edgesOfPair[Math.floor((edgesOfPair.length - 1) / 2)];
    list.push({ id: 'd' + list.length, a: e.a, b: e.b, x: e.x, y: e.y, dir: e.dir });
  }
  return list;
}

/** @param {string[]} roomIds @param {Door[]} doors */
function checkConnected(roomIds, doors) {
  const seen = new Set([roomIds[0]]);
  const queue = [roomIds[0]];
  for (let i = 0; i < queue.length; i++) {
    for (const d of doors) {
      const next = d.a === queue[i] ? d.b : d.b === queue[i] ? d.a : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const lost = roomIds.filter((id) => !seen.has(id));
  if (lost.length) throw new Error(`rooms ${lost.join(', ')} are not connected to room ${roomIds[0]}`);
}

/** Freeze a plain-data tree in place (memoized geometry here; CONTENT in content/index.js). @template T @param {T} o @returns {T} */
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** @type {WeakMap<object, Geometry>} */
const memo = new WeakMap();

/**
 * Memoized, frozen geometry of a ship blueprint.
 * @param {Content} content
 * @param {string} bpId
 * @returns {Geometry}
 */
export function geometry(content, bpId) {
  const bp = Object.hasOwn(content.ships, bpId) ? content.ships[bpId] : null;
  if (!bp) throw new Error(`unknown ship blueprint ${bpId}`);
  let geo = memo.get(bp);
  if (!geo) {
    geo = deepFreeze(parseMap(bp.map, bp.legend, bp.doors ?? null));
    memo.set(bp, geo);
  }
  return geo;
}

/** @param {Geometry} geo @param {number} x @param {number} y @returns {string | null} */
export function roomAt(geo, x, y) {
  const k = cellKey(x, y);
  return Object.hasOwn(geo.cellRoom, k) ? geo.cellRoom[k] : null;
}

/** @param {Geometry} geo @param {string} roomId @returns {[number, number][]} fresh arrays, row-major */
export function roomCells(geo, roomId) {
  if (!Object.hasOwn(geo.rooms, roomId)) return [];
  const r = geo.rooms[roomId];
  /** @type {[number, number][]} */
  const cells = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells.push([x, y]);
  return cells;
}

/**
 * System type in that room that the ship has, or null (view-safe).
 * @param {Content} content @param {Ship} ship @param {string | null} roomId
 * @returns {string | null}
 */
export function systemAt(content, ship, roomId) {
  const geo = geometry(content, ship.bp);
  const type = Object.hasOwn(geo.rooms, roomId) ? geo.rooms[roomId].system : null;
  return type && Object.hasOwn(ship.systems, type) ? type : null;
}

/**
 * Room holding the ship's system of that type, or null (view-safe).
 * @param {Content} content @param {Ship} ship @param {string} type
 * @returns {string | null}
 */
export function roomOfSystem(content, ship, type) {
  if (!Object.hasOwn(ship.systems, type)) return null;
  const geo = geometry(content, ship.bp);
  return geo.roomIds.find((id) => geo.rooms[id].system === type) ?? null;
}

/**
 * Deterministic BFS (neighbor order right, down, left, up).
 * @param {Geometry} geo @param {[number, number]} from @param {[number, number]} to
 * @returns {[number, number][] | null} cells excluding from, including to; null if unreachable
 */
export function findPath(geo, from, to) {
  const start = cellKey(from[0], from[1]);
  const goal = cellKey(to[0], to[1]);
  if (!Object.hasOwn(geo.edges, start) || !Object.hasOwn(geo.edges, goal)) return null;
  const prev = new Map([[start, start]]);
  const queue = [start];
  for (let i = 0; i < queue.length && !prev.has(goal); i++) {
    for (const n of geo.edges[queue[i]]) {
      if (!prev.has(n)) {
        prev.set(n, queue[i]);
        queue.push(n);
      }
    }
  }
  if (!prev.has(goal)) return null;
  const path = [];
  for (let k = goal; k !== start; k = prev.get(k)) path.push(parseKey(k));
  return path.reverse();
}
