import test from 'node:test';
import assert from 'node:assert/strict';
import { Dashboard } from '../src/dashboard.js';

/*
 * Port 0 throughout: the OS picks a free one, so these never collide with a
 * coach the developer has running in another window.
 */
async function serving(fn) {
  const dash = new Dashboard({ port: 0, open: false });
  const url = await dash.start();
  assert.ok(url, 'the dashboard took a port');
  try { await fn(dash, url); } finally { dash.stop(); }
}

test('it serves the review page with the live-reload script added', async () => {
  await serving(async (dash, url) => {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('window.__REVIEW__'), 'the page keeps its inlined data');
    assert.ok(html.includes("new EventSource('/events')"), 'and gains a live channel');
    // Never cached: a stale dashboard is the thing this exists to prevent.
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

test('it listens on localhost only', async () => {
  await serving(async (dash, url) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(dash.server.address().address, '127.0.0.1');
  });
});

test('anything that is not the page or the event stream is a 404', async () => {
  await serving(async (dash, url) => {
    assert.equal((await fetch(url + 'secrets')).status, 404);
    assert.equal((await fetch(url + '../board.json')).status, 404);
  });
});

test('a notify reaches an open event stream', async () => {
  await serving(async (dash, url) => {
    const res = await fetch(url + 'events');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const first = await reader.read();                      // the retry hint
    assert.match(new TextDecoder().decode(first.value), /retry:/);

    dash.notify();
    const next = await reader.read();
    assert.match(new TextDecoder().decode(next.value), /^data:/m);
    await reader.cancel();
  });
});

test('a port already taken is not an error, just no dashboard', async () => {
  await serving(async (taken) => {
    const second = new Dashboard({ port: taken.port, open: false });
    // Null rather than a throw: losing the dashboard must never cost a game.
    assert.equal(await second.start(), null);
    second.stop();
  });
});

test('notify on a dashboard that never started does nothing', () => {
  const dash = new Dashboard({ port: 0, open: false });
  assert.doesNotThrow(() => dash.notify());
  assert.doesNotThrow(() => dash.stop());
});
