// @ts-check
// Original ship blueprints (design doc 8.6). Maps: equal-length rows, each distinct non-'.' character is one
// rectangular room, bow at the highest x. `legend` maps rooms to systems (unlisted rooms are corridors).
// Doors: one per edge-adjacent room pair, unless an explicit `doors` list of [a, b] pairs is given.
// Hulls, reactors and Candlewick's shield level are tuned with tools/duel.js (design doc 8.6 tuning record):
// Candlewick's fourth shield bar (a second layer at the cost of engines or the Needle) balances the AI that
// keeps Lampblack's Hush Pulse powered.

/** @type {Record<string, import('../sim/types.js').ShipBp>} */
export default {
  candlewick: {
    name: 'Candlewick', blurb: 'A steady flame. Balanced, forgiving, and one bar short of everything.',
    map: [
      '.WW.SS..',
      'EWWaSSHH',
      'EbbaccHH',
    ],
    legend: { W: 'weapons', S: 'shields', E: 'engines', H: 'piloting' },
    stats: { hullMax: 20 },                   // overrides base.stats for this hull
    reactor: 7,
    systems: {
      piloting: { level: 1 },
      shields:  { level: 4, power: 2 },
      engines:  { level: 3, power: 2 },
      weapons:  { level: 3 },
    },
    devices: [ { bp: 'ember', on: true }, { bp: 'needle', on: false } ],
    stores: { missiles: 8 },
    crew: [
      { name: 'Ines Calder', room: 'H' },
      { name: 'Tomo Reyk',   room: 'W' },
      { name: 'Wen Sato',    room: 'S' },
    ],
  },
  lampblack: {
    name: 'Lampblack', blurb: 'A soot-dark raider that smothers systems before it burns them.',
    map: [
      '.SSaa',
      'EEWWH',
      'EEWWH',
    ],
    legend: { S: 'shields', E: 'engines', W: 'weapons', H: 'piloting' },
    stats: { hullMax: 17 },
    reactor: 7,
    systems: {
      piloting: { level: 1 },
      shields:  { level: 2, power: 2 },
      engines:  { level: 4, power: 2 },
      weapons:  { level: 3 },
    },
    devices: [ { bp: 'hush', on: true }, { bp: 'flint', on: true }, { bp: 'flint', on: true } ],
    stores: {},
    crew: [
      { name: 'Vashti Morrow', room: 'H' },
      { name: 'Oduya Fenn',    room: 'W' },
      { name: 'Kell Ardent',   room: 'E' },
    ],
  },
};
