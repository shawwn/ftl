// @ts-check
// The ?local path (design doc 19.3): GameClient over memoryLinkPair to an in-process Lobby on a manual
// clock completes hello, create, joined, snap, cmd and ack; a pending command clears with the first snap
// after its ack. Also co-op crew and a spectator joining by code, and a reload (a new client with the same
// token) resuming the same seat, all without sockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameClient } from '../client/game-client.js';
import { Lobby } from '../shared/host/lobby.js';
import { manualClock } from '../shared/host/clock.js';
import { memoryLinkPair } from '../shared/net/link.js';
import { CONTENT, CONTENT_HASH } from '../shared/content/index.js';
import { TICK_MS } from '../shared/sim/index.js';

/** Memory links deliver on microtasks; a macrotask turn lets every queued message land. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function host() {
  const clock = manualClock();
  const lobby = new Lobby({ content: CONTENT, clock });
  const net = { down: false, connects: 0 };
  /** @returns {Promise<import('../shared/net/link.js').Link>} */
  const connector = async () => {
    net.connects += 1;
    if (net.down) throw new Error('unreachable');
    const [mine, theirs] = memoryLinkPair();
    lobby.connect(theirs);
    return mine;
  };
  /** Advance n ticks, letting messages land before and after each. */
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await flush();
      clock.advance(TICK_MS);
      await flush();
    }
  };
  return { lobby, connector, tick, net, clock };
}

