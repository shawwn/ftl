// @ts-check
// The DOM HUD (design doc 17.3, 17.4): reactor filaments, one power column per system, weapon cards and
// crew chips, plus toasts. Every control dispatches an Intent; nothing here talks to the network.
// Widgets are built once per "shape" (ship, systems, devices, crew) and then updated in place each frame,
// touching the DOM only when a value changes.
//
// Doc choices:
// - Spectators see the HUD of the first home ship (s1), read-only: values update, controls are hidden.
// - Whether a system takes [+]/[-] comes from COMMANDS.setPower.check (subsystems and host systems answer
//   'not-powerable'); a button is disabled when check rejects the level it would ask for. Reactor
//   availability is left to the sim, so a refused tap explains itself with a toast.
// - Pips, bottom to top, follow render.js barStates: powered, wanted (dashed amber), free, locked (ion),
//   damaged. Tapping or dragging on a pip stack asks for the level under the finger on release, hit
//   testing the drawn pips themselves, so what is drawn is what is tapped.
// - A control pulses while a pending command names it: `system` -> its column, `device` -> its card,
//   `crew` ids -> their chips.
// - The target badge shows the targeted room's system label (the room letter for corridors).
// - While aiming, the card's status line gives way to the weapon's blurb (no hover needed).
// - Exports `h` and `button` (tiny element builders) for menu.js.

import { COMMANDS, canPay, crewRoom, fireBlock, freeReactor, isManned, meterAt, shipsInOrder, systemAt } from '../shared/sim/index.js';
import { THEME } from './theme.js';
import { barStates, initials } from './render.js';
import { REASON_TEXT } from './ui-state.js';

/** @typedef {import('../shared/sim/types.js').Ship} Ship */
/** @typedef {import('../shared/sim/types.js').View} View */
/** @typedef {import('../shared/sim/types.js').Content} Content */
/** @typedef {import('./ui-state.js').Ui} Ui */
/** @typedef {import('./ui-state.js').Intent} Intent */

/**
 * Element builder: h('button', { class: 'x', onclick }, 'text', child).
 * @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node | string | number | null | false)} kids
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false) el.append(typeof kid === 'number' ? String(kid) : kid);
  return el;
}

/**
 * A button that never submits a form.
 * @param {Record<string, any>} attrs @param {...(Node | string | number | null | false)} kids
 * @returns {HTMLButtonElement}
 */
export function button(attrs, ...kids) {
  return /** @type {HTMLButtonElement} */ (h('button', { type: 'button', ...attrs }, ...kids));
}

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  power: 'M12 3.5v7.5M7.2 6.6a7 7 0 1 0 9.6 0',
  auto: 'M5 12a7 7 0 0 1 12.3-4.6M19 12a7 7 0 0 1-12.3 4.6M17.5 3.5v4h-4M6.5 20.5v-4h4',
};

/** @param {keyof typeof ICONS} name */
export function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** Set an element's class string only when it changed. @param {Element} el @param {string} value */
function cls(el, value) {
  if (el.getAttribute('class') !== value) el.setAttribute('class', value);
}
/** @param {Element} el @param {string} value */
function txt(el, value) {
  if (el.textContent !== value) el.textContent = value;
}
/** @param {HTMLElement} el @param {string} prop @param {string} value */
function style(el, prop, value) {
  if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
}

/** "8 missiles", "1 missile": store names are plural nouns. @param {number} n @param {string} store */
const count = (n, store) => `${n} ${n === 1 ? store.replace(/s$/, '') : store}`;

/** Control keys named by pending commands. @param {Map<number, { c: any }>} pending */
export function pendingKeys(pending) {
  const keys = new Set();
  for (const { c } of pending?.values() ?? []) {
    if (typeof c.system === 'string') keys.add('sys:' + c.system);
    if (typeof c.device === 'string') keys.add('dev:' + c.device);
    if (Array.isArray(c.crew)) for (const id of c.crew) keys.add('crew:' + id);
  }
  return keys;
}

/**
 * A weapon card's state and status word (pure). The fire rule is the sim's own: a charged device reads
 * 'Firing' only when fireBlock says it fires; one that cannot pay its cost is 'empty' (no ready glow).
 * @param {View} view @param {Ship} ship @param {any} dev @param {Content} content @param {number} elapsedMs
 * @returns {{ state: 'off' | 'starved' | 'charging' | 'ready' | 'empty', word: string, k: number }}
 */
