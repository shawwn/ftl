// @ts-check
// Canvas drawing (design doc 17.3, 17.5): "power is light". Ships are luminous line art on deep ink; a
// room's amber glow follows its system's power, shield layers are cyan halo rings, ion is a cold flicker,
// damage a red hatch with stuttering light, crew are motes with initials, and each projectile `look` has
// its own drawing. Every meter is drawn at meterAt(m, elapsedMs); geometry comes only from the scene.
// Doc choices: the renderer reads content through scene.content; GLYPHS draw a small line icon per system
// type (unknown types show the first letter of their label); LOOKS is exported for fx.js (misses keep
// flying with the same look); every device with a visible target gets a numbered marker on that room.

import { capacity, capacityPenalty, meterAt, systemAt, shipsInOrder } from '../shared/sim/index.js';
import { THEME, rgba, sideColor } from './theme.js';
import { cellCenter, shotPath, pathAt, hullBox, HULL_PAD } from './scene.js';

/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {import('./scene.js').SceneShip} SceneShip */
/** @typedef {import('../shared/sim/types.js').Ship} Ship */
/** @typedef {import('../shared/sim/types.js').Meter} Meter */
/** @typedef {import('./ui-state.js').Ui} Ui */
/** @typedef {{ x0: number, y0: number, cx: number, cy: number, x1: number, y1: number }} Path */
/**
 * @typedef {object} Frame
 * @property {Scene | null} scene
 * @property {any} snap
 * @property {number} elapsedMs
 * @property {Ui} ui
 * @property {{ ship: string | null, side: string | null } | null} you
 * @property {{ draw(ctx: CanvasRenderingContext2D, now: number): void, offset(now: number): { x: number, y: number } } | null} fx
 * @property {number} now
 */

const C = THEME.color;

/** Stepwise pseudo-random in [0, 1): changes every `stepMs`, different per seed. */
export function flicker(now, seed, stepMs = 70) {
  const s = Math.sin(Math.floor(now / stepMs) * 12.9898 + seed * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** @param {string} s */
const hashSeed = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7);

/** @param {HTMLCanvasElement} canvas */
export function createRenderer(canvas) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  let W = 0;
  let H = 0;
  let DPR = 1;
  const dust = makeDust(140);
  return {
    /** @param {number} w @param {number} h @param {number} dpr */
    resize(w, h, dpr) {
      W = w;
      H = h;
      DPR = dpr;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    },
    /** @param {Frame} frame */
    draw(frame) {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = C.ink;
      ctx.fillRect(0, 0, W, H);
      drawDust(ctx, dust, W, H, frame.now);
      const { scene, snap } = frame;
      if (!scene || !snap) return;
      const shake = frame.fx?.offset(frame.now) ?? { x: 0, y: 0 };
      ctx.save();
      ctx.translate(shake.x, shake.y);
      const ships = shipsInOrder(snap.view);
      for (const ship of ships) drawPool(ctx, scene.ships[ship.id], ship, scene.cell);
      for (const ship of ships) drawShip(ctx, scene, ship, frame);
      drawTargets(ctx, scene, ships, frame);
      for (const shot of snap.view.shots) drawShot(ctx, scene, shot, frame);
      frame.fx?.draw(ctx, frame.now);
      ctx.restore();
      if (snap.paused) drawPaused(ctx, W, H);
    },
  };
}

// ---- backdrop ----

/** Deterministic dust: [x, y, size, depth] in unit coordinates. @param {number} n */
function makeDust(n) {
  let s = 1234567;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => [r(), r(), r(), r()]);
}

function drawDust(ctx, dust, w, h, now) {
  for (const [ux, uy, us, depth] of dust) {
    const x = ((ux * w - now * 0.004 * (0.3 + depth)) % w + w) % w;
    ctx.fillStyle = rgba(C.line, 0.06 + depth * 0.22);
    const size = 0.6 + us * 1.1;
    ctx.fillRect(x, uy * h, size, size);
  }
}

