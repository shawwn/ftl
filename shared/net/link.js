// @ts-check
// Link (design doc 14.1): a text pipe. ws on the server, WebSocket in the browser, or an in-memory pair.
// Links carry strings, not objects, so there is a real serialization boundary even in memory.
// Doc choices for memoryLinkPair: a message is delivered to the listeners registered when it arrives
// (like a socket, nothing is buffered for late listeners); close() on either end stops further sends at
// once, lets messages already in flight arrive, then runs every onClose listener on both ends, once.

/**
 * @typedef {{ send(text: string): void, onMessage(fn: (text: string) => void): void,
 *             onClose(fn: () => void): void, close(): void }} Link
 */

/** @returns {[Link, Link]} ordered, async (queueMicrotask); close propagates */
export function memoryLinkPair() {
  const ends = [endpoint(), endpoint()];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => ends.forEach((e) => e.closeFns.forEach((fn) => fn())));
  };
  /** @param {number} i @returns {Link} */
  const link = (i) => ({
    send(text) {
      if (closed) return;
      const peer = ends[1 - i];
      const s = String(text);
      queueMicrotask(() => peer.messageFns.forEach((fn) => fn(s)));
    },
    onMessage(fn) { ends[i].messageFns.push(fn); },
    onClose(fn) { ends[i].closeFns.push(fn); },
    close,
  });
  return [link(0), link(1)];
}

function endpoint() {
  return { /** @type {((text: string) => void)[]} */ messageFns: [], /** @type {(() => void)[]} */ closeFns: [] };
}
