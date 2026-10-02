/**
 * Turning pixels into moves.
 *
 * The naive approach — classify all 64 squares independently, assemble a FEN —
 * compounds errors: one misread square yields an impossible position and the
 * whole thing desyncs. Instead we exploit the fact that we already know the
 * position, so the next frame can only be one of ~30 legal successors. We score
 * each legal move as a hypothesis against the observed pixels and take the best.
 *
 * That makes recognition robust to noise that would sink per-square classifying:
 * a move has to be legal to even be a candidate, and castling, en passant and
 * promotion need no special handling because they are just legal moves whose
 * hypotheses happen to touch more squares.
 */

import { Chess } from 'chess.js';
import { SQ_BYTES, square } from './capture.js';

/**
 * How many squares may be wrong-either-way before we stop excusing them.
 *
 * One. Each of the three faults that made this necessary broke exactly one
 * square, and one is the largest bound that gives up nothing: at two it starts
 * excusing a board that has merely run two plies ahead, and at three a board
 * four plies ahead was measured accepting `e3` — a move the game did play, but
 * as its third ply, which lands the tracked position on a line the game never
 * followed. That is the unrecoverable mistake the whole design is built to
 * avoid, and being behind is what the recovery ladder is for.
 *
 * So this buys a single square of slack against a board that is otherwise
 * explained, and nothing else.
 */
export const STALE_MAX = 1;

/** Piece codes, index 0 reserved for an empty square. */
export const CODES = ['.', 'wp', 'wn', 'wb', 'wr', 'wq', 'wk',
                           'bp', 'bn', 'bb', 'br', 'bq', 'bk'];
const CODE_INDEX = Object.fromEntries(CODES.map((c, i) => [c, i]));

/** Template format. Bumped whenever a saved model.json stops being readable. */
export const MODEL_VERSION = 3;

/**
 * Opacity mask for a piece the exact solve cannot reach: the king and queen,
 * which stand on a single square colour in the start position.
 *
 * A pixel is background wherever the observation matches the bare square under
 * it. That test is read together with the same piece in the other colour —
 * which does sit on the other square colour — because a white pixel can
 * coincide with a light square by chance, but not while the black version
 * coincides with a dark one at the same time.
 *
 * The ramp — how far a pixel must deviate before it counts as fully covered —
 * is measured off this piece rather than assumed, because assuming it is what
 * made a king unreadable the moment it stepped onto the other square colour.
 *
 * A quarter of the board's contrast, which this used, is about 23 grey levels
 * on a normal theme, while a genuinely opaque pixel of a dark piece on a light
 * square deviates by nearly 200. Every half-covered pixel therefore saturated
 * at fully opaque, and `ink` absorbed the background showing through it. That
 * is invisible while the piece stands where it was learned — the same
 * background is there to cancel it — and costs a fifth of the board's contrast
 * per pixel once it moves to the other shade. Measured on a real session: the
 * black king, learned on light e8, cost 2116 on dark f8 against a limit of
 * 200, where the black *queen* — learned on dark d8 — explained him at 311.
 * One square, wrong under every hypothesis, and the coach lost the game from a
 * perfectly tracked position.
 *
 * So the ramp is the deviation a covered pixel actually shows, taken as a high
 * percentile so one specular pixel cannot set it. That is self-calibrating: it
 * holds for a dark piece on light, a light piece on dark, and a low-contrast
 * theme, none of which share a constant.
 */
function maskFromDeviation(obs, base, twin, twinBase, contrast) {
  const dev = new Float32Array(obs.length);
  for (let i = 0; i < obs.length; i++) {
    let d = Math.abs(obs[i] - base[i]);
    if (twin) d = Math.max(d, Math.abs(twin[i] - twinBase[i]));
    dev[i] = d;
  }

  // The 90th percentile sits inside the glyph body for any piece that covers
  // more than a tenth of its square, which the king and queen — the only
  // pieces that reach this path — comfortably do.
  const sorted = Float32Array.from(dev).sort();
  const covered = sorted[Math.floor(sorted.length * 0.9)];
  const ramp = Math.max(4, contrast * 0.25, covered);

  const mask = new Float32Array(obs.length);
  for (let i = 0; i < obs.length; i++) mask[i] = Math.min(1, dev[i] / ramp);
  return mask;
}

/**
 * Map an image square index to chess.js board coordinates.
 * chess.js `board()` is rank 8 -> rank 1, file a -> h, which matches an
 * unflipped screenshot exactly; flipping is a 180 degree rotation.
 */
export function toBoardCoords(idx, flipped) {
  const row = Math.floor(idx / 8), col = idx % 8;
  return flipped ? [7 - row, 7 - col] : [row, col];
}

/** Union of two 64-square masks, either of which may be absent. */
export function combine(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = a[i] | b[i];
  return out;
}

/** a8 is a light square; shade follows coordinate parity from there. */
export function shadeOf(boardRow, boardCol) {
  return (boardRow + boardCol) % 2 === 0 ? 'light' : 'dark';
}

/** Square name ("e4") -> image square index. Inverse of {@link toBoardCoords}. */
export function indexOfSquare(name, flipped) {
  const col = name.charCodeAt(0) - 97;
  const row = 8 - Number(name[1]);
  return flipped ? (7 - row) * 8 + (7 - col) : row * 8 + col;
}

/** Image square index -> square name ("e4"). Inverse of {@link indexOfSquare}. */
export function squareName(idx, flipped) {
  const [r, c] = toBoardCoords(idx, flipped);
  return String.fromCharCode(97 + c) + (8 - r);
}

/**
 * Squares the board is expected to be decorating right now.
 *
 * Every site marks the last move's two squares, and the cost of that is not
 * small: measured on a real board, a highlight drawn under the piece adds ~2400
 * to a dark square's error — twenty times what a correctly-read square costs,
 * and four times what reading the *wrong* piece costs. Any per-square test that
 * did not know about it would read the highlight as a desync on every single
 * move.
 *
 * We do not have to guess where it is, though: it is on the move we just
 * accepted. Naming the squares exactly is what lets the test stay strict
 * everywhere else. A king in check is marked the same way, and we know that too.
 */