export function weaponState(view, ship, dev, content, elapsedMs) {
  const bp = content.devices[dev.bp];
  const k = meterAt(dev.charge, elapsedMs);
  if (!(dev.on ?? dev.powered)) return { state: 'off', word: 'Off', k };
  if (!dev.powered) return { state: 'starved', word: 'No power', k };
  if (k < 1) return { state: 'charging', word: 'Charging', k };
  if (!canPay(ship, bp.cost)) return { state: 'empty', word: REASON_TEXT['no-ammo'], k };
  return { state: 'ready', word: fireBlock(view, ship, bp, dev.target, content) === null ? 'Firing' : 'Ready', k };
}

/** The ship whose HUD to show: yours, or for spectators the first ship of the first side. */
function hudShip(view, you) {
  if (you?.ship && Object.hasOwn(view.ships, you.ship)) return view.ships[you.ship];
  if (you?.ship) return null;
  return shipsInOrder(view)[0] ?? null;
}

/**
 * @param {HTMLElement} root @param {(intent: Intent) => void} dispatch
 */
export function createHud(root, dispatch) {
  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  let shape = '';
  /** @type {any} */
  let w = null;
  /** @type {{ view: View, ship: Ship, content: Content } | null} */
  let latest = null;
  let readOnlyNow = false;

  /** @param {Ship} ship @param {Content} content @param {boolean} readOnly @param {View} view */
  function build(ship, content, readOnly, view) {
    const filaments = Array.from({ length: ship.reactor }, () => h('i', { class: 'fil' }));
    const fils = h('span', { class: 'fils', role: 'img' }, ...filaments);
    const freeN = h('span', { class: 'reactor-n' });
    const reactor = h('div', { class: 'reactor' }, h('span', { class: 'hud-label' }, 'Reactor'), fils, freeN);
    const systems = content.systemOrder.filter((t) => Object.hasOwn(ship.systems, t)).map((type) => systemWidget(type, ship, content, view));
    const weapons = ship.devices.map((dev, i) => weaponWidget(dev, i, content));
    const crew = ship.crew.map((c) => crewWidget(c));
    root.replaceChildren(
      h('div', { class: 'hud-power' }, reactor, h('div', { class: 'systems' }, ...systems.map((s) => s.el))),
      h('div', { class: 'hud-weapons' }, h('div', { class: 'cards' }, ...weapons.map((x) => x.el))),
      h('div', { class: 'hud-crew' }, h('div', { class: 'chips' }, ...crew.map((x) => x.el))),
      toasts,
    );
    root.toggleAttribute('data-readonly', readOnly);
    return { fils, freeN, filaments, systems, weapons, crew };
  }

  /** @param {string} type @param {Ship} ship @param {Content} content @param {View} view */
  function systemWidget(type, ship, content, view) {
    const def = content.systems[type];
    const level = ship.systems[type].level;
    const fixed = COMMANDS.setPower.check(view, ship, { type: 'setPower', ship: ship.id, system: type, level: 0 }, content) !== null;
    const now = () => latest.ship.systems[type];
    const up = button({ class: 'sys-btn', 'aria-label': `More power to ${def.label}`,
      onclick: () => dispatch({ kind: 'power', system: type, level: now().power + 1 }) }, icon('plus'));
    const down = button({ class: 'sys-btn', 'aria-label': `Less power to ${def.label}`,
      onclick: () => dispatch({ kind: 'power', system: type, level: now().power - 1 }) }, icon('minus'));
    const pips = Array.from({ length: level }, () => h('i', { class: 'pip' }));
    const stack = h('div', { class: 'pips', role: 'img' }, ...pips);
    const manned = h('span', { class: 'manned', 'aria-hidden': 'true' });
    const el = h('div', { class: 'sys', 'data-key': 'sys:' + type, ...(fixed ? { 'data-fixed': true } : {}) },
      h('span', { class: 'sys-label' }, def.label, manned), up, stack, down);
    if (!fixed) dragLevels(stack, (lvl) => dispatch({ kind: 'power', system: type, level: lvl }), pips);
    return { type, el, up, down, pips, stack, manned, fixed, label: def.label };
  }

  /** @param {any} dev @param {number} i @param {Content} content */
  function weaponWidget(dev, i, content) {
    const bp = content.devices[dev.bp];
    const bar = h('i');
    const badge = h('span', { class: 'w-badge' });
    const note = h('span', { class: 'w-note' });
    const body = button({ class: 'w-body', 'data-tap': 'dev:' + dev.id, 'aria-label': `${bp.name}: aim`,
      onclick: () => dispatch({ kind: 'tapWeapon', device: dev.id }) },
      h('span', { class: 'w-top' }, h('span', { class: 'w-num' }, i + 1), h('span', { class: 'w-name' }, bp.name)),
      h('span', { class: 'w-bar' }, bar),
      h('span', { class: 'w-foot' }, note, badge),
      h('span', { class: 'w-blurb' }, bp.blurb ?? ''));
    const bars = Array.from({ length: bp.power }, () => h('i'));
    const power = button({ class: 'w-tog', 'aria-label': `Power for ${bp.name}`,
      onclick: () => dispatch({ kind: 'toggleDevice', device: dev.id }) }, icon('power'), h('span', { class: 'w-cost' }, ...bars));
    const auto = button({ class: 'w-tog', 'aria-label': `Keep firing ${bp.name} at its target`,
      onclick: () => dispatch({ kind: 'toggleAuto', device: dev.id }) }, icon('auto'));
    const el = h('div', { class: 'weapon', 'data-key': 'dev:' + dev.id }, body, h('div', { class: 'w-togs' }, power, auto));
    return { id: dev.id, el, body, bar, badge, note, power, auto, bp };
  }

  /** @param {any} c */
  function crewWidget(c) {
    const hp = h('i');
    const task = h('span', { class: 'c-task' });
    const el = button({ class: 'chip', 'data-key': 'crew:' + c.id, 'data-tap': 'crew:' + c.id, 'aria-label': c.name,
      onclick: () => dispatch({ kind: 'tapCrew', crew: c.id }) },
      h('span', { class: 'mote' }, initials(c.name)),
      h('span', { class: 'c-main' }, h('span', { class: 'c-name' }, c.name.split(' ')[0]), h('span', { class: 'c-hp' }, hp)),
      task);
    return { id: c.id, el, hp, task };
  }

  /** @param {ReturnType<typeof systemWidget>} s @param {Ship} ship @param {View} view @param {Content} content @param {Set<string>} busy */
  function updateSystem(s, ship, view, content, busy) {
    const sys = ship.systems[s.type];
    barStates(sys).forEach((state, i) => cls(s.pips[i], 'pip ' + state));
    s.stack.setAttribute('aria-label', `${s.label}: ${sys.power} of ${sys.level} powered`);
    const check = (lvl) => COMMANDS.setPower.check(view, ship, { type: 'setPower', ship: ship.id, system: s.type, level: lvl }, content);
    s.up.disabled = readOnlyNow || check(sys.power + 1) !== null;
    s.down.disabled = readOnlyNow || check(sys.power - 1) !== null;
    cls(s.manned, isManned(ship, s.type, content) ? 'manned on' : 'manned');
    cls(s.el, busy.has('sys:' + s.type) ? 'sys pending' : 'sys');
  }

  /** @param {ReturnType<typeof weaponWidget>} x */
  function updateWeapon(x, ship, view, ui, content, busy, elapsedMs) {
    const dev = ship.devices.find((d) => d.id === x.id);
    const { state, word, k } = weaponState(view, ship, dev, content, elapsedMs);
    const on = dev.on ?? dev.powered;
    const aiming = ui.mode === 'aiming' && ui.device === x.id;
    style(x.bar, 'transform', `scaleX(${k.toFixed(3)})`);
    const t = dev.target;
    const foe = t && Object.hasOwn(view.ships, t.ship) ? view.ships[t.ship] : null;
    const sysType = foe ? systemAt(content, foe, t.room) : null;
    txt(x.badge, foe ? (sysType ? content.systems[sysType].label : 'room ' + t.room) : '');
    const cost = Object.entries(x.bp.cost).filter(([, n]) => n > 0);
    const stock = cost.map(([store]) => count(ship.stores[store] ?? 0, store)).join(', ');
    txt(x.note, word + (stock && state !== 'empty' ? ` (${stock})` : ''));
    x.power.setAttribute('aria-pressed', String(!!on));
    cls(x.power, 'w-tog' + (dev.powered ? ' lit' : on ? ' wanted' : ''));
    x.auto.setAttribute('aria-pressed', String(!!dev.auto));
    cls(x.auto, 'w-tog' + (dev.auto ? ' lit' : ''));
    x.power.disabled = x.auto.disabled = readOnlyNow;
    cls(x.el, `weapon ${state}${aiming ? ' aiming' : ''}${t ? ' targeted' : ''}${busy.has('dev:' + x.id) ? ' pending' : ''}`);
  }

  /** @param {ReturnType<typeof crewWidget>} x */
  function updateCrew(x, ship, ui, content, busy) {
    const c = ship.crew.find((m) => m.id === x.id);
    style(x.hp, 'transform', `scaleX(${(c.maxHp ? c.hp / c.maxHp : 0).toFixed(3)})`);
    const room = systemAt(content, ship, crewRoom(content, ship, c));
    const words = { walk: 'walking', repair: 'repairing', man: room ? `at ${content.systems[room].label}` : 'on station', idle: 'idle' };
    txt(x.task, words[c.task] ?? c.task);
    const selected = ui.mode === 'crew' && ui.crew.includes(c.id);
    x.el.setAttribute('aria-pressed', String(selected));
    x.el.disabled = readOnlyNow;
    cls(x.el, `chip ${c.task}${selected ? ' selected' : ''}${c.hp / c.maxHp < 0.35 ? ' hurt' : ''}${busy.has('crew:' + c.id) ? ' pending' : ''}`);
  }

  return {
    /**
     * @param {{ snap: any, you: any, ui: Ui, pending: Map<number, { c: any }>, content: Content, elapsedMs: number }} frame
     */
    update({ snap, you, ui, pending, content, elapsedMs }) {
      const view = snap?.view;
      const ship = view ? hudShip(view, you) : null;
      root.hidden = !ship;
      if (!ship) return;
      readOnlyNow = !you?.ship;
      const key = [ship.id, readOnlyNow, ship.reactor, ...Object.entries(ship.systems).map(([t, s]) => t + s.level),
        ...ship.devices.map((d) => d.id), ...ship.crew.map((c) => c.id)].join('|');
      latest = { view, ship, content };
      if (key !== shape) {
        shape = key;
        w = build(ship, content, readOnlyNow, view);
      }
      const busy = pendingKeys(pending);
      const free = freeReactor(ship, content);
      w.filaments.forEach((f, i) => cls(f, i < free ? 'fil lit' : 'fil'));
      txt(w.freeN, `${free} free`);
      w.fils.setAttribute('aria-label', `Reactor: ${free} of ${ship.reactor} bars free`);
      for (const s of w.systems) updateSystem(s, ship, view, content, busy);
      for (const x of w.weapons) updateWeapon(x, ship, view, ui, content, busy, elapsedMs);
      for (const x of w.crew) updateCrew(x, ship, ui, content, busy);
    },
    /** @param {string} text */
    toast(text) {
      const el = h('div', { class: 'toast', role: 'status' }, text);
      toasts.append(el);
      while (toasts.children.length > 3) toasts.firstElementChild.remove();
      setTimeout(() => el.classList.add('gone'), THEME.motion.toastMs);
      setTimeout(() => el.remove(), THEME.motion.toastMs + 400);
    },
  };
}

