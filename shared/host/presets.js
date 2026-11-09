// @ts-check
// Match specs and presets (design doc 14.2). A preset turns opts into a MatchSpec; buildSpec then validates
// the result rather than each preset's inputs, so a new preset needs no validation code of its own.
// Doc choices: opts must be a plain object (or absent); unknown opts keys are ignored; a spec is valid when
// every ship names an existing blueprint and has a controller: an existing AI profile, or human seats when
// its `ai` is null (so `ai: null` in vsAi is bad-opts, not a ship nobody flies). buildSpec takes the
// preset table as an optional 4th argument so a Lobby's injected presets are validated the same way.

/** @typedef {import('../sim/types.js').Content} Content */

/**
 * @typedef {{
 *   preset: string, name: string,
 *   rules: { pause: 'crew' | 'any' | 'none', pauseWhenEmpty: boolean, snapEvery: number, idleTtlMs: number },
 *   ships: SpecShip[]
 * }} MatchSpec
 */
/** @typedef {{ id: string, bp: string, side: string, seats: { min: number, max: number }, ai: string | null }} SpecShip */
/** @typedef {(opts: Record<string, any>, content: Content) => MatchSpec} Preset */

const MINUTE = 60000;

/** @type {Record<string, Preset>} */
export const PRESETS = {
  vsAi: ({ ship = 'candlewick', foe = 'lampblack', ai = 'captain' }) => ({
    preset: 'vsAi', name: 'Skirmish',
    rules: { pause: 'crew', pauseWhenEmpty: true, snapEvery: 2, idleTtlMs: 10 * MINUTE },
    ships: [
      { id: 's1', bp: ship, side: 'blue', seats: { min: 1, max: 4 }, ai: null },
      { id: 's2', bp: foe, side: 'red', seats: { min: 0, max: 0 }, ai },
    ],
  }),
  aiVsAi: ({ a = 'candlewick', b = 'lampblack', aiA = 'captain', aiB = 'captain' }) => ({
    preset: 'aiVsAi', name: 'Exhibition',
    rules: { pause: 'any', pauseWhenEmpty: false, snapEvery: 2, idleTtlMs: 2 * MINUTE },
    ships: [
      { id: 's1', bp: a, side: 'blue', seats: { min: 0, max: 0 }, ai: aiA },
      { id: 's2', bp: b, side: 'red', seats: { min: 0, max: 0 }, ai: aiB },
    ],
  }),
  pvp: ({ a = 'candlewick', b = 'lampblack' }) => ({
    preset: 'pvp', name: 'Duel',
    rules: { pause: 'none', pauseWhenEmpty: false, snapEvery: 2, idleTtlMs: 10 * MINUTE },
    ships: [
      { id: 's1', bp: a, side: 'blue', seats: { min: 1, max: 3 }, ai: null },
      { id: 's2', bp: b, side: 'red', seats: { min: 1, max: 3 }, ai: null },
    ],
  }),
};

/** @param {unknown} v @returns {v is Record<string, any>} */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {Record<string, unknown>} table @param {unknown} key */
const names = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);

/**
 * @param {unknown} preset @param {unknown} opts @param {Content} content @param {Record<string, Preset>} [presets]
 * @returns {MatchSpec | { error: 'bad-preset' | 'bad-opts' }}
 */
export function buildSpec(preset, opts, content, presets = PRESETS) {
  if (!names(presets, preset)) return { error: 'bad-preset' };
  if (opts !== undefined && opts !== null && !isPlainObject(opts)) return { error: 'bad-opts' };
  const o = /** @type {Record<string, any>} */ (opts ?? {});
  if (o.seed !== undefined && !(Number.isSafeInteger(o.seed) && o.seed >= 0)) return { error: 'bad-opts' };
  const spec = presets[/** @type {string} */ (preset)](o, content);
  const valid = spec.ships.every((s) => names(content.ships, s.bp) && (s.ai === null ? s.seats.max > 0 : names(content.ai, s.ai)));
  return valid ? spec : { error: 'bad-opts' };
}
