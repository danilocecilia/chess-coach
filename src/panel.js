/**
 * Reading the move list, rather than the board.
 *
 * The board is a rendering that has to be inverted; the move list is the site's
 * own record of what was played. Every hard case in board.js comes from the
 * inversion and none of them exist here — a piece held under the cursor, a
 * promotion picker, an arrow, a piece mid-flight all change the board and none
 * of them write a row. The panel only gains a row once a move is committed,
 * loses rows on a takeback, and empties on a new game.
 *
 * So this file has one job and it is a segmentation job: cut the panel into
 * rows, cut rows into characters, and hand back boxes. Nothing here knows what
 * a letter is. Turning shapes into SAN is a separate step with a separate
 * ground truth, and keeping the two apart is what lets this half be checked on
 * its own — which is the half that decides whether the idea works at all.
 *
 * The same discipline as the rest of the project applies to the alphabet:
 * recognition is constrained, not guessed. A row must be one of the ~30-40
 * legal moves in the tracked position, which is a far tighter cage than the 13
 * things a square can be. But that is downstream of here.
 */

/**
 * Deviation from the background, per pixel.
 *
 * Background is taken as each *pixel row's own median*, which is what makes
 * this blind to the panel's decoration rather than fooled by it. Move lists
 * stripe alternate rows, tint the row for the move you are on, and grey the
 * move-number column against the moves — all of which shift the background
 * without changing the text. A fixed threshold would have to be retuned for
 * every one of those; a median cannot see them, because within any one pixel
 * row the background is still the overwhelming majority of the pixels.
 *
 * Absolute deviation rather than signed, so a light theme reads the same as a
 * dark one. Nothing downstream needs to know which way round the panel is.
 */
export function ink(gray, w, h) {
  const out = new Uint8Array(w * h);
  const row = new Uint8Array(w);
  for (let r = 0; r < h; r++) {
    const off = r * w;
    row.set(gray.subarray(off, off + w));
    row.sort();
    const bg = row[w >> 1];
    for (let c = 0; c < w; c++) out[off + c] = Math.abs(gray[off + c] - bg);
  }
  return out;
}

/**
 * The deviation at which a pixel is text rather than noise.
 *
 * Measured off the image for the same reason calibrate.js measures square
 * contrast instead of assuming it: the number depends on the theme, and the
 * gap it has to land in is wide enough that it does not need to be precise. A
 * solid text pixel deviates by most of the panel's text contrast; an untouched
 * background pixel by a level or two of noise, and an antialiased edge by
 * something in between. A high percentile finds the solid end without being
 * dragged by an outlier, and a quarter of it sits clear of the edges.
 */
export function inkFloor(map, frac = 0.25) {
  /*
   * Read off a fixed *count* of the strongest pixels, not a percentile.
   *
   * A percentile silently assumes text covers a roughly constant share of the
   * region, and the move list breaks that assumption every game: the container
   * is a fixed size on screen and starts almost empty. Measured on a real
   * panel, the 99.5th percentile gave 46 with the list full and 8 — the clamp,
   * meaning it had landed in the background — with two rows on it. A floor
   * that low calls antialiasing text, at exactly the moment the coach is
   * trying to pick up the first move of a game.
   *
   * A count does not care what fraction of the panel is blank. Any text at all
   * brings a few hundred solid pixels with it, so the 64th strongest is still
   * a stroke and not an edge, whether the list holds two rows or forty — the
   * same panel measured 47 at one, two, three and six rows, and 55 when full.
   * The count is deliberately absolute rather than a share of the region: a
   * share is just a percentile again, and would drift back with the size of
   * the rectangle that was dragged.
   *
   * Counted through a histogram rather than a sort: the values are bytes, so
   * this is one pass and 256 bins, which keeps it affordable per frame.
   */
  const hist = new Uint32Array(256);
  for (let i = 0; i < map.length; i++) hist[map[i]]++;
  const want = 64;
  let seen = 0, solid = 0;
  for (let v = 255; v >= 0; v--) {
    seen += hist[v];
    if (seen >= want) { solid = v; break; }
  }
  // The clamp is what says "there is no text here" for a blank region, where
  // the strongest pixels are noise a level or two off the background.
  return Math.max(8, Math.round(solid * frac));
}