/**
 * Pointer taps and vertical drags on a pip stack choose the level under the finger, on release. The hit
 * test reads the drawn pips, not the stack's box (pips may sit packed at the bottom of a taller stack): the
 * level is the number of pips whose bottom edge is at or below the pointer, so a pip asks for its own level,
 * below the first pip is 0 and anywhere above the top pip is full power.
 * @param {HTMLElement} stack @param {(lvl: number) => void} commit @param {HTMLElement[]} pips
 */
function dragLevels(stack, commit, pips) {
  let active = null;
  const levelAt = (y) => pips.filter((p) => p.getBoundingClientRect().bottom >= y).length;
  const preview = (lvl) => pips.forEach((p, i) => p.classList.toggle('preview', lvl !== null && i < lvl));
  stack.addEventListener('pointerdown', (e) => {
    if (stack.closest('[data-readonly]')) return;
    active = e.pointerId;
    stack.setPointerCapture(e.pointerId);
    preview(levelAt(e.clientY));
  });
  stack.addEventListener('pointermove', (e) => {
    if (e.pointerId === active) preview(levelAt(e.clientY));
  });
  const end = (e, ok) => {
    if (e.pointerId !== active) return;
    active = null;
    preview(null);
    if (ok) commit(levelAt(e.clientY));
  };
  stack.addEventListener('pointerup', (e) => end(e, true));
  stack.addEventListener('pointercancel', (e) => end(e, false));
}
