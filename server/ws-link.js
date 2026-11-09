// @ts-check
// A Link over a `ws` socket (design doc 18). Frames arrive as text whatever their opcode; parsing decides.
// Doc choices: a send on a socket that is not open is dropped silently; past 4 MB of backlog the socket is
// terminated rather than closed, since a close frame would queue behind the backlog it is meant to cut.
// Every socket has an 'error' listener: ws emits 'error' on any protocol violation from the peer (a frame
// over maxPayload, an unmasked frame, bad UTF-8), and an unheard 'error' event would kill the process.

/** @typedef {import('../shared/net/link.js').Link} Link */
/** @typedef {import('ws').WebSocket} WebSocket */

export const MAX_BUFFERED = 4 * 1024 * 1024;

/** @param {WebSocket} socket @returns {Link} */
export function wsLink(socket) {
  // ws has already started closing the socket with the right status code (1009, 1002, ...) when it emits
  // this; the 'close' listener below then detaches the session like any other disconnect.
  socket.on('error', () => {});
  return {
    send(text) {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED) {
        socket.terminate();
        return;
      }
      socket.send(text);
    },
    onMessage(fn) {
      socket.on('message', (data) => fn(data.toString()));
    },
    onClose(fn) {
      socket.on('close', () => fn());
    },
    close() {
      socket.close();
    },
  };
}