/**
 * Columns to ignore because they are a bar, not text.
 *
 * A move list grows a scrollbar the moment the game outgrows the panel, and a
 * scrollbar is the one decoration that defeats every test above it: it has
 * ink, it sits at a fixed x, and it appears on every row — which is precisely
 * the signature of a text column, so the column check would confirm it as one.
 * Some panels draw a vertical rule between the move columns and that behaves
 * the same way.
 *
 * What separates them from text is not where they are but that they do not
 * *stop*. Text lives inside a row and leaves the gap between rows empty; a bar
 * runs straight through the gaps. So a column whose ink is continuous for
 * longer than any glyph could be is masked out before the rows are found at
 * all — otherwise it bridges every gap, and the whole panel bands as one row.
 *
 * A quarter of the panel is the bound, which no character approaches and no
 * scrollbar worth the name falls under.
 */
export function barColumns(map, w, h, floor, frac = 0.25) {
  const limit = Math.max(8, Math.floor(h * frac));
  const bars = new Set();
  for (let c = 0; c < w; c++) {
    let run = 0;
    for (let r = 0; r < h; r++) {
      run = map[r * w + c] > floor ? run + 1 : 0;
      if (run > limit) { bars.add(c); break; }
    }
  }
  return bars;
}

/**
 * Horizontal bands that contain text.
 *
 * A move list spaces its rows generously, so the gaps between them are several
 * pixels of untouched background and the runs come out unambiguous. Bands
 * thinner than `minHeight` are dropped as stray antialiasing rather than
 * merged into a neighbour — a one-pixel band is never half a glyph, because a
 * glyph that short would not be legible to the person either.
 */
export function rowBands(map, w, h, floor, { minHeight = 4, minPixels = 2 } = {}) {
  const bands = [];
  let top = -1;
  for (let r = 0; r <= h; r++) {
    let n = 0;
    if (r < h) {
      const off = r * w;
      for (let c = 0; c < w; c++) if (map[off + c] > floor) n++;
    }
    const filled = r < h && n >= minPixels;
    if (filled && top < 0) top = r;
    if (!filled && top >= 0) {
      if (r - top >= minHeight) bands.push({ top, bottom: r - 1 });
      top = -1;
    }
  }
  return bands;
}

/**
 * Runs of ink within one band, left to right, split on every empty column.
 *
 * A run is *not* reliably one character, and finding that out is the main
 * thing this file has measured. At the size a move list renders, adjacent
 * characters routinely share a column of ink — on a real panel `e4` came back
 * as a single 15x10 run, `exd5` as one 29x10 run — so a projection cut gives
 * whole tokens as often as it gives letters, and which one it gave is not
 * knowable from the box.
 *
 * That is why nothing downstream may be built on character segmentation. The
 * way out is the one board.js already takes: do not cut the pixels up and ask
 * what each piece is, score the handful of things the position allows against
 * the pixels as they are. A row must be one of the ~35 legal moves, each of
 * which is a known string, so the hypothesis can be drawn and compared whole —
 * and two characters touching is then something the hypothesis reproduces
 * rather than something the reader has to survive.
 *
 * Runs remain exactly the right tool for finding *tokens*, which is the
 * structure this does recover cleanly, and for learning an alphabet from the
 * runs that happen to be single characters.
 *
 * Each box is tightened vertically onto its own ink, so a run's height is its
 * own rather than the band's — height being one of the cheapest things telling
 * two shapes apart.
 */
export function inkRuns(map, w, floor, band) {
  const boxes = [];
  let x0 = -1;
  for (let c = 0; c <= w; c++) {
    let filled = false;
    if (c < w) {
      for (let r = band.top; r <= band.bottom; r++) {
        if (map[r * w + c] > floor) { filled = true; break; }
      }
    }
    if (filled && x0 < 0) x0 = c;
    if (!filled && x0 >= 0) {
      const box = { x0, x1: c - 1, y0: band.bottom, y1: band.top };
      for (let r = band.top; r <= band.bottom; r++) {
        for (let x = box.x0; x <= box.x1; x++) {
          if (map[r * w + x] > floor) {
            if (r < box.y0) box.y0 = r;
            if (r > box.y1) box.y1 = r;
            break;
          }
        }
      }
      boxes.push(box);
      x0 = -1;
    }
  }
  return boxes;
}

/**
 * Group characters into tokens on the gaps between them.
 *
 * The threshold is read off this panel's own gaps rather than set: inside a
 * word the gaps are the font's letter spacing, between words they are the
 * layout's column spacing, and the two are separated by a wide margin in any
 * font a person is expected to read. Taking the midpoint of the largest jump
 * in the sorted gaps finds the split wherever it happens to fall.
 */
export function tokenize(boxes, gap) {
  const tokens = [];
  let cur = [];
  for (const b of boxes) {
    if (cur.length && b.x0 - cur[cur.length - 1].x1 - 1 > gap) { tokens.push(cur); cur = []; }
    cur.push(b);
  }
  if (cur.length) tokens.push(cur);
  return tokens;
}

