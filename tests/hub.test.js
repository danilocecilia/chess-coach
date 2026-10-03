import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';

/*
 * Port 0 throughout, for the reason `tests/dashboard.test.js` gives: the OS
 * picks a free one, so these never collide with a hub left running in another
 * window — which, for this file, is the likely case rather than the unlucky one.
 */
async function serving(fn) {
  const hub = new Hub({ port: 0 });
  const url = await hub.start();
  assert.ok(url, 'the hub took a port');
  try { await fn(hub, url); } finally { await hub.stop(); }
}

test('it listens on localhost only', async () => {
  await serving(async (hub, url) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(hub.server.address().address, '127.0.0.1');
  });
});

test('the review is served from /review, with the live-reload script added', async () => {
  await serving(async (hub, url) => {
    const res = await fetch(url + 'review');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('window.__REVIEW__'), 'the page keeps its inlined data');
    assert.ok(html.includes("new EventSource('/events')"), 'and gains a live channel');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

/*
 * The one that pins the mounted dashboard.
 *
 * `Dashboard.notify` used to return early unless it owned a server, which a
 * mounted one never does — so it would collect this client and then never push
 * to it. The page would sit there connected and go stale after every move.
 */
test('the event stream stays at the root, and a notify reaches it', async () => {
  await serving(async (hub, url) => {
    const res = await fetch(url + 'events');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const first = await reader.read();                      // the retry hint
    assert.match(new TextDecoder().decode(first.value), /retry:/);

    hub.dash.notify();
    const next = await reader.read();
    assert.match(new TextDecoder().decode(next.value), /^data:/m);
    await reader.cancel();
  });
});

test('the hub page names both routes', async () => {
  await serving(async (hub, url) => {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes('href="/review"'));
    assert.ok(html.includes('href="/play"'));
  });
});

/*
 * No session is a 503, not a 404.
 *
 * The path is right and the server is here; there is just nothing to answer
 * with yet. `call()` in src/play-page.js renders the message, so a page left
 * open after a session ended explains itself instead of breaking.
 */
test('the play API answers 503 while no session is running', async () => {
  await serving(async (hub, url) => {
    const res = await fetch(url + 'api/state');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { error: 'no session' });

    // The page behind it says the same thing in words.
    const page = await fetch(url + 'play');
    assert.equal(page.status, 503);
    assert.match(await page.text(), /no session/i);
  });
});

test('every other path is a 404', async () => {
  await serving(async (hub, url) => {
    assert.equal((await fetch(url + 'secrets')).status, 404);
    assert.equal((await fetch(url + '../board.json')).status, 404);
    assert.equal((await fetch(url + 'hub/api/nonsense')).status, 404);
  });
});

test('status reports the coach, the one-shot tool and the drill session', async () => {
  await serving(async (hub, url) => {
    const state = await (await fetch(url + 'hub/api/status')).json();
    // No coach was started by this test, and the suite refuses to touch a real
    // one, so the only honest answer here is "off".
    assert.equal(state.coach.coach, 'off');
    assert.equal(state.coach.log, false);
    assert.equal(state.tool.running, null);
    assert.deepEqual(state.play, { running: false, positions: null });
  });
});

test('the hub API refuses a GET where it expects a POST', async () => {
  await serving(async (hub, url) => {
    const res = await fetch(url + 'hub/api/coach-stop');
    assert.equal(res.status, 405);
    assert.match((await res.json()).error, /POST/);
  });
});

/*
 * Stopping nothing has to be safe, because the button is reachable whenever the
 * page has gone stale — and the alternative to answering "nothing to stop" is a
 * 500 the page would show as a sentence.
 */
test('stopping a coach that is not running answers rather than fails', async () => {
  await serving(async (hub, url) => {
    const res = await fetch(url + 'hub/api/coach-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, was: 'off' });
  });
});

test('the log is an event stream on the hub prefix, never on /events', async () => {
  await serving(async (hub, url) => {
    const res = await fetch(url + 'hub/api/log');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    /*
     * This separation is load-bearing. The script injected into the review page
     * calls location.reload() on *any* message arriving at /events, so coach log
     * lines sent there would reload every open review tab once per printed line.
     */
    await res.body.getReader().cancel();
  });
});

/*
 * The deliberate difference from the dashboard.
 *
 * `Dashboard.start` resolves null on a taken port, because losing a dashboard
 * must never cost a game. The hub is the opposite: once the app is installed its
 * identity is its origin, so a hub that silently moved would leave the installed
 * app pointing at nothing.
 */
test('a port already taken is fatal', async () => {
  await serving(async (taken) => {
    const second = new Hub({ port: taken.port });
    await assert.rejects(() => second.start(), /EADDRINUSE/);
    await second.stop();
  });
});

test('stopping a hub that never started does nothing', async () => {
  const hub = new Hub({ port: 0 });
  await assert.doesNotReject(() => hub.stop());
});
