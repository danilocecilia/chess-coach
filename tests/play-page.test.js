import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { playPage } from '../src/play-page.js';
import { INK } from '../src/report.js';

/*
 * The page is drawn by a browser, so what is checkable here is what the
 * generator is responsible for: that it parses at all, that it needs nothing off
 * the network, that the script and the markup agree about what exists — and the
 * one architectural rule that cannot be allowed to erode, which is that no chess
 * knowledge lives on this side.
 *
 * It is worth more than it looks. The script is a `String.raw` block, so a stray
 * backtick in a comment silently truncates the page rather than failing — which
 * is exactly how it broke the first time it was run.
 */

const html = playPage();
const scriptOf = (page) => page.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)?.[1] ?? '';
const styleOf = (page) => page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

test('the page is one self-contained file that needs no network', () => {
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<(script|link)[^>]+(src|href)=/.test(html), 'nothing may be fetched');
  assert.ok(html.includes('<style>'), 'the CSS is inlined');
});

test('the page script parses', () => {
  const js = scriptOf(html);
  assert.ok(js.length > 2000, `expected a script, got ${js.length} bytes`);
  // A truncated String.raw block is still valid HTML and a broken page, so this
  // is the test that catches a backtick written into a comment.
  assert.doesNotThrow(() => new Function(js));
});

test('the CSS is balanced', () => {
  const css = styleOf(html);
  assert.equal((css.match(/{/g) ?? []).length, (css.match(/}/g) ?? []).length);
});

test('no chess knowledge lives in the page', () => {
  /*
   * The rule this protects: the page sends two square names and draws what comes
   * back. A move generator here would mean the board being looked at and the
   * board being graded could disagree about the rules — and chess.js cannot get
   * here anyway, because there is no build step.
   */
  const js = scriptOf(html);
  for (const forbidden of ['chess.js', 'new Chess', 'isCheckmate', 'isLegal', 'generateMoves']) {
    assert.ok(!js.includes(forbidden), `the page must not contain ${forbidden}`);
  }
  // Legality is asked for, never worked out.
  assert.match(js, /\/api\/legal/);
});

test('every element the script reaches for exists in the markup', () => {
  const js = scriptOf(html);
  const ids = [...js.matchAll(/\$\('#([a-zA-Z]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 4, 'expected the script to address the document');
  for (const id of new Set(ids)) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is used but never rendered`);
  }
});

test('every action the page posts is one the session answers', () => {
  /*
   * The page and the server agree about nothing except these names, and a typo
   * in one is a button that silently does nothing in a browser — there is no
   * build step and no type to catch it. So the two files are read against each
   * other here.
   */
  const js = scriptOf(html);
  const posted = new Set([...js.matchAll(/call\('([a-z]+)'/g)].map((m) => m[1]));
  assert.ok(posted.has('back'), 'a move of yours must be takeable back');
  const server = readFileSync(new URL('../src/play-server.js', import.meta.url), 'utf8');
  for (const action of posted) {
    assert.match(server, new RegExp(`case '${action}':`), `/api/${action} is posted but never routed`);
  }
});

test('the board shares the report page’s palette rather than inventing one', () => {
  // Two pages of the same tool whose boards are different greens reads as a bug.
  assert.ok(html.includes(INK.light['board-light']));
  assert.ok(html.includes(INK.dark['board-dark']));
});

test('the page states that it will not name your move', () => {
  // The one promise the interface makes on screen; it belongs in the markup
  // rather than only in a prompt the server happens to send.
  assert.match(html, /will not name your move|nothing here will name your move/i);
});

test('it renders in both themes without a toggle', () => {
  // Dark is the default, so it is the bare :root that carries it and the media
  // query that names the alternate — the reverse of how this page started. What
  // the test is for is unchanged: both themes are in the file, with no control
  // on screen to switch them.
  assert.match(html, /color-scheme: dark/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.match(html, /data-theme="light"/);
});
