// @ts-check
// Event animations (design doc 17.3). Events are decoration: each FX entry turns one event into short-lived
// drawings (items) and optional screen shake; a client that misses every event is still correct.
// Doc choices:
// - createFx takes an optional { now } clock. FX handlers receive (event, scene, state).
// - Items capture ids (ship, room, device, crew), never pixels: they resolve positions against the latest
//   scene when drawn, so a resize mid-animation moves them with the ships. ingest(events, scene, view)
//   with no events just refreshes that scene (main.js calls it on every relayout).
// - The state remembers crew and shots in flight from the previous ingest, because crewDied and miss
//   arrive after the crew member or shot has left the view.
// - Floating damage numbers rise from the hull bar (hullDamaged carries no room). Shake and vibration
//   answer hits on your own ship only, and respect prefers-reduced-motion and user activation.

import { roomOfSystem, shipsInOrder } from '../shared/sim/index.js';
import { THEME, rgba } from './theme.js';
import { hullBox, roomCenter, shotPath } from './scene.js';
import { LOOKS, crewPoint } from './render.js';

/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {import('../shared/sim/types.js').SimEvent} SimEvent */
/** @typedef {import('../shared/sim/types.js').View} View */
/** @typedef {import('../shared/sim/types.js').Shot} Shot */
/** @typedef {import('../shared/sim/types.js').Crew} Crew */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ t0: number, dur: number, draw: (ctx: CanvasRenderingContext2D, k: number, now: number) => void }} Item */
/**
 * @typedef {object} FxState
 * @property {Item[]} items
 * @property {{ until: number, amp: number }} shake
 * @property {Scene | null} scene                         the latest scene; items read positions from it
 * @property {View | null} view
 * @property {Map<string, { ship: string, crew: Crew }>} crew   crew at the previous ingest
 * @property {Map<string, Shot>} shots                    shots in flight at the previous ingest
 * @property {number} now
 * @property {boolean} calm                               reduced motion
 */

const C = THEME.color;
const M = THEME.motion;

/** @param {FxState} st @param {number} dur @param {Item['draw']} draw @param {number} [delay] */
function add(st, dur, draw, delay = 0) {
  st.items.push({ t0: st.now + delay, dur, draw });
}

/** @param {FxState} st @param {number} amp */
function shake(st, amp) {
  if (st.calm) return;
  st.shake = { until: st.now + M.shakeMs, amp: Math.max(amp, st.shake.until > st.now ? st.shake.amp : 0) };
}

/** @param {FxState} st @param {string} ship @param {string} room @returns {Rect | undefined} */
const roomRect = (st, ship, room) => st.scene?.ships[ship]?.rooms[room];

function ring(ctx, x, y, r, color, width) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** @param {CanvasRenderingContext2D} ctx @param {Rect} r */
function glowRect(ctx, r, color, blur) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4, 4);
  ctx.fill();
  ctx.restore();
}