/**
 * The gap that separates tokens from letters, measured off the gaps present.
 *
 * By ratio rather than by absolute size, which matters because a move list has
 * *three* scales of gap, not two: letter spacing, the space between columns,
 * and — if any graphics were caught at the right-hand edge — a much wider run
 * of blank panel out to them. Measured on a real panel the three were 1-5px,
 * 31-41px and 58-100px. The largest absolute jump is the one out to the
 * graphics, which merges the columns; the largest *ratio* is 5 -> 31, which is
 * the split we want. Ratio is also the scale-free choice, so it survives a
 * panel rendered larger without being retuned.
 */
export function gapThreshold(rows) {
  const gaps = [];
  for (const boxes of rows) {
    for (let i = 1; i < boxes.length; i++) gaps.push(boxes[i].x0 - boxes[i - 1].x1 - 1);
  }
  if (gaps.length < 2) return 3;
  gaps.sort((a, b) => a - b);
  let ratio = 1, at = -1;
  for (let i = 1; i < gaps.length; i++) {
    const r = (gaps[i] + 1) / (gaps[i - 1] + 1);
    if (r > ratio) { ratio = r; at = i; }
  }
  if (at < 0) return gaps[0] + 1;
  // Geometric midpoint: the two scales differ by a factor, not by a count.
  return Math.max(1, Math.round(Math.sqrt((gaps[at - 1] + 1) * (gaps[at] + 1))) - 1);
}

/**
 * One character's ink, cropped to its box and scaled to a common peak.
 *
 * Normalising by the glyph's own maximum is the text equivalent of the tinted
 * reading in board.js: the panel renders the move-number column dimmer than
 * the moves and repaints the row you are on, so the same shape arrives at
 * different strengths. Dividing that out compares the shape and ignores the
 * decoration, while leaving every other difference — width, height, stroke
 * placement — intact to refute a wrong match.
 */
export function cut(map, w, box) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const px = new Uint8Array(bw * bh);
  let peak = 1;
  for (let r = 0; r < bh; r++) {
    for (let c = 0; c < bw; c++) {
      const v = map[(box.y0 + r) * w + box.x0 + c];
      px[r * bw + c] = v;
      if (v > peak) peak = v;
    }
  }
  for (let i = 0; i < px.length; i++) px[i] = Math.min(255, Math.round(px[i] * 255 / peak));
  return { w: bw, h: bh, px };
}

/**
 * Mean squared difference between two glyphs, or Infinity if they cannot be
 * the same character at all.
 *
 * Size is checked first and absolutely, because it is free and because the
 * font never scales: two renderings of one character have the same bounding
 * box to the pixel. Anything else is a different character, and comparing
 * their pixels would only produce a number that invites a threshold to argue
 * with. This is the same move as scoring legal moves instead of classifying
 * squares — refuse what cannot be, rather than rank everything.
 */
export function cost(a, b) {
  if (a.w !== b.w || a.h !== b.h) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.px.length; i++) {
    const d = a.px[i] - b.px[i];
    sum += d * d;
  }
  return sum / a.px.length;
}

/**
 * Group identical shapes, without being told what any of them are.
 *
 * This is the measurement the whole idea rests on, and it needs no labels: if
 * repeated renderings of one character land together and distinct characters
 * land apart, then reading the panel is a solved problem and only the naming
 * is left. If they do not separate, no amount of chess knowledge downstream
 * will rescue it. So the clusters are built greedily and the report is the
 * *gap* between the worst match kept and the best match refused — the same
 * quantity the board reports as its square separation.
 */
export function cluster(glyphs, limit = 400) {
  const clusters = [];
  let worstKept = 0;
  for (const g of glyphs) {
    let best = null, bestCost = Infinity;
    for (const cl of clusters) {
      const c = cost(g.glyph, cl.centroid);
      if (c < bestCost) { bestCost = c; best = cl; }
    }
    if (best && bestCost <= limit) {
      best.members.push(g);
      if (bestCost > worstKept) worstKept = bestCost;
    } else {
      clusters.push({ id: clusters.length, centroid: g.glyph, members: [g] });
    }
  }

  // The cheapest pair of distinct clusters. Same-size pairs only — a pair of
  // different sizes is refused by construction and says nothing about whether
  // the threshold is in the right place.
  let closest = Infinity, pair = null;
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const c = cost(clusters[i].centroid, clusters[j].centroid);
      if (c < closest) { closest = c; pair = [i, j]; }
    }
  }

  clusters.sort((a, b) => b.members.length - a.members.length);
  return { clusters, worstKept, closest, pair };
}

