// @ts-check
// Protocol (design doc 15) and memory links (14.1): every 15.1 example parses; malformed messages are
// rejected; links are ordered, async, string-only, and close propagates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, LIMITS, PROTOCOL_VERSION, parseClient, parseServer, encode } from '../shared/net/protocol.js';
import { memoryLinkPair } from '../shared/net/link.js';

const CLIENT_EXAMPLES = [
  '{"t":"hello","v":1,"name":"shawn"}',
  '{"t":"create","rid":1,"preset":"vsAi","opts":{"ship":"candlewick","ai":"captain"}}',
  '{"t":"cmd","rid":12,"c":{"type":"setPower","system":"shields","level":4}}',
  '{"t":"cmd","rid":13,"c":{"type":"setDevicePower","device":"w2","on":true}}',
  '{"t":"cmd","rid":14,"c":{"type":"setTarget","device":"w1","target":{"ship":"s2","room":"W"}}}',
  '{"t":"cmd","rid":15,"c":{"type":"setAuto","device":"w1","on":true}}',
  '{"t":"cmd","rid":16,"c":{"type":"moveCrew","crew":["c4"],"room":"E"}}',
  '{"t":"join","rid":2,"code":"QXRTV"}',
  '{"t":"join","rid":2,"code":"QXRTV","spectate":true}',
  '{"t":"pause","rid":5,"on":true}',
  '{"t":"rematch","rid":6}',
  '{"t":"list","rid":7}',
  '{"t":"ping","ct":81234}',
  '{"t":"leave","rid":8}',   // not in 15.1; added so every client type has an example
];

const SERVER_EXAMPLES = [
  '{"t":"welcome","player":"p1","token":"9f2c4e0b7a1d4c3e8b6a5f4e3d2c1b0a","name":"shawn","v":1,"content":"3fa9c021"}',
  `{"t":"joined","re":1,"code":"QXRTV","preset":"vsAi","round":1,
    "you":{"member":"m2","ship":"s1","side":"blue","role":"crew","grants":["*"]},
    "rules":{"pause":"crew","pauseWhenEmpty":true,"snapEvery":2,"idleTtlMs":600000,"tickMs":50}}`,
  `{"t":"snap","round":1,"tick":1342,"phase":"running","paused":false,
    "roster":[{"id":"m2","name":"shawn","kind":"human","ship":"s1","online":true},
              {"id":"m1","name":"Gloam (Captain)","kind":"ai","ship":"s2","online":true}],
    "view":{"v":1,"tick":1342,"nextId":58,"ships":{"s1":{"...":"as in 7.2"},"s2":{"...":"as in 7.2, redacted"}},
            "shots":[{"id":"p57","bp":"flint","from":{"ship":"s2","device":"w7"},"to":{"ship":"s1","room":"W"},
                      "flight":{"v":25000,"max":100000,"rate":100}}],"outcome":null},
    "ev":[{"type":"fired","tick":1336,"ship":"s2","device":"w7","bp":"flint","shots":["p57"]}]}`,
  '{"t":"ack","re":12,"ok":true,"tick":1343}',
  '{"t":"ack","re":13,"ok":false,"why":"no-reactor","tick":1343}',
  '{"t":"error","re":2,"code":"seat-full","msg":"That ship has no free seats."}',
  '{"t":"ok","re":5}',
  `{"t":"lobby","re":7,"matches":[{"code":"HWMNB","preset":"aiVsAi","name":"Exhibition","phase":"running",
    "ships":[{"id":"s1","bp":"candlewick","side":"blue","open":0},{"id":"s2","bp":"lampblack","side":"red","open":0}],
    "spectators":2}]}`,
  '{"t":"pong","ct":81234,"tick":1342}',
  '{"t":"left","reason":"idle"}',
];

test('every 15.1 client example parses to the same message', () => {
  for (const text of CLIENT_EXAMPLES) {
    const r = parseClient(text);
    assert.equal(r.ok, true, text);
    if (r.ok) assert.deepEqual(r.msg, JSON.parse(text));
  }
});

test('every 15.1 server example parses to the same message', () => {
  for (const text of SERVER_EXAMPLES) {
    const r = parseServer(text);
    assert.equal(r.ok, true, text);
    if (r.ok) assert.deepEqual(r.msg, JSON.parse(text));
  }
});

test('every message type in the schema is covered by an example', () => {
  const seen = (examples) => new Set(examples.map((t) => JSON.parse(t).t));
  assert.deepEqual([...seen(CLIENT_EXAMPLES)].sort(), Object.keys(MESSAGES.client).sort());
  assert.deepEqual([...seen(SERVER_EXAMPLES)].sort(), Object.keys(MESSAGES.server).sort());
});

/** @param {unknown} text */
function rejected(text) {
  const r = parseClient(text);
  assert.equal(r.ok, false, String(text));
  if (!r.ok) {
    assert.equal(r.code, 'bad-message');
    assert.equal(typeof r.msg, 'string');
  }
  return r;
}

