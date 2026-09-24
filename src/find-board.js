/**
 * Finding the board on the screen, with no drag and no model.
 *
 * The drag was never the point — it is a hint, and grid.js already re-measures
 * the grid inside it. So the hint can come from a search instead of a hand,
 * provided the search is a measurement rather than a guess.
 *
 * What it keys on is the one thing a chess board has that the rest of a desktop
 * does not: 8x8 cells of equal pitch whose shades *alternate*. Periodicity
 * alone is not enough — a spreadsheet, a calendar, a file listing and a window
 * border all have evenly spaced lines, which is why the edge-profile fit in
 * grid.js is only trustworthy once you already know you are looking at a board.
 * Alternation is far rarer, and it is checked the strict way: every cell of one
 * colour must be brighter than every cell of the other. A near-miss fails, so
 * the answer is not a ranking of bad options.
 *
 * Calibration holds the board in the starting position, which the search then
 * gets for free: the middle four ranks are empty, so their cells show bare
 * squares and nothing else. Those 24 cells are the whole signal (the outer two
 * files are skipped because some themes print rank numbers inside them).
 *
 * The search is deliberately coarse. It only has to hand measureGrid a
 * rectangle that *contains* the board, because trimming can shrink onto the
 * grid but never grow — which is also why the result is padded outwards before
 * it is returned.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

/**
 * Screen pixels per scan pixel. 4 turns a 1920x1080 monitor into 480x270, in
 * which a 600px board is 150px across — plenty for a pitch, and small enough
 * that the whole candidate space is a fraction of a second. Precision is not
 * wanted here: measureGrid re-measures from the screen at full resolution.
 */
export const SCALE = 4;

/** Smallest board worth looking for, in screen pixels. */
export const MIN_SIDE = 160;

/**
 * Fraction of a cell trimmed off each side before its mean is taken.
 *
 * Kept small, which is the opposite of the obvious choice. A generous inset
 * samples only the middle of each cell, so shifting the whole grid by a few
 * pixels changes nothing and every offset in that range scores identically —
 * a plateau, whose winner is decided by scan order and can therefore sit
 * *inside* the true board. That is the one error this search must not make,
 * because trimming can shrink a rectangle onto the grid but never grow it.
 * A narrow inset lets a misaligned fit pull in the neighbouring cell, which
 * costs it separation immediately, so the maximum is sharp and centred.
 */
const INSET = 0.1;

/**
 * Least separation worth reporting, in grey levels.
 *
 * The same bar calibrate.js uses to decide a region is not a chess board at
 * all (`contrast < 10`), so the search does not hand on anything calibration
 * is about to reject. Without it, a grid of *uniform* cells scores a hair
 * above zero on rounding alone and would be reported as a candidate.
 */
const MIN_SEPARATION = 8;

/** Ranks empty in the starting position, as row indices from the top. */
const RANKS = [2, 3, 4, 5];

/** Files sampled. The outer two are skipped: several themes print coordinates
 *  inside the board's edge, which would land on a cell and break alternation. */
const FILES = [1, 2, 3, 4, 5, 6];

/** Summed-area table, so a cell mean is four lookups regardless of its size. */
export function integral(img, w, h) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += img[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + run;
    }
  }
  return sat;
}

/** Mean of [x0,x1) x [y0,y1) from a summed-area table. */
export function rectMean(sat, w, x0, y0, x1, y1) {
  const s = w + 1;
  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return 0;
  return (sat[y1 * s + x1] - sat[y0 * s + x1] - sat[y1 * s + x0] + sat[y0 * s + x0]) / area;
}

/**
 * How well an 8x8 grid at (x0, y0) with this pitch behaves like a board.
 *
 * Returned as the separation between the two shades: the darkest cell of the
 * light colour minus the brightest cell of the dark colour. Positive means
 * every sampled cell fell on the correct side, and the value is how much room
 * there was to spare. Which parity is light is unknown, so both are tried.
 *
 * A minimum-against-maximum test rather than a difference of means, because a
 * mean can be dragged into looking board-like by a few strong cells while half
 * the grid disagrees — and that is exactly what a window full of alternating
 * table rows does.
 */
