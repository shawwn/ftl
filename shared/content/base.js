// @ts-check
// Base stats, pool definitions and global durations (design doc 8.2). A pool's `max` names a stat;
// `regenMs` is the time to regain one unit at 100 percent; `ratePct` names the stat that scales it.

/** @type {import('../sim/types.js').BaseContent} */
export default {
  stats: { evasion: 0, shieldLayers: 0, shieldRegenPct: 100, chargePct: 100,
           repairPct: 100, walkPct: 100, hullMax: 30 },
  pools: {
    hull:   { max: 'hullMax' },                                            // no regen; drained by effects
    shield: { max: 'shieldLayers', regenMs: 2000, ratePct: 'shieldRegenPct' },
  },
  poolOrder: ['hull', 'shield'],
  repairMs: 6000,     // one bar, one crew member, at 100 percent
  walkMs: 350,        // one cell
  drainPct: 300,      // unpowered devices lose charge at 3x normal speed
  crewHp: 100,
};