/** Poll (real time) until pred holds. @param {() => boolean} pred */
async function until(pred, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A token store that outlives one client, like sessionStorage across a reload. */
function tokens() {
  let token = null;
  return { get: () => token, set: (/** @type {string} */ t) => { token = t; } };
}

/** @param {GameClient} client @param {string} type */
const next = (client, type) => new Promise((resolve) => {
  client.addEventListener(type, (e) => resolve(/** @type {CustomEvent} */ (e).detail), { once: true });
});

test('hello, create, joined, snap, cmd, ack; pending clears with the first snap after the ack', async () => {
  const { lobby, connector, tick } = host();
  const client = new GameClient(connector, { name: 'shawn' });
  try {
    const welcome = await client.start();
    assert.equal(welcome.content, CONTENT_HASH);
    assert.equal(welcome.name, 'shawn');
    assert.equal(client.status, 'online');

    const joined = await client.create('vsAi', { ai: 'drifter', seed: 3 });
    assert.deepEqual([joined.you.ship, joined.you.side, joined.you.role], ['s1', 'blue', 'crew']);
    await flush();
    assert.equal(client.snap.phase, 'running');
    assert.deepEqual(Object.keys(client.snap.view.ships), ['s1', 's2']);
    assert.ok(!('rng' in client.snap.view));

    const target = { ship: 's2', room: 'S' };
    const rid = client.cmd({ type: 'setTarget', device: 'w1', target });
    assert.ok(client.pending.has(rid));
    await tick();   // tick 1: the ack arrives, but no snapshot is due on an odd tick
    assert.deepEqual(client.lastAck, { t: 'ack', re: rid, ok: true, tick: 1 });
    assert.ok(client.pending.has(rid), 'still pending until a snapshot reflects it');
    await tick();   // tick 2: the snapshot
    assert.equal(client.pending.size, 0);
    assert.deepEqual(client.snap.view.ships.s1.devices[0].target, target);

    const bad = client.cmd({ type: 'setPower', system: 'nope', level: 1 });
    await tick();
    assert.deepEqual(client.lastAck, { t: 'ack', re: bad, ok: false, why: 'no-system', tick: 3 });
    assert.equal(client.pending.has(bad), false, 'a rejected order clears at its ack: no snapshot will confirm it (client-9)');
  } finally {
    client.close();
    lobby.close();
  }
});

test('co-op crew and a spectator join by code; a reload resumes the same seat', async () => {
  const { lobby, connector, tick } = host();
  const store = tokens();
  const a = new GameClient(connector, { name: 'Ann', tokenStore: store });
  const b = new GameClient(connector, { name: 'Ben' });
  const c = new GameClient(connector, { name: 'Cyd' });
  /** @type {GameClient | null} */
  let reloaded = null;
  try {
    await a.start();
    const { code, you } = await a.create('vsAi', { ai: 'drifter', seed: 4 });

    await b.start();
    const crew = await b.join(code.toLowerCase());
    assert.deepEqual([crew.you.ship, crew.you.role], ['s1', 'crew'], 'a second human on the same ship is co-op crew');

    await c.start();
    const spectator = await c.join(code, { spectate: true });
    assert.deepEqual([spectator.you.ship, spectator.you.role], [null, 'spectator']);
    const rid = c.cmd({ type: 'setAuto', device: 'w1', on: true });
    await tick();
    assert.deepEqual([c.lastAck.re, c.lastAck.ok, c.lastAck.why], [rid, false, 'spectator']);

    b.cmd({ type: 'setPower', system: 'engines', level: 1 });
    await tick();
    assert.equal(a.snap.view.ships.s1.systems.engines.want, 1, 'crewmates see each other\'s orders');

    a.close();   // the page unloads
    await tick(2);
    reloaded = new GameClient(connector, { tokenStore: store });
    const rejoined = next(reloaded, 'joined');
    const welcome = await reloaded.start();
    assert.equal(welcome.name, 'Ann', 'the token resumes the player');
    const again = await rejoined;
    assert.deepEqual([again.code, again.you.member, again.you.ship], [code, you.member, 's1']);
    await flush();
    assert.equal(reloaded.snap.view.ships.s1.systems.engines.want, 1, 'the same fight');
    const roster = reloaded.snap.roster.map((m) => [m.name, m.ship, m.online]);
    assert.deepEqual(roster, [['Drifter (Target practice)', 's2', true], ['Ann', 's1', true], ['Ben', 's1', true], ['Cyd', null, true]]);
  } finally {
    for (const cl of [a, b, c, reloaded]) cl?.close();
    lobby.close();
  }
});

test('a reconnect to a match that is gone tells the player instead of freezing the fight (client-1)', async () => {
  const { lobby, connector } = host();
  const client = new GameClient(connector);
  try {
    await client.start();
    const { code } = await client.create('vsAi', { ai: 'drifter' });
    await flush();
    /** @type {any} */
    let left = null;
    client.addEventListener('left', (e) => { left = /** @type {CustomEvent} */ (e).detail; });
    client.link.close();
    await flush();
    lobby.dispose(lobby.get(code), 'idle');   // the idle TTL passed while the phone slept
    await until(() => left !== null);
    assert.deepEqual(left, { reason: 'gone' });
    assert.equal(client.status, 'online');
    assert.deepEqual([client.code, client.snap, client.intent], [null, null, null]);
  } finally {
    client.close();
    lobby.close();
  }
});

test('a reconnect keeps a surviving crew seat and re-joins a spectator the server let go (client-1, host-8)', async () => {
  const { lobby, connector, tick } = host();
  const crew = new GameClient(connector);
  const fan = new GameClient(connector);
  try {
    await crew.start();
    const { code, you } = await crew.create('vsAi', { ai: 'drifter' });
    await fan.start();
    await fan.join(code, { spectate: true });
    const match = lobby.get(code);
    assert.equal(match.members.size, 3);
    crew.link.close();
    fan.link.close();
    await flush();
    assert.equal(match.members.size, 2, 'the spectator held no seat and was let go');
    await until(() => crew.status === 'online' && fan.status === 'online');
    await tick(2);
    assert.deepEqual([crew.code, crew.you.member], [code, you.member], 'the same seat');
    assert.deepEqual([fan.code, fan.you.role], [code, 'spectator'], 'watching again');
    assert.equal(match.members.size, 3);
    assert.equal(fan.snap.tick, match.world.tick);
  } finally {
    crew.close();
    fan.close();
    lobby.close();
  }
});

test('Menu while reconnecting sticks: the kept seat is released on reconnect, not adopted (client-3)', async () => {
  const { lobby, connector, tick } = host();
  const client = new GameClient(connector);
  try {
    await client.start();
    const { code } = await client.create('vsAi', { ai: 'drifter' });
    client.link.close();
    await flush();
    assert.equal(client.status, 'reconnecting');
    await assert.rejects(client.leave(), { code: 'disconnected' });
    assert.deepEqual([client.code, client.intent], [null, null], 'leaving clears the intent even offline');
    let joins = 0;
    client.addEventListener('joined', () => { joins += 1; });
    await until(() => client.status === 'online');
    await tick(2);
    assert.equal(joins, 0, 'the pushed joined for the kept seat is ignored');
    assert.equal(client.code, null);
    assert.equal(lobby.get(code), undefined, 'the server released the seat (and the match it emptied)');
  } finally {
    client.close();
    lobby.close();
  }
});

test('Menu pressed before the first welcome (a reload) releases the seat the server resumes (client-3)', async () => {
  const { lobby, connector, tick } = host();
  const store = tokens();
  const first = new GameClient(connector, { tokenStore: store });
  /** @type {GameClient | null} */
  let reloaded = null;
  try {
    await first.start();
    const { code } = await first.create('vsAi', { ai: 'drifter' });
    first.close();
    await flush();
    reloaded = new GameClient(connector, { tokenStore: store });
    const welcomed = reloaded.start();
    reloaded.leave().catch(() => {});   // Menu while still connecting
    let joins = 0;
    reloaded.addEventListener('joined', () => { joins += 1; });
    await welcomed;
    await tick(2);
    assert.equal(joins, 0, 'the resumed seat is not adopted');
    assert.equal(reloaded.code, null);
    assert.equal(lobby.get(code), undefined, 'the first welcome reasserted "no match", so the seat (and its match) went');
  } finally {
    first.close();
    reloaded?.close();
    lobby.close();
  }
});

test('a link that goes silent is treated as lost after three ping periods (client-7)', async () => {
  const { lobby } = host();
  let t = 0;
  /** @type {any} */
  let live = null;
  const muted = async () => {
    const [mine, theirs] = memoryLinkPair();
    lobby.connect(theirs);
    let silent = false;
    live = { mute: () => { silent = true; } };
    return {
      send: (text) => { if (!silent) mine.send(text); },
      onMessage: (fn) => mine.onMessage((text) => { if (!silent) fn(text); }),
      onClose: (fn) => mine.onClose(fn),
      close: () => mine.close(),
    };
  };
  const client = new GameClient(muted, { now: () => t });
  try {
    await client.start();
    await client.create('vsAi', { ai: 'drifter' });
    const first = client.link;
    live.mute();   // a half-open socket: nothing in either direction, and no close event
    t += 5000;
    client.ping();
    assert.equal(client.link, first, 'two silent ping periods are not yet a dead link');
    t += 2000;
    client.ping();
    assert.equal(client.status, 'reconnecting');
    assert.notEqual(client.link, first);
    await until(() => client.status === 'online');
  } finally {
    client.close();
    lobby.close();
  }
});

test('a server that cannot be reached at first load is reported as reconnecting before any welcome (client-8)', async () => {
  const { lobby, connector, net } = host();
  net.down = true;
  const client = new GameClient(connector);
  const statuses = [];
  client.addEventListener('status', () => statuses.push(client.status));
  try {
    client.start();
    await until(() => statuses.length > 0);
    assert.deepEqual([statuses[0], client.welcome], ['reconnecting', null], 'the first failure is visible');
    net.down = false;
    await until(() => client.status === 'online');
    assert.ok(client.welcome);
  } finally {
    client.close();
    lobby.close();
  }
});
