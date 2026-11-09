// @ts-check
// Clocks (design doc 14.1). The host asks a Clock for time and fixed-rate callbacks; tests use
// manualClock so every match and session is driven deterministically.
// Doc choice: realClock runs at most 4 catch-up callbacks per wake and then drops the rest of the backlog
// (time stretches after a long stall instead of fast-forwarding).

/** @typedef {{ now(): number, every(ms: number, fn: () => void): () => void }} Clock */

const MAX_CATCH_UP = 4;

/** @param {number} ms */
function checkPeriod(ms) {
  if (!(ms > 0)) throw new RangeError(`clock period must be positive, got ${ms}`);
}

/** setTimeout scheduler against performance.now. @returns {Clock} */
export function realClock() {
  const now = () => globalThis.performance.now();
  return {
    now,
    every(ms, fn) {
      checkPeriod(ms);
      let next = now() + ms;
      let stopped = false;
      const wake = () => {
        for (let runs = 0; runs < MAX_CATCH_UP && !stopped && now() >= next; runs++) {
          fn();
          next += ms;
        }
        if (stopped) return;
        if (now() >= next) next = now() + ms;
        timer = globalThis.setTimeout(wake, Math.max(0, next - now()));
      };
      let timer = globalThis.setTimeout(wake, ms);
      return () => {
        stopped = true;
        globalThis.clearTimeout(timer);
      };
    },
  };
}

/**
 * Time moves only through advance(ms), which runs every due callback synchronously, in due-time order
 * (ties in registration order).
 * @returns {Clock & { advance(ms: number): void }}
 */
export function manualClock() {
  let t = 0;
  let seq = 0;
  /** @type {{ next: number, ms: number, fn: () => void, seq: number }[]} */
  let timers = [];
  const earliestDue = (end) => timers.reduce((best, x) => (
    x.next <= end && (!best || x.next < best.next || (x.next === best.next && x.seq < best.seq)) ? x : best
  ), null);
  return {
    now: () => t,
    every(ms, fn) {
      checkPeriod(ms);
      const timer = { next: t + ms, ms, fn, seq: seq++ };
      timers.push(timer);
      return () => { timers = timers.filter((x) => x !== timer); };
    },
    advance(ms) {
      const end = t + ms;
      for (let due = earliestDue(end); due; due = earliestDue(end)) {
        t = due.next;
        due.next += due.ms;
        due.fn();
      }
      t = end;
    },
  };
}