/** A soft pool of side-tinted light under each ship, so ships sit in space rather than on it. */
function drawPool(ctx, s, ship, cell) {
  if (!s) return;
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const r = Math.max(s.w, s.h) * 0.9 + cell;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, rgba(sideColor(ship.side), ship.out ? 0.02 : 0.07));
  g.addColorStop(1, rgba(sideColor(ship.side), 0));
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function drawPaused(ctx, w, h) {
  ctx.fillStyle = rgba(C.ink, 0.45);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = rgba(C.text, 0.9);
  ctx.font = `600 18px ${THEME.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Paused', w / 2, h / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// ---- ships ----

/** @param {CanvasRenderingContext2D} ctx @param {Scene} scene @param {Ship} ship @param {Frame} f */
function drawShip(ctx, scene, ship, f) {
  const s = scene.ships[ship.id];
  if (!s) return;
  const { cell } = scene;
  const tint = sideColor(ship.side);
  const wreck = ship.out !== null;
  const box = hullBox(s);
  if (!wreck) drawHalos(ctx, ship, box, cell, f.elapsedMs, f.now);

  hullPath(ctx, s, cell);
  ctx.fillStyle = C.inkHull;
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = rgba(wreck ? C.faint : tint, wreck ? 0.04 : 0.07);
  ctx.stroke();
  ctx.save();
  ctx.shadowColor = rgba(tint, wreck ? 0 : 0.55);
  ctx.shadowBlur = wreck ? 0 : 12;
  ctx.lineWidth = THEME.line.hull;
  ctx.strokeStyle = rgba(wreck ? C.faint : tint, wreck ? 0.9 : 0.85);
  ctx.stroke();
  ctx.restore();

  for (const id of s.geo.roomIds) drawRoom(ctx, scene, s, ship, id, f);
  drawDoors(ctx, s, cell, wreck);
  for (const dev of ship.devices) drawMount(ctx, scene, s, dev, wreck, f);
  for (const c of ship.crew) drawCrew(ctx, scene, s, ship, c, f);
  drawLabel(ctx, scene, s, ship);
}

/**
 * Hull silhouette with rounded corners; corners on the bow (the end facing away from home) get a much
 * larger radius, so every hull reads as pointing at its enemy.
 * @param {CanvasRenderingContext2D} ctx @param {SceneShip} s @param {number} cell
 */
function hullPath(ctx, s, cell) {
  const pts = s.outline;
  const n = pts.length;
  const bowX = s.mirror ? Math.min(...pts.map((p) => p[0])) : Math.max(...pts.map((p) => p[0]));
  ctx.beginPath();
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const room = Math.min(Math.hypot(p[0] - prev[0], p[1] - prev[1]), Math.hypot(next[0] - p[0], next[1] - p[1])) / 2;
    const r = Math.min(room, (p[0] === bowX ? 0.95 : 0.3) * cell);
    const m = mid(p, next);
    ctx.arcTo(p[0], p[1], m[0], m[1], r);
  }
  ctx.closePath();
}

/** Shield layers as halo rings: lit layers glow, the next layer fills as it regenerates. */
function drawHalos(ctx, ship, box, cell, elapsedMs, now) {
  const pool = ship.pools.shield;
  if (!pool || pool.max <= 0) return;
  for (let i = 0; i < pool.max; i++) {
    const off = cell * (0.26 + 0.1 * i);
    const x = box.x - off;
    const y = box.y - off;
    const w = box.w + off * 2;
    const h = box.h + off * 2;
    const r = h / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.save();
    if (i < pool.v) {
      ctx.shadowColor = rgba(C.halo, 0.8);
      ctx.shadowBlur = 10;
      ctx.lineWidth = THEME.line.halo;
      ctx.strokeStyle = rgba(C.halo, 0.62 + 0.12 * Math.sin(now / 900 + i));
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(C.halo, 0.1);
      ctx.setLineDash([2, 6]);
      ctx.stroke();
      if (i === pool.v && pool.regen) {
        const k = meterAt(pool.regen, elapsedMs);
        const per = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
        ctx.setLineDash([per * k, per]);
        ctx.lineWidth = THEME.line.halo;
        ctx.strokeStyle = rgba(C.halo, 0.45);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {Scene} scene @param {SceneShip} s @param {Ship} ship @param {string} id @param {Frame} f */
function drawRoom(ctx, scene, s, ship, id, f) {
  const r = s.rooms[id];
  const inset = Math.max(1.5, scene.cell * 0.05);
  const x = r.x + inset;
  const y = r.y + inset;
  const w = r.w - inset * 2;
  const h = r.h - inset * 2;
  const rad = Math.min(4, scene.cell * 0.1);
  const type = systemAt(scene.content, ship, id);
  const sys = type ? ship.systems[type] : null;
  const wreck = ship.out !== null;
  const seed = hashSeed(ship.id + id);
  const dmg = sys && sys.level ? sys.damage / sys.level : 0;
  // Damaged rooms stutter: their light drops out in irregular beats.
  const stutter = dmg > 0 ? (flicker(f.now, seed, 90) < 0.22 ? 0.25 : 1) : 1;
  const lit = sys && !wreck && sys.level ? (sys.power / sys.level) * stutter : 0;

  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
  if (sys && !wreck) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
    g.addColorStop(0, rgba(C.amber, 0.03 + 0.22 * lit));
    g.addColorStop(1, rgba(C.amber, 0.01 + 0.05 * lit));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    ctx.shadowColor = rgba(C.amber, 0.8 * lit);
    ctx.shadowBlur = 12 * lit;
    ctx.lineWidth = THEME.line.room;
    ctx.strokeStyle = rgba(lit > 0 ? C.amber : C.line, lit > 0 ? 0.25 + 0.6 * lit : 0.3);
    ctx.stroke();
    ctx.restore();
    filaments(ctx, sys, x, y, w, h, scene.cell, stutter);
  } else {
    ctx.fillStyle = rgba(C.line, wreck ? 0.01 : 0.02);
    ctx.fill();
    ctx.lineWidth = THEME.line.room;
    ctx.strokeStyle = rgba(wreck ? C.faint : C.line, wreck ? 0.6 : 0.2);
    ctx.stroke();
  }
  if (!sys) return;

  const def = scene.content.systems[type];
  const size = Math.min(w, h) * 0.2;
  const dir = s.mirror ? -1 : 1;
  ctx.save();
  ctx.lineWidth = Math.max(1.2, scene.cell * 0.035);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = rgba(lit > 0 ? C.amber : C.line, wreck ? 0.18 : lit > 0 ? 0.55 + 0.45 * lit : 0.35);
  ctx.fillStyle = ctx.strokeStyle;
  (GLYPHS[type] ?? letterGlyph(def.label))(ctx, x + w / 2, y + h / 2, size, dir);
  ctx.restore();
  if (wreck) return;

  if (dmg > 0) hatch(ctx, x, y, w, h, rad, rgba(C.damage, (0.35 + 0.45 * dmg) * (stutter < 1 ? 0.5 : 1)), scene.cell);
  const ion = sys.status.ion?.n ?? 0;
  if (ion > 0) drawIon(ctx, x, y, w, h, rad, ion, f.now, seed);
  if (sys.damage > 0 && sys.repair.v + sys.repair.rate > 0) {
    const k = meterAt(sys.repair, f.elapsedMs);
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, size * 1.55, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(C.mark, 0.85);
    ctx.stroke();
  }
}

/**
 * What each installed bar of a system is doing, bottom bar first: 'lit' (powered), 'wanted' (free but
 * asked for), 'free', 'locked' (capacity lost to a status such as ion) or 'dmg'. The HUD pips and the
 * room filaments both draw this.
 * @param {import('../shared/sim/types.js').SystemState} sys @returns {string[]}
 */
export function barStates(sys) {
  const cap = capacity(sys);
  const locked = Math.min(capacityPenalty(sys), sys.level - sys.damage);
  const want = sys.want ?? sys.power;
  return Array.from({ length: sys.level }, (_, i) =>
    i < sys.power ? 'lit' : i < cap ? (i < want ? 'wanted' : 'free') : i < cap + locked ? 'locked' : 'dmg');
}

const BAR_COLOR = { lit: C.amber, wanted: C.faint, free: C.faint, locked: C.ion, dmg: C.damage };

/** One filament per installed bar along the room's floor (see barStates). */
function filaments(ctx, sys, x, y, w, h, cell, stutter) {
  const bars = barStates(sys);
  const gap = 2.5;
  const fw = Math.max(2, Math.min(cell * 0.22, (w - 8 - gap * (bars.length - 1)) / bars.length));
  const fh = Math.max(2, cell * 0.055);
  ctx.save();
  bars.forEach((state, i) => {
    const lit = state === 'lit';
    ctx.shadowColor = lit ? rgba(C.amber, 0.9 * stutter) : 'transparent';
    ctx.shadowBlur = lit ? 6 : 0;
    ctx.fillStyle = rgba(BAR_COLOR[state], lit ? stutter : 0.9);
    ctx.fillRect(x + 5 + i * (fw + gap), y + h - 5 - fh, fw, fh);
  });
  ctx.restore();
}

/** Diagonal red hatch clipped to a room. */
function hatch(ctx, x, y, w, h, rad, color, cell) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  const gap = Math.max(5, cell * 0.16);
  ctx.beginPath();
  for (let d = -h; d < w; d += gap) {
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Ion: a cold wash and static that flickers; one tick mark per stack. */
function drawIon(ctx, x, y, w, h, rad, n, now, seed) {
  const k = flicker(now, seed + 3, 55);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
  ctx.fillStyle = rgba(C.ion, 0.08 + 0.14 * k);
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = rgba(C.ion, 0.35 + 0.4 * k);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const yy = y + h * flicker(now, seed + 11 * i, 45);
    ctx.moveTo(x, yy);
    for (let xx = x; xx <= x + w; xx += 6) ctx.lineTo(xx, yy + (flicker(now + xx, seed + i, 45) - 0.5) * 4);
  }
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = rgba(C.ion, 0.95);
  for (let i = 0; i < n; i++) ctx.fillRect(x + 4 + i * 6, y + 4, 3, 3);
}

/** Line icons per system type, centered at (cx, cy) with half-size s; dir is +1 bow right, -1 bow left. */
/** @type {Record<string, (ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, dir: number) => void>} */
const GLYPHS = {
  piloting(ctx, cx, cy, s, dir) {
    ctx.beginPath();
    ctx.moveTo(cx - dir * s * 0.55, cy - s * 0.75);
    ctx.lineTo(cx + dir * s * 0.65, cy);
    ctx.lineTo(cx - dir * s * 0.55, cy + s * 0.75);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - dir * s * 0.55, cy, s * 0.16, 0, Math.PI * 2);
    ctx.fill();
  },
  shields(ctx, cx, cy, s) {
    for (const k of [1, 0.55]) {
      ctx.beginPath();
      ctx.arc(cx, cy + s * 0.45, s * k, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.9, cy + s * 0.55);
    ctx.lineTo(cx + s * 0.9, cy + s * 0.55);
    ctx.stroke();
  },
  engines(ctx, cx, cy, s, dir) {
    ctx.beginPath();
    for (const [i, len] of [[-1, 0.7], [0, 1], [1, 0.7]]) {
      ctx.moveTo(cx + dir * s * 0.5, cy + i * s * 0.5);
      ctx.lineTo(cx + dir * s * (0.5 - 1.3 * len), cy + i * s * 0.5);
    }
    ctx.moveTo(cx + dir * s * 0.75, cy - s * 0.8);
    ctx.lineTo(cx + dir * s * 0.75, cy + s * 0.8);
    ctx.stroke();
  },
  weapons(ctx, cx, cy, s) {
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + dx * s * 0.72, cy + dy * s * 0.72);
      ctx.lineTo(cx + dx * s * 1.05, cy + dy * s * 1.05);
    }
    ctx.stroke();
  },
};

/** @param {string} label */
function letterGlyph(label) {
  return (ctx, cx, cy, s) => {
    ctx.font = `600 ${Math.round(s * 1.6)}px ${THEME.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((label || '?')[0], cx, cy);
  };
}