function text(ctx, s, x, y, color, size) {
  ctx.save();
  ctx.font = `700 ${size}px ${THEME.font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, x, y);
  ctx.restore();
}

/** Flash of a system's room, for events that name a system. */
function systemFlash(e, st, dur, draw) {
  const ship = st.view?.ships[e.ship];
  const room = ship ? roomOfSystem(st.scene.content, ship, e.system) : null;
  if (!room) return;
  add(st, dur, (ctx, k, now) => {
    const r = roomRect(st, e.ship, room);
    if (r) draw(ctx, r, k, now);
  });
}

/** @type {Record<string, (e: SimEvent, scene: Scene, st: FxState) => void>} */
export const FX = {
  fired(e, scene, st) {
    add(st, M.flashMs, (ctx, k) => {
      const m = st.scene.ships[e.ship]?.mounts[e.device];
      if (!m) return;
      const reach = st.scene.cell * 0.3;
      ctx.save();
      ctx.shadowColor = rgba(C.amber, 1);
      ctx.shadowBlur = 16;
      ctx.fillStyle = rgba(C.mark, 1 - k);
      ctx.beginPath();
      ctx.arc(m.x + m.nx * reach, m.y + m.ny * reach, 3 + 7 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  },

  miss(e, scene, st) {
    // The shot sails on past the room, along its own path extrapolated beyond t = 1.
    const shot = st.shots.get(e.shot);
    const look = LOOKS[scene.content.devices[e.bp]?.look] ?? LOOKS.spark;
    if (shot) {
      add(st, 600, (ctx, k, now) => {
        const path = shotPath(st.scene, shot);
        if (path) look(ctx, path, 1 + k * 0.45, now, 1 - k);
      });
    }
    add(st, M.floatMs, (ctx, k) => {
      if (!roomRect(st, e.ship, e.room)) return;
      const c = roomCenter(st.scene, e.ship, e.room);
      text(ctx, 'Miss', c.x - 14, c.y - 10 - 18 * k, rgba(C.line, 1 - k), 13);
    });
  },

  shieldHit(e, scene, st) {
    add(st, M.rippleMs, (ctx, k) => {
      const s = st.scene.ships[e.ship];
      if (!s) return;
      const b = hullBox(s);
      const off = st.scene.cell * (0.26 + 0.5 * k);
      ctx.save();
      ctx.shadowColor = rgba(C.halo, 1);
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.roundRect(b.x - off, b.y - off, b.w + off * 2, b.h + off * 2, (b.h + off * 2) / 2);
      ctx.strokeStyle = rgba(C.halo, 0.9 * (1 - k));
      ctx.lineWidth = 2.5 * (1 - k) + 0.5;
      ctx.stroke();
      ctx.restore();
    });
    if (scene.ships[e.ship]?.own) shake(st, 2);
  },

  hit(e, scene, st) {
    add(st, M.flashMs * 1.6, (ctx, k) => {
      const r = roomRect(st, e.ship, e.room);
      if (!r) return;
      const c = roomCenter(st.scene, e.ship, e.room);
      glowRect(ctx, r, rgba(C.mark, 0.85 * (1 - k)), 24);
      ring(ctx, c.x, c.y, 4 + k * st.scene.cell * 1.2, rgba(C.amber, 1 - k), 2);
    });
    if (scene.ships[e.ship]?.own) shake(st, 6);
  },

  hullDamaged(e, scene, st) {
    if (!e.n) return;
    add(st, M.floatMs, (ctx, k) => {
      const s = st.scene.ships[e.ship];
      if (s) text(ctx, '-' + e.n, s.label.x, s.label.y + 18 - 12 * k, rgba(C.damage, 1 - k * k), 16);
    });
    const nav = /** @type {any} */ (globalThis.navigator);
    if (scene.ships[e.ship]?.own && !st.calm && nav?.userActivation?.hasBeenActive) nav.vibrate?.(20);
  },

  systemDamaged(e, scene, st) {
    systemFlash(e, st, M.stutterMs, (ctx, r, k, now) => {
      if (Math.floor(now / 70) % 2) glowRect(ctx, r, rgba(C.damage, 0.4 * (1 - k)), 18);
    });
  },

  ionized(e, scene, st) {
    systemFlash(e, st, M.stutterMs, (ctx, r, k, now) => {
      glowRect(ctx, r, rgba(C.ion, (Math.floor(now / 50) % 3 === 0 ? 0.5 : 0.18) * (1 - k)), 22);
    });
  },

  systemRepaired(e, scene, st) {
    const motes = Array.from({ length: 9 }, (_, i) => ({ a: (i / 9) * Math.PI * 2, d: 0.5 + ((i * 37) % 10) / 20 }));
    systemFlash(e, st, M.sparkleMs, (ctx, r, k) => {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      ctx.save();
      ctx.shadowColor = rgba(C.amber, 1);
      ctx.shadowBlur = 8;
      ctx.fillStyle = rgba(C.amber, 1 - k);
      for (const m of motes) {
        const d = st.scene.cell * m.d * (0.3 + k);
        ctx.fillRect(cx + Math.cos(m.a) * d - 1.5, cy + Math.sin(m.a) * d - 1.5 - k * 10, 3, 3);
      }
      ctx.restore();
    });
  },

  crewHurt(e, scene, st) {
    const was = st.crew.get(e.crew);
    if (!was) return;
    add(st, M.flashMs * 2, (ctx, k) => {
      const p = crewAt(st, was);
      if (p) ring(ctx, p.x, p.y, p.r + 2 + k * 8, rgba(C.damage, 1 - k), 2);
    });
  },

  crewDied(e, scene, st) {
    const was = st.crew.get(e.crew);
    if (!was) return;
    add(st, M.fadeMs, (ctx, k) => {
      const p = crewAt(st, was);
      if (!p) return;
      ring(ctx, p.x, p.y, p.r * (1 + k * 1.5), rgba(C.mark, 0.8 * (1 - k)), 1.5);
      ctx.fillStyle = rgba(C.mark, 0.5 * (1 - k));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 - k), 0, Math.PI * 2);
      ctx.fill();
    });
  },

  shipOut(e, scene, st) {
    const s0 = scene.ships[e.ship];
    if (!s0) return;
    const step = 140;
    // Every room starts lit and goes dark in turn...
    s0.geo.roomIds.forEach((id, i) => {
      const dark = step * (i + 1);
      add(st, dark + 300, (ctx, k) => {
        const r = roomRect(st, e.ship, id);
        const t = k * (dark + 300);
        if (r) glowRect(ctx, r, rgba(C.amber, 0.45 * Math.max(0, t < dark ? 1 : 1 - (t - dark) / 300)), 14);
      });
    });
    // ...then the hull breaks apart: each outline edge drifts outward and spins.
    add(st, M.wreckMs, (ctx, k) => {
      const s = st.scene.ships[e.ship];
      if (!s) return;
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      ring(ctx, cx, cy, 10 + k * s.w * 0.9, rgba(C.mark, 0.6 * (1 - k)), 2);
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(C.line, 0.85 * (1 - k));
      ctx.beginPath();
      s.outline.forEach((p, i) => {
        const q = s.outline[(i + 1) % s.outline.length];
        const mx = (p[0] + q[0]) / 2;
        const my = (p[1] + q[1]) / 2;
        const len = Math.hypot(mx - cx, my - cy) || 1;
        const d = k * st.scene.cell * 2.2;
        const a = (((i * 7) % 5) - 2) * 0.4 * k;
        const hx = (q[0] - p[0]) / 2;
        const hy = (q[1] - p[1]) / 2;
        const rx = hx * Math.cos(a) - hy * Math.sin(a);
        const ry = hx * Math.sin(a) + hy * Math.cos(a);
        const ox = mx + ((mx - cx) / len) * d;
        const oy = my + ((my - cy) / len) * d;
        ctx.moveTo(ox - rx, oy - ry);
        ctx.lineTo(ox + rx, oy + ry);
      });
      ctx.stroke();
      ctx.restore();
    }, step * s0.geo.roomIds.length + 200);
    shake(st, s0.own ? 10 : 4);
  },
};

/** Where a remembered crew member stood, on the latest scene. */
function crewAt(st, { ship, crew }) {
  if (!st.scene?.ships[ship]) return null;
  return { ...crewPoint(st.scene, ship, crew, 0), r: Math.max(8, st.scene.cell * 0.26) };
}

/** @param {{ now?: () => number }} [opts] */
export function createFx({ now = () => performance.now() } = {}) {
  /** @type {FxState} */
  const st = {
    items: [], shake: { until: 0, amp: 0 }, scene: null, view: null, crew: new Map(), shots: new Map(), now: now(),
    calm: !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  };
  return {
    /** @param {SimEvent[]} events @param {Scene} scene @param {View} view */
    ingest(events, scene, view) {
      st.now = now();
      st.scene = scene;
      st.view = view;
      for (const e of events) if (Object.hasOwn(FX, e.type)) FX[e.type](e, scene, st);
      st.crew = new Map(shipsInOrder(view).flatMap((s) => s.crew.map((c) => [c.id, { ship: s.id, crew: c }])));
      st.shots = new Map(view.shots.map((s) => [s.id, s]));
    },
    /** @param {CanvasRenderingContext2D} ctx @param {number} t */
    draw(ctx, t) {
      st.items = st.items.filter((it) => t < it.t0 + it.dur);
      if (!st.scene) return;
      for (const it of st.items) if (t >= it.t0) it.draw(ctx, (t - it.t0) / it.dur, t);
    },
    /** @param {number} t @returns {{ x: number, y: number }} */
    offset(t) {
      if (t >= st.shake.until) return { x: 0, y: 0 };
      const k = ((st.shake.until - t) / M.shakeMs) * st.shake.amp;
      return { x: Math.sin(t * 0.09) * k, y: Math.cos(t * 0.113) * k };
    },
    reset() {
      st.items = [];
      st.shake = { until: 0, amp: 0 };
      st.crew = new Map();
      st.shots = new Map();
    },
  };
}
