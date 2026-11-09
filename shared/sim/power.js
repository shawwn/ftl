// @ts-check
// The power tree: reactor -> systems -> devices (design doc 9.4). Commands set intent (want, on);
// settlePower is the only writer of sys.power and dev.powered.
// Tolerant reader: on redacted views `want` and `on` are absent, so settling keeps current power and only
// sheds what no longer fits (which is what the AI needs to imagine ion and damage on an enemy).
// Doc choice: a system with `hosts` is always a reactor system (content/validate.js enforces it).

import { capacityPenalty } from './statuses.js';

/** @typedef {import('./types.js').Ship} Ship */
/** @typedef {import('./types.js').SystemState} SystemState */
/** @typedef {import('./types.js').Content} Content */
/** @typedef {import('./types.js').Emit} Emit */

/**
 * The system takes a `want` (intent): it draws reactor power and is not a host (whose power is the sum of
 * its powered devices). Subsystems and hosts answer false.
 * @param {import('./types.js').SystemDef} def
 */
export function takesWant(def) {
  return def.reactor && !def.hosts;
}

/** Usable bars (view-safe). @param {SystemState} sys */
export function capacity(sys) {
  return Math.max(0, sys.level - sys.damage - capacityPenalty(sys));
}

/** Reactor bars not drawn by any reactor system (view-safe). @param {Ship} ship @param {Content} content */
export function freeReactor(ship, content) {
  let used = 0;
  for (const [type, sys] of Object.entries(ship.systems)) if (content.systems[type].reactor) used += sys.power;
  return ship.reactor - used;
}

/** @param {Ship} ship @param {string} type */
function hosted(ship, type) {
  return ship.devices.filter((d) => d.host === type);
}

/** Step 1: drop power that intent or capacity no longer allows. */
function shed(ship, type, content) {
  const sys = ship.systems[type];
  const def = content.systems[type];
  const cap = capacity(sys);
  if (def.hosts) {
    let used = 0;
    for (const dev of hosted(ship, type)) {
      const p = content.devices[dev.bp].power;
      dev.powered = dev.powered && (dev.on ?? dev.powered) && used + p <= cap;
      if (dev.powered) used += p;
    }
    sys.power = used;
  } else if (!def.reactor) {
    sys.power = cap;
  } else {
    sys.power = Math.min(sys.power, sys.want ?? sys.power, cap);
  }
}

/** Step 2: raise toward intent using free bars only. Returns the bars still free. */
function grant(ship, type, free, content) {
  const sys = ship.systems[type];
  const def = content.systems[type];
  if (!def.reactor) return free;
  const cap = capacity(sys);
  if (def.hosts) {
    for (const dev of hosted(ship, type)) {
      const p = content.devices[dev.bp].power;
      if ((dev.on ?? dev.powered) && !dev.powered && sys.power + p <= cap && p <= free) {
        dev.powered = true;
        sys.power += p;
        free -= p;
      }
    }
    return free;
  }
  const add = Math.min(Math.min(sys.want ?? sys.power, cap) - sys.power, free);
  if (add > 0) {
    sys.power += add;
    free -= add;
  }
  return free;
}

/**
 * Deterministic and idempotent. Afterwards every reactor system has power === min(want, capacity) or no
 * reactor bar is free, and every `on` device is powered or cannot fit.
 * @param {Ship} ship @param {Content} content @param {Emit} [emit]
 */
export function settlePower(ship, content, emit = () => {}) {
  const types = content.systemOrder.filter((t) => Object.hasOwn(ship.systems, t));
  const before = types.map((t) => ship.systems[t].power);
  const wasPowered = ship.devices.map((d) => d.powered);
  for (const t of types) shed(ship, t, content);
  let free = freeReactor(ship, content);
  for (const t of types) free = grant(ship, t, free, content);
  types.forEach((t, i) => {
    if (ship.systems[t].power < before[i]) emit({ type: 'depowered', ship: ship.id, system: t });
  });
  ship.devices.forEach((d, i) => {
    if (wasPowered[i] && !d.powered) emit({ type: 'depowered', ship: ship.id, device: d.id });
  });
}