export function cellSeparation(sat, w, h, x0, y0, pitch) {
  let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
  for (const r of RANKS) {
    const cy0 = Math.round(y0 + (r + INSET) * pitch);
    const cy1 = Math.max(cy0 + 1, Math.round(y0 + (r + 1 - INSET) * pitch));
    if (cy0 < 0 || cy1 > h) return -Infinity;
    for (const c of FILES) {
      const cx0 = Math.round(x0 + (c + INSET) * pitch);
      const cx1 = Math.max(cx0 + 1, Math.round(x0 + (c + 1 - INSET) * pitch));
      if (cx0 < 0 || cx1 > w) return -Infinity;
      const m = rectMean(sat, w, cx0, cy0, cx1, cy1);
      if ((r + c) % 2 === 0) {
        if (m < aMin) aMin = m;
        if (m > aMax) aMax = m;
      } else {
        if (m < bMin) bMin = m;
        if (m > bMax) bMax = m;
      }
    }
  }
  return Math.max(aMin - bMax, bMin - aMax);
}

/** Edge energy in each axis, as summed-area tables, so the strength of a line
 *  spanning a board is four lookups. */
export function edgeTables(img, w, h) {
  const gx = new Float64Array(w * h), gy = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) gx[y * w + x] = Math.abs(img[y * w + x] - img[y * w + x - 1]);
  }
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) gy[y * w + x] = Math.abs(img[y * w + x] - img[(y - 1) * w + x]);
  }
  return { x: integral(gx, w, h), y: integral(gy, w, h) };
}

/**
 * Weakest of the nine lines the candidate claims, in each axis.
 *
 * Alternation says "this is a checkerboard"; it cannot say where one *ends*,
 * because a checkerboard is periodic and a fit slid by a whole cell alternates
 * just as well — it simply swaps the two shades, which is a parity this search
 * already accepts. Sampling only the interior cells cannot see that slide, and
 * the consequence is not a cosmetic offset: the rectangle lands a cell inside
 * the board on one side, which trimming can never undo.
 *
 * So the extent is measured separately, and the telling number is the *weakest*
 * line rather than the total: every line of a correctly placed grid is a real
 * board line, while a slid grid puts its last line out in blank desktop, where
 * there is nothing to find. A sum would hide that behind seven strong ones.
 *
 * Lines falling on the image boundary are skipped, for the reason grid.js skips
 * them: a board flush against the edge of the screen has no neighbouring pixel
 * out there to make an edge, and counting it would punish the fit for being
 * right.
 */
export function lineStrength(edges, w, h, x0, y0, pitch) {
  const span = pitch * 8;
  let worst = Infinity;

  // Vertical lines: mean |dx| down the board's height, at each of the nine
  // column positions. Taken as the best of a one-pixel window either side,
  // since rounding and the downsample's own blur can put the edge next door.
  const ya = Math.max(0, Math.round(y0)), yb = Math.min(h, Math.round(y0 + span));
  for (let k = 0; k <= 8; k++) {
    const lx = Math.round(x0 + k * pitch);
    if (lx <= 0 || lx >= w - 1) continue;
    let best = 0;
    for (const x of [lx - 1, lx, lx + 1]) {
      if (x <= 0 || x >= w) continue;
      best = Math.max(best, rectMean(edges.x, w, x, ya, x + 1, yb));
    }
    if (best < worst) worst = best;
  }

  const xa = Math.max(0, Math.round(x0)), xb = Math.min(w, Math.round(x0 + span));
  for (let k = 0; k <= 8; k++) {
    const ly = Math.round(y0 + k * pitch);
    if (ly <= 0 || ly >= h - 1) continue;
    let best = 0;
    for (const y of [ly - 1, ly, ly + 1]) {
      if (y <= 0 || y >= h) continue;
      best = Math.max(best, rectMean(edges.y, w, xa, y, xb, y + 1));
    }
    if (best < worst) worst = best;
  }

  return worst === Infinity ? 0 : worst;
}

