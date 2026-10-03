import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubPage } from '../src/hub-page.js';
import { INK } from '../src/report.js';
import { DRILLABLE } from '../src/play.js';

/*
 * Same bargain as `tests/play-page.test.js`: a browser draws this, so what is
 * checkable here is what the generator is responsible for — that it parses, that
 * it fetches nothing, and that the script and the markup agree about what exists.
 *
 * The script is a `String.raw` block, so a stray backtick in a comment truncates
 * the page into something that is still valid HTML and a broken app. That is not
 * hypothetical; it is how the play page broke the first time it ran.
 */

const html = hubPage({ port: 7070 });
const scriptOf = (page) => page.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)?.[1] ?? '';
const styleOf = (page) => page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

test('the page is one self-contained file that needs no network', () => {
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<(script|link)[^>]+(src|href)=/.test(html), 'nothing may be fetched');
  assert.ok(html.includes('<style>'), 'the CSS is inlined');
});

test('the page script parses', () => {
  const js = scriptOf(html);
  assert.ok(js.length > 1500, `expected a script, got ${js.length} bytes`);
  assert.doesNotThrow(() => new Function(js));
});

test('the script contains no backtick, which would have truncated it', () => {
  // Belt as well as braces: the parse test above only catches a truncation that
  // happens to leave invalid JavaScript behind.
  assert.ok(!scriptOf(html).includes('`'), 'a backtick in a String.raw block ends it');
});

test('the CSS is balanced', () => {
  const css = styleOf(html);
  assert.equal((css.match(/{/g) ?? []).length, (css.match(/}/g) ?? []).length);
});

test('every element the script reaches for exists in the markup', () => {
  const js = scriptOf(html);
  const ids = [...js.matchAll(/\$\('#([a-zA-Z]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 8, 'expected the script to address the document');
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is used but never rendered`);
  }
});

test('every action the page posts is one the hub routes', () => {
  /*
   * The page and the server agree about nothing except these names, and a typo in
   * one is a button that silently does nothing — there is no build step and no
   * type to catch it. So the two files are read against each other.
   */
  const js = scriptOf(html);
  const posted = new Set([...js.matchAll(/post\('([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(posted.has('coach-start'), 'the coach must be startable');
  assert.ok(posted.has('coach-stop'), 'and stoppable, which is the whole point');

  const hub = readFileSync(new URL('../src/hub.js', import.meta.url), 'utf8');
  for (const action of posted) {
    assert.match(hub, new RegExp(`'${action}': `), `/hub/api/${action} is posted but never routed`);
  }
});

test('the two endpoints the page reads are the two the hub serves', () => {
  const js = scriptOf(html);
  assert.match(js, /\/hub\/api\/status/);
  // The log must be on the hub prefix: anything arriving at /events reloads
  // every open review tab, because that is what the injected script does there.
  assert.match(js, /EventSource\('\/hub\/api\/log'\)/);
  assert.ok(!js.includes("EventSource('/events')"), 'the coach log may not share the review channel');
});

test('it offers every habit the drill can actually deal', () => {
  // A select holding a habit `pickSet` has never heard of is a filter that
  // silently returns nothing.
  for (const kind of DRILLABLE) {
    assert.ok(html.includes(`value="${kind}"`), `${kind} is drillable but not offered`);
  }
  assert.ok(html.includes('value=""'), 'and "all of them" stays the default');
});

test('it shares the report page palette rather than inventing one', () => {
  // Three pages of the same tool in three different greens reads as a bug.
  const css = styleOf(html);
  assert.ok(css.includes(INK.dark.plane));
  assert.ok(css.includes(INK.light.plane));
});

test('it renders in both themes without a toggle', () => {
  assert.match(html, /color-scheme: dark/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.match(html, /data-theme="light"/);
});

test('it says that stopping is safe, because that is what makes the button usable', () => {
  // The coach writes its game and its review during shutdown. Someone who does
  // not know that will reach for Task Manager instead, which loses both.
  assert.match(html, /writes the game and the review/i);
});

test('it warns that calibration and a live coach do not mix', () => {
  // Calibration rewrites board.json and templates/model.json underneath a
  // session that has them loaded. The server refuses it; the page says why.
  assert.match(html, /not while a coach is running|rewrites the very files/i);
});

test('the port it was built with is shown, so two hubs are tellable apart', () => {
  assert.ok(html.includes('7070'));
  assert.ok(hubPage().includes('127.0.0.1'), 'and it still renders without one');
});
