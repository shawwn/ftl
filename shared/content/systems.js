// @ts-check
// System tables (design doc 8.3). byPower tables have length maxLevel + 1 and are indexed by power.
// reactor: false marks a subsystem (power = capacity, no reactor draw); `hosts` powers devices of a kind;
// `manned` mods apply when manned with power > 0; `unmanned` tables (indexed by power) apply when not
// manned. The helm is pure data: unmanned it flies on autopilot (0, 50, 80 percent of evasion by level).

/** Fold, settle and UI order. */
export const systemOrder = ['piloting', 'shields', 'engines', 'weapons'];

/** @type {Record<string, import('../sim/types.js').SystemDef>} */
export default {
  piloting: { label: 'Helm', maxLevel: 3, reactor: false, mannable: true,
              byPower:  { mul: { evasion: [0, 100, 100, 100] } },
              unmanned: { mul: { evasion: [100, 0, 50, 80] } },
              manned:   { add: { evasion: 5 } } },
  shields:  { label: 'Shields', maxLevel: 8, reactor: true, mannable: true,
              byPower: { add: { shieldLayers: [0, 0, 1, 1, 2, 2, 3, 3, 4] } },
              manned:  { add: { shieldRegenPct: 10 } } },
  engines:  { label: 'Engines', maxLevel: 8, reactor: true, mannable: true,
              byPower: { add: { evasion: [0, 5, 10, 15, 20, 25, 28, 31, 35] },
                         mul: { evasion: [0, 100, 100, 100, 100, 100, 100, 100, 100] } },
              manned:  { add: { evasion: 5 } } },
  weapons:  { label: 'Weapons', maxLevel: 8, reactor: true, mannable: true, hosts: 'weapon',
              manned:  { add: { chargePct: 10 } } },
};
