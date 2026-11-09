// @ts-check
// "Power is light" (design doc 17.5): the only saturated light on screen means something. Amber is power,
// cyan is shield, cold blue is ion, red is damage; everything else is ink and pale line.
// This file is the single source of the palette: main.js copies THEME.color into CSS custom properties
// (cssVars), and the canvas reads THEME directly. DOM-free, so Node tests may import it.

export const THEME = {
  color: {
    ink: '#0b0d1a',        // space
    inkHull: '#0f1328',    // hull interior, a breath above space
    inkPanel: '#10132a',   // HUD surfaces
    line: '#c3cbff',       // neutral line art
    text: '#e9e7f5',
    dim: '#8a8fb3',
    faint: '#3a3f66',
    amber: '#ffcf6e',      // power
    halo: '#6ee7ff',       // shield layers
    ion: '#9ab8ff',        // ion
    damage: '#ff5a5f',     // damage
    mark: '#fff4dc',       // selection, reticles: the player's own intent
  },
  /** Hull line tint per side; unknown sides fall back to `line`. */
  sides: { blue: '#aebcff', red: '#ffb0a8' },
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  line: { hull: 1.6, room: 1, halo: 1.5, shot: 2 },
  motion: {
    toastMs: 2600,
    shakeMs: 380,
    floatMs: 1100,
    flashMs: 260,
    rippleMs: 520,
    stutterMs: 700,
    sparkleMs: 900,
    fadeMs: 1200,
    wreckMs: 2600,
  },
};

/** @param {string} side */
export function sideColor(side) {
  return Object.hasOwn(THEME.sides, side) ? THEME.sides[side] : THEME.color.line;
}

/** CSS custom properties for THEME.color: { '--ink': '#0b0d1a', ... }. */
export function cssVars() {
  /** @type {Record<string, string>} */
  const vars = { '--font': THEME.font };
  for (const [k, v] of Object.entries(THEME.color)) vars['--' + k] = v;
  return vars;
}

/**
 * Hex color with alpha, for canvas strokes and fills.
 * @param {string} hex '#rrggbb' @param {number} a 0..1
 */
export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
