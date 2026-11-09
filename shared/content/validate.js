// @ts-check
// validateContent(content) -> string[] (empty means valid), design doc 8.8. Never throws: each section is
// checked defensively and an unexpected failure is reported as an error string.
// Imports the sim registries and parseMap to validate names and maps; sim never imports content, so this
// adds no cycle (doc 3 names hash.js as the only content -> sim import; this is a second, read-only one).
// Doc choices beyond 8.8, each guarding a sim assumption: a system that hosts devices must draw reactor
// power; stat names in system mods, blueprint stats and base pools must exist in base.stats; effect
// amounts are positive integers; every room needs at least as many cells as its crew.

import { parseMap } from '../sim/geometry.js';
import { EFFECT_ORDER } from '../sim/effects.js';
import { DELIVERIES } from '../sim/devices.js';
import { STATUSES } from '../sim/statuses.js';
import { takesWant } from '../sim/power.js';

/** @typedef {import('../sim/types.js').Content} Content */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isNatural = (v) => Number.isSafeInteger(v) && v >= 0;
const has = (o, k) => isObj(o) && Object.hasOwn(o, k);
const entries = (o) => (isObj(o) ? Object.entries(o) : []);

/**
 * @param {Content} content
 * @returns {string[]}
 */
export function validateContent(content) {
  if (!isObj(content)) return ['content must be an object'];
  /** @type {string[]} */
  const errors = [];
  /** @param {string} msg */
  const err = (msg) => errors.push(msg);
  /** @type {[string, () => void][]} */
  const sections = [
    ['base', () => checkBase(content.base, err)],
    ['systems', () => checkSystems(content, err)],
    ['statuses', () => checkStatuses(content.statuses, err)],
    ['devices', () => checkDevices(content.devices, err)],
    ['ships', () => checkShips(content, err)],
    ['ai', () => checkAi(content.ai, err)],
    ['integers', () => checkIntegers(content, err)],
  ];
  for (const [name, run] of sections) {
    try {
      run();
    } catch (e) {
      err(`${name}: malformed (${e.message})`);
    }
  }
  return errors;
}

function checkBase(base, err) {
  if (!isObj(base)) return err('base must be an object');
  if (!isObj(base.stats)) err('base.stats must be an object');
  for (const k of ['repairMs', 'walkMs', 'drainPct', 'crewHp']) {
    if (!isPosInt(base[k])) err(`base.${k} must be a positive integer`);
  }
  for (const [id, def] of entries(base.pools)) {
    if (!has(base.stats, def.max)) err(`base.pools.${id}.max names unknown stat ${def.max}`);
    if (def.regenMs === undefined) continue;
    if (!isPosInt(def.regenMs)) err(`base.pools.${id}.regenMs must be a positive integer`);
    if (!has(base.stats, def.ratePct)) err(`base.pools.${id}.ratePct names unknown stat ${def.ratePct}`);
  }
  if (!sameSet(base.poolOrder, Object.keys(base.pools ?? {}))) err('base.poolOrder must list every pool exactly once');
}

/** True when list is an array holding exactly the keys, each once. */
function sameSet(list, keys) {
  return Array.isArray(list) && list.length === keys.length && new Set(list).size === list.length && keys.every((k) => list.includes(k));
}

function checkSystems(content, err) {
  const { systems, systemOrder, base } = content;
  if (!isObj(systems)) return err('systems must be an object');
  if (!sameSet(systemOrder, Object.keys(systems))) err('systemOrder must list every system exactly once');
  for (const [type, def] of entries(systems)) {
    const at = `systems.${type}`;
    if (typeof def.label !== 'string') err(`${at}.label must be a string`);
    if (!isPosInt(def.maxLevel)) err(`${at}.maxLevel must be a positive integer`);
    if (typeof def.reactor !== 'boolean') err(`${at}.reactor must be a boolean`);
    if (typeof def.mannable !== 'boolean') err(`${at}.mannable must be a boolean`);
    if (def.hosts !== undefined && typeof def.hosts !== 'string') err(`${at}.hosts must be a string`);
    if (def.hosts && !def.reactor) err(`${at}: a system that hosts devices must draw reactor power`);
    tables(def, at, def.maxLevel + 1, err);
    const mods = [def.byPower?.add, def.byPower?.mul, def.manned?.add, def.manned?.mul, def.unmanned?.add, def.unmanned?.mul];
    for (const stat of mods.flatMap((m) => Object.keys(m ?? {}))) {
      if (!has(base?.stats, stat)) err(`${at}: unknown stat ${stat}`);
    }
  }
}

