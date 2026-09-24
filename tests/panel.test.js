/**
 * Move-list segmentation.
 *
 * The properties pinned here are the ones the panel's decoration attacks:
 * alternating row stripes, a highlighted current row, and a move-number column
 * rendered dimmer than the moves. Each of those changes the pixels without
 * changing the text, and each would break a reader that thresholded on
 * brightness instead of on deviation from the local background.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ink, inkFloor, rowBands, inkRuns, tokenize, gapThreshold, cut, cost, cluster, segment,
  rowPitch, columns,
} from '../src/panel.js';

const W = 40, H = 30;

/** A panel with striped row backgrounds and no text at all. */
function striped(shades = [30, 45]) {
  const img = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) img.fill(shades[Math.floor(r / 10) % shades.length], r * W, r * W + W);
  return img;
}

/** Paint a filled box. */
function box(img, x0, y0, w, h, v) {
  for (let r = y0; r < y0 + h; r++) for (let c = x0; c < x0 + w; c++) img[r * W + c] = v;
}

test('striping and row highlights leave no ink', () => {
  // Three different background shades, one per band, as a move list draws its
  // alternating rows and the row you are on. A brightness threshold would have
  // to be picked per band; deviation from the row's own median sees nothing.
  const img = striped([30, 45, 90]);
  assert.ok(ink(img, W, H).every((v) => v === 0), 'a flat row must produce no ink');
});

test('text is found on every stripe, whatever the stripe', () => {
  const img = striped([30, 45, 90]);
  box(img, 4, 3, 3, 4, 200);      // on the dark stripe
  box(img, 4, 13, 3, 4, 200);     // on the mid stripe
  box(img, 4, 23, 3, 4, 200);     // on the bright stripe
  const map = ink(img, W, H);
  const bands = rowBands(map, W, H, inkFloor(map), { minHeight: 3 });
  assert.equal(bands.length, 3);
  assert.deepEqual(bands.map((b) => b.top), [3, 13, 23]);
});

test('ink runs split on empty columns and are tightened onto their own ink', () => {
  const img = striped();
  box(img, 4, 2, 3, 6, 200);      // tall
  box(img, 9, 4, 3, 2, 200);      // short, and lower down
  const map = ink(img, W, H);
  const floor = inkFloor(map);
  const [band] = rowBands(map, W, H, floor, { minHeight: 3 });
  const boxes = inkRuns(map, W, floor, band);

  assert.equal(boxes.length, 2, 'an empty column between them is a character break');
  assert.deepEqual(boxes[0], { x0: 4, x1: 6, y0: 2, y1: 7 });
  // The band spans both, so a box that inherited the band would be 2..7 here.
  // Height is one of the cheapest ways to tell two glyphs apart; keep it.
  assert.deepEqual(boxes[1], { x0: 9, x1: 11, y0: 4, y1: 5 });
});

test('tokens are cut at the gap the panel actually uses', () => {
  const img = striped();
  box(img, 2, 2, 2, 5, 200);
  box(img, 5, 2, 2, 5, 200);      // 1px gap: same token
  box(img, 20, 2, 2, 5, 200);     // 13px gap: new token
  box(img, 23, 2, 2, 5, 200);     // 1px gap: same token
  const map = ink(img, W, H);
  const floor = inkFloor(map);
  const [band] = rowBands(map, W, H, floor, { minHeight: 3 });
  const boxes = inkRuns(map, W, floor, band);

  const gap = gapThreshold([boxes]);
  assert.ok(gap > 1 && gap < 13, `gap threshold ${gap} should sit between the two kinds of gap`);
  const tokens = tokenize(boxes, gap);
  assert.equal(tokens.length, 2);
  assert.deepEqual(tokens.map((t) => t.length), [2, 2]);
});

test('graphics at the right-hand edge do not swallow the column split', () => {
  /*
   * Three scales of gap, as a real panel has them: letters, then the space
   * between the number and move columns, then a wide run of blank out to an
   * evaluation bar at the edge. The largest *absolute* jump is the one out to
   * the bar, and taking it merges the two move columns into a single token —
   * which is what an earlier version of this did on a real panel, reporting a
   * 146px threshold and one token per row.
   */
  const img = striped();
  box(img, 2, 2, 2, 5, 200);
  box(img, 5, 2, 2, 5, 200);      // 1px:  same token
  box(img, 14, 2, 2, 5, 200);     // 7px:  next column
  box(img, 34, 2, 4, 5, 200);     // 18px: the bar, far off to the right
  const map = ink(img, W, H);
  const floor = inkFloor(map);
  const [band] = rowBands(map, W, H, floor, { minHeight: 3 });
  const boxes = inkRuns(map, W, floor, band);

  const gap = gapThreshold([boxes]);
  assert.ok(gap >= 1 && gap < 7, `threshold ${gap} must split letters from columns, not columns from graphics`);
  assert.equal(tokenize(boxes, gap).length, 3, 'number, move, and the bar are three tokens');
});