/** Doors: short bright ticks across the shared wall. */
function drawDoors(ctx, s, cell, wreck) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, cell * 0.07);
  ctx.strokeStyle = rgba(wreck ? C.faint : C.line, wreck ? 0.5 : 0.5);
  ctx.beginPath();
  for (const d of s.geo.doors) {
    const gx = d.dir === 'v' ? d.x + 1 : d.x;
    const gy = d.dir === 'v' ? d.y : d.y + 1;
    const [ax, ay, bx, by] = d.dir === 'v' ? [gx, gy + 0.3, gx, gy + 0.7] : [gx + 0.3, gy, gx + 0.7, gy];
    const x0 = s.x + (s.mirror ? s.geo.w - ax : ax) * cell;
    const x1 = s.x + (s.mirror ? s.geo.w - bx : bx) * cell;
    ctx.moveTo(x0, s.y + ay * cell);
    ctx.lineTo(x1, s.y + by * cell);
  }
  ctx.stroke();
  ctx.restore();
}

/** A hardpoint on the hull: a short barrel whose light grows with its charge. */
function drawMount(ctx, scene, s, dev, wreck, f) {
  const m = s.mounts[dev.id];
  if (!m) return;
  const cell = scene.cell;
  const k = meterAt(dev.charge, f.elapsedMs);
  const full = k >= 1;
  const len = cell * 0.3;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, cell * 0.08);
  ctx.strokeStyle = rgba(wreck ? C.faint : C.line, wreck ? 0.6 : 0.75);
  ctx.beginPath();
  ctx.moveTo(m.x, m.y - m.ny * cell * 0.12);
  ctx.lineTo(m.x + m.nx * len, m.y + m.ny * len);
  ctx.stroke();
  if (!wreck && dev.powered) {
    const pulse = full ? 0.75 + 0.25 * Math.sin(f.now / 140) : 1;
    ctx.shadowColor = rgba(C.amber, 0.9);
    ctx.shadowBlur = 6 + 10 * k;
    ctx.fillStyle = rgba(full ? C.mark : C.amber, (0.25 + 0.75 * k) * pulse);
    ctx.beginPath();
    ctx.arc(m.x + m.nx * len, m.y + m.ny * len, Math.max(1.5, cell * (0.05 + 0.07 * k)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** @param {string} name */
export function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? '')).toUpperCase();
}

