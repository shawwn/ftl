// @ts-check
// Boot and wiring (design doc 17.1, 17.6): URL parameters choose a connector and a first action; a
// GameClient carries the protocol; every snapshot re-lays the scene and feeds FX; a rAF loop draws the
// latest snapshot with meters extrapolated by elapsedMs; taps and HUD buttons become intents for the
// reducer, whose commands go out through client.cmd.
//
// Doc choices:
// - Behind the start menu the stage shows a still world (createWorld of the first two blueprints) as
//   the hero; it never ticks and is replaced by the first real snapshot.
// - The URL describes the membership the player chose (writeUrl): after joining an online match it is
//   ?join=CODE (keeping local, debug, server and name), so a reload reconnects into the same fight; Menu
//   removes join and spectate, so a reload after leaving does not put the player back in. Offline (?local)
//   matches live in the page and are not kept.
// - The connection banner covers every retry: before any welcome it says the server cannot be reached.
//   Pressing Menu while still connecting is a choice: boot then skips the URL's first action.
// - The canvas backing store follows devicePixelRatio: a ResizeObserver handles CSS size changes and the
//   frame loop catches a ratio change at the same CSS size (a window moved to another monitor).
// - The player token lives in sessionStorage, not localStorage: it survives a reload (which resumes the
//   seat), and every tab is its own player. With one token per browser, two tabs would keep taking the
//   seat from each other (each reconnects when the server closes the older session), and a second tab
//   could not join as a crewmate or opponent.
// - Uncaught errors and unhandled rejections are always collected; ?debug exposes them in __ftl.
// - tapPoint returns viewport CSS px (what CDP input expects); weapon and crew points are the HUD
//   controls, room points are on the canvas.

import { CONTENT } from '../shared/content/index.js';
import { createWorld, project, shipsInOrder } from '../shared/sim/index.js';
import { GameClient } from './game-client.js';
import { localConnector, wsConnector } from './net.js';
import { initialUi, reduceUi, REASON_TEXT } from './ui-state.js';
import { layoutScene, pick, roomCenter } from './scene.js';
import { createRenderer } from './render.js';
import { createFx } from './fx.js';
import { createHud } from './hud.js';
import { bindPointer } from './input.js';
import { createMenu } from './menu.js';
import { cssVars } from './theme.js';

/** @typedef {import('./ui-state.js').Intent} Intent */

const params = new URLSearchParams(location.search);
const LOCAL = params.has('local');
/** @type {string[]} */
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.message ?? e.reason)));

for (const [k, v] of Object.entries(cssVars())) document.documentElement.style.setProperty(k, v);

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const stage = $('stage');
const canvas = /** @type {HTMLCanvasElement} */ ($('canvas'));
const hudRoot = $('hud');
const overlay = $('overlay');
const banner = $('banner');
const bar = { match: $('bar-match'), vs: $('bar-vs'), pause: $('bar-pause'), menu: $('bar-menu') };

const tokenStore = {
  get() {
    try { return sessionStorage.getItem('ftl.token'); } catch { return null; }
  },
  /** @param {string} t */
  set(t) {
    try { sessionStorage.setItem('ftl.token', t); } catch { /* storage may be unavailable */ }
  },
};

const defaultServer = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const connector = LOCAL ? localConnector() : wsConnector(params.get('server') || defaultServer);
const client = new GameClient(connector, { name: params.get('name') ?? undefined, tokenStore });

const renderer = createRenderer(canvas);
const fx = createFx();
const hud = createHud(hudRoot, dispatch);
const menu = createMenu(overlay, {
  playAi: (o) => enter(client.create('vsAi', { ...o, ...seedOpt() })),
  watchAi: (o) => enter(client.create('aiVsAi', { ...o, ...seedOpt() })),
  createPvp: (o) => enter(client.create('pvp', { ...o, ...seedOpt() })),
  join: (code, o) => enter(client.join(code, o)),
  rematch: () => client.rematch().catch(fail),
  toMenu,
  offline: LOCAL ? null : () => { location.search = '?local'; },
});

/** @type {import('./ui-state.js').Ui} */
let ui = initialUi();
/** @type {import('./scene.js').Scene | null} */
let scene = null;
let sceneOf = null;
let size = { w: 1, h: 1 };
/** @typedef {'boot' | 'menu' | 'waiting' | 'running' | 'ended'} Phase */
/** @type {Phase} */
let phase = 'boot';
let overlayFor = '';

