/**
 * Board-search tests against a synthetic desktop.
 *
 * The search runs on a plain image, so everything here is tested without a
 * screen, a monitor list or PowerShell. What is worth testing is not "can it
 * find a checkerboard" — profile/findLines already could — but the two ways an
 * unprompted search goes wrong: mistaking other desktop furniture for a board,
 * and finding the right board at slightly the wrong place. The second one is
 * not cosmetic. A rectangle that cuts inside the board cannot be recovered
 * downstream, because grid.js trims onto the grid and never grows, so the
 * offset assertions here are deliberately one-sided about it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { searchImage, integral, rectMean } from '../src/find-board.js';

/** A 1920x1080 monitor at the search's own scale of 4. */
const W = 480, H = 270;

/** Deterministic noise: a flaky detector test is worse than none. */
function rng(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function desktop(fill = 40) {
  return new Float64Array(W * H).fill(fill);
}

function box(img, x, y, w, h, value) {
  for (let r = y; r < y + h; r++) {
    if (r < 0 || r >= H) continue;
    for (let c = x; c < x + w; c++) {
      if (c < 0 || c >= W) continue;
      img[r * W + c] = value;
    }
  }
}

/** Paint an 8x8 board. `pitch` may be fractional, as a real one always is. */
function board(img, { x, y, pitch, light = 205, dark = 95 }) {
  const side = pitch * 8;
  for (let r = 0; r < Math.ceil(side); r++) {
    for (let c = 0; c < Math.ceil(side); c++) {
      const cr = Math.floor(r / pitch), cc = Math.floor(c / pitch);
      if (cr > 7 || cc > 7) continue;
      const py = Math.round(y + r), px = Math.round(x + c);
      if (py < 0 || py >= H || px < 0 || px >= W) continue;
      img[py * W + px] = (cr + cc) % 2 === 0 ? light : dark;
    }
  }
}

/** Pieces, as blobs on the outer two ranks at each end — where a starting
 *  position keeps them, and where the search does not look. */
function pieces(img, { x, y, pitch }) {
  for (const r of [0, 1, 6, 7]) {
    for (let c = 0; c < 8; c++) {
      const cy = y + (r + 0.5) * pitch, cx = x + (c + 0.5) * pitch;
      const rad = pitch * 0.35;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          const py = Math.round(cy + dy), px = Math.round(cx + dx);
          if (py < 0 || py >= H || px < 0 || px >= W) continue;
          img[py * W + px] = (r < 2) ? 20 : 240;
        }
      }
    }
  }
}

/** Evenly spaced lines, uniform cells: a spreadsheet, a calendar, a table. The
 *  thing an edge-profile fit cannot tell from a board. */
function table(img, { x, y, w, h, pitch, bg = 250, line = 170 }) {
  box(img, x, y, w, h, bg);
  for (let i = 0; i * pitch <= h; i++) box(img, x, Math.round(y + i * pitch), w, 1, line);
  for (let i = 0; i * pitch <= w; i++) box(img, Math.round(x + i * pitch), y, 1, h, line);
}

/** Alternating rows — a striped list view. Alternates, but in one axis only. */
function stripes(img, { x, y, w, h, pitch, a = 250, b = 215 }) {
  for (let i = 0; i * pitch < h; i++) {
    box(img, x, Math.round(y + i * pitch), w, Math.round(pitch), i % 2 ? a : b);
  }
}

function speckle(img, amount = 6, seed = 1) {
  const r = rng(seed);
  for (let i = 0; i < img.length; i++) img[i] += (r() * 2 - 1) * amount;
}

test('summed-area table gives exact rectangle means', () => {
  const img = new Float64Array(4 * 3);
  for (let i = 0; i < img.length; i++) img[i] = i;
  const sat = integral(img, 4, 3);
  assert.equal(rectMean(sat, 4, 0, 0, 4, 3), 5.5);            // mean of 0..11
  assert.equal(rectMean(sat, 4, 1, 1, 3, 2), 5.5);            // {5,6}
  assert.equal(rectMean(sat, 4, 3, 2, 4, 3), 11);             // single pixel
});

test('finds a board on a cluttered desktop', () => {
  const img = desktop();
  box(img, 0, 0, W, 24, 70);                 // a task bar
  table(img, { x: 300, y: 60, w: 170, h: 190, pitch: 19 });
  stripes(img, { x: 20, y: 200, w: 240, h: 60, pitch: 9 });
  const truth = { x: 61, y: 43, pitch: 18.5 };
  board(img, truth);
  pieces(img, truth);
  speckle(img);

  const [best, ...rest] = searchImage(img, W, H);
  assert.ok(best, 'should find something');
  assert.ok(Math.abs(best.pitch - truth.pitch) <= 0.5, `pitch ${best.pitch}`);
  // One-sided on purpose: landing left of / above the true edge is harmless
  // (trimming fixes it), landing inside it is fatal.
  assert.ok(best.x <= truth.x + 1, `x ${best.x} must not start inside the board`);
  assert.ok(best.y <= truth.y + 1, `y ${best.y} must not start inside the board`);
  assert.ok(best.x >= truth.x - 3 && best.y >= truth.y - 3, 'but should still be close');
  assert.ok(!rest.some((c) => c.score > best.score), 'sorted best first');
});