export function decorated(chess, lastMove, flipped) {
  const mask = new Uint8Array(64);
  if (lastMove) {
    mask[indexOfSquare(lastMove.from, flipped)] = 1;
    mask[indexOfSquare(lastMove.to, flipped)] = 1;
  }
  if (chess.inCheck()) {
    const turn = chess.turn();
    const board = chess.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = board[r][c];
        if (sq && sq.type === 'k' && sq.color === turn) {
          mask[flipped ? (7 - r) * 8 + (7 - c) : r * 8 + c] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * Position -> 64 piece-code indices in *image* order.
 * Taken straight off `chess.board()` rather than via a FEN string: scoring a
 * candidate is the inner loop of both detection and resync, and serialising a
 * position only to parse it straight back cost more than the scoring did.
 */
export function gridOf(chess, flipped) {
  const board = chess.board();
  const grid = new Uint8Array(64);
  for (let idx = 0; idx < 64; idx++) {
    const [r, c] = toBoardCoords(idx, flipped);
    const sq = board[r][c];
    grid[idx] = sq ? CODE_INDEX[sq.color + sq.type] : 0;
  }
  return grid;
}

/** FEN -> 64 piece-code indices in *image* order. */
export function fenToGrid(fen, flipped) {
  return gridOf(new Chess(fen), flipped);
}

/**
 * The position calibration learns from. Named here as well as in calibrate.js
 * because a model written before `oneShade` was recorded has to have it derived,
 * and this is the only position it could have been learned from.
 */
export const LEARNED_FROM = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Which piece codes stand on only one square shade in `fen`, and which shade.
 *
 * Those are the pieces whose opacity cannot be solved, only estimated — see
 * {@link BoardModel.shadeAllowance}. In the opening it is exactly the four
 * kings and queens, but it is derived rather than asserted so that a model
 * learned from some other position still describes itself correctly.
 */
export function oneShadeCodes(fen) {
  const grid = fenToGrid(fen, false);
  const seen = {};
  for (let idx = 0; idx < 64; idx++) {
    if (grid[idx] === 0) continue;
    const [r, c] = toBoardCoords(idx, false);
    (seen[CODES[grid[idx]]] ??= new Set()).add(shadeOf(r, c));
  }
  const out = {};
  for (const [code, shades] of Object.entries(seen)) {
    if (shades.size === 1) out[code] = [...shades][0];
  }
  return out;
}

/** 64 piece-code indices in image order -> the placement field of a FEN. */
export function gridToPlacement(grid, flipped) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '', gap = 0;
    for (let c = 0; c < 8; c++) {
      const code = CODES[grid[flipped ? (7 - r) * 8 + (7 - c) : r * 8 + c]];
      if (code === '.') { gap++; continue; }
      if (gap) { row += gap; gap = 0; }
      row += code[0] === 'w' ? code[1].toUpperCase() : code[1];
    }
    rows.push(row + (gap || ''));
  }
  return rows.join('/');
}

/**
 * Work out which way round the board is, from the start position.
 *
 * The two ranks nearest the player hold White's pieces and the two far ranks
 * hold Black's. Square colours are balanced across both bands, so any brightness
 * difference comes from the pieces — and white pieces are light in every board
 * theme worth supporting.
 */
export function detectFlipped(frame) {
  const bandMean = (rows) => {
    let sum = 0, n = 0;
    for (const row of rows) {
      for (let col = 0; col < 8; col++) {
        const tile = square(frame, row * 8 + col);
        for (let i = 0; i < SQ_BYTES; i++) { sum += tile[i]; n++; }
      }
    }
    return sum / n;
  };
  const top = bandMean([0, 1]);      // far side
  const bottom = bandMean([6, 7]);   // near side
  return { flipped: top > bottom, top, bottom };
}

/**
 * Which side the learned templates are calling White, measured from the men.
 *
 * This is the one orientation question that cannot be answered by asking how
 * well a model fits. {@link BoardModel.learn} fits its templates to whatever
 * pixels sit under the grid it was handed, so a model learned the wrong way
 * round reproduces its own calibration frame *exactly* as well as the right one
 * — measured on four real boards across two themes, the two fits came out
 * bit-identical, to every digit a double carries. A comparison whose answer is
 * always a tie is not a weak test, it is no test: the winner is then whichever
 * the sort happened to leave first, and orientation is decided by nothing.
 *
 * That mattered. A session calibrated the templates with the colours swapped,
 * every later check agreed with the mistake because the mistake was baked into
 * the templates that the checks are made of, and the coach spent a game telling
 * a Black player they were White and grading their opponent's moves.
 *
 * `ink` is the piece's own colour with the square behind it already divided out
 * (see pass 3 of `learn`), so this asks about the men alone — never about the
 * board they stand on, never about the frame they came from. A piece set draws
 * White lighter than Black, which is the one assumption here and a safe one: a
 * set that broke it would be unreadable to the player too.
 *
 * Weighted by opacity because a transparent pixel is showing the square, not
 * the piece, and averaging it in would drag both sides towards the background.
 *
 * @param {BoardModel} model  a trained model
 * @returns {{consistent: boolean|null, separation: number,
 *            white: number|null, black: number|null}}
 *          `consistent` is true when White's men really are the lighter ones,
 *          i.e. the model's `flipped` is right; null when a side has no
 *          templates at all. `separation` is how far apart the two sides are
 *          drawn, which is the confidence.
 */
export function inkTone(model) {
  const tone = (side) => {
    let sum = 0, weight = 0;
    for (const [code, p] of Object.entries(model.piece)) {
      if (code[0] !== side) continue;
      for (let i = 0; i < SQ_BYTES; i++) {
        sum += p.ink[i] * p.opacity[i];
        weight += p.opacity[i];
      }
    }
    return weight ? sum / weight : null;
  };
  const white = tone('w'), black = tone('b');
  if (white == null || black == null) return { consistent: null, separation: 0, white, black };
  return { consistent: white > black, separation: Math.abs(white - black), white, black };
}

/**
 * How far apart the two sides must be drawn before {@link inkTone} is believed,
 * as a fraction of the board's own light/dark contrast.
 *
 * Scaled from contrast rather than fixed, for the same reason `allow` and
 * `squareLimit` are: it has to mean the same thing on a high-contrast wood
 * theme and a flat grey one. A quarter is deliberately loose — on a real board
 * the measured separation was 102.4 against a bar of 24, and anything close to
 * the bar is a board this test should decline to rule on rather than guess.
 */
export const INK_MARGIN_RATIO = 0.25;

/**
 * Board-level shift, as a fraction of the board's own contrast, past which the
 * templates are not describing the board on screen. See
 * {@link BoardModel.themeDrift}.
 *
 * A tenth is well clear of the couple of grey levels an unchanged board wanders
 * by between sessions, and well under the ~14 measured when a real theme change
 * broke four sessions in a row on a board of contrast ~97.
 */
export const THEME_DRIFT_RATIO = 0.1;

/**
 * Which way round to calibrate, from one frame of the start position.
 *
 * Two independent readings, because each fails differently. {@link inkTone}
 * asks which men are drawn lighter and knows nothing about where they stand;
 * {@link detectFlipped} asks which end of the board is brighter and knows
 * nothing about which men are which. A dark piece set on a light theme fools
 * the second; a set with no tonal difference between the sides defeats the
 * first. They are wrong in different places, so agreement is worth something
 * and disagreement is worth stopping for.
 *
 * Only one model has to be built. The two candidates are exact mirrors of each
 * other — flipping relabels which code was learned from which square, so the
 * inks simply swap — which means a model built either way round answers the
 * question, and the answer for the other way round is its negation.
 *
 * @param {BoardModel} trial   a model learned from `frame` with *any* `flipped`
 * @param {Uint8Array} frame   the calibration frame
 * @returns {{flipped: boolean|null, ink: object, brightness: object,
 *            agree: boolean, decisive: boolean, bar: number}}
 *          `flipped` is null when the two disagree or the ink is too close to
 *          call, which is a refusal to answer and not a default.
 */
export function chooseOrientation(trial, frame) {
  const ink = inkTone(trial);
  const brightness = detectFlipped(frame);
  const bar = (trial.contrast ?? 0) * INK_MARGIN_RATIO;
  // `consistent` is about the model we were handed, so the orientation it
  // implies is that model's own flag when the ink agrees with it, and the
  // opposite when it does not.
  const byInk = ink.consistent == null ? null
    : ink.consistent ? trial.flipped : !trial.flipped;
  const decisive = byInk != null && ink.separation >= bar;
  const agree = byInk != null && byInk === brightness.flipped;
  return {
    flipped: decisive && agree ? byInk : null,
    byInk, ink, brightness, agree, decisive, bar,
  };
}

/**
 * Which way round a *read* board says it is, from where the colours sit.
 *
 * The per-square classifier names a piece by how it is drawn, colour included,
 * so a grid is always correct in image space however wrong our orientation is:
 * image square 0 really does hold whatever is painted in the top-left corner.
 * That makes orientation directly measurable at any point in a game — compare
 * the mean image row of White's men with Black's. White sits at the bottom, at
 * the high row indices, unless the board is flipped.
 *
 * This is what {@link detectFlipped} cannot do. That one works on raw
 * brightness bands and needs the start position, so it can only run at
 * calibration; this one needs a reading, and in exchange it works from any
 * position — which is the case that matters, because a board does not turn
 * round until you are already playing on it.
 *
 * It answers `null` rather than guess when there is not enough left on the board
 * for the question to mean anything. Separation alone cannot stand in for that:
 * two bare kings three ranks apart look as decisive as a full opening position,
 * and which of them is nearer the bottom says nothing at all. So the men are
 * counted first, and a thin position gets no opinion — which leaves orientation
 * where it is instead of driving it off one king's walk up the board.
 */
export function orientationOf(grid) {
  let wSum = 0, wN = 0, bSum = 0, bN = 0;
  for (let idx = 0; idx < 64; idx++) {
    const code = CODES[grid[idx]];
    if (code === '.') continue;
    const row = Math.floor(idx / 8);
    if (code[0] === 'w') { wSum += row; wN++; } else { bSum += row; bN++; }
  }
  if (wN < ORIENTATION_MEN || bN < ORIENTATION_MEN) return { flipped: null, margin: 0 };
  const w = wSum / wN, b = bSum / bN;
  return { flipped: w < b, margin: Math.abs(w - b) };
}

/**
 * Men a side must still have before where they stand says which way it plays.
 * Five is a guess at where an endgame stops having sides, and it is deliberately
 * on the cautious end: the cost of no opinion is that the last rung of recovery
 * keeps the orientation it already had, which is the behaviour this check
 * replaced everywhere anyway.
 */
export const ORIENTATION_MEN = 5;

/** Ranks of separation below which {@link orientationOf} is not worth believing. */
export const ORIENTATION_MARGIN = 1;

export class BoardModel {
  constructor({ flipped = false } = {}) {
    this.flipped = flipped;
    /**
     * What decided `flipped`, kept so a session can say where its orientation
     * came from instead of stating it as a bare fact. Written by calibration
     * via {@link chooseOrientation}; null on a model built for a trial fit or
     * loaded from a file predating it.
     */
    this.orientation = null;
    this.empty = { light: null, dark: null };  // mean appearance of a bare square
    /**
     * Bare appearance of one specific square, where the start position left it
     * empty. Real boards decorate individual squares in ways no per-shade
     * average can absorb: chess.com paints the rank numbers inside the a-file
     * and the file letters inside rank 1, and rounds off the four corners.
     * Averaged into `empty` those become a ghost that every a-file square then
     * mismatches — measured at 117-135 against ~3 for an ordinary empty square,
     * a third of the whole noise floor. Kept per square they cost nothing.
     */
    this.bare = new Array(64).fill(null);
    this.piece = {};                            // piece code -> { opacity, ink }
    /**
     * Pieces whose opacity was *guessed* rather than solved, and the single
     * square shade they were seen on. Only the king and queen reach this in a
     * normal calibration: every other piece type stands on both square colours
     * in the opening, which makes both unknowns solvable exactly.
     * Read by {@link slackFor}.
     */
    this.oneShade = {};
    /** Memoised {@link shadeAllowance}; cleared whenever templates change. */
    this._allow = null;
    /** Light/dark separation, which sets every threshold that scales with theme. */
    this.contrast = 0;
    this.trained = false;
  }

  /**
   * Learn templates from one frame whose position is known.
   *
   * A piece is modelled as an alpha composite over the bare square,
   *
   *     tile = ink + (1 - opacity) * bare
   *
   * rather than as a delta added to it. Real sprites are opaque: the pixels a
   * piece covers read the same whatever square it stands on, so a *delta* from
   * the bare square differs between the two square colours by the whole square
   * contrast. Averaging those two deltas into one template left every piece
   * appearing twice — which is every piece but the king and queen, the only two
   * standing on a single colour in the start position — mismatched by half that
   * contrast. Measured on a real board that put the noise floor at 336 against
   * a per-square move signal of ~42, so no move ever cleared the threshold and
   * nothing was ever detected. The symmetry of the per-square error map gave it
   * away: identical on a-h, b-g and c-f, and exactly zero on d and e.
   *
   * Seeing a piece on both colours makes both unknowns solvable exactly,
   * because only the background differs between the two observations:
   *
   *     tile_light - tile_dark = (1 - opacity) * (bare_light - bare_dark)
   */
  learn(frame, fen) {
    const grid = fenToGrid(fen, this.flipped);

    // Pass 1: bare squares, kept both per shade and per square.
    const acc = { light: new Float64Array(SQ_BYTES), dark: new Float64Array(SQ_BYTES) };
    const n = { light: 0, dark: 0 };
    this.bare = new Array(64).fill(null);
    for (let idx = 0; idx < 64; idx++) {
      if (grid[idx] !== 0) continue;
      const [r, c] = toBoardCoords(idx, this.flipped);
      const sh = shadeOf(r, c);
      const tile = square(frame, idx);
      for (let i = 0; i < SQ_BYTES; i++) acc[sh][i] += tile[i];
      n[sh]++;
      this.bare[idx] = Float32Array.from(tile);
    }
    for (const sh of ['light', 'dark']) {
      if (!n[sh]) throw new Error(`calibration needs at least one empty ${sh} square`);
      this.empty[sh] = Float32Array.from(acc[sh], (v) => v / n[sh]);
    }

    // Pass 2: mean observed tile per piece code, kept apart by square shade.
    const seen = {};
    for (let idx = 0; idx < 64; idx++) {
      if (grid[idx] === 0) continue;
      const code = CODES[grid[idx]];
      const [r, c] = toBoardCoords(idx, this.flipped);
      const sh = shadeOf(r, c);
      seen[code] ??= { light: new Float64Array(SQ_BYTES), dark: new Float64Array(SQ_BYTES),
                       n: { light: 0, dark: 0 } };
      const tile = square(frame, idx);
      for (let i = 0; i < SQ_BYTES; i++) seen[code][sh][i] += tile[i];
      seen[code].n[sh]++;
    }
    const mean = {};
    for (const [code, o] of Object.entries(seen)) {
      mean[code] = {
        light: o.n.light ? Float64Array.from(o.light, (v) => v / o.n.light) : null,
        dark: o.n.dark ? Float64Array.from(o.dark, (v) => v / o.n.dark) : null,
      };
    }

    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const contrast = Math.abs(avg(this.empty.light) - avg(this.empty.dark));
    this.contrast = contrast;

    // Pass 3: solve opacity and ink.
    this.piece = {};
    this.oneShade = {};
    this._allow = null;
    for (const [code, m] of Object.entries(mean)) {
      const both = m.light && m.dark;
      const shade = m.light ? 'light' : 'dark';
      // Recorded, not inferred later: what the guess was allowed to cost is
      // judged against the shade this piece was actually seen on.
      if (!both) this.oneShade[code] = shade;
      const other = shade === 'light' ? 'dark' : 'light';
      const obs = m.light ?? m.dark;
      const twin = mean[(code[0] === 'w' ? 'b' : 'w') + code.slice(1)];
      const guessed = maskFromDeviation(obs, this.empty[shade],
        twin?.[other] ?? null, this.empty[other], contrast);

      const opacity = new Float32Array(SQ_BYTES), ink = new Float32Array(SQ_BYTES);
      for (let i = 0; i < SQ_BYTES; i++) {
        const dB = this.empty.light[i] - this.empty.dark[i];
        // Where the two bare squares happen to agree the mask is unobservable,
        // so fall back there too, not only for the king and queen.
        const exact = both && Math.abs(dB) >= 1;
        opacity[i] = Math.min(1, Math.max(0, exact ? 1 - (m.light[i] - m.dark[i]) / dB : guessed[i]));

        /*
         * Clamping opacity into [0,1] breaks the identity the exact solve rests
         * on, and the two observations then imply different inks. Taking the
         * light one — as this did — reproduces light squares perfectly and
         * dumps the entire residual on dark ones: on one real calibration frame
         * the same black knight scored 0 on g8 and 421 on b8.
         *
         * That asymmetry is worse than it looks. It makes the fit error depend
         * on which shade a piece happens to be standing on, so the floor
         * measured at calibration stops describing the position a few moves
         * later — and the floor is exactly what "have we lost the board?" is
         * judged against. Splitting the residual halves the worst case and
         * makes it shade-independent, which is the point.
         */
        ink[i] = exact
          ? ((m.light[i] - (1 - opacity[i]) * this.empty.light[i])
             + (m.dark[i] - (1 - opacity[i]) * this.empty.dark[i])) / 2
          : obs[i] - (1 - opacity[i]) * this.empty[shade][i];
      }
      this.piece[code] = { opacity, ink };
    }

    this.trained = true;
    return this;
  }

  toJSON() {
    return {
      // Bumped when the template format changes, so a stale model.json is
      // refused with an instruction rather than silently mispredicting.
      version: MODEL_VERSION,
      flipped: this.flipped,
      orientation: this.orientation,
      contrast: this.contrast,
      empty: { light: Array.from(this.empty.light), dark: Array.from(this.empty.dark) },
      bare: this.bare.map((b) => (b ? Array.from(b) : null)),
      piece: Object.fromEntries(Object.entries(this.piece).map(([k, v]) => [k, {
        opacity: Array.from(v.opacity), ink: Array.from(v.ink),
      }])),
      oneShade: this.oneShade,
    };
  }

  static fromJSON(o) {
    if (o.version !== MODEL_VERSION) {
      throw new Error('templates/model.json was written by an older version of this tool.'
        + '\nRe-run `npm run calibrate`.');
    }
    const m = new BoardModel({ flipped: o.flipped });
    // Absent in models written before orientation recorded its reasons; the
    // session log then says so rather than inventing a provenance.
    m.orientation = o.orientation ?? null;
    m.empty = { light: Float32Array.from(o.empty.light), dark: Float32Array.from(o.empty.dark) };
    m.bare = (o.bare ?? []).map((b) => (b ? Float32Array.from(b) : null));
    while (m.bare.length < 64) m.bare.push(null);
    m.contrast = o.contrast;
    m.piece = Object.fromEntries(Object.entries(o.piece).map(([k, v]) => [k, {
      opacity: Float32Array.from(v.opacity), ink: Float32Array.from(v.ink),
    }]));
    /*
     * Derived rather than defaulted to nothing when a model predates the field.
     * The allowance is computed from the templates themselves, so an older
     * board.json can have it without being re-learned — and defaulting to `{}`
     * would silently leave exactly the boards already on disk unprotected.
     */
    m.oneShade = o.oneShade ?? oneShadeCodes(LEARNED_FROM);
    m._allow = null;
    m.trained = true;
    return m;
  }

  /**
   * How far this frame's board is from the one the templates were learned on.
   *
   * Asked of the empty middle ranks only, and of their *levels* rather than
   * their pixels, because that is the part of the board no position can change:
   * whatever is being played, ranks 3 to 6 of a chess board are mostly bare
   * squares, and their light and dark means are a property of the skin.
   *
   * The case this exists for is a board theme changed between sessions. Nothing
   * then fits, every hypothesis is refused for the right reasons, and the coach
   * spends the game correctly concluding it is lost — while the actual answer,
   * "these templates are for a different board", is deducible in one frame. On
   * a real session that cost 160 lost frames and 35 seconds before anything was
   * said, and what it said arrived on the console while the overlay still read
   * "Waiting for a move...".
   *
   * Reported, never acted on: a drift this large is a reason to tell someone,
   * not a reason for the watcher to behave differently.
   *
   * @returns {{light: number, dark: number, drift: number, stale: boolean}}
   *          `drift` is the larger of the two level shifts, `stale` whether it
   *          is big enough that the templates cannot be describing this board.
   */
  themeDrift(frame) {
    const mean = (idx) => {
      const tile = square(frame, idx);
      let sum = 0;
      for (let i = 0; i < SQ_BYTES; i++) sum += tile[i];
      return sum / SQ_BYTES;
    };
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const seen = { light: [], dark: [] }, want = { light: [], dark: [] };
    for (let idx = 16; idx < 48; idx++) {
      const [r, c] = toBoardCoords(idx, this.flipped);
      const sh = shadeOf(r, c);
      seen[sh].push(mean(idx));
      want[sh].push(avg(Array.from(this.bareAt(idx))));
    }
    const light = avg(seen.light) - avg(want.light);
    const dark = avg(seen.dark) - avg(want.dark);
    const drift = Math.max(Math.abs(light), Math.abs(dark));
    return { light, dark, drift, stale: drift >= this.contrast * THEME_DRIFT_RATIO };
  }

  /** Bare appearance of one square: measured if we have it, else the shade mean. */
  bareAt(idx) {
    if (this.bare[idx]) return this.bare[idx];
    const [r, c] = toBoardCoords(idx, this.flipped);
    return this.empty[shadeOf(r, c)];
  }

  /** Expected appearance of `code` standing on square `idx`. */
  predict(code, idx) {
    const base = this.bareAt(idx);
    if (code === '.') return base;
    const p = this.piece[code];
    if (!p) return base;                       // unseen piece: fall back to bare
    const out = new Float32Array(SQ_BYTES);
    for (let i = 0; i < SQ_BYTES; i++) out[i] = p.ink[i] + (1 - p.opacity[i]) * base[i];
    return out;
  }

  /**
   * How far a guessed opacity may miss by on the shade it never saw — measured,
   * not chosen.
   *
   * {@link learn} solves opacity exactly for a piece observed on both square
   * colours and *estimates* it for one seen on a single colour: the king and
   * queen, which stand on one square each in the opening. An estimate off by
   * `e` per pixel costs `e * (bare_light - bare_dark)` the moment that piece
   * steps onto the other shade — invisible at home, because the background it
   * was fitted against is there to cancel it, and scaled by the whole board
   * contrast away from it. Measured on a real session: the white queen, learned
   * on light d1, cost 646 on dark e3 against a limit of 200. The right piece,
   * three times too expensive, and one square wrong under every hypothesis is
   * enough that no move can be accepted and no resync line comes back clean.
   * That session lost 159 seconds and the game from a perfectly tracked
   * position.
   *
   * The size of that error is not a mystery to be tuned around. It can be
   * measured on this board, from the pieces that did not need the guess: hide
   * one shade of a piece seen on both, guess its mask exactly as the king and
   * queen's is guessed, predict the shade that was hidden, and score it. That
   * is a leave-one-shade-out cross-validation of the estimator, and what it
   * returns is the allowance the estimator has earned — which shrinks to
   * nothing on a board where the guess happens to be good, and needs no
   * constant.
   *
   * Kept per colour and per *target* shade, because the error is strongly
   * asymmetric and the asymmetry is the mechanism: a piece drawn in the tone of
   * the square it was learned on deviates from that square least, so its mask
   * saturates, its opacity is overestimated, and only the opposite shade pays.
   * On the board this was written against, white pieces learned on light missed
   * dark squares by 331-574 while the same pieces learned on dark missed light
   * ones by 29-132 — a factor of five, in one direction only. Averaging the two
   * would excuse the safe direction and still refuse the queen.
   *
   * The maximum rather than a percentile: there are only four pieces to measure
   * per direction, and the queen is the largest glyph on the board, so it
   * covers more pixels than any of them and its own error is likely at or above
   * theirs. This is the conservative end of a small sample, not a headroom
   * multiplier.
   *
   * @returns {{w: {light: number, dark: number}, b: {light: number, dark: number}}}
   *          mean-squared-error allowance, in the units {@link costTable} uses
   */
  shadeAllowance() {
    if (this._allow) return this._allow;
    const out = { w: { light: 0, dark: 0 }, b: { light: 0, dark: 0 } };
    if (!this.empty.light || !this.empty.dark) return (this._allow = out);

    const baseOf = (sh) => this.empty[sh];
    // What a piece would show on `sh`, reconstructed from its own template.
    // The templates are the composite, so this is the observation `learn` had.
    const shows = (code, sh) => {
      const p = this.piece[code];
      if (!p) return null;
      const base = baseOf(sh), o = new Float32Array(SQ_BYTES);
      for (let i = 0; i < SQ_BYTES; i++) o[i] = p.ink[i] + (1 - p.opacity[i]) * base[i];
      return o;
    };

    for (const code of Object.keys(this.piece)) {
      if (this.oneShade[code]) continue;        // a guess is all this one ever had
      for (const seen of ['light', 'dark']) {
        const other = seen === 'light' ? 'dark' : 'light';
        const obs = shows(code, seen), truth = shows(code, other);
        if (!obs || !truth) continue;
        // The same twin the real guess is given: the opposite-colour piece of
        // the same kind, as seen on the shade being predicted.
        const twin = shows((code[0] === 'w' ? 'b' : 'w') + code.slice(1), other);
        const g = maskFromDeviation(obs, baseOf(seen), twin, baseOf(other), this.contrast);
        let sum = 0;
        for (let i = 0; i < SQ_BYTES; i++) {
          // Ink from the single shade, exactly as the guessed branch derives it.
          const ink = obs[i] - (1 - g[i]) * baseOf(seen)[i];
          const d = truth[i] - (ink + (1 - g[i]) * baseOf(other)[i]);
          sum += d * d;
        }
        const mse = sum / SQ_BYTES;
        if (mse > out[code[0]][other]) out[code[0]][other] = mse;
      }
    }
    return (this._allow = out);
  }

  /**
   * The extra cost expecting `code` on square `idx` is allowed to carry.
   *
   * Zero for every piece whose opacity was solved, and zero for a guessed piece
   * standing on the shade it was learned on — there the guess cancels against
   * the background it was fitted to. See {@link shadeAllowance}.
   */
  slackFor(code, idx) {
    const seen = this.oneShade[code];
    if (!seen) return 0;
    const [r, c] = toBoardCoords(idx, this.flipped);
    const sh = shadeOf(r, c);
    if (sh === seen) return 0;
    return this.shadeAllowance()[code[0]][sh];
  }

  /**
   * {@link slackFor}, but only where the pixels have earned it.
   *
   * The allowance excuses an imprecise *prediction* of a known piece; it must
   * never excuse the wrong piece. On a board whose guess is poor the measured
   * allowance can run to thousands, and granted unconditionally that would stop
   * the square saying anything at all — the opposite of the mistake this fixes,
   * and the one that puts the coach on a line the game never played.
   *
   * So it is granted only while the expected piece is still the cheapest
   * explanation of its own square. That is the same question the decorated
   * squares are asked — name the expected piece — reached from the other side:
   * if something else explains these pixels better, there is nothing here for
   * the estimate to have been imprecise about. Measured on the session this was
   * written for, the white queen on e3 read `want=wq(877) best=wq(877)`: the
   * right piece, merely too expensive, which is exactly the case to excuse.
   */
  allowanceAt(table, idx, want) {
    const give = this.slackFor(CODES[want], idx);
    if (!give) return 0;
    const row = idx * CODES.length;
    let best = Infinity;
    for (let k = 0; k < CODES.length; k++) if (table[row + k] < best) best = table[row + k];
    return table[row + want] <= best ? give : 0;
  }

  /**
   * Per-square cost of every piece hypothesis for this frame.
   * Computed once per frame (64 squares x 13 codes) so that scoring a candidate
   * position is then just 64 table lookups.
   * @returns {Float32Array} indexed [idx * 13 + code]
   */
  costTable(frame) {
    const table = new Float32Array(64 * CODES.length);
    for (let idx = 0; idx < 64; idx++) {
      const tile = square(frame, idx);
      for (let k = 0; k < CODES.length; k++) {
        const exp = this.predict(CODES[k], idx);
        let sum = 0;
        for (let i = 0; i < SQ_BYTES; i++) { const d = tile[i] - exp[i]; sum += d * d; }
        table[idx * CODES.length + k] = sum / SQ_BYTES;   // mean squared error
      }
    }
    return table;
  }

  /**
   * How far a square may sit from the closest thing a chess square can show
   * before we call it covered by something else.
   *
   * Deliberately loose. Masking a square throws its evidence away, and the
   * squares most likely to be decorated are exactly the two a move must be read
   * from, so a false positive here costs a missed move — the failure that
   * starts a desync. A real highlight peaks near 0.5 contrast squared, so the
   * limit sits above that and catches only the genuinely foreign: a modal, a
   * scrim, a piece in mid-flight.
   */
  occlusionLimit() {
    return (this.contrast * 0.7) ** 2;
  }

  /**
   * Squares where this hypothesis is not merely imprecise but wrong.
   *
   * The mean over 64 squares that everything else uses cannot see a desync:
   * measured on a real board, being a whole move behind moves the mean from
   * 15.1 to 17.6, against a limit of 140 — a one-move desync is four plies away
   * from being noticed, and by then it is far too late to recover. Counting
   * squares instead makes it immediate, because the separation per square is
   * enormous: on that same board the worst correctly-read square costs 111 and
   * the cheapest *wrongly*-read one costs 277.
   */
  /**
   * Which piece best explains this square once any uniform tint is fitted out.
   *
   * A highlight is `observed = (1 - a) * actual + a * colour` — an affine map
   * on intensity. Fitting one out before comparing makes the test blind to the
   * tint, whatever colour and strength it is, while leaving it fully sensitive
   * to the shape underneath. That generality is the point: the same test covers
   * a last-move highlight, a check glow, a premove tint and a selection, none
   * of which we would otherwise have any way to anticipate.
   *
   * The gain is clamped because a tint cannot erase a piece. Without a floor
   * under it, a flat highlighted square fits *every* code at once by taking the
   * gain to zero and the offset to its mean, and the comparison says nothing.
   *
   * The ceiling is above one because the affine model is only true of the
   * background. A highlight is drawn *under* an opaque piece, so it moves the
   * square and leaves the sprite where it was — and when it moves the square
   * *away* from the piece's own intensity, the tile comes out with more
   * contrast than the template predicts, not less. A black knight on a dark f6
   * lightened by a last-move highlight is exactly that case: the fit wanted a
   * gain of 1.50, a ceiling of one held it to 1.00, and a square that fits at
   * 245 was scored at 478 — over the soft bound, so the only line that
   * explained the board was refused and an 800-second session never recovered.
   * A ceiling of one could only ever be right for a tint drawn *over*
   * everything, which is not how any of these boards draw one.
   *
   * Two is where the physics puts it: the most a background-only tint can
   * amplify apparent contrast is the ratio it can open between piece and
   * square, and a dark square lightened to mid-grey under a black piece is
   * about twice the template's. It stays a bound rather than a free parameter,
   * so the discrimination the residual is there to provide survives — a
   * displaced piece is mismatched in *shape*, which no gain repairs.
   */
  bestUnderTint(frame, idx) {
    const tile = square(frame, idx);
    let so = 0;
    for (let i = 0; i < SQ_BYTES; i++) so += tile[i];
    const mo = so / SQ_BYTES;
    let vo = 0;
    for (let i = 0; i < SQ_BYTES; i++) { const d = tile[i] - mo; vo += d * d; }

    let arg = 0, lowest = Infinity, next = Infinity;
    for (let k = 0; k < CODES.length; k++) {
      const p = this.predict(CODES[k], idx);
      let mp = 0;
      for (let i = 0; i < SQ_BYTES; i++) mp += p[i];
      mp /= SQ_BYTES;
      let vp = 0, cov = 0;
      for (let i = 0; i < SQ_BYTES; i++) {
        const dp = p[i] - mp;
        vp += dp * dp;
        cov += dp * (tile[i] - mo);
      }
      const gain = Math.min(2, Math.max(0.35, vp > 0 ? cov / vp : 1));
      const residual = vo - 2 * gain * cov + gain * gain * vp;
      if (residual < lowest) { next = lowest; lowest = residual; arg = k; }
      else if (residual < next) next = residual;
    }
    // Per pixel, so the numbers are in the same units as the cost table and the
    // limits measured at calibration apply to both.
    return { code: arg, best: lowest / SQ_BYTES, second: next / SQ_BYTES };
  }

  /** Memoised {@link bestUnderTint} — only the few decorated squares pay for it. */
  tintReader(frame) {
    const cache = new Array(64).fill(null);
    const read = (idx) => (cache[idx] ??= this.bestUnderTint(frame, idx));
    const fn = (idx) => read(idx).code;
    fn.full = read;
    return fn;
  }

  /**
   * Does the tinted reading let this square off?
   *
   * The weaker question a square gets when the pixel threshold cannot fairly be
   * applied to it: not "are the pixels close" but "is this piece still the best
   * of the thirteen once a uniform tint is fitted out". Two callers ask it, for
   * two different reasons, and both are in {@link misfits}:
   *
   *   decorated  a highlight drawn under the piece costs ~2400 where the limit
   *              is 200. Excusing such a square outright is worse than useless
   *              — skipping the two squares a candidate moves between hands
   *              every *wrong* candidate a free pass on the two squares that
   *              would have refuted it: with d4 missed and cxd4 on screen, "d3"
   *              excused d2 and d3, scored better than standing still, and was
   *              accepted.
   *   repainted  a square the board decorated for a reason the tracked position
   *              cannot predict: a piece you have selected, one the cursor is
   *              over, an arrow, a premove. Measured on a real session, a
   *              selected queen cost 1441 against a limit of 206 while
   *              remaining the best explanation of her own square by a wide
   *              margin — the right piece, too expensive. Held to the hard
   *              threshold that square is wrong under *every* hypothesis, which
   *              stops any move being accepted and stops any resync line coming
   *              back clean, so the coach can neither follow the game nor
   *              recover. It lost five minutes to one such square.
   *
   * `softLimit` is what stops the question being *too* weak, and it is the
   * reason a phantom move stopped being accepted.
   *
   * Naming the piece is a comparison between the thirteen codes, so it says
   * which piece the square looks most like and nothing at all about how well.
   * A piece the cursor is *holding over* a square passes it: a bishop halfway
   * onto g4 looks more like a bishop than like anything else, so the escape
   * waved it through and the coach recorded a move the player was still
   * thinking about — then watched them put the piece somewhere else.
   *
   * The residual `bestUnderTint` already computes is exactly the quantity that
   * separates the two, because it is measured *after* the affine fit: whatever
   * a decoration does to a square it does uniformly, so it comes out in the
   * gain and the offset and leaves the residual where it was. Displacement does
   * not. Measured over every settled frame of a real game, the square the last
   * move landed on — highlight and all — peaked at 0.59x the square limit,
   * while a bishop held under the cursor sat at 3.66x. So the escape is allowed
   * a generous multiple of the limit and still refuses a piece that is merely
   * *near* where it claims to be.
   *
   * Infinite by default, which is the behaviour every caller had before this
   * existed: tools that score a frame without a calibrated limit should not
   * suddenly start refusing squares over a bound they never passed.
   */
  excused(tint, idx, want, softLimit = Infinity) {
    if (!tint || tint(idx) !== want) return false;
    // `full` is absent only on a hand-rolled reader, which predates the bound
    // and cannot be held to it.
    if (softLimit === Infinity || !tint.full) return true;
    return tint.full(idx).best <= softLimit;
  }

  /**
   * @param {object} [o]
   * @param {Uint8Array} [o.skip]  occluded squares, which carry no information
   * @param {Uint8Array} [o.soft]  squares the board is expected to be decorating
   * @param {Function}   [o.tint]  reader from {@link tintReader}, required by `soft`
   * @param {number} [o.softLimit] how far the tinted reading may be stretched
   *                               before it stops excusing anything — see
   *                               {@link excused}
   */
  misfits(table, grid, limit, { skip = null, soft = null, tint = null,
                                softLimit = Infinity, out = null } = {}) {
    let n = 0;
    if (out) out.fill(0);
    for (let idx = 0; idx < 64; idx++) {
      if (skip && skip[idx]) continue;                  // foreign: no information
      const want = grid[idx];
      // A decorated square never gets the pixel test; any other square gets it
      // first and only falls through to the weaker question if it fails.
      const decoratedHere = !!(soft && soft[idx] && tint);
      // Both bounds carry it, because it is the *prediction* that is imprecise,
      // not the reading: a tinted reading of a guessed piece inherits the same
      // error the plain one does.
      const give = this.allowanceAt(table, idx, want);
      if (!decoratedHere && table[idx * CODES.length + want] <= limit + give) continue;
      if (this.excused(tint, idx, want, softLimit + give)) continue;
      n++;
      if (out) out[idx] = 1;
    }
    return n;
  }

  /**
   * Legal moves out of `fen` that this calibration could never see.
   *
   * The one question that decides whether a board is worth playing on, and it
   * is asked of the calibration rather than of the board: if a move can be made
   * and leave *no* square wrong, then that move is indistinguishable from
   * standing still and will never be detected, however long you wait.
   *
   * It exists because every numeric guard missed the case it was built for. A
   * `squareLimit` of 2714 — inflated by a stale last-move highlight, which is
   * one square dragging the worst-square term up with it — made sixteen of the
   * twenty legal first moves invisible: 1.e4 changes e2 (cost 578) and e4
   * (573), and both sit far under 2714, so neither is flagged and the coach
   * simply never notices the game has begun. Three sessions died that way, none
   * of them grading a single move. Meanwhile the ratio of `squareLimit` to what
   * the board's contrast implies does *not* separate the good calibrations from
   * the bad: it reads 5.28 and 5.45 on boards that graded 29- and 26-move games,
   * against 1.52 on one that was hopeless for a different reason.
   *
   * So this is binary and there is nothing to tune. A board that can see all
   * twenty first moves is not thereby perfect; a board that cannot see one of
   * them is certainly broken.
   *
   * It also catches the other half of a decoration, which no limit can. Where a
   * highlight sat on an *empty* square its background is learned with the tint
   * in it, so the square fits itself perfectly and a move onto it changes
   * nothing measurable — blind at every limit, including a corrected one. That
   * is why the answer to this is to refuse the calibration rather than to clamp
   * the number.
   *
   * @param {Uint8Array} frame  the same frame the templates were learned from
   * @param {string} fen        the position that frame is known to show
   * @param {number} squareLimit
   * @returns {string[]} SAN of every move that leaves nothing wrong
   */
  blindMoves(frame, fen, squareLimit) {
    const table = this.costTable(frame);
    const chess = new Chess(fen);
    const out = [];
    for (const mv of chess.moves({ verbose: true })) {
      chess.move(mv);
      const n = this.misfits(table, gridOf(chess, this.flipped), squareLimit);
      chess.undo();
      if (n === 0) out.push(mv.san);
    }
    return out;
  }

  /**
   * The same judgement as {@link misfits}, kept rather than counted.
   *
   * A count says we have lost the board; it cannot say what the board is doing
   * instead, and that is the whole question when a desync has to be explained
   * after the fact. Per wrong square this names the piece expected, the piece
   * the pixels actually look like, and what each costs — so the log distinguishes
   * "we are one move behind" (two or three squares wrong, along one move) from
   * "this is a different game" (half the board wrong, and it reads as the start
   * position).
   *
   * Only ever called on a frame already in trouble, so it is allowed to be the
   * expensive shape: an array of objects rather than a number.
   *
   * @returns {Array<{sq: string, want: string, wantCost: number, best: string,
   *                  bestCost: number, tint: string|null, soft: boolean,
   *                  occluded: boolean}>}
   */
  diagnose(table, grid, limit, { skip = null, soft = null, tint = null,
                                 softLimit = Infinity } = {}) {
    const out = [];
    for (let idx = 0; idx < 64; idx++) {
      const covered = !!(skip && skip[idx]);
      const decoratedHere = !!(soft && soft[idx]);
      const want = grid[idx];
      const wantCost = table[idx * CODES.length + want];

      let arg = 0, low = Infinity;
      for (let k = 0; k < CODES.length; k++) {
        const v = table[idx * CODES.length + k];
        if (v < low) { low = v; arg = k; }
      }

      // Exactly the predicate misfits uses, so a square listed here is a square
      // that was counted there — no second opinion to reconcile.
      const softHere = decoratedHere && !!tint;
      const give = this.allowanceAt(table, idx, want);
      const wrong = covered ? false
        : (softHere || wantCost > limit + give)
          && !this.excused(tint, idx, want, softLimit + give);
      if (!wrong && !covered) continue;

      out.push({
        sq: squareName(idx, this.flipped),
        want: CODES[want],
        wantCost: Math.round(wantCost),
        best: CODES[arg],
        bestCost: Math.round(low),
        tint: tint ? CODES[tint(idx)] : null,
        // What the tinted reading cost, which is the number that decides whether
        // the escape applied. Without it a square refused for being *displaced*
        // rather than for showing the wrong piece is indistinguishable in the
        // log from one refused on the pixels — and those have different fixes.
        tintCost: tint?.full ? Math.round(tint.full(idx).best) : null,
        soft: decoratedHere,
        occluded: covered,
      });
    }
    return out;
  }

  /**
   * Squares showing something that is not a chess square at all.
   *
   * This is the one measurement that separates "a dialog is sitting on the
   * board" from "we have lost track of the position", and it needs no
   * hypothesis to make: take the *best* of all thirteen codes for a square and
   * ask whether even that explains the pixels. A square we merely read wrongly
   * still looks like some piece — it is a knight, just not the knight we
   * expected — so its best code fits well. A square under a promotion picker, a
   * game-over modal, an arrow, a coach badge or a piece in mid-flight looks like
   * none of the thirteen, and stands out by an order of magnitude.
   *
   * Those squares carry no information either way, so every score below simply
   * leaves them out rather than letting them swamp a mean over 64.
   */
  occluded(table, limit = this.occlusionLimit()) {
    const mask = new Uint8Array(64);
    let count = 0;
    for (let idx = 0; idx < 64; idx++) {
      let min = Infinity;
      for (let k = 0; k < CODES.length; k++) {
        const v = table[idx * CODES.length + k];
        if (v < min) min = v;
      }
      if (min > limit) { mask[idx] = 1; count++; }
    }
    return { mask, count };
  }

  /**
   * Mean per-square error if the board really is `grid`. Lower is better.
   * `skip` marks squares to leave out of the average — see {@link occluded}.
   */
  scoreGrid(table, grid, skip = null) {
    let total = 0, n = 0;
    for (let idx = 0; idx < 64; idx++) {
      if (skip && skip[idx]) continue;
      total += table[idx * CODES.length + grid[idx]];
      n++;
    }
    // Nothing left to measure is not a good fit; it is no reading at all.
    return n ? total / n : Infinity;
  }

  scoreFen(table, fen, skip = null) {
    return this.scoreGrid(table, fenToGrid(fen, this.flipped), skip);
  }

  /**
   * Decide what — if anything — changed on the board.
   *
   * @param {Uint8Array} frame
   * @param {Chess} chess   current known position (not mutated)
   * @returns {{move: object|null, uci: string|null, score: number, still: number, margin: number}}
   *   `move` is null when the board still looks like the current position.
   */
  /**
   * @param {Uint8Array} frame
   * @param {Chess} chess   current known position (not mutated)
   * @param {object} [opt]
   * @param {number} [opt.squareLimit]  per-square error above which a square
   *                                    counts as read wrongly, not just noisily
   * @param {Uint8Array} [opt.excuse]   squares the board is expected to be
   *                                    decorating — see {@link decorated}
   * @param {number} [opt.softLimit]    see {@link excused}. This is what keeps a
   *                                    piece the cursor is holding over a square
   *                                    from being read as a piece that landed
   *                                    on it.
   */
  detectMove(frame, chess, { squareLimit = null, excuse = null,
                             softLimit = Infinity } = {}) {
    const table = this.costTable(frame);
    const { mask, count } = this.occluded(table);
    const stillGrid = gridOf(chess, this.flipped);
    const still = this.scoreGrid(table, stillGrid, mask);

    /*
     * The caller's `excuse` is where the board is highlighting the move we
     * already know about. A candidate implies a *different* highlight — its own
     * — because a board marks the move that just landed, which is precisely the
     * one we are trying to read.
     *
     * Judging every candidate against the old highlight makes the true move
     * look wrong on exactly the two squares that prove it. In a replay of a
     * real game that cost a move of lag on every single move: c5 was refused
     * while c7-c5 was lit, and only accepted a move later once the highlight
     * had moved on to g1-f3. So each hypothesis is scored with the decoration
     * it implies, the same way a resync line is.
     */
    const tint = this.tintReader(frame);
    const probe = new Chess(chess.fen());
    const candidates = [];
    for (const m of probe.moves({ verbose: true })) {
      probe.move(m);
      const grid = gridOf(probe, this.flipped);
      const soft = combine(excuse, decorated(probe, m, this.flipped));
      candidates.push({
        move: m,
        uci: m.from + m.to + (m.promotion ?? ''),
        grid,
        soft,
        score: this.scoreGrid(table, grid, mask),
        misfits: squareLimit == null ? 0
          : this.misfits(table, grid, squareLimit, { skip: mask, tint, soft, softLimit }),
      });
      probe.undo();
    }
    candidates.sort((a, b) => a.score - b.score);

    const best = candidates[0];
    const second = candidates[1];

    /*
     * Squares that are wrong whichever way we read the board.
     *
     * Three separate faults have now put one square permanently beyond the
     * pixel threshold: a highlight learned into a background at calibration, a
     * queen the player had selected, and a king standing on the one square
     * colour its template was never learned from. Each time the position was
     * tracked perfectly and the coach still died, because a square that is
     * wrong under *every* hypothesis makes "the move must explain the whole
     * board" unsatisfiable — no move accepted, no resync line clean, and the
     * ladder climbing all the way to giving up.
     *
     * But a square both readings agree about, and both get wrong, cannot
     * distinguish them. It is the same fact the occlusion mask already acts on
     * — "those squares carry no information either way, so every score simply
     * leaves them out" — arrived at from the other direction: not a square we
     * cannot read, but one whose reading cannot settle anything.
     *
     * Excluding it favours neither hypothesis, and refutation is untouched
     * where it matters: a square the move *changes* is judged exactly as
     * before, which is where a wrong candidate is caught. With d4 missed and
     * cxd4 on screen, "d3" is still refuted on d3.
     *
     * Bounded hard at {@link STALE_MAX}, which is one square. A board that has
     * run two plies ahead is wrong either way on two, past the bound, so it is
     * not discounted at all and the recovery ladder handles it as it always
     * did. Being behind stays the ladder's problem; this only answers a square
     * that no reading can fix.
     *
     * A *wrong* move is refused throughout, because it is still judged on the
     * squares it changes and those are never shared with standing still. With
     * d4 missed and cxd4 on screen, "d3" claims a pawn on d3 where the board
     * shows none — not a square standing still gets wrong, so it is counted,
     * and the move is refused exactly as before.
     */
    const stillWrong = new Uint8Array(64);
    const stillCount = squareLimit == null ? 0
      : this.misfits(table, stillGrid, squareLimit,
        { skip: mask, soft: excuse, tint, softLimit, out: stillWrong });

    let stale = null, staleCount = 0;
    if (squareLimit != null && best && stillCount > 0 && best.misfits > 0) {
      const bestWrong = new Uint8Array(64);
      this.misfits(table, best.grid, squareLimit,
        { skip: mask, tint, soft: best.soft, softLimit, out: bestWrong });
      const shared = new Uint8Array(64);
      for (let idx = 0; idx < 64; idx++) {
        // Wrong both ways, and about a square the move leaves alone — so the
        // two readings are making the same claim there and both are refused.
        if (stillWrong[idx] && bestWrong[idx] && stillGrid[idx] === best.grid[idx]) {
          shared[idx] = 1;
          staleCount++;
        }
      }
      if (staleCount > 0 && staleCount <= STALE_MAX) stale = shared;
      else staleCount = 0;
    }
    return {
      move: best?.move ?? null,
      uci: best?.uci ?? null,
      score: best?.score ?? Infinity,
      still,
      // The head of the ranking, for the log. Which move *won* says little on
      // its own — what a desync looks like is the true move sitting third with
      // the field bunched, and that is only visible if the field is recorded.
      top: candidates.slice(0, 5).map((c) => ({
        uci: c.uci, san: c.move.san, score: c.score, misfits: c.misfits,
      })),
      // How much better the winner is than the runner-up: our confidence signal.
      margin: second ? second.score - best.score : Infinity,
      // Squares each hypothesis gets outright wrong. This is what tells a
      // desync from a board that merely looks a little different than it did.
      // Net of the squares that are wrong either way, which say nothing about
      // which reading is right — see `stale` above.
      stillMisfits: stillCount - staleCount,
      bestMisfits: (best?.misfits ?? 0) - staleCount,
      // The squares that were discounted, so a resync can leave them out too
      // and the log can say which they were.
      stale,
      staleCount,
      // Carried so a resync can reuse the frame's cost table rather than
      // recomputing the expensive part of it.
      table,
      mask,
      tint,
      occluded: count,
    };
  }

  /**
   * Squares whose learned background does not look like the rest of its shade.
   *
   * The one contamination no fit-based check can see. Calibration learns an
   * empty square's appearance *from* the calibration frame, so whatever was
   * sitting on that square — a stale last-move highlight, a badge, a hover
   * tint — is learned as the square itself and then fits perfectly. Every
   * measurement calibration takes afterwards agrees the board is fine.
   *
   * It stops being fine the moment the decoration clears. The square now
   * mismatches its own stored background by thousands, which is above any
   * sane wrong-square limit, so it counts as wrong under *every* hypothesis —
   * and since accepting a move demands that the move explain the whole board,
   * no move is ever accepted again. Measured on a real session: one such
   * square, learned from a d2-d4 highlight, cost 3309 against a limit of 2714
   * and read as a black queen on an empty square. The board sat in the opening
   * position for seventeen minutes without a single move being graded.
   *
   * Comparison is against the median of the same shade rather than the mean,
   * because the mean already contains the contamination we are looking for.
   * Squares a theme legitimately decorates — chess.com's rank digits down the
   * a-file — shift a background by a few levels, well inside this limit; a
   * highlight shifts it by tens.
   *
   * @param {number} [limit]  levels of deviation to tolerate
   * @returns {Array<{sq: string, mean: number, expected: number, delta: number}>}
   */
  oddBackgrounds(limit = Math.max(8, this.contrast * 0.12)) {
    const byShade = { light: [], dark: [] };
    for (let idx = 0; idx < 64; idx++) {
      if (!this.bare[idx]) continue;
      const [r, c] = toBoardCoords(idx, this.flipped);
      let sum = 0;
      for (const v of this.bare[idx]) sum += v;
      byShade[shadeOf(r, c)].push({ idx, mean: sum / this.bare[idx].length });
    }

    const out = [];
    for (const [shade, squares] of Object.entries(byShade)) {
      if (squares.length < 4) continue;              // too few to have a middle
      const sorted = [...squares].sort((a, b) => a.mean - b.mean);
      const median = sorted[Math.floor(sorted.length / 2)].mean;
      for (const s of squares) {
        const delta = s.mean - median;
        if (Math.abs(delta) > limit) {
          out.push({
            sq: squareName(s.idx, this.flipped), shade,
            mean: Math.round(s.mean * 10) / 10,
            expected: Math.round(median * 10) / 10,
            delta: Math.round(delta * 10) / 10,
          });
        }
      }
    }
    return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  /**
   * Read the position off the board directly, square by square.
   *
   * This is the method the whole design avoids, and for good reason: one
   * misread square yields a position that never existed, and as a *primary*
   * reader it compounds errors that hypothesis-scoring never makes. But as the
   * last rung of recovery it is exactly right, because by then the alternative
   * is not a better reading, it is giving up — and the objection is answered by
   * refusing to answer at all unless every one of the 64 squares is certain.
   *
   * Certainty is two tests per square: the winning code must fit outright, and
   * it must beat the runner-up by the same margin that a wrong square is
   * defined by. A board mid-animation, under a panel, or in a theme we no
   * longer match fails that on some square and returns nothing, which is the
   * outcome we want. What it recovers is the case forward search cannot reach
   * at any depth: several moves went by unseen, so the truth is no longer a
   * small number of plies away.
   *
   * @param {Function} tint  reader from {@link tintReader}
   * @returns {{fen: string, turn: string}|null}
   */
  readBoard(tint, { squareLimit, mask = null, lead = squareLimit / 4,
                    cap = squareLimit * 4 } = {}) {
    const grid = new Uint8Array(64);
    for (let idx = 0; idx < 64; idx++) {
      /*
       * The occlusion mask is not optional here, it is load-bearing. Fitting a
       * tint out makes a *flat* panel look like a bare square — confidently, and
       * with a wide lead, because emptiness is exactly what has no shape. The
       * per-square confidence test cannot catch that by construction, so the
       * one measurement that can is consulted first: a square that matches none
       * of the thirteen at full contrast is foreign, and a board with any such
       * square is not a board we are willing to read.
       */
      if (mask && mask[idx]) return null;
      // Read through any tint, because when we are lost we do not know where
      // the board is highlighting. Held to raw pixels this refused every real
      // board it was given: the last move's two squares cost ~2400 against a
      // limit of 200, so two squares out of 64 sank the whole reading.
      const { code, best, second } = tint.full(idx);

      /*
       * Both thresholds are measured rather than assumed, and both are looser
       * than the wrong-square limit for reasons worth stating.
       *
       * `cap` is generous because a highlight is drawn *under* the piece, so it
       * is only affine on the background and the fit leaves a real residual
       * even when the answer is right: a correctly-read knight on a highlighted
       * f6 measured 481 against a limit of 200. It is a sanity bound on
       * nonsense, not a fit test — the lead does the discriminating.
       *
       * `lead` is a quarter because an empty square cannot lead by much. With
       * the gain clamped at 0.35, a piece can always shrink toward flat and get
       * within roughly an eighth of its own variance of a bare square, which on
       * a real board put the tightest honest lead at 69. Asking for more than
       * that rejects boards it has in fact read perfectly.
       */
      if (best > cap || second - best < lead) return null;
      grid[idx] = code;
    }

    // Cheap impossibilities, checked before chess.js is asked anything. A
    // position that passes per-square confidence can still be nonsense, and
    // adopting nonsense is the one failure this rung must never produce.
    let kings = { w: 0, b: 0 };
    for (let idx = 0; idx < 64; idx++) {
      const code = CODES[grid[idx]];
      if (code === '.') continue;
      if (code[1] === 'k') kings[code[0]]++;
      if (code[1] === 'p') {
        const [r] = toBoardCoords(idx, this.flipped);
        if (r === 0 || r === 7) return null;      // a pawn cannot stand on rank 1 or 8
      }
    }
    if (kings.w !== 1 || kings.b !== 1) return null;

    /*
     * And the one impossibility a per-square test can never see: the board
     * being the other way round from the one we are reading it as.
     *
     * Every square can be certain and the whole reading still a fiction, because
     * a rotated board is a legal-looking board — it is the same 64 pieces, read
     * from the far end. That is not hypothetical: a real session adopted
     * `RNBKQB1R/PPPP1PPP/5N2/...`, which is 1.d4 d5 2.Nc3 seen upside down, and
     * then fitted every later move against it. The grid itself carries the
     * answer, so refusing costs nothing but a comparison.
     *
     * Only a decisive disagreement refuses. A thin margin means the position has
     * no clear sides left, and inventing an opinion there would break endgames
     * to protect against a case this test cannot see anyway.
     */
    const facing = orientationOf(grid);
    if (facing.flipped != null && facing.margin >= ORIENTATION_MARGIN
        && facing.flipped !== this.flipped) {
      return null;
    }

    const placement = gridToPlacement(grid, this.flipped);
    // Castling rights are not observable, so they are inferred from the only
    // thing that is: a king and rook still standing at home. Inferring them
    // generously is the safe direction — an extra candidate move costs a little
    // scoring, a missing one would make the real move unreadable.
    const at = (name) => CODES[grid[indexOfSquare(name, this.flipped)]];
    let rights = (at('e1') === 'wk' ? (at('h1') === 'wr' ? 'K' : '') + (at('a1') === 'wr' ? 'Q' : '') : '')
      + (at('e8') === 'bk' ? (at('h8') === 'br' ? 'k' : '') + (at('a8') === 'br' ? 'q' : '') : '');
    if (!rights) rights = '-';

    for (const turn of ['w', 'b']) {
      const fen = `${placement} ${turn} ${rights} - 0 1`;
      try {
        const c = new Chess(fen);
        // Both sides can be legal placements; the one whose opponent is left in
        // check is not a position that could have arisen, so it is discarded.
        if (c.moves().length) return { fen, turn };
      } catch { /* not a legal position with this side to move */ }
    }
    return null;
  }

  /**
   * Widen the search when a single ply cannot explain a settled board.
   *
   * One misread or missed move used to be terminal: every later frame is fitted
   * against a position that no longer exists, nothing ever matches again, and
   * the only advice left was "restart". But a board that has run ahead of us has
   * run ahead by a *small, known* amount — you moved and the opponent replied —
   * so the position on screen is still only two or three plies out. Searching
   * that far finds it, and the same margin test that guards a one-ply detection
   * guards this one.
   *
   * Lines are compared by resulting position, not by move order: two ways of
   * reaching the same board are not competing hypotheses, and treating them as
   * such would collapse the margin and refuse every recovery.
   *
   * @param {Float32Array} table  cost table from {@link detectMove}
   * @param {Chess} chess         position we currently believe we are in
   * @param {object} [opt]
   * @param {number} [opt.plies]       exact depth to search
   * @param {Uint8Array} [opt.mask]    occluded squares, left out of every score
   * @param {number} [opt.squareLimit] see {@link misfits}
   * @returns {{line: object[], score: number, margin: number, misfits: number}|null}
   */
  resync(table, chess, { plies = 2, mask = null, squareLimit = null, tint = null,
                         softLimit = Infinity } = {}) {
    const probe = new Chess(chess.fen());
    const seen = new Map();          // position key -> best line reaching it

    /*
     * Every depth from 1 to `plies`, not `plies` exactly.
     *
     * Walking to an exact depth means a rung cannot represent a truth shallower
     * than itself. Measured on a real session: the board was one ply ahead —
     * a queen had moved and nothing else — and the two-ply rung, unable to stop
     * at one, had to invent a reply for the opponent. It returned `Qe3 a5`,
     * three squares wrong, and was refused on the square count while its own
     * confidence margin passed by 66%. The move it needed was the first half of
     * its own line.
     *
     * The shallower positions are nearly free — thirty of them against nine
     * hundred at two plies — and `seen` already dedupes by grid, so a line that
     * transposes into a position another line reached is counted once. What it
     * changes is that a rung can now answer "you moved and we missed it" without
     * having to claim a number of plies it has no evidence for.
     */
    const walk = (depth, line) => {
      if (line.length) {
        const grid = gridOf(probe, this.flipped);
        const key = String.fromCharCode(...grid);
        if (!seen.has(key)) {
          // Each line is judged with the decoration *it* implies: whatever move
          // really landed last is the one the board is highlighting now.
          const soft = decorated(probe, line[line.length - 1], this.flipped);
          seen.set(key, {
            line: line.slice(),
            score: this.scoreGrid(table, grid, mask),
            misfits: squareLimit == null ? 0
              : this.misfits(table, grid, squareLimit, { skip: mask, soft, tint, softLimit }),
          });
        }
      }
      if (depth === 0) return;
      for (const m of probe.moves({ verbose: true })) {
        probe.move(m);
        line.push(m);
        walk(depth - 1, line);
        line.pop();
        probe.undo();
      }
    };
    walk(plies, []);

    const ranked = [...seen.values()].sort((a, b) => a.score - b.score);
    if (!ranked.length) return null;
    return { ...ranked[0], margin: ranked[1] ? ranked[1].score - ranked[0].score : Infinity };
  }

  /**
   * The last move we recorded never happened — a *different* one did.
   *
   * {@link resync} looks forward and `tryUndo` looks back, and there is a third
   * direction neither of them can see. A move can be accepted that the player
   * was still only considering: they pick a piece up, hold it over a square
   * while they think, the board is pixel-identical for as long as they hold
   * still, and the watcher has no way to tell a settled board from a settled
   * cursor. Then they put the piece somewhere else.
   *
   * From that moment the truth is one ply *sideways*: the same position we were
   * in before, with a different move played from it. Nothing else reaches it.
   * A takeback test asks whether the board went back to the prior position and
   * it did not — the piece is on the board, just not where we said. A forward
   * search asks what follows the phantom and the truth does not follow it at
   * all. Measured on the session that prompted this, every rung failed for its
   * own correct reason while a three-ply search eventually stumbled onto the
   * right *pixels* by way of `Bb5 Be6 Bc4` — explaining all 64 squares through a
   * line the game never played, and refused, rightly, for leading the field by
   * nothing.
   *
   * Asked here properly it is the cheapest rung but one: one `undo` and a
   * single ply of moves scored against a cost table we already have, about
   * thirty positions where a two-ply resync is nine hundred. On that session it
   * recovered 1.6s after the phantom, naming the real move with every square
   * explained and a lead of 102 over the runner-up where 6 was required.
   *
   * The move we undid is deliberately left in the field it competes against.
   * If it *wins*, the board does look like the move we recorded and this is not
   * the phantom case at all, so there is nothing to replace; the caller is told
   * so by getting `null` rather than a replacement that changes nothing.
   *
   * @param {Float32Array} table  cost table from {@link detectMove}
   * @param {Chess} chess         position we currently believe we are in. Not
   *                              mutated — but note this is the one search here
   *                              that needs the game's *history* and not just
   *                              its position, so it cannot clone through a FEN
   *                              the way {@link resync} does. A FEN copy has
   *                              nothing to undo and would silently never find
   *                              anything.
   * @returns {{move: object, uci: string, was: object, score: number,
   *            margin: number, misfits: number}|null}
   */
  replaceLast(table, chess, { mask = null, squareLimit = null, tint = null,
                              softLimit = Infinity } = {}) {
    /*
     * Each way of declining says which. All four used to return a bare `null`
     * and the caller logged every one of them as `no move`, so the rung's
     * refusal — the whole diagnostic value of a rung that validates before it
     * keeps — could not be read afterwards. On a real session `no move` appeared
     * with a 34-ply game in hand, where it actually meant "the move we recorded
     * is the best explanation of the board", which is the rung *agreeing* with
     * the tracked position and the opposite of what the string suggests.
     */
    const probe = new Chess();
    try {
      probe.loadPgn(chess.pgn());
    } catch {
      return { no: 'history' };                // nothing we can walk back
    }
    const was = probe.undo();
    if (!was) return { no: 'first move' };     // no move to replace yet

    const ranked = [];
    for (const m of probe.moves({ verbose: true })) {
      probe.move(m);
      const grid = gridOf(probe, this.flipped);
      // Each candidate is judged with the decoration it implies, exactly as in
      // detectMove: the board highlights whichever move really landed.
      const soft = decorated(probe, m, this.flipped);
      ranked.push({
        move: m,
        uci: m.from + m.to + (m.promotion ?? ''),
        score: this.scoreGrid(table, grid, mask),
        misfits: squareLimit == null ? 0
          : this.misfits(table, grid, squareLimit, { skip: mask, soft, tint, softLimit }),
      });
      probe.undo();
    }
    ranked.sort((a, b) => a.score - b.score);

    const best = ranked[0], second = ranked[1];
    if (!best) return { no: 'no legal move' };
    const wasUci = was.from + was.to + (was.promotion ?? '');
    // Not a phantom: it is what we said. Worth distinguishing, because it is the
    // rung confirming the tracked position rather than failing to run.
    if (best.uci === wasUci) return { no: 'confirmed', was, score: best.score };
    return {
      ...best,
      was,
      margin: second ? second.score - best.score : Infinity,
    };
  }
}
