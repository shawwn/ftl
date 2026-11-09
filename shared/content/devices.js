// @ts-check
// Original weapon blueprints (design doc 8.5). Weapon types differ only by data:
// pierce 99 ignores shields, multi-shot volleys pop one layer per blocked shot, ion strips and locks power.

/** @type {Record<string, import('../sim/types.js').DeviceBp>} */
export default {
  flint: {
    kind: 'weapon', name: 'Flint Bolt', blurb: 'One honest spark. Cheap, quick, reliable.',
    power: 1, chargeMs: 7000, target: 'enemyRoom', cost: {},
    delivery: 'projectile', shots: 1, gapMs: 0, travelMs: 1000,
    accuracy: 0, pierce: 0, canMiss: true,
    onBlock: {}, onHit: { hull: 1, sysDamage: 1, crew: 15 },
    look: 'spark',
  },
  ember: {
    kind: 'weapon', name: 'Ember Volley', blurb: 'Three hot sparks in a row. Halos hate it.',
    power: 2, chargeMs: 12000, target: 'enemyRoom', cost: {},
    delivery: 'projectile', shots: 3, gapMs: 250, travelMs: 1100,
    accuracy: 0, pierce: 0, canMiss: true,
    onBlock: {}, onHit: { hull: 1, sysDamage: 1, crew: 15 },
    look: 'spark',
  },
  needle: {
    kind: 'weapon', name: 'Long Needle', blurb: 'A slow dart that slips through any halo. Spends a missile.',
    power: 1, chargeMs: 11000, target: 'enemyRoom', cost: { missiles: 1 },
    delivery: 'projectile', shots: 1, gapMs: 0, travelMs: 2000,
    accuracy: 0, pierce: 99, canMiss: true,
    onBlock: {}, onHit: { hull: 2, sysDamage: 1, crew: 30 },
    look: 'dart',
  },
  hush: {
    kind: 'weapon', name: 'Hush Pulse', blurb: 'Cold static that makes machines forget their power.',
    power: 1, chargeMs: 8000, target: 'enemyRoom', cost: {},
    delivery: 'projectile', shots: 1, gapMs: 0, travelMs: 1000,
    accuracy: 0, pierce: 0, canMiss: true,
    onBlock: { ion: 1 }, onHit: { ion: 2 },
    look: 'pulse',
  },
};