test('malformed client messages are rejected as bad-message', () => {
  const cases = [
    'not json',
    '{"t":"hello","v":1',
    '42',
    'null',
    '[{"t":"list","rid":1}]',
    '{"rid":1}',
    '{"t":7}',
    '{"t":"teleport","rid":1}',          // unknown type
    '{"t":"toString","rid":1}',          // prototype keys are not message types
    '{"t":"welcome","player":"p1","token":"x","name":"n","v":1,"content":"c"}',   // server type from a client
    '{"t":"list"}',                       // missing rid
    '{"t":"list","rid":"1"}',             // wrong type
    '{"t":"list","rid":1.5}',             // not an integer
    `{"t":"list","rid":${2 ** 60}}`,      // not a safe integer
    '{"t":"hello","v":1,"name":7}',
    '{"t":"hello","v":1,"name":null}',    // optional means absent, not null
    `{"t":"hello","v":1,"name":"${'x'.repeat(65)}"}`,   // strings are at most 64 characters
    '{"t":"create","rid":1,"preset":"vsAi","opts":[]}', // obj is a plain object
    '{"t":"join","rid":1,"code":"QXRTV","spectate":"yes"}',
    '{"t":"cmd","rid":1,"c":"setPower"}',
    '{"t":"cmd","rid":1,"c":{"system":"shields"}}',                // no command type
    '{"t":"cmd","rid":1,"c":{"type":"selfDestruct"}}',             // unknown command type
    '{"t":"cmd","rid":1,"c":{"type":"constructor"}}',
    '{"t":"pause","rid":1,"on":1}',
  ];
  for (const text of cases) rejected(text);
  rejected(undefined);
  rejected(42);
});

test('oversize text is rejected before parsing, by UTF-8 bytes', () => {
  const pad = (s) => `{"t":"hello","v":1,"pad":"${s}"}`;
  const ascii = 'x'.repeat(LIMITS.maxBytes - pad('').length);
  assert.equal(parseClient(pad(ascii)).ok, true, 'exactly maxBytes is fine');
  rejected(pad(ascii + 'x'));
  const wide = 'é'.repeat(Math.ceil(LIMITS.maxBytes / 2));   // 2 bytes each in UTF-8, fewer UTF-16 units than maxBytes
  assert.ok(pad(wide).length < LIMITS.maxBytes);
  rejected(pad(wide));
  rejected('{' + ' '.repeat(LIMITS.maxBytes) + '}');
});

test('unknown fields are ignored and stripped; the token may exceed 64 characters', () => {
  const r = parseClient(`{"t":"hello","v":1,"token":"${'a'.repeat(100)}","extra":{"deep":true}}`);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.msg, { t: 'hello', v: 1, token: 'a'.repeat(100) });
});

test('a failed parse reports the request rid when it is readable', () => {
  assert.equal(rejected('{"t":"cmd","rid":9,"c":{"type":"nope"}}').rid, 9);
  assert.equal(rejected('{"t":"create","rid":3,"preset":5}').rid, 3);
  assert.equal(rejected('{"t":"create","rid":"3","preset":5}').rid, undefined);
  assert.equal(rejected('garbage').rid, undefined);
});

test('the server side checks types the same way and encode is JSON', () => {
  assert.equal(parseServer('{"t":"ack","re":1,"ok":"yes","tick":1}').ok, false);
  assert.equal(parseServer('{"t":"hello","v":1}').ok, false, 'client types are not server types');
  const msg = { t: 'pong', ct: 1, tick: 2 };
  assert.equal(encode(msg), JSON.stringify(msg));
  assert.equal(PROTOCOL_VERSION, 1);
});

// ---- memoryLinkPair ----

test('memory links deliver strings in order, asynchronously, in both directions', async () => {
  const [a, b] = memoryLinkPair();
  const gotB = [];
  const gotA = [];
  b.onMessage((t) => gotB.push(t));
  a.onMessage((t) => gotA.push(t));
  a.send('one');
  a.send('two');
  b.send('back');
  assert.deepEqual(gotB, [], 'nothing arrives synchronously');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(gotB, ['one', 'two']);
  assert.deepEqual(gotA, ['back']);
});

test('close propagates to both ends once, after messages in flight, and stops sends', async () => {
  const [a, b] = memoryLinkPair();
  const log = [];
  b.onMessage((t) => log.push(`b got ${t}`));
  a.onClose(() => log.push('a closed'));
  b.onClose(() => log.push('b closed'));
  a.send('last');
  a.close();
  a.close();
  b.close();
  a.send('after close');
  b.send('after close');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, ['b got last', 'a closed', 'b closed']);
});

test('every protocol error code has one text, short enough for the wire, shared by server and client', async () => {
  const { ERROR_TEXT } = await import('../shared/net/protocol.js');
  const { REASON_TEXT } = await import('../client/ui-state.js');
  const codes = ['bad-message', 'hello-first', 'upgrade-required', 'rate-limited', 'bad-preset', 'bad-opts', 'busy',
    'no-match', 'bad-ship', 'seat-full', 'not-in-match', 'forbidden', 'not-ended'];
  assert.deepEqual(Object.keys(ERROR_TEXT).sort(), [...codes].sort());
  for (const code of codes) {
    assert.ok(ERROR_TEXT[code].length <= 64, code);
    assert.ok(REASON_TEXT[code], `client text for ${code}`);
  }
  const overridden = codes.filter((c) => REASON_TEXT[c] !== ERROR_TEXT[c]);
  assert.deepEqual(overridden, ['hello-first'], 'the client overrides only where a player needs other words');
});
