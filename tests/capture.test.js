/**
 * The repack, pinned to the loop it replaced.
 *
 * `repack` used to be a PowerShell loop inside ps/capture.ps1, and it was moved
 * into Node for speed. That kind of move is only safe if the output is
 * byte-identical, because templates/model.json was calibrated against frames the
 * old loop produced and recorded sessions are replayed through those same
 * templates — so a frame that drifts by one luma level here biases every match
 * made against it, silently, in both directions in time.
 *
 * The trap is the rounding. PowerShell's [byte] cast goes through
 * Convert.ToByte, which rounds half to *even*; assigning a float into a
 * Uint8Array truncates. They agree everywhere except on exact .5, which is
 * common enough in Rec. 601 luma to matter — verified against this machine's
 * PowerShell: [byte]127.5 is 128, [byte]1.5 is 2, [byte]0.5 is 0, [byte]2.5 is 2.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { repack, SAMPLE, SQ_BYTES } from '../src/capture.js';

/** A BGRA buffer of one flat colour, laid out as the daemon sends it. */
function flat(r, g, b, sample = SAMPLE) {
  const stride = sample * 8 * 4;
  const raw = Buffer.alloc(stride * sample * 8);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = b; raw[i + 1] = g; raw[i + 2] = r; raw[i + 3] = 255;
  }
  return { raw, stride };
}

test('luma lands on .5 the way .NET rounded it, not the way JavaScript would', () => {
  /*
   * Each of these is a real BGRA triple whose Rec. 601 luma is exactly n.5, and
   * where half-to-even and truncation give different answers. Truncating would
   * pass every other test in this file and still be wrong by one level on a
   * fraction of pixels — which is precisely the kind of error that shows up as
   * unexplained drift in a match score months later.
   */
  const cases = [
    { r: 0, g: 4, b: 168, luma: 21.5, dotNet: 22, truncated: 21 },
    { r: 0, g: 12, b: 4, luma: 7.5, dotNet: 8, truncated: 7 },
    { r: 0, g: 18, b: 131, luma: 25.5, dotNet: 26, truncated: 25 },
  ];
  for (const c of cases) {
    const { raw, stride } = flat(c.r, c.g, c.b);
    const out = repack(raw, stride);
    assert.equal((c.r * 299 + c.g * 587 + c.b * 114) / 1000, c.luma, 'case is not on .5');
    assert.notEqual(c.dotNet, c.truncated, 'case does not discriminate');
    assert.equal(out[0], c.dotNet,
      `rgb(${c.r},${c.g},${c.b}) is ${c.luma}: .NET gave ${c.dotNet}, truncation gives ${c.truncated}`);
  }
});

test('half to even rounds both ways, not always up', () => {
  // The other half of the rule, and the one a naive "round" gets wrong: an
  // exact .5 over an even quotient stays put. [byte]28.5 is 28 in PowerShell.
  const { raw, stride } = flat(0, 0, 250);              // luma exactly 28.5
  assert.equal(repack(raw, stride)[0], 28);
});

test('an ordinary colour is the plain weighted sum', () => {
  const { raw, stride } = flat(200, 100, 50);
  const expected = Math.round((200 * 299 + 100 * 587 + 50 * 114) / 1000);
  assert.equal(repack(raw, stride)[0], expected);
});

test('the output is square-major: 64 tiles, a8 first, h1 last', () => {
  /*
   * The layout every other module assumes — board.js slices tiles out of it by
   * index, and the session log writes it to disk verbatim for replay. Painting
   * each square its own shade proves the mapping rather than just the size:
   * screen square 0 is the top-left, and its whole tile must come back first.
   */
  const sample = SAMPLE, stride = sample * 8 * 4;
  const raw = Buffer.alloc(stride * sample * 8);
  for (let sq = 0; sq < 64; sq++) {
    const top = Math.floor(sq / 8) * sample, left = (sq % 8) * sample;
    for (let r = 0; r < sample; r++) {
      for (let c = 0; c < sample; c++) {
        const p = (top + r) * stride + (left + c) * 4;
        raw[p] = sq; raw[p + 1] = sq; raw[p + 2] = sq; raw[p + 3] = 255;   // grey = index
      }
    }
  }

  const out = repack(raw, stride);
  assert.equal(out.length, 64 * SQ_BYTES);
  for (let sq = 0; sq < 64; sq++) {
    const tile = out.subarray(sq * SQ_BYTES, (sq + 1) * SQ_BYTES);
    assert.ok(tile.every((v) => v === sq),
      `square ${sq} should be uniformly ${sq}, got ${tile[0]}..${tile[SQ_BYTES - 1]}`);
  }
});

test('stride is honoured, so a padded row does not shear the board', () => {
  // GDI+ pads rows to a 4-byte boundary; a repack that assumed width*4 would
  // walk diagonally across the board and still produce a plausible-looking frame.
  const sample = 2, width = sample * 8, stride = width * 4 + 12;   // 12 bytes of padding
  const raw = Buffer.alloc(stride * sample * 8, 0);
  for (let row = 0; row < sample * 8; row++) {
    for (let col = 0; col < width; col++) {
      const p = row * stride + col * 4;
      raw[p] = 10; raw[p + 1] = 10; raw[p + 2] = 10; raw[p + 3] = 255;
    }
    // Padding left as zeroes: if it were read as pixels, some tile would be 0.
  }
  const out = repack(raw, stride, sample);
  assert.ok(out.every((v) => v === 10), 'row padding must not be read as image data');
});