/** Where a crew member is drawn now: between its cell and the cell it steps into. */
export function crewPoint(scene, shipId, c, elapsedMs) {
  const a = cellCenter(scene, shipId, c.cell);
  if (!c.path.length) return a;
  const b = cellCenter(scene, shipId, c.path[0]);
  const k = meterAt(c.walk, elapsedMs);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function drawCrew(ctx, scene, s, ship, c, f) {
  const p = crewPoint(scene, ship.id, c, f.elapsedMs);
  const r = Math.max(8, scene.cell * 0.26);
  const tint = s.own ? C.mark : sideColor(ship.side);
  const hp = c.maxHp ? c.hp / c.maxHp : 0;
  const selected = s.own && f.ui.mode === 'crew' && f.ui.crew.includes(c.id);
  ctx.save();
  if (selected) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 5 + Math.sin(f.now / 160) * 1.2, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(C.mark, 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = C.ink;
  ctx.fill();
  ctx.shadowColor = rgba(tint, 0.6);
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = rgba(tint, 0.4);
  ctx.stroke();
  ctx.shadowBlur = 0;
  // hp as the mote's own ring, starting at twelve o'clock
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2);
  ctx.strokeStyle = hp < 0.35 ? C.damage : rgba(tint, 0.95);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = rgba(C.text, 0.95);
  ctx.font = `600 ${Math.round(r * 0.78)}px ${THEME.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(c.name), p.x, p.y + 0.5);
  if (c.task === 'man' || c.task === 'repair') {
    const a = c.task === 'repair' ? f.now / 220 : -Math.PI / 2;
    ctx.fillStyle = c.task === 'man' ? C.amber : C.mark;
    ctx.beginPath();
    ctx.arc(p.x + Math.cos(a) * (r + 3.5), p.y + Math.sin(a) * (r + 3.5), 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Name, hull and evasion above the ship, then hull as a row of segments; facts drop when space is short. */
function drawLabel(ctx, scene, s, ship) {
  const { x, y, w } = s.label;
  const small = scene.cell < 30;
  const hull = ship.pools.hull;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `600 ${small ? 12 : 14}px ${THEME.font}`;
  ctx.fillStyle = rgba(ship.out ? C.dim : C.text, 0.95);
  ctx.fillText(ship.name, x, y - 14);
  const nameW = ctx.measureText(ship.name).width + 10;
  ctx.font = `${small ? 11 : 12}px ${THEME.font}`;
  ctx.fillStyle = C.dim;
  const facts = ship.out ? [ship.out === 'hull' ? 'hull breached' : 'no crew left']
    : [`hull ${hull.v}/${hull.max}`, `evasion ${ship.stats.evasion ?? 0}%`];
  while (facts.length && nameW + ctx.measureText(facts.join('   ')).width > w) facts.pop();
  ctx.fillText(facts.join('   '), x + nameW, y - 14);
  const avail = Math.max(40, Math.min(s.w + HULL_PAD * 2 * scene.cell, 260, w));
  const seg = Math.max(1, Math.min(6, avail / Math.max(1, hull.max) - 2));
  for (let i = 0; i < hull.max; i++) {
    const on = i < hull.v;
    ctx.fillStyle = on ? rgba(hull.v / hull.max < 0.34 ? C.damage : C.text, 0.85) : rgba(C.faint, 0.8);
    ctx.fillRect(x + i * (seg + 2), y - 7, seg, 4);
  }
  ctx.restore();
}

// ---- targets and shots ----

/** Reticles on enemy rooms while aiming; numbered markers on every visible target. */
function drawTargets(ctx, scene, ships, f) {
  const you = f.you;
  const mine = you?.ship ? ships.find((s) => s.id === you.ship) : null;
  if (mine && f.ui.mode === 'aiming') {
    for (const ship of ships) {
      if (ship.side === mine.side || ship.out) continue;
      for (const r of Object.values(scene.ships[ship.id]?.rooms ?? {})) brackets(ctx, r, rgba(C.mark, 0.45 + 0.25 * Math.sin(f.now / 200)), scene.cell * 0.22);
    }
  }
  /** @type {Map<string, number>} */
  const stacked = new Map();
  for (const ship of ships) {
    ship.devices.forEach((dev, i) => {
      const t = dev.target;
      const room = t && scene.ships[t.ship]?.rooms[t.room];
      if (!room) return;
      const key = t.ship + ':' + t.room;
      const n = stacked.get(key) ?? 0;
      stacked.set(key, n + 1);
      const color = ship.id === you?.ship ? C.mark : sideColor(ship.side);
      brackets(ctx, room, rgba(color, 0.95), scene.cell * 0.3);
      const bx = room.x + room.w - 9 - n * 16;
      const by = room.y + 9;
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fillStyle = C.ink;
      ctx.fill();
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = rgba(color, 1);
      ctx.font = `700 10px ${THEME.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), bx, by + 0.5);
    });
  }
}

