// @ts-check
// Canvas taps (design doc 17.3): pointer events only, so mouse, pen and touch share one path. A tap is a
// press and release within 10 px and 600 ms; anything else (a drag, a long press, a second finger) is
// ignored. Coordinates are CSS px relative to the element, the scene's coordinate space.

const SLOP_PX = 10;
const TAP_MS = 600;

/** @typedef {import('./ui-state.js').Intent} Intent */

/**
 * @param {HTMLElement} el
 * @param {(x: number, y: number) => Intent} pick
 * @param {(intent: Intent) => void} dispatch
 * @returns {() => void} unbind
 */
export function bindPointer(el, pick, dispatch) {
  /** @type {{ id: number, x: number, y: number, t: number } | null} */
  let down = null;
  const local = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    down = { id: e.pointerId, ...local(e), t: e.timeStamp };
  };
  const onUp = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const p = local(e);
    const tap = Math.hypot(p.x - down.x, p.y - down.y) <= SLOP_PX && e.timeStamp - down.t <= TAP_MS;
    down = null;
    if (tap) dispatch(pick(p.x, p.y));
  };
  const onCancel = () => {
    down = null;
  };
  const noMenu = (e) => e.preventDefault();
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('contextmenu', noMenu);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('contextmenu', noMenu);
  };
}