test('the same shape matches itself however dim it was drawn', () => {
  /*
   * The move-number column is drawn greyer than the moves beside it, so `1` as
   * a move number and `1` as a rank arrive at different strengths. Normalising
   * each glyph by its own peak is what makes those the same character — the
   * text counterpart of fitting a tint out before judging a square.
   */
  const bright = striped(); box(bright, 4, 2, 3, 5, 220);
  const dim = striped(); box(dim, 4, 2, 3, 5, 90);

  const glyph = (img) => {
    const map = ink(img, W, H);
    const floor = inkFloor(map);
    const [band] = rowBands(map, W, H, floor, { minHeight: 3 });
    return cut(map, W, inkRuns(map, W, floor, band)[0]);
  };

  assert.equal(cost(glyph(bright), glyph(dim)), 0);
});

test('two different sizes are refused outright, not scored', () => {
  const a = { w: 3, h: 5, px: new Uint8Array(15).fill(255) };
  const b = { w: 3, h: 6, px: new Uint8Array(18).fill(255) };
  // The font never scales, so a size difference is a different character and
  // there is no number worth producing for the pair.
  assert.equal(cost(a, b), Infinity);
});

test('repeated shapes cluster together and distinct ones do not', () => {
  const img = striped();
  for (const y of [2, 12, 22]) {
    box(img, 4, y, 3, 5, 200);          // the same character, three times
    box(img, 12, y, 5, 5, 200);         // a wider one, three times
  }
  const { map, rows } = segment(img, W, H, { minHeight: 3 });
  const glyphs = [];
  for (const [i, r] of rows.entries()) {
    for (const b of r.boxes) glyphs.push({ row: i, glyph: cut(map, W, b) });
  }

  const { clusters, worstKept } = cluster(glyphs);
  assert.equal(clusters.length, 2, 'two shapes, six renderings');
  assert.deepEqual(clusters.map((c) => c.members.length), [3, 3]);
  assert.equal(worstKept, 0, 'identical renderings must cost nothing to join');
});

test('a trailing result line does not condemn the rows above it', () => {
  /*
   * Twenty rows on an exact pitch and one line sitting further down, which is
   * what a move list looks like with `1-0` printed under the last move. Judged
   * by the mean and its worst deviation, the real panel this came from failed
   * — 30.3px pitch, worst deviation 6.7, against a tolerance of 6.1 — while
   * every row it had cut was perfect.
   */
  const rows = [];
  for (let i = 0; i < 21; i++) rows.push({ band: { top: 15 + i * 30, bottom: 38 + i * 30 } });
  rows.push({ band: { top: 652, bottom: 660 } });           // the result line, 37px down

  const { pitch, onPitch, steps } = rowPitch(rows);
  assert.equal(pitch, 30);
  assert.equal(steps, 21);
  assert.equal(onPitch, 20, 'only the step onto the result line may disagree');
});

test('a column is measured from its own edge, so graphics cannot chain into one', () => {
  /*
   * Two real text columns, and eight tokens spread across 25px at the right —
   * evaluation bars, which start wherever their length puts them. Every bar is
   * within the tolerance of the bar before it, so an anchor that slid along
   * would swallow all eight into one column and report it as text present in
   * every row. That is what a real panel did.
   */
  const at = (xs) => ({ tokens: xs.map((x) => [{ x0: x }]) });
  const rows = [
    at([34, 182, 284]), at([34, 182, 288]), at([34, 182, 291]), at([34, 182, 294]),
    at([34, 182, 297]), at([34, 182, 300]), at([34, 182, 303]), at([34, 182, 306]),
  ];

  const cols = columns(rows);
  const solid = cols.filter((c) => c.n >= rows.length * 0.5);
  assert.deepEqual(solid.map((c) => c.x), [34, 182], 'only the two text columns are solid');
  assert.ok(cols.length >= 5, `the bars must stay scattered, got ${cols.length} columns total`);
});

test('segment survives a panel with nothing in it', () => {
  const { rows } = segment(striped(), W, H);
  assert.deepEqual(rows, []);
});