/** Two candidates describe the same board if their origins are within half a
 *  board of each other — enough to collapse the cluster of near-fits around a
 *  real board without merging two boards side by side. */
function sameBoard(a, b) {
  const near = 4 * Math.max(a.pitch, b.pitch);
  return Math.abs(a.x - b.x) < near && Math.abs(a.y - b.y) < near;
}

/**
 * Insert into a best-first list, keeping one entry per board.
 *
 * Ranked on `edge`, not on separation. The two numbers answer different
 * questions and both are needed: separation is the gate — it decides whether
 * this is a chess board at all — and every candidate that gets this far has
 * already passed it. What is left to choose between is *alignments*, where the
 * only thing that discriminates is whether the claimed lines are really there.
 */
function offer(list, cand, keep) {
  for (let i = 0; i < list.length; i++) {
    if (!sameBoard(list[i], cand)) continue;
    if (cand.edge > list[i].edge) list[i] = cand;
    return;
  }
  list.push(cand);
  list.sort((p, q) => q.edge - p.edge);
  if (list.length > keep) list.length = keep;
}

/**
 * Search a plain row-major image for boards.
 *
 * Coarse pass on a stride, then each surviving candidate is refined at full
 * scan resolution. Separating the two keeps the cost down without giving up
 * the last pixel, which matters because the padding added later is sized
 * against the refined error, not the coarse one.
 *
 * @returns {Array<{x:number,y:number,pitch:number,score:number,edge:number}>}
 *   in scan pixels, best first. `score` is the shade separation that let the
 *   candidate through; `edge` is its weakest line, which is what they are
 *   ranked on.
 */
export function searchImage(img, w, h, {
  minPitch = 8, stride = 2, keep = 8, minSeparation = MIN_SEPARATION,
} = {}) {
  const sat = integral(img, w, h);
  const edges = edgeTables(img, w, h);
  const maxPitch = Math.min(w, h) / 8;
  const found = [];

  // Separation first, everywhere; line strength only for what survives it.
  // The gate is four lookups per candidate and rejects almost the whole
  // screen, which is what keeps an exhaustive search affordable.
  for (let pitch = minPitch; pitch <= maxPitch; pitch += 1) {
    const span = Math.ceil(pitch * 8);
    for (let y0 = 0; y0 + span <= h; y0 += stride) {
      for (let x0 = 0; x0 + span <= w; x0 += stride) {
        const score = cellSeparation(sat, w, h, x0, y0, pitch);
        if (score <= minSeparation) continue;
        const edge = lineStrength(edges, w, h, x0, y0, pitch);
        offer(found, { x: x0, y: y0, pitch, score, edge }, keep);
      }
    }
  }

  // Refine: the coarse winner is within `stride` of the truth in each axis and
  // within a pixel of the true pitch. Sub-pixel on the pitch because an error
  // there is multiplied by eight across the board — and the refinement searches
  // a cell either side, since the coarse pass may have landed on a slide.
  const out = [];
  for (const c of found) {
    let best = null;
    const reach = Math.ceil(c.pitch) + stride;
    for (let pitch = c.pitch - 1; pitch <= c.pitch + 1; pitch += 0.25) {
      if (pitch < minPitch || pitch > maxPitch) continue;
      const span = Math.ceil(pitch * 8);
      for (let y0 = Math.max(0, c.y - reach); y0 <= c.y + reach && y0 + span <= h; y0++) {
        for (let x0 = Math.max(0, c.x - reach); x0 <= c.x + reach && x0 + span <= w; x0++) {
          const score = cellSeparation(sat, w, h, x0, y0, pitch);
          if (score <= minSeparation) continue;
          const edge = lineStrength(edges, w, h, x0, y0, pitch);
          if (!best || edge > best.edge) best = { x: x0, y: y0, pitch, score, edge };
        }
      }
    }
    if (best) out.push(best);
  }
  out.sort((p, q) => q.edge - p.edge);
  return out;
}

