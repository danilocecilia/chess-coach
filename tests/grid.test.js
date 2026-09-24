/**
 * Grid measurement tests.
 *
 * The thing worth testing is recovery: given a board sitting somewhere inside a
 * larger region — which is what a hand-drawn rectangle always produces — do we
 * get its true offset and square size back?
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { unpack, profile, findLines } from '../src/grid.js';

const SIDE = 512;

/**
 * Paint a checkerboard of `pitch` starting at `off`, on a flat surround that
 * stands in for the board's outer frame.
 */
function board({ off, pitch, light = 210, dark = 90, frame = 60 }) {
  const img = new Float64Array(SIDE * SIDE).fill(frame);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const r = Math.floor((y - off) / pitch), c = Math.floor((x - off) / pitch);
      if (r < 0 || r > 7 || c < 0 || c > 7) continue;
      img[y * SIDE + x] = (r + c) % 2 === 0 ? light : dark;
    }
  }
  return img;
}

test('recovers a grid that fills the region exactly', () => {
  const pitch = SIDE / 8;
  const img = board({ off: 0, pitch });
  const got = findLines(profile(img, SIDE, 0), SIDE);
  assert.ok(Math.abs(got.off) <= 1, `offset ${got.off}`);
  assert.ok(Math.abs(got.pitch - pitch) < 1, `pitch ${got.pitch}`);
});

test('recovers a grid inset by a border', () => {
  // ~5px of frame on a 633px board, scaled into this 512-wide view.
  const off = 4, pitch = 62.8;
  const img = board({ off, pitch });
  for (const axis of [0, 1]) {
    const got = findLines(profile(img, SIDE, axis), SIDE);
    assert.ok(Math.abs(got.off - off) <= 1, `axis ${axis} offset ${got.off}, want ${off}`);
    assert.ok(Math.abs(got.pitch - pitch) < 1, `axis ${axis} pitch ${got.pitch}, want ${pitch}`);
  }
});

test('rows and columns agree, which is what makes the result trustworthy', () => {
  const img = board({ off: 7, pitch: 61.5 });
  const cols = findLines(profile(img, SIDE, 0), SIDE);
  const rows = findLines(profile(img, SIDE, 1), SIDE);
  assert.ok(Math.abs(cols.pitch - rows.pitch) < 0.5, 'pitch should match across axes');
  assert.ok(Math.abs(cols.off - rows.off) < 1.5, 'offset should match across axes');
});

test('pieces do not pull the grid off the squares', () => {
  const off = 4, pitch = 62.8;
  const img = board({ off, pitch });
  // Blobs at square centres, as pieces are: strong edges, but not on the lines.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r * 8 + c) % 3) continue;
      const cy = off + (r + 0.5) * pitch, cx = off + (c + 0.5) * pitch;
      for (let y = -12; y <= 12; y++) {
        for (let x = -12; x <= 12; x++) {
          if (x * x + y * y > 144) continue;
          img[Math.round(cy + y) * SIDE + Math.round(cx + x)] = 250;
        }
      }
    }
  }
  const got = findLines(profile(img, SIDE, 0), SIDE);
  assert.ok(Math.abs(got.off - off) <= 1, `offset ${got.off}`);
  assert.ok(Math.abs(got.pitch - pitch) < 1, `pitch ${got.pitch}`);
});

test('unpack inverts the daemon\'s square-major layout', () => {
  const sample = 8, side = sample * 8;
  const frame = new Uint8Array(side * side);
  for (let i = 0; i < frame.length; i++) frame[i] = i % 251;
  const img = unpack(frame, sample);
  // Square 9 is row 1, col 1: its first byte belongs at (sample, sample).
  assert.equal(img[sample * side + sample], frame[9 * sample * sample]);
  assert.equal(img[0], frame[0]);
});
