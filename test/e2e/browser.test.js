// @ts-check
// Headless Chrome against the real server (design doc 19.5): a desktop spectator, a phone portrait player
// who fires with two taps, a co-op match (HUD power and crew orders, a crewmate and a spectator joining by
// code, a reload resuming the seat), and a phone landscape player. Then layout checks: every HUD control is
// on screen on landscape phones from 568 px wide, in portrait and on tablets (three weapons too); pip taps
// ask for the tapped level; the canvas follows a pixel-ratio change; the waiting and outcome panels keep
// their buttons on screen on small phones in both orientations; and an unreachable server says so. Every
// scenario fails on page exceptions, console errors or __ftl.errors, and checks that the canvas is not
// blank. Screenshots go to test/artifacts/.
// Choice: "not blank" counts pixels that differ strongly from the ink background (summed RGB distance
// > 200), which the faint dust in the backdrop never reaches; ship lines and room light do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome } from '../helpers/cdp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACTS = join(ROOT, 'test/artifacts');
const chrome = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const PORTRAIT = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
const LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 3, mobile: true };
const SMALL_LANDSCAPE = { width: 667, height: 375, deviceScaleFactor: 2, mobile: true };
const TABLET = { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false };

/** Labels of visible #hud buttons not fully inside the viewport and every scrolling ancestor's box. */
const OFFSCREEN_CONTROLS = `(() => {
  const out = [];
  for (const b of document.querySelectorAll('#hud button')) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let ok = r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    for (let p = b.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!/(auto|scroll|hidden)/.test(cs.overflowX + cs.overflowY)) continue;
      const q = p.getBoundingClientRect();
      if (r.left < q.left - 0.5 || r.right > q.right + 0.5 || r.top < q.top - 0.5 || r.bottom > q.bottom + 0.5) ok = false;
    }
    if (!ok) out.push(b.getAttribute('aria-label') || b.textContent);
  }
  return out;
})()`;

/** Labels of overlay buttons not fully inside the viewport and the panel's visible box. */
const HIDDEN_PANEL_BUTTONS = `(() => {
  const panel = document.querySelector('#overlay .panel').getBoundingClientRect();
  return [...document.querySelectorAll('#overlay button')].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.top < Math.max(0, panel.top) || r.bottom > Math.min(innerHeight, panel.bottom) || r.left < 0 || r.right > innerWidth;
  }).map((b) => b.textContent);
})()`;

/** Pixels of the stage canvas that differ strongly from the ink background. */
const LIT_PIXELS = `(() => {
  const c = document.getElementById('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 11) + Math.abs(d[i + 1] - 13) + Math.abs(d[i + 2] - 26) > 200) n++;
  return n;
})()`;