/** Monitor list, in the coordinate space capture.ps1 grabs from. */
export function listScreens() {
  return new Promise((resolve, reject) => {
    const script = path.join(ROOT, 'ps', 'screens.ps1');
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => {
      const rows = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{'));
      if (!rows.length) return reject(new Error('could not enumerate monitors'));
      resolve(rows.map((r) => JSON.parse(r)));
    });
  });
}

/** One grab of an arbitrary rectangle, downsampled, as a plain image. */
export function scan({ x, y, w, h, outW, outH }) {
  return new Promise((resolve, reject) => {
    const script = path.join(ROOT, 'ps', 'scan.ps1');
    const p = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-X', x, '-Y', y, '-W', w, '-H', h, '-OutW', outW, '-OutH', outH,
    ].map(String));
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => {
      const line = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
      if (!line) return reject(new Error('screen scan produced no result'));
      const o = JSON.parse(line);
      if (!o.ok) return reject(new Error(o.error));
      const bytes = Buffer.from(o.data, 'base64');
      const img = new Float64Array(o.w * o.h);
      for (let i = 0; i < img.length; i++) img[i] = bytes[i];
      resolve({ img, w: o.w, h: o.h });
    });
  });
}

/**
 * Scan every monitor and return the boards found, in screen coordinates.
 *
 * Each rectangle is padded outwards by more than the search's own error. The
 * asymmetry is deliberate and is the whole reason this can work at all:
 * measureGrid trims a too-large rectangle onto the grid exactly, and cannot
 * recover a too-small one. Padding is clamped to the monitor so a board sitting
 * flush against an edge does not pull in a strip of blank desktop beyond it.
 *
 * @returns {{screens: Array, candidates: Array}}
 */
export async function findBoards({ scale = SCALE, minSide = MIN_SIDE } = {}) {
  const screens = await listScreens();
  const candidates = [];

  for (const s of screens) {
    const outW = Math.max(64, Math.round(s.w / scale));
    const outH = Math.max(64, Math.round(s.h / scale));
    // The scan's own scale, which is what converts back to screen pixels. Taken
    // from the rounded output size rather than `scale` itself, so the two axes
    // stay honest even when a monitor does not divide evenly.
    const sx = s.w / outW, sy = s.h / outH;

    const { img, w, h } = await scan({ x: s.x, y: s.y, w: s.w, h: s.h, outW, outH });
    const hits = searchImage(img, w, h, { minPitch: minSide / 8 / Math.max(sx, sy) });

    for (const c of hits) {
      const side = c.pitch * 8;
      /*
       * One scan pixel of search error, plus one of downsample blur.
       *
       * Padding is bounded on both sides, which is why it is a couple of pixels
       * and not a generous margin. Too little and the rectangle can cut into
       * the board, which trimming cannot undo. Too much and the true grid is a
       * small enough fraction of the rectangle to fall outside the pitch window
       * findLines searches (0.88..1.02 of region/8): at this scale, 2px holds
       * that ratio above 0.97 for any board we accept.
       */
      const pad = Math.ceil(2 * Math.max(sx, sy));
      let x = Math.round(s.x + c.x * sx) - pad;
      let y = Math.round(s.y + c.y * sy) - pad;
      let wpx = Math.round(side * sx) + 2 * pad;
      let hpx = Math.round(side * sy) + 2 * pad;
      if (x < s.x) { wpx -= s.x - x; x = s.x; }
      if (y < s.y) { hpx -= s.y - y; y = s.y; }
      wpx = Math.min(wpx, s.x + s.w - x);
      hpx = Math.min(hpx, s.y + s.h - y);
      candidates.push({ x, y, w: wpx, h: hpx, score: c.score, screen: s });
    }
  }

  candidates.sort((p, q) => q.score - p.score);
  return { screens, candidates };
}
