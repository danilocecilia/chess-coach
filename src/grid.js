/**
 * Finding the 8x8 grid inside a roughly-dragged region.
 *
 * Everything downstream slices a square as region/8, so a region that includes
 * the board's outer frame does not merely add a margin — it shifts every tile,
 * and the drift compounds across the board until each tile straddles two
 * squares. Dragging to the exact pixel is not something a person should be
 * asked to do, so the region is only a hint and the grid is measured.
 *
 * The measurement uses the one thing a chess board always has regardless of
 * position, theme or piece set: nine equally spaced lines in each axis. Pieces
 * contribute edges too, but they cannot fake nine evenly spaced ones spanning
 * the whole region, so the fit is unambiguous in practice.
 */

import { Capture } from './capture.js';

/** Sampling for the measurement grab: 64 -> a 512x512 view of the region. */
export const FINE = 64;

/** Plausible square pitch, as a fraction of "the region is exactly the grid". */
const PITCH_MIN = 0.88, PITCH_MAX = 1.02;

/** capture.ps1 emits square-major tiles; rebuild the plain image. */
export function unpack(frame, sample = FINE) {
  const side = sample * 8;
  const img = new Float64Array(side * side);
  for (let sq = 0; sq < 64; sq++) {
    const sr = Math.floor(sq / 8) * sample, sc = (sq % 8) * sample;
    for (let r = 0; r < sample; r++) {
      for (let c = 0; c < sample; c++) {
        img[(sr + r) * side + (sc + c)] = frame[sq * sample * sample + r * sample + c];
      }
    }
  }
  return img;
}

/** Edge energy per column (axis 0) or per row (axis 1). */
export function profile(img, side, axis) {
  const p = new Float64Array(side);
  for (let i = 1; i < side; i++) {
    let sum = 0;
    for (let j = 0; j < side; j++) {
      const a = axis === 0 ? img[j * side + i] : img[i * side + j];
      const b = axis === 0 ? img[j * side + i - 1] : img[(i - 1) * side + j];
      sum += Math.abs(a - b);
    }
    p[i] = sum;
  }
  return p;
}

/**
 * Best (offset, pitch) for nine equally spaced lines in an edge profile.
 * Searched directly rather than by autocorrelation: the space is small enough
 * that an exhaustive scan is both faster to run and impossible to get subtly
 * wrong.
 */
export function findLines(p, side) {
  // A line that lands between two pixels splits its energy across both, so read
  // the profile by interpolation. An earlier version took the strongest edge
  // within one pixel instead, which scored a two-pixel-wide band of candidate
  // fits identically and let the winner be decided by scan order.
  const at = (x) => {
    if (x < 1 || x >= side - 1) return 0;
    const i = Math.floor(x), f = x - i;
    return p[i] * (1 - f) + p[i + 1] * f;
  };
  const ideal = side / 8;
  let best = { score: -1, off: 0, pitch: ideal };
  for (let pitch = ideal * PITCH_MIN; pitch <= ideal * PITCH_MAX; pitch += 0.05) {
    for (let off = 0; off <= side - pitch * 8; off += 0.25) {
      // Only the seven interior lines are scored. The board's own outer edges
      // may sit exactly on the image boundary — where there is no neighbouring
      // pixel to make an edge — so counting them would quietly punish the one
      // case we most want to get right: a drag that was already perfect.
      // Constraining the board to fit inside the region is what stops the fit
      // sliding a whole square sideways onto lines 2..8.
      let score = 0;
      for (let k = 1; k <= 7; k++) score += at(off + k * pitch);
      if (score > best.score) best = { score, off, pitch };
    }
  }
  return best;
}

/**
 * Measure the grid inside `region` (screen coordinates).
 * @returns {{region: object, trim: object, square: boolean}}
 */
export async function measureGrid(region) {
  const side = FINE * 8;
  const cap = await new Capture({ ...region, sample: FINE }).start();
  let img;
  try {
    img = unpack(await cap.grab(), FINE);
  } finally {
    await cap.quit();
  }

  const cols = findLines(profile(img, side, 0), side);
  const rows = findLines(profile(img, side, 1), side);

  const sx = region.w / side, sy = region.h / side;
  const x = Math.round(region.x + cols.off * sx);
  const y = Math.round(region.y + rows.off * sy);
  const w = Math.round(cols.pitch * 8 * sx);
  const h = Math.round(rows.pitch * 8 * sy);

  return {
    region: { x, y, w, h },
    trim: {
      left: x - region.x, top: y - region.y,
      right: region.x + region.w - x - w, bottom: region.y + region.h - y - h,
    },
    // Rows and columns are measured independently, so agreeing on the square
    // size is a real check that a grid was found and not just a strong edge.
    square: Math.abs(w - h) <= Math.max(2, w * 0.01),
  };
}