if (!chrome) {
  test('headless Chrome scenarios', { skip: 'Chrome not found (set CHROME to its binary)' }, () => {});
} else {
  /** @type {{ port: number, close(): Promise<void> }} */
  let server;
  /** @type {Awaited<ReturnType<typeof launchChrome>>} */
  let browser;

  before(async () => {
    const { startServer } = await import('../../server/main.js');
    server = await startServer({ port: 0, host: '127.0.0.1' });
    browser = await launchChrome({ chrome });
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  /**
   * Open a page with device metrics, collecting every problem the page reports.
   * @param {object} metrics @param {string} path
   */
  async function open(metrics, path) {
    const page = await browser.newPage();
    const problems = [];
    page.on('Runtime.exceptionThrown', (p) => problems.push('exception: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text)));
    page.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') problems.push('console.error: ' + p.args.map((a) => a.value ?? a.description).join(' '));
    });
    page.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') problems.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`);
    });
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', metrics);
    if (metrics.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const loaded = page.waitFor('Page.loadEventFired');
    await page.send('Page.navigate', { url: `http://127.0.0.1:${server.port}${path}` });
    await loaded;
    return { page, problems };
  }

  /** @param {any} page @param {string[]} problems @param {string} name */
  async function finish(page, problems, name) {
    await page.send('Page.bringToFront');   // a background tab neither paints nor captures faithfully
    await sleep(300);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ARTIFACTS, name), Buffer.from(shot.data, 'base64'));
    const errors = await page.evaluate('window.__ftl.errors');
    const lit = await page.evaluate(LIT_PIXELS);
    await page.close();
    assert.deepEqual(problems, []);
    assert.deepEqual(errors, []);
    assert.ok(lit > 1000, `canvas looks blank (${lit} lit pixels)`);
  }

  /** @param {any} page @param {{ x: number, y: number }} p */
  async function tap(page, p) {
    assert.ok(p, 'tap target exists');
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  test('desktop: watch two AIs', async () => {
    const { page, problems } = await open(DESKTOP, '/?watch=ai&seed=7&debug');
    await page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    await sleep(4000);
    assert.equal(await page.evaluate('document.body.dataset.phase'), 'running');
    await finish(page, problems, 'desktop-watch.png');
  });

  test('phone portrait: tap a weapon, tap an enemy room, the order is accepted', async () => {
    const { page, problems } = await open(PORTRAIT, '/?play=ai&ai=drifter&seed=3&debug');
    await page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    await page.waitUntil(`!!window.__ftl.tapPoint('weapon', 0)`);
    await tap(page, await page.evaluate(`window.__ftl.tapPoint('weapon', 0)`));
    await page.waitUntil(`window.__ftl.ui.mode === 'aiming'`, 5000);
    await tap(page, await page.evaluate(`window.__ftl.tapPoint('room', 's2', 'S')`));
    await page.waitUntil(`window.__ftl.lastAck?.ok === true`, 10000);
    const target = await page.waitUntil(`window.__ftl.client.snap.view.ships.s1.devices[0].target`, 5000);
    assert.deepEqual(target, { ship: 's2', room: 'S' });
    await sleep(2000);
    await finish(page, problems, 'phone-play.png');
  });

  /**
   * Viewport center of the first element matching a selector, once it exists (the HUD is built on the
   * first animation frame after the first snapshot, which can trail the phase change).
   * @param {any} page @param {string} selector
   */
  const centerOf = (page, selector) => page.waitUntil(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`, 5000);

  /**
   * Tap, wait for an ack newer than the last one, then for a snapshot whose view satisfies `seen`.
   * @param {any} page @param {{ x: number, y: number }} point @param {string} seen   JS: (view) => boolean
   */
  async function order(page, point, seen) {
    const last = await page.evaluate('window.__ftl.lastAck?.re ?? 0');
    await tap(page, point);
    const ack = await page.waitUntil(`window.__ftl.lastAck?.re > ${last} && window.__ftl.lastAck`, 5000);
    assert.equal(ack.ok, true, JSON.stringify(ack));
    await page.waitUntil(`(${seen})(window.__ftl.client.snap.view)`, 5000);
  }

  test('co-op: HUD power and crew orders, a crewmate and a spectator join by code, a reload resumes the seat', async () => {
    const a = await open(PORTRAIT, '/?play=ai&ai=drifter&seed=5&debug&name=Ann');
    await a.page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    const { code, member } = await a.page.evaluate(`({ code: window.__ftl.client.code, member: window.__ftl.client.you.member })`);
    assert.match(await a.page.evaluate('location.search'), new RegExp(`join=${code}`), 'the URL remembers the match');

    await order(a.page, await centerOf(a.page, '[data-key="sys:engines"] .sys-btn[aria-label^="Less"]'), `(v) => v.ships.s1.systems.engines.want === 1`);
    await order(a.page, await centerOf(a.page, '[data-key="sys:shields"] .sys-btn[aria-label^="More"]'), `(v) => v.ships.s1.systems.shields.power === 3`);
    await tap(a.page, await a.page.evaluate(`window.__ftl.tapPoint('crew', 'c4')`));
    await a.page.waitUntil(`window.__ftl.ui.mode === 'crew'`, 3000);
    await order(a.page, await a.page.evaluate(`window.__ftl.tapPoint('room', 's1', 'E')`),
      `(v) => v.ships.s1.crew.some((c) => c.id === 'c4' && c.task === 'walk')`);

    const b = await open(DESKTOP, `/?join=${code}&debug&name=Ben`);
    await b.page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    assert.deepEqual(await b.page.evaluate('[window.__ftl.client.you.ship, window.__ftl.client.you.role]'), ['s1', 'crew']);
    await order(b.page, await centerOf(b.page, '[data-key="sys:engines"] .sys-btn[aria-label^="More"]'), `(v) => v.ships.s1.systems.engines.want === 2`);
    await a.page.waitUntil(`window.__ftl.client.snap.view.ships.s1.systems.engines.want === 2`, 5000);

    const c = await open(DESKTOP, `/?join=${code}&spectate=1&debug&name=Cyd`);
    await c.page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    assert.deepEqual(await c.page.evaluate('[window.__ftl.client.you.ship, window.__ftl.client.you.role]'), [null, 'spectator']);
    await c.page.waitUntil(`document.getElementById('hud').hasAttribute('data-readonly')`, 5000);   // built on the next frame
    await a.page.waitUntil(`window.__ftl.client.snap.roster.length === 4`, 5000);

    const tick = await a.page.evaluate('window.__ftl.client.snap.tick');
    const reloaded = a.page.waitFor('Page.loadEventFired');
    await a.page.send('Page.reload');
    await reloaded;
    await a.page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    const after = await a.page.evaluate(`({ code: window.__ftl.client.code, member: window.__ftl.client.you.member,
      tick: window.__ftl.client.snap.tick, engines: window.__ftl.client.snap.view.ships.s1.systems.engines.want })`);
    assert.deepEqual([after.code, after.member, after.engines], [code, member, 2], 'the same seat in the same fight');
    assert.ok(after.tick >= tick);
    await finish(c.page, c.problems, 'coop-spectator.png');
    await finish(b.page, b.problems, 'coop-crewmate.png');
    await finish(a.page, a.problems, 'coop-reloaded.png');
  });

  test('phone landscape: the same match type lays out in one HUD row', async () => {
    const { page, problems } = await open(LANDSCAPE, '/?play=ai&ai=drifter&seed=3&debug');
    await page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    await sleep(1500);
    const fits = await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight`);
    assert.equal(fits, true, 'no page overflow');
    await finish(page, problems, 'phone-landscape.png');
  });

  test('layout: every HUD control is on screen on phones and tablets, for two and three weapons (client-2)', async () => {
    /** @type {[typeof TABLET, string | null, string][]} */
    const sizes = [
      [{ ...SMALL_LANDSCAPE, width: 568, height: 320 }, null, 'candlewick'], [{ ...SMALL_LANDSCAPE, width: 640, height: 360 }, null, 'candlewick'],
      [SMALL_LANDSCAPE, 'small-landscape.png', 'candlewick'], [{ ...SMALL_LANDSCAPE, width: 740, height: 360 }, null, 'candlewick'],
      [TABLET, 'tablet.png', 'candlewick'], [{ ...TABLET, width: 1080, height: 810 }, null, 'candlewick'],
      // Lampblack's three weapons share the row in portrait and from 667 px wide in landscape
      [PORTRAIT, null, 'lampblack'], [{ ...PORTRAIT, width: 320, height: 568 }, null, 'lampblack'],
      [SMALL_LANDSCAPE, null, 'lampblack'], [TABLET, null, 'lampblack'],
    ];
    for (const [metrics, name, ship] of sizes) {
      const { page, problems } = await open(metrics, `/?play=ai&ai=drifter&seed=3&ship=${ship}&debug`);
      await page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
      const n = ship === 'lampblack' ? 3 : 2;
      await page.waitUntil(`document.querySelectorAll('#hud .weapon').length === ${n}`, 5000);
      assert.deepEqual(await page.evaluate(OFFSCREEN_CONTROLS), [], `${ship} ${metrics.width}x${metrics.height}`);
      if (name) await finish(page, problems, name);
      else {
        assert.deepEqual(problems, []);
        await page.close();
      }
    }
  });

  test('tablet: a tap on a drawn pip asks for that pip\'s level; the canvas follows a pixel-ratio change (client-6, client-10)', async () => {
    const { page, problems } = await open(TABLET, '/?play=ai&ai=drifter&seed=3&debug');
    await page.waitUntil(`window.__ftl?.phase === 'running'`, 20000);
    await page.waitUntil(`document.querySelectorAll('[data-key="sys:shields"] .pip').length > 1`, 5000);
    await page.evaluate(`(() => {
      const c = window.__ftl.client;
      window.__sent = [];
      const send = c.cmd.bind(c);
      c.cmd = (cmd) => { window.__sent.push(cmd); return send(cmd); };
    })()`);
    const pips = await page.evaluate(`[...document.querySelectorAll('[data-key="sys:shields"] .pip')].map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })`);
    for (const p of pips) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    await page.waitUntil(`window.__sent.length === ${pips.length}`, 5000);
    assert.deepEqual(await page.evaluate(`window.__sent.map((c) => [c.type, c.system, c.level])`),
      pips.map((_, i) => ['setPower', 'shields', i + 1]), 'each pip asks for its own level');
    assert.equal(await page.evaluate(`document.getElementById('canvas').width`), 1024);
    await page.send('Emulation.setDeviceMetricsOverride', { ...TABLET, deviceScaleFactor: 2 });
    await page.waitUntil(`document.getElementById('canvas').width === 2048`, 5000);
    await page.send('Emulation.setDeviceMetricsOverride', TABLET);
    await page.waitUntil(`document.getElementById('canvas').width === 1024`, 5000);
    await finish(page, problems, 'tablet-pips.png');
  });

  test('phones: the waiting and outcome panels keep their buttons on screen (client-4)', async () => {
    const SMALL_PORTRAIT = { width: 320, height: 568, deviceScaleFactor: 2, mobile: true };
    for (const [metrics, prefix] of /** @type {[typeof LANDSCAPE, string | null][]} */ ([[LANDSCAPE, 'landscape'], [SMALL_LANDSCAPE, null], [SMALL_PORTRAIT, null]])) {
      const at = `${metrics.width}x${metrics.height}`;
      const { page, problems } = await open(metrics, '/?pvp=new&debug');
      await page.waitUntil(`window.__ftl?.phase === 'waiting' && document.body.dataset.menu === 'waiting'`, 20000);
      assert.deepEqual(await page.evaluate(HIDDEN_PANEL_BUTTONS), [], `${at} waiting: Copy invite link and Menu`);
      if (prefix) {
        await page.send('Page.bringToFront');
        await sleep(200);
        writeFileSync(join(ARTIFACTS, `${prefix}-waiting.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      }
      // The outcome screen, from a synthetic final snapshot (snapshots are truth; the waiting match sends no
      // more snapshots until something changes).
      await page.evaluate(`(() => {
        const snap = structuredClone(window.__ftl.client.snap);
        snap.phase = 'ended';
        snap.seed = 12345;
        snap.view.ships.s2.out = 'hull';
        snap.view.outcome = { winner: 'blue', tick: 2400 };
        window.__ftl.client.receive(JSON.stringify(snap));
      })()`);
      await page.waitUntil(`document.body.dataset.menu === 'outcome'`, 5000);
      assert.deepEqual(await page.evaluate(HIDDEN_PANEL_BUTTONS), [], `${at} outcome: Rematch and Menu`);
      if (prefix) await finish(page, problems, `${prefix}-outcome.png`);
      else {
        assert.deepEqual(problems, []);
        await page.close();
      }
    }
  });

  test('an unreachable server is reported, not a silent backdrop (client-8)', async () => {
    const { page } = await open(DESKTOP, '/?server=ws://127.0.0.1:9/ws&debug');
    const text = await page.waitUntil(`!document.getElementById('banner').hidden && document.getElementById('banner').textContent`, 10000);
    assert.equal(text, 'Cannot reach the server. Retrying.');
    await page.send('Page.bringToFront');
    await sleep(300);
    writeFileSync(join(ARTIFACTS, 'unreachable.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    assert.deepEqual(await page.evaluate('window.__ftl.errors'), []);
    await page.close();
  });
}