/** The still world behind the start menu. */
const backdrop = (() => {
  const [a, b] = Object.keys(CONTENT.ships);
  const world = createWorld({ seed: 1, ships: [{ id: 's1', bp: a, side: 'blue' }, { id: 's2', bp: b ?? a, side: 'red' }] }, CONTENT);
  return { view: project(world, { kind: 'all' }), paused: false, tick: 0, ev: [] };
})();

function seedOpt() {
  const seed = Number(params.get('seed'));
  return params.has('seed') && Number.isInteger(seed) && seed >= 0 ? { seed } : {};
}

/** @param {Phase} p */
function setPhase(p) {
  phase = p;
  document.body.dataset.phase = p;
}

/** @param {{ code?: string, msg?: string }} err */
function fail(err) {
  hud.toast(REASON_TEXT[err?.code] ?? err?.msg ?? 'Something went wrong');
}

/** @param {Promise<any>} request */
async function enter(request) {
  try {
    const joined = await request;
    if (!LOCAL) writeUrl(joined);
  } catch (err) {
    toMenu(REASON_TEXT[err?.code] ?? err?.msg);
  }
}

/**
 * Write the URL from the chosen membership: ?join=CODE (and spectate) for an online match, nothing for the
 * menu; local, debug, server and name are kept.
 * @param {{ code: string, you?: { role?: string } } | null} joined
 */
function writeUrl(joined) {
  const keep = new URLSearchParams();
  if (joined) {
    keep.set('join', joined.code);
    if (joined.you?.role === 'spectator') keep.set('spectate', '1');
  }
  for (const k of ['local', 'debug', 'server', 'name']) if (params.has(k)) keep.set(k, params.get(k) ?? '');
  const query = keep.toString().replace(/=(&|$)/g, '$1');
  history.replaceState(null, '', query ? '?' + query : location.pathname);
}

/** Notes for the menu when a match ends without the player asking ('left' reasons). */
const LEFT_TEXT = {
  gone: 'That match is over.',
  error: 'The match stopped because of an error.',
  idle: 'The match closed after everyone left.',
};

/** @param {string} [note] */
function toMenu(note) {
  client.leave().catch(() => {});   // clears local state and intent at once, even offline
  writeUrl(null);
  fx.reset();
  ui = initialUi();
  overlayFor = '';
  hudRoot.hidden = true;
  setPhase('menu');
  menu.showStart(note);
}

/** @param {Intent} intent */
function dispatch(intent) {
  const r = reduceUi(ui, intent, { view: client.snap?.view ?? null, you: client.you });
  ui = r.ui;
  for (const c of r.cmds) client.cmd(c);
}

function relayout() {
  const snap = client.snap ?? backdrop;
  scene = layoutScene(snap.view, client.snap ? client.you : null, size, CONTENT);
  sceneOf = snap;
}

/** Overlays follow the match phase: waiting shows the invite, ended shows the outcome. */
function syncOverlay(snap) {
  const key = `${client.code}:${snap.round}:${snap.phase}`;
  if (key === overlayFor) return;
  overlayFor = key;
  if (snap.phase === 'ended') menu.showOutcome(snap, client.you);
  else if (snap.phase === 'waiting' && client.you?.role === 'crew') {
    menu.showWaiting(client.code, `${location.origin}${location.pathname}?join=${client.code}`);
  } else menu.hide();
}

function updateBar(snap) {
  const you = client.you;
  bar.match.replaceChildren(document.createTextNode('code '), Object.assign(document.createElement('b'), { textContent: client.code ?? '' }),
    document.createTextNode(`  round ${snap.round}`));
  const mine = you?.ship ? snap.view.ships[you.ship] : null;
  const names = (pred) => snap.roster.filter((m) => m.ship && pred(snap.view.ships[m.ship])).map((m) => m.name);
  bar.vs.textContent = mine ? `vs ${names((s) => s && s.side !== mine.side).join(', ') || 'nobody yet'}`
    : `watching ${shipsInOrder(snap.view).map((s) => s.name).join(' and ')}`;
  const rule = client.rules?.pause;
  bar.pause.hidden = !(rule === 'any' || (rule === 'crew' && you?.role === 'crew')) || snap.phase === 'ended';
  bar.pause.textContent = snap.paused ? 'Resume' : 'Pause';
  bar.pause.setAttribute('aria-pressed', String(!!snap.paused));
}

// ---- client events ----