/**
 * Drop the rows the region cut in half.
 *
 * Once a game outgrows the panel the list scrolls, and a scrolled list almost
 * never stops on a row boundary — the top and bottom of the region land in the
 * middle of a row. Half a row still has ink, still bands, and still cuts into
 * runs, so nothing downstream would notice; it would simply read a move from
 * the half of the glyphs that survived.
 *
 * Which is worth being clear about, because scrolling costs less than it
 * looks. It does not lose the game: every row carries its own move number, so
 * a scrolled panel is a window that says where it is, and the rows that matter
 * — the newest ones — are the rows a list scrolls *to*. The only real damage
 * is at the two edges, and a clipped row gives itself away by being shorter
 * than the rows it is stacked with.
 *
 * Only edge rows are eligible. A short band in the middle of the panel is
 * something else — a result line, a header — and dropping it would be wrong.
 */
export function dropClipped(bands, h) {
  if (bands.length < 3) return bands;
  const heights = bands.map((b) => b.bottom - b.top + 1).sort((a, b) => a - b);
  const typical = heights[heights.length >> 1];
  const keep = (b, edge) =>
    !(edge && (b.bottom - b.top + 1) < typical * 0.8);
  return bands.filter((b, i) =>
    keep(b, (i === 0 && b.top === 0) || (i === bands.length - 1 && b.bottom === h - 1)));
}

/**
 * The row step, as the median rather than the mean, with a count of how many
 * steps agree with it.
 *
 * A move list is entitled to a row that is not a move — a result line under
 * the last one, a header over the first — and on a real panel one such line
 * pulled the mean enough to fail a worst-deviation test that the twenty rows
 * above it passed exactly. What distinguishes a bad cut is *many* steps
 * disagreeing, which is what a split or merged row gives and a trailing line
 * does not, so the count is the number to look at and the median is what it
 * should be counted against.
 */
export function rowPitch(rows) {
  const tops = rows.map((r) => r.band.top);
  const steps = tops.slice(1).map((t, i) => t - tops[i]);
  if (!steps.length) return { pitch: 0, onPitch: 0, steps: 0 };
  const sorted = [...steps].sort((a, b) => a - b);
  const pitch = sorted[sorted.length >> 1];
  return { pitch, onPitch: steps.filter((s) => Math.abs(s - pitch) <= 1).length, steps: steps.length };
}

/**
 * Token start positions stacked into columns.
 *
 * This is what says a move list was found rather than some other text: a move
 * list is a table, so its tokens share a few x positions and nearly every row
 * contributes to each. Anything drawn to a length — an evaluation bar, an
 * accuracy meter — starts wherever its length puts it, and gives itself away
 * by having no shared x at all.
 *
 * Each token is measured against its column's own left edge, never against
 * the last position added to it. Sliding the anchor lets a run of small steps
 * chain into one wide column: measured on a real panel, bars starting anywhere
 * across 25px were each within 4px of the one before, and a sliding anchor
 * swept all of them into a single column present in 21 of 22 rows — which is
 * exactly what a text column looks like, and completely wrong.
 */
export function columns(rows, tol = 4) {
  const starts = rows.flatMap((r) => r.tokens.map((t) => t[0].x0)).sort((a, b) => a - b);
  const out = [];
  for (const x of starts) {
    const last = out[out.length - 1];
    if (last && x - last.x <= tol) { last.n++; last.spread = x - last.x; } else {
      out.push({ x, n: 1, spread: 0 });
    }
  }
  return out;
}

/**
 * Panel pixels -> rows of tokens. The whole segmentation, in one call.
 *
 * Order matters in one place: bars are masked before the rows are found, not
 * after. A scrollbar runs through every gap between rows, so a pass that
 * banded first would find a single band covering the whole panel and have
 * nothing left to diagnose.
 */
export function segment(gray, w, h, opts = {}) {
  const map = ink(gray, w, h);
  const floor = opts.floor ?? inkFloor(map);

  const bars = opts.bars ?? barColumns(map, w, h, floor);
  for (const c of bars) for (let r = 0; r < h; r++) map[r * w + c] = 0;

  const bands = dropClipped(rowBands(map, w, h, floor, opts), h);
  const rows = bands.map((band) => ({ band, boxes: inkRuns(map, w, floor, band) }))
    .filter((r) => r.boxes.length > 0);
  const gap = opts.gap ?? gapThreshold(rows.map((r) => r.boxes));
  for (const r of rows) r.tokens = tokenize(r.boxes, gap);
  return { map, floor, gap, rows, bars };
}