test('a table of equal pitch is not a board', () => {
  // The discriminator, alone on the screen so nothing else can win: evenly
  // spaced lines in both axes, but cells that do not alternate.
  const img = desktop();
  table(img, { x: 100, y: 40, w: 200, h: 200, pitch: 20 });
  speckle(img);
  assert.equal(searchImage(img, W, H).length, 0);
});

test('a striped list view is not a board', () => {
  const img = desktop();
  stripes(img, { x: 60, y: 30, w: 300, h: 220, pitch: 18 });
  speckle(img);
  assert.equal(searchImage(img, W, H).length, 0);
});

test('an empty desktop finds nothing', () => {
  const img = desktop(120);
  box(img, 0, 246, W, 24, 70);
  speckle(img, 10);
  assert.equal(searchImage(img, W, H).length, 0);
});

test('the board wins against furniture that is bigger and brighter', () => {
  const img = desktop();
  table(img, { x: 200, y: 20, w: 260, h: 240, pitch: 30, bg: 255, line: 120 });
  stripes(img, { x: 0, y: 0, w: 190, h: 120, pitch: 15 });
  const truth = { x: 24, y: 140, pitch: 14.25 };
  board(img, truth);
  pieces(img, truth);
  speckle(img);

  const best = searchImage(img, W, H)[0];
  assert.ok(best, 'should find the board');
  assert.ok(Math.abs(best.pitch - truth.pitch) <= 0.5, `pitch ${best.pitch}`);
  assert.ok(best.x <= truth.x + 1 && best.y <= truth.y + 1, 'must not start inside');
});

test('finds a board flush against the top-left corner', () => {
  // Nothing to the left or above to pad into, and no outer edge to find there:
  // the fit has to come from the interior lines alone.
  const img = desktop();
  const truth = { x: 0, y: 0, pitch: 22 };
  board(img, truth);
  pieces(img, truth);
  speckle(img);

  const best = searchImage(img, W, H)[0];
  assert.ok(best, 'should find the board');
  assert.equal(best.x, 0);
  assert.equal(best.y, 0);
  assert.ok(Math.abs(best.pitch - truth.pitch) <= 0.5, `pitch ${best.pitch}`);
});

test('finds a dark-themed board, where the shades are inverted', () => {
  // Parity is unknown, so both assignments are scored; a board whose a1 is
  // light must work as well as one whose a1 is dark.
  const img = desktop(200);
  const truth = { x: 120, y: 60, pitch: 20, light: 110, dark: 45 };
  board(img, truth);
  pieces(img, truth);
  speckle(img);

  const best = searchImage(img, W, H)[0];
  assert.ok(best, 'should find the board');
  assert.ok(best.x <= truth.x + 1 && best.y <= truth.y + 1, 'must not start inside');
  assert.ok(Math.abs(best.pitch - truth.pitch) <= 0.5, `pitch ${best.pitch}`);
});

test('does not slide the fit by a whole cell', () => {
  /*
   * The failure this guards against scores *perfectly* on alternation: shift
   * the grid one cell right and the sampled cells are still bare squares, with
   * the two shades merely swapped — which is a parity the search accepts. Only
   * the board's outer edge says where it stops, so a plain background with
   * pieces that keep alternating is the case that pins it.
   */
  const img = desktop(30);
  const truth = { x: 100, y: 50, pitch: 20 };
  board(img, truth);
  pieces(img, truth);
  speckle(img);

  const best = searchImage(img, W, H)[0];
  assert.ok(best, 'should find the board');
  assert.equal(best.x, truth.x);
  assert.equal(best.y, truth.y);
  assert.ok(Math.abs(best.pitch - truth.pitch) <= 0.25, `pitch ${best.pitch}`);
});

test('two boards on screen are both reported, not silently merged', () => {
  const img = desktop();
  const a = { x: 20, y: 30, pitch: 16 };
  const b = { x: 300, y: 120, pitch: 14 };
  board(img, a); pieces(img, a);
  board(img, b); pieces(img, b);
  speckle(img);

  const hits = searchImage(img, W, H);
  assert.ok(hits.length >= 2, `expected two boards, got ${hits.length}`);
  const near = (c, t) => Math.abs(c.x - t.x) <= 3 && Math.abs(c.y - t.y) <= 3;
  assert.ok(hits.some((c) => near(c, a)), 'first board reported');
  assert.ok(hits.some((c) => near(c, b)), 'second board reported');
});

test('low-contrast squares still separate, faint squares do not', () => {
  // The bar is calibrate.js's own: under ~10 grey levels between the shades it
  // is not treated as a board, because calibration would reject it anyway.
  const faint = desktop(128);
  board(faint, { x: 100, y: 50, pitch: 20, light: 131, dark: 126 });
  assert.equal(searchImage(faint, W, H).length, 0, 'a 5-level board is not accepted');

  const ok = desktop(128);
  const truth = { x: 100, y: 50, pitch: 20, light: 146, dark: 110 };
  board(ok, truth);
  const best = searchImage(ok, W, H)[0];
  assert.ok(best, 'a 36-level board is');
  assert.ok(best.x <= truth.x + 1 && best.y <= truth.y + 1, 'must not start inside');
});
