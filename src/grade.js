/**
 * Grade a single move: engine in, verdict out.
 *
 * This is the whole "is it a blunder" question, and deliberately contains no
 * model calls. The label is arithmetic on Stockfish evaluations; the language
 * model only ever narrates the result afterwards.
 */

import { Chess } from 'chess.js';
import { negate } from './engine.js';
import { classify } from './verdict.js';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material balance in pawns from `color`'s point of view. */
export function material(fen, color) {
  const board = new Chess(fen).board();
  let total = 0;
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue;
      total += (sq.color === color ? 1 : -1) * VALUE[sq.type];
    }
  }
  return total;
}

/** Convert a chess.js verbose move into the UCI string Stockfish speaks. */
export function toUci(m) {
  return m.from + m.to + (m.promotion ?? '');
}

/**
 * The other direction: a UCI principal variation as readable SAN, e.g.
 * "Nxe5 Qh4 Nf3". Stops early rather than throwing if a line does not play out,
 * since a pv is only as legal as the position it was searched from.
 */
export function pvToSan(fen, pv, plies = 6) {
  const chess = new Chess(fen);
  const out = [];
  for (const uci of (pv ?? []).slice(0, plies)) {
    const m = chess.moves({ verbose: true }).find((x) => toUci(x) === uci);
    if (!m) break;
    chess.move(m);
    out.push(m.san);
  }
  return out.join(' ');
}

/**
 * @param {Engine} engine
 * @param {string} fenBefore  position before the move
 * @param {string} uci        the move actually played, e.g. "g1f3"
 * @param {number} depth
 * @param {object} [o]
 * @param {object} [o.pre]    an analysis of `fenBefore` already in hand, as
 *                            `{ fen, analysis }`. The suggestion ladder runs
 *                            this exact search the moment it becomes your turn,
 *                            so reusing it halves the wait for a grade. Keyed by
 *                            FEN and checked, never assumed: a misread move
 *                            would otherwise attach an analysis to a position
 *                            that never existed.
 */
export async function gradeMove(engine, fenBefore, uci, depth = 18, { pre = null } = {}) {
  const chess = new Chess(fenBefore);
  const mover = chess.turn();

  const move = chess.moves({ verbose: true }).find((m) => toUci(m) === uci);
  if (!move) throw new Error(`illegal move ${uci} in ${fenBefore}`);

  const before = pre?.fen === fenBefore ? pre.analysis : await engine.analyse(fenBefore, depth);

  chess.move(move);
  const fenAfter = chess.fen();
  const after = await engine.analyse(fenAfter, depth);

  // `after` is scored for the opponent (they are to move now), so flip it back
  // into the mover's frame before comparing.
  const afterForMover = negate(after.score);

  const playedBest = before.bestmove === uci;

  // A sacrifice only counts as brilliant if the engine still likes the move:
  // giving material away and being right about it is the whole point.
  const sacrificed = material(fenAfter, mover) < material(fenBefore, mover);

  const verdict = classify({
    before: before.score,
    after: afterForMover,
    playedBest,
    sacrificed,
  });

  return {
    ...verdict,
    uci,
    san: move.san,
    mover,
    fenBefore,
    fenAfter,
    bestMove: before.bestmove,
    bestLine: before.pv,
    // How the opponent punishes this move. For a bad move this is the single
    // most useful thing to explain, and it is what the coach is grounded on.
    refutation: after.pv,
    materialSwing: materialAfterLine(fenAfter, after.pv, mover) - material(fenBefore, mover),
    scoreBefore: before.score,
    scoreAfter: afterForMover,
    /*
     * The `after` search, untouched, in the frame the engine returned it.
     *
     * For a caller walking a whole game this is the next move's `before`: the
     * position after your move is the position your opponent moves from. Handed
     * back as `pre` it halves the searches over a game — and it has to be the
     * real object rather than something rebuilt from the fields above, because
     * `bestmove` is what decides Best, and reconstructing it as `pv[0]` would
     * quietly misgrade the moves where the engine reports the two differently.
     */
    afterAnalysis: after,
  };
}

/**
 * What a line actually nets, as opposed to what it happens to hold partway
 * through it.
 *
 * Counting at a fixed ply lands in the middle of a capture sequence and reports
 * material that comes straight back. Measured: after 1.e4 e5, the engine's line
 * for a free black move runs Nf6 Nc3 d5 exd5 Nxd5 — a four-ply window stops
 * after exd5 and announces White has won a pawn, which Black recaptures on the
 * very next ply. At 2, 6, 8 and at the end of the line the swing is zero.
 *
 * A pv ends where the engine's own search chose to stop, which is as close to a
 * quiet position as anything here gets, so that is where the honest count is.
 */
export function netMaterial(fen, pv, color) {
  if (!pv?.length) return 0;
  return materialAfterLine(fen, pv, color, pv.length) - material(fen, color);
}

/**
 * Material for `color` after playing out `pv` from `fen`.
 * Lets us state the cost as a concrete fact ("you end up a queen down") rather
 * than leaving a language model to infer it from a FEN, which they do badly.
 */
export function materialAfterLine(fen, pv, color, plies = 8) {
  const chess = new Chess(fen);
  for (const uci of (pv ?? []).slice(0, plies)) {
    const m = chess.moves({ verbose: true }).find((x) => toUci(x) === uci);
    if (!m) break;
    chess.move(m);
  }
  return material(chess.fen(), color);
}