client.addEventListener('snap', (e) => {
  const { snap, fresh } = /** @type {CustomEvent} */ (e).detail;
  if (fresh) {
    fx.reset();
    ui = initialUi();
  }
  relayout();
  fx.ingest(snap.ev, scene, snap.view);
  setPhase(snap.phase === 'ended' ? 'ended' : snap.phase === 'waiting' ? 'waiting' : 'running');
  syncOverlay(snap);
  updateBar(snap);
});
client.addEventListener('ack', (e) => {
  const ack = /** @type {CustomEvent} */ (e).detail;
  if (!ack.ok) hud.toast(REASON_TEXT[ack.why] ?? ack.why);
});
client.addEventListener('error', (e) => fail(/** @type {CustomEvent} */ (e).detail));
client.addEventListener('left', (e) => {
  const reason = /** @type {CustomEvent} */ (e).detail?.reason;
  toMenu(LEFT_TEXT[reason] ?? REASON_TEXT[reason] ?? 'You left the match.');
});
client.addEventListener('status', () => {
  const text = client.status === 'reconnecting'
    ? (client.welcome ? 'Connection lost. Reconnecting.' : 'Cannot reach the server. Retrying.')
    : client.status === 'outdated' ? 'This client is out of date. Reload to update.' : '';
  banner.hidden = !text;
  banner.textContent = text;
});

bar.pause.addEventListener('click', () => client.pause(!client.snap?.paused).catch(fail));
bar.menu.addEventListener('click', () => toMenu());
document.getElementById('app').addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.repeat) return;
  if (/^[1-9]$/.test(e.key) || e.key === 'Escape') dispatch({ kind: 'key', key: e.key });
});

bindPointer(canvas, (x, y) => (scene && client.snap ? pick(scene, x, y) : { kind: 'tapEmpty' }), dispatch);

let dpr = 0;
function resize() {
  size = { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) };
  dpr = window.devicePixelRatio || 1;
  renderer.resize(size.w, size.h, dpr);
  relayout();
  if (client.snap) fx.ingest([], scene, client.snap.view);   // running effects follow the new layout
}
new ResizeObserver(resize).observe(stage);

// ---- frame loop ----

function frame(now) {
  requestAnimationFrame(frame);
  if ((window.devicePixelRatio || 1) !== dpr) resize();   // same CSS size, new pixel ratio
  const live = client.snap;
  const snap = live ?? backdrop;
  if (sceneOf !== snap) relayout();
  const elapsedMs = !live || live.paused ? 0 : Math.min(now - client.recvAt, 250);
  renderer.draw({ scene, snap, elapsedMs, ui, you: live ? client.you : null, fx: live ? fx : null, now });
  if (live) hud.update({ snap: live, you: client.you, ui, pending: client.pending, content: CONTENT, elapsedMs });
}
requestAnimationFrame(frame);

// ---- debug hook ----

if (params.has('debug')) {
  /** @param {Element | null} el */
  const center = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  /** @type {any} */ (window).__ftl = {
    client,
    errors,
    get ui() { return ui; },
    get scene() { return scene; },
    get phase() { return phase; },
    get lastAck() { return client.lastAck; },
    /** @param {'weapon' | 'room' | 'crew'} kind @param {...any} args */
    tapPoint(kind, ...args) {
      if (kind === 'room') {
        if (!scene?.ships[args[0]]?.rooms[args[1]]) return null;
        const r = canvas.getBoundingClientRect();
        const c = roomCenter(scene, args[0], args[1]);
        return { x: r.left + c.x, y: r.top + c.y };
      }
      if (kind === 'weapon') {
        const dev = client.snap?.view.ships[client.you?.ship]?.devices[args[0]];
        return dev ? center(document.querySelector(`[data-tap="dev:${dev.id}"]`)) : null;
      }
      if (kind === 'crew') return center(document.querySelector(`[data-tap="crew:${args[0]}"]`));
      return null;
    },
  };
}

// ---- boot ----

async function boot() {
  await client.start();
  if (client.status === 'outdated' || phase !== 'boot') return;   // Menu while connecting: that choice stands
  const first = { a: params.get('a'), b: params.get('b'), ship: params.get('ship'), ai: params.get('ai'),
    aiA: params.get('aiA'), aiB: params.get('aiB') };
  /** @param {string[]} keys */
  const opts = (...keys) => Object.fromEntries(keys.filter((k) => first[k]).map((k) => [k, first[k]]));
  if (params.get('play') === 'ai') return enter(client.create('vsAi', { ...opts('ship', 'ai'), ...seedOpt() }));
  if (params.get('watch') === 'ai') return enter(client.create('aiVsAi', { ...opts('a', 'b', 'aiA', 'aiB'), ...seedOpt() }));
  if (params.get('pvp') === 'new') return enter(client.create('pvp', { ...opts('a', 'b'), ...seedOpt() }));
  if (params.get('join')) return enter(client.join(params.get('join').toUpperCase(), { spectate: params.get('spectate') === '1' }));
  if (!client.code) toMenu();
}

setPhase('boot');
boot();