/** Corner brackets around a rect. */
function brackets(ctx, r, color, len) {
  const L = Math.min(len, r.w / 3, r.h / 3);
  const x0 = r.x + 2;
  const y0 = r.y + 2;
  const x1 = r.x + r.w - 2;
  const y1 = r.y + r.h - 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    ctx.moveTo(cx + sx * L, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * L);
  }
  ctx.stroke();
  ctx.restore();
}

function drawShot(ctx, scene, shot, f) {
  const path = shotPath(scene, shot);
  if (!path) return;
  const raw = (shot.flight.v + shot.flight.rate * f.elapsedMs) / shot.flight.max;
  if (raw < 0) return;   // a later shot of a volley, still in the barrel
  const look = scene.content.devices[shot.bp]?.look ?? 'spark';
  (LOOKS[look] ?? LOOKS.spark)(ctx, path, Math.min(1, raw), f.now, 1);
}

/**
 * Projectile drawings keyed by a weapon's `look`: (ctx, path, t, now, alpha).
 * @type {Record<string, (ctx: CanvasRenderingContext2D, path: Path, t: number, now: number, alpha: number) => void>}
 */
export const LOOKS = {
  spark(ctx, path, t, now, alpha) {
    const head = pathAt(path, t);
    const tail = pathAt(path, Math.max(0, t - 0.07));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = rgba(C.amber, alpha);
    ctx.shadowBlur = 12;
    ctx.strokeStyle = rgba(C.amber, 0.8 * alpha);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    ctx.strokeStyle = rgba(C.mark, alpha);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  },
  dart(ctx, path, t, now, alpha) {
    ctx.save();
    ctx.lineCap = 'round';
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const a = pathAt(path, Math.max(0, t - 0.3 * (1 - i / steps)));
      const b = pathAt(path, Math.max(0, t - 0.3 * (1 - (i + 1) / steps)));
      ctx.strokeStyle = rgba(C.line, (i / steps) * 0.55 * alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const head = pathAt(path, t);
    ctx.shadowColor = rgba(C.mark, alpha);
    ctx.shadowBlur = 8;
    ctx.strokeStyle = rgba(C.mark, alpha);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(head.x - head.dx * 9, head.y - head.dy * 9);
    ctx.lineTo(head.x + head.dx * 3, head.y + head.dy * 3);
    ctx.stroke();
    ctx.restore();
  },
  pulse(ctx, path, t, now, alpha) {
    const head = pathAt(path, t);
    const beat = (now % 360) / 360;
    ctx.save();
    ctx.shadowColor = rgba(C.ion, alpha);
    ctx.shadowBlur = 10;
    ctx.fillStyle = rgba(C.ion, 0.9 * alpha);
    ctx.beginPath();
    ctx.arc(head.x, head.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    for (const k of [beat, (beat + 0.5) % 1]) {
      ctx.beginPath();
      ctx.arc(head.x, head.y, 3 + k * 9, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(C.ion, (1 - k) * 0.8 * alpha);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  },
};
