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
 * A UCI principal variation walked out, one step at a time: `{ uci, san }` per
 * ply. Stops early rather than throwing if a line does not play out, since a pv
 * is only as legal as the position it was searched from.
 *
 * Both halves are worth keeping. SAN is the only form a player reads, and UCI
 * is the only form that says which square a piece came from without parsing
 * SAN — which is what lets the report animate a line in the browser without
 * carrying a move generator into the page.
 */
export function pvSteps(fen, pv, plies = 6) {
  const chess = new Chess(fen);
  const out = [];
  for (const uci of (pv ?? []).slice(0, plies)) {
    const m = chess.moves({ verbose: true }).find((x) => toUci(x) === uci);
    if (!m) break;
    chess.move(m);
    out.push({ uci, san: m.san });
  }
  return out;
}

/**
 * The other direction: the same line as readable SAN, e.g. "Nxe5 Qh4 Nf3".
 */
export function pvToSan(fen, pv, plies = 6) {
  return pvSteps(fen, pv, plies).map((s) => s.san).join(' ');
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

  /*
   * A mating move ends the game, so there is nothing after it to search.
   *
   * Asking anyway is not merely wasted: Stockfish answers `mate 0` for a mated
   * board, which negates to `-0` and grades the win as a total loss. `classify`
   * takes `mated` and settles it from the board instead — see the note there.
   * The stand-in keeps the shape every field below reads, with an empty line,
   * because a game that is over has no continuation to quote.
   */
  const mated = chess.isCheckmate();
  const after = mated
    ? { bestmove: null, score: { mate: 0 }, pv: [], depth: 0, lines: [] }
    : await engine.analyse(fenAfter, depth);

  // `after` is scored for the opponent (they are to move now), so flip it back
  // into the mover's frame before comparing.
  const afterForMover = mated ? { mate: 0 } : negate(after.score);

  const playedBest = before.bestmove === uci;

  // A sacrifice only counts as brilliant if the engine still likes the move:
  // giving material away and being right about it is the whole point.
  const sacrificed = material(fenAfter, mover) < material(fenBefore, mover);

  // What the move leaves takeable. Once the game is decided this is the only
  // thing left that can tell a hung rook from a quiet move, because by then the
  // win% scale reports both as nothing.
  const hanging = hangingMaterial(fenAfter, mover);
  const exchange = exchangeSwing(fenBefore, fenAfter, after.pv, mover);

  const verdict = classify({
    before: before.score,
    after: afterForMover,
    playedBest,
    sacrificed,
    hanging,
    mated,
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
    /*
     * Two different material questions, both recorded because they answer
     * different things and disagreeing is informative.
     *
     * `hanging` is what the move leaves takeable, asked of the board — it is
     * what the label was floored on, and a log without it cannot explain a
     * Mistake sitting next to a 0.4% drop. `exchange` is what the engine's own
     * line takes, which is what the review quotes back to you.
     */
    hanging,
    exchange,
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
 * What the move costs *now*, over the capture sequence that answers it.
 *
 * Not `netMaterial` over the whole pv. That is the right measure for "what does
 * this line finally win" — it is why `netMaterial` counts at the end of a pv
 * rather than at a fixed ply — and it is the wrong measure for "what did this
 * move drop", because a piece handed over now and a pawn structure repaired
 * nine plies later come out as zero.
 *
 * Both failures were measured on one real game. `Ng5` is met by `Qxg5` and the
 * knight is simply gone; over the full line the material came back and the move
 * was filed as a *positional* concession while losing 65% of the win
 * probability. In the same game a 15% inaccuracy was announced as leaving you
 * "a queen down", because the engine's line went on to a queen trade neither
 * side was forced into.
 *
 * So: play out the captures and stop at the first quiet move. That is the
 * exchange the move actually invited, and it is over by the time anybody has a
 * choice about anything else.
 *
 * @param {string} fenBefore   position before the move
 * @param {string} fenAfter    position after it
 * @param {string[]} refutation  the engine's line from `fenAfter`
 * @param {string} color       whose material to count, 'w' or 'b'
 * @returns {number} pawns netted, from `color`'s POV; negative is material shed
 */
export function exchangeSwing(fenBefore, fenAfter, refutation, color) {
  if (!refutation?.length) return 0;
  const chess = new Chess(fenAfter);
  let plies = 0;
  for (const uci of refutation) {
    const m = chess.moves({ verbose: true }).find((x) => toUci(x) === uci);
    if (!m?.captured) break;                        // the sequence has gone quiet
    chess.move(m);
    plies++;
  }
  return plies ? material(chess.fen(), color) - material(fenBefore, color) : 0;
}

/**
 * What one capture is worth once both sides have finished taking on the square.
 *
 * Standard static exchange evaluation: take, then let the defender recapture if
 * recapturing gains anything, alternating down to the square going quiet. The
 * `Math.max(0, …)` is the right to stand pat — nobody is obliged to recapture
 * into a loss, and a swap that only works because the opponent is forced to
 * continue is not a swap that wins material.
 *
 * Legality comes from `chess.js`, so a defender that is pinned does not count
 * as a defender. What this deliberately cannot see is the tactic *around* the
 * square — a discovery that makes the recapture impossible, a piece that is
 * loose for a move and defended the next. That is the accepted cost of SEE, and
 * it is the same thing a player does when they count attackers and defenders.
 */
function see(chess, move) {
  const gain = VALUE[move.captured];
  chess.move(move);
  let best = 0;
  for (const r of chess.moves({ verbose: true })) {
    if (r.to === move.to && r.captured) best = Math.max(best, see(chess, r));
  }
  chess.undo();
  return gain - best;
}

/**
 * The most material the side to move can simply take, from `color`'s POV.
 *
 * This is the question the grade needs once the game is decided, and it has to
 * be asked of the position rather than of the engine's line. `exchangeSwing`
 * reads the refutation Stockfish returned, which is the right thing when the
 * position is still competitive and unreliable when it is not: in a position
 * that is winning six different ways the engine has no reason to prefer the
 * one that happens to pick up the hanging piece.
 *
 * Measured on the same game, re-graded at depth 18: `Bb2` leaves the bishop
 * takeable on b2 and `Re7` leaves a rook takeable on e7, and in neither case
 * did the returned pv begin with the capture — so a floor that trusted the pv
 * saw nothing to floor. Asking the board directly is stable across runs,
 * because it does not depend on which winning line the search settled on.
 *
 * @returns {{points: number, move: object}|null} the capture and what it wins,
 *   in pawns, or null if nothing of `color`'s can simply be taken
 */
export function hangingCapture(fen, color) {
  const chess = new Chess(fen);
  if (chess.turn() === color) return null;     // not the opponent's move to take
  let best = null;
  for (const m of chess.moves({ verbose: true })) {
    if (!m.captured) continue;
    const points = see(chess, m);
    if (points > 0 && points > (best?.points ?? 0)) best = { points, move: m };
  }
  return best;
}

/** The same question as a number, from `color`'s POV: 0 or negative. */
export function hangingMaterial(fen, color) {
  const points = hangingCapture(fen, color)?.points ?? 0;
  return points ? -points : 0;              // not -0, which reads badly and compares worse
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