/** Every array in a system definition is a table indexed by power. */
function tables(value, path, length, err) {
  if (Array.isArray(value)) {
    if (value.length !== length) err(`${path} has length ${value.length}, expected ${length}`);
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) tables(v, `${path}.${k}`, length, err);
  }
}

function checkStatuses(statuses, err) {
  if (!isObj(statuses)) return err('statuses must be an object');
  for (const [id, def] of Object.entries(statuses)) {
    if (!Object.hasOwn(STATUSES, id)) err(`statuses.${id} is not a known status`);
    if (!isPosInt(def?.decayMs)) err(`statuses.${id}.decayMs must be a positive integer`);
  }
}

function checkDevices(devices, err) {
  if (!isObj(devices)) return err('devices must be an object');
  for (const [id, bp] of Object.entries(devices)) {
    const at = `devices.${id}`;
    if (typeof bp.kind !== 'string' || !bp.kind) err(`${at}.kind must be a non-empty string`);
    if (typeof bp.name !== 'string') err(`${at}.name must be a string`);
    for (const k of ['power', 'chargeMs', 'shots', 'travelMs']) if (!isPosInt(bp[k])) err(`${at}.${k} must be a positive integer`);
    if (!isNatural(bp.gapMs)) err(`${at}.gapMs must be an integer >= 0`);
    for (const k of ['accuracy', 'pierce']) if (!Number.isSafeInteger(bp[k])) err(`${at}.${k} must be an integer`);
    if (typeof bp.canMiss !== 'boolean') err(`${at}.canMiss must be a boolean`);
    if (bp.target !== 'enemyRoom') err(`${at}.target must be 'enemyRoom'`);
    if (!Object.hasOwn(DELIVERIES, bp.delivery)) err(`${at}.delivery names unknown delivery ${bp.delivery}`);
    if (!isObj(bp.cost)) err(`${at}.cost must be an object`);
    for (const [k, n] of entries(bp.cost)) if (!isNatural(n)) err(`${at}.cost.${k} must be a non-negative integer`);
    for (const slot of ['onBlock', 'onHit']) {
      if (!isObj(bp[slot])) err(`${at}.${slot} must be an object`);
      for (const [k, n] of entries(bp[slot])) {
        if (!EFFECT_ORDER.includes(k)) err(`${at}.${slot}.${k} is not a known effect`);
        else if (!isPosInt(n)) err(`${at}.${slot}.${k} must be a positive integer`);
      }
    }
  }
}

function checkShips(content, err) {
  if (!isObj(content.ships)) return err('ships must be an object');
  for (const [id, bp] of Object.entries(content.ships)) checkShip(content, `ships.${id}`, bp, err);
}

function checkShip(content, at, bp, err) {
  if (typeof bp.name !== 'string') err(`${at}.name must be a string`);
  if (!isPosInt(bp.reactor)) err(`${at}.reactor must be a positive integer`);
  let geo = null;
  try {
    geo = parseMap(bp.map, isObj(bp.legend) ? bp.legend : {}, bp.doors ?? null);
  } catch (e) {
    err(`${at}: ${e.message}`);
  }
  if (!isObj(bp.legend)) err(`${at}.legend must be an object`);
  if (!isObj(bp.systems)) err(`${at}.systems must be an object`);
  const legend = isObj(bp.legend) ? bp.legend : {};
  const installed = isObj(bp.systems) ? bp.systems : {};
  const placed = Object.values(legend);
  for (const [room, type] of Object.entries(legend)) {
    if (geo && !Object.hasOwn(geo.rooms, room)) err(`${at}.legend: ${room} is not a room in the map`);
    if (!has(content.systems, type)) err(`${at}.legend: ${room} maps to unknown system ${type}`);
    if (!Object.hasOwn(installed, type)) err(`${at}.legend: system ${type} is not installed`);
  }
  for (const type of new Set(placed.filter((t, i) => placed.indexOf(t) !== i))) {
    err(`${at}.legend: system ${type} appears more than once`);
  }
  let draw = 0;
  for (const [type, s] of Object.entries(installed)) {
    const def = has(content.systems, type) ? content.systems[type] : null;
    if (!placed.includes(type)) err(`${at}.systems.${type} has no room in the legend`);
    if (!def) continue;
    if (!Number.isSafeInteger(s?.level) || s.level < 1 || s.level > def.maxLevel) err(`${at}.systems.${type}.level must be between 1 and ${def.maxLevel}`);
    if (s?.power !== undefined && (!isNatural(s.power) || s.power > s.level)) err(`${at}.systems.${type}.power must be between 0 and its level`);
    if (takesWant(def)) draw += s?.power ?? 0;
  }
  draw += checkShipDevices(content, at, bp, installed, err);
  if (Number.isSafeInteger(bp.reactor) && draw > bp.reactor) err(`${at}: starting reactor draw ${draw} exceeds reactor ${bp.reactor}`);
  for (const [k] of entries(bp.stats)) if (!has(content.base?.stats, k)) err(`${at}.stats: unknown stat ${k}`);
  if (!isObj(bp.stores)) err(`${at}.stores must be an object`);
  for (const [k, n] of entries(bp.stores)) if (!isNatural(n)) err(`${at}.stores.${k} must be a non-negative integer`);
  checkCrew(at, bp, geo, err);
}

