// @ts-check
// (pure) The UI as a reducer over intents (design doc 17.2). Taps, keys and HUD buttons all become
// intents; the reducer turns them into the next selection state and absolute sim commands.
//
// Doc choices:
// - Spectators (you.ship === null) stay idle and never produce commands.
// - Rows the table leaves open: tapWeapon from crew mode acts as from idle, tapCrew from aiming acts as
//   from idle, tapRoom while idle does nothing.
// - "Enemy" means another side (validTarget would call a same-side ship 'friendly'); "own" means the
//   ship you crew. Rooms on any other ship return to idle.
// - Crew selections drop members that are no longer aboard (they may die while selected).

import { ERROR_TEXT } from '../shared/net/protocol.js';

/** @typedef {import('../shared/sim/types.js').View} View */
/** @typedef {import('../shared/sim/types.js').Ship} Ship */

/** @typedef {{ mode: 'idle' } | { mode: 'aiming', device: string } | { mode: 'crew', crew: string[] }} Ui */
/** @typedef {{ kind: 'tapWeapon', device: string } | { kind: 'tapRoom', ship: string, room: string }
 *          | { kind: 'tapCrew', crew: string } | { kind: 'power', system: string, level: number }
 *          | { kind: 'toggleDevice', device: string } | { kind: 'toggleAuto', device: string }
 *          | { kind: 'tapEmpty' } | { kind: 'key', key: string }} Intent */
/** @typedef {{ ship: string | null, side: string | null }} You */
/** @typedef {{ type: string } & Record<string, any>} ClientCommand   a command without `ship` */

/** @returns {Ui} */
export function initialUi() {
  return { mode: 'idle' };
}

const IDLE = Object.freeze(initialUi());

/**
 * @param {Ui} ui @param {Intent} intent @param {{ view: View | null, you: You | null }} ctx
 * @returns {{ ui: Ui, cmds: ClientCommand[] }}
 */
export function reduceUi(ui, intent, { view, you }) {
  const mine = you?.ship && view && Object.hasOwn(view.ships, you.ship) ? view.ships[you.ship] : null;
  if (!mine) return { ui: initialUi(), cmds: [] };
  const handler = Object.hasOwn(INTENTS, intent?.kind) ? INTENTS[intent.kind] : null;
  return handler ? handler(ui, /** @type {any} */ (intent), mine, view) : { ui, cmds: [] };
}

/** @param {Ship} ship @param {string} id */
const deviceOf = (ship, id) => ship.devices.find((d) => d.id === id) ?? null;

/** @type {Record<string, (ui: Ui, intent: any, mine: Ship, view: View) => { ui: Ui, cmds: ClientCommand[] }>} */
const INTENTS = {
  tapWeapon(ui, { device }, mine) {
    const dev = deviceOf(mine, device);
    if (!dev) return { ui, cmds: [] };
    if (ui.mode === 'aiming') return { ui: ui.device === device ? IDLE : { mode: 'aiming', device }, cmds: [] };
    if (dev.target) return { ui: IDLE, cmds: [{ type: 'setTarget', device, target: null }] };
    return { ui: { mode: 'aiming', device }, cmds: [] };
  },

  tapRoom(ui, { ship, room }, mine, view) {
    const tapped = Object.hasOwn(view.ships, ship) ? view.ships[ship] : null;
    if (ui.mode === 'aiming' && tapped && tapped.side !== mine.side) {
      return { ui: IDLE, cmds: [{ type: 'setTarget', device: ui.device, target: { ship, room } }] };
    }
    if (ui.mode === 'crew' && ship === mine.id) {
      const crew = aboard(ui.crew, mine);
      return { ui: IDLE, cmds: crew.length ? [{ type: 'moveCrew', crew, room }] : [] };
    }
    return { ui: ui.mode === 'idle' ? ui : IDLE, cmds: [] };
  },

  tapCrew(ui, { crew }, mine) {
    if (!mine.crew.some((c) => c.id === crew)) return { ui, cmds: [] };
    if (ui.mode !== 'crew') return { ui: { mode: 'crew', crew: [crew] }, cmds: [] };
    const sel = aboard(ui.crew, mine);
    const next = sel.includes(crew) ? sel.filter((id) => id !== crew) : [...sel, crew];
    return { ui: next.length ? { mode: 'crew', crew: next } : IDLE, cmds: [] };
  },

  tapEmpty() {
    return { ui: IDLE, cmds: [] };
  },

  power(ui, { system, level }) {
    return { ui, cmds: [{ type: 'setPower', system, level }] };
  },

  toggleDevice(ui, { device }, mine) {
    const dev = deviceOf(mine, device);
    return { ui, cmds: dev ? [{ type: 'setDevicePower', device, on: !(dev.on ?? dev.powered) }] : [] };
  },

  toggleAuto(ui, { device }, mine) {
    const dev = deviceOf(mine, device);
    return { ui, cmds: dev ? [{ type: 'setAuto', device, on: !dev.auto }] : [] };
  },

  key(ui, { key }, mine, view) {
    if (key === 'Escape') return INTENTS.tapEmpty(ui, { kind: 'tapEmpty' }, mine, view);
    const dev = /^[1-9]$/.test(key) ? mine.devices[Number(key) - 1] : null;
    return dev ? INTENTS.tapWeapon(ui, { kind: 'tapWeapon', device: dev.id }, mine, view) : { ui, cmds: [] };
  },
};

/** @param {string[]} ids @param {Ship} ship */
function aboard(ids, ship) {
  return ids.filter((id) => ship.crew.some((c) => c.id === id));
}

/**
 * Short, plain text for every rejection reason a player can meet: sim reasons (section 11), host
 * authorization, and protocol error codes (15.3, the shared ERROR_TEXT table, which the server also uses
 * for its `msg`), overriding only where a player needs other words.
 * @type {Record<string, string>}
 */
export const REASON_TEXT = {
  // sim
  'unknown-command': 'That order is not understood',
  'no-ship': 'That ship is gone',
  'ship-out': 'That ship is out of the fight',
  'no-system': 'This ship has no such system',
  'not-powerable': 'That system draws no reactor power',
  'bad-level': 'That system has no such power level',
  'damaged': 'Damaged or ionized bars cannot take power',
  'no-reactor': 'No free reactor power',
  'no-device': 'No such weapon aboard',
  'bad-arg': 'That order was malformed',
  'no-capacity': 'Weapons system has no room for it',
  'no-target': 'Pick a target first',
  'friendly': 'That ship is on your side',
  'no-room': 'No such room',
  'no-ammo': 'Out of missiles',
  'no-crew': 'That crew member is not aboard',
  'room-full': 'That room is full',
  // host (ack reasons; 'forbidden' is also a protocol code)
  'spectator': 'Spectators cannot give orders',
  'ended': 'The fight is over',
  // protocol
  ...ERROR_TEXT,
  'hello-first': 'Still connecting',
  // client only
  'disconnected': 'Connection lost',
};
