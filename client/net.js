// @ts-check
// Connectors (design doc 17.2): each call opens a fresh Link. wsConnector speaks to a server; with
// localConnector the whole host (Lobby, matches, AI) runs inside this page over an in-memory Link pair,
// so the game works offline after load.
// Doc choice: localConnector imports the host lazily (dynamic import), so online play never loads it.

/** @typedef {import('../shared/net/link.js').Link} Link */
/** @typedef {() => Promise<Link>} Connector */

/**
 * A Link over a browser WebSocket; the promise resolves on open and rejects if it never opens.
 * @param {string} url @returns {Connector}
 */
export function wsConnector(url) {
  return () => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    /** @type {(() => void)[]} */
    const closeFns = [];
    let open = false;
    ws.addEventListener('open', () => {
      open = true;
      resolve({
        send(text) {
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        onMessage(fn) {
          ws.addEventListener('message', (e) => fn(String(e.data)));
        },
        onClose(fn) {
          closeFns.push(fn);
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('close', () => {
      if (!open) return reject(new Error('socket closed before opening'));
      for (const fn of closeFns.splice(0)) fn();
    });
  });
}

/**
 * A Lobby in this page, created on first connect and shared by later connects (so a reconnect resumes).
 * @returns {Connector}
 */
export function localConnector() {
  /** @type {Promise<{ connect(link: Link): unknown }> | null} */
  let lobby = null;
  /** @type {typeof import('../shared/net/link.js').memoryLinkPair} */
  let pair;
  return async () => {
    lobby ??= (async () => {
      const [{ Lobby }, { realClock }, link, { CONTENT }] = await Promise.all([
        import('../shared/host/lobby.js'),
        import('../shared/host/clock.js'),
        import('../shared/net/link.js'),
        import('../shared/content/index.js'),
      ]);
      pair = link.memoryLinkPair;
      return new Lobby({ content: CONTENT, clock: realClock() });
    })();
    const host = await lobby;
    const [mine, theirs] = pair();
    host.connect(theirs);
    return mine;
  };
}