/** Device entries; returns the reactor bars drawn by devices that start on. */
function checkShipDevices(content, at, bp, installed, err) {
  const hostDraw = {};
  if (!Array.isArray(bp.devices)) {
    err(`${at}.devices must be an array`);
    return 0;
  }
  bp.devices.forEach((d, i) => {
    const dbp = has(content.devices, d?.bp) ? content.devices[d.bp] : null;
    if (!dbp) return err(`${at}.devices[${i}]: unknown device ${d?.bp}`);
    if (d.on !== undefined && typeof d.on !== 'boolean') err(`${at}.devices[${i}].on must be a boolean`);
    const host = Object.keys(installed).find((t) => has(content.systems, t) && content.systems[t].hosts === dbp.kind);
    if (!host) return err(`${at}.devices[${i}]: no system hosts kind ${dbp.kind}`);
    if (d.on) hostDraw[host] = (hostDraw[host] ?? 0) + dbp.power;
  });
  let draw = 0;
  for (const [host, n] of Object.entries(hostDraw)) {
    if (n > installed[host].level) err(`${at}: starting device power on ${host} exceeds its level`);
    draw += n;
  }
  return draw;
}

function checkCrew(at, bp, geo, err) {
  if (!Array.isArray(bp.crew)) return err(`${at}.crew must be an array`);
  const count = {};
  bp.crew.forEach((c, i) => {
    if (typeof c?.name !== 'string') err(`${at}.crew[${i}].name must be a string`);
    if (!geo) return;
    if (!Object.hasOwn(geo.rooms, c?.room)) return err(`${at}.crew[${i}]: unknown room ${c?.room}`);
    count[c.room] = (count[c.room] ?? 0) + 1;
  });
  for (const [room, n] of Object.entries(count)) {
    if (n > geo.rooms[room].w * geo.rooms[room].h) err(`${at}: room ${room} holds more crew than cells`);
  }
}

/** @type {Record<string, [string, (v: any) => boolean]>} */
const AI_FIELDS = {
  label: ['a string', (v) => typeof v === 'string'],
  persona: ['a string', (v) => typeof v === 'string'],
  passive: ['a boolean', (v) => typeof v === 'boolean'],
  thinkEveryTicks: ['a positive integer', isPosInt],
  reactionTicks: ['an integer >= 0', isNatural],
  temperature: ['a number >= 0', (v) => Number.isFinite(v) && v >= 0],
  patienceMs: ['a number >= 0', (v) => Number.isFinite(v) && v >= 0],
  crew: ['a boolean', (v) => typeof v === 'boolean'],
  weights: ['{ offense, defense } numbers', (v) => isObj(v) && Number.isFinite(v.offense) && Number.isFinite(v.defense)],
};

function checkAi(ai, err) {
  if (!isObj(ai)) return err('ai must be an object');
  for (const [id, profile] of Object.entries(ai)) {
    for (const [field, [desc, ok]] of Object.entries(AI_FIELDS)) {
      if (!ok(profile?.[field])) err(`ai.${id}.${field} must be ${desc}`);
    }
  }
}

/** Every number the sim reads is a safe integer (ai profiles are read only by shared/ai). */
function checkIntegers(content, err) {
  const walk = (v, path) => {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) err(`${path} must be a safe integer`);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const k of ['base', 'systems', 'statuses', 'devices', 'ships']) walk(content[k], k);
}
