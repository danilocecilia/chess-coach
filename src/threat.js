/**
 * What is the opponent actually threatening?
 *
 * This is the first question a coach asks, and it is almost never "what is the
 * best move". Amateurs lose games to the move they did not look at, not to the
 * move they failed to find — so pointing at the opponent's idea teaches more
 * than pointing at your own.
 *
 * It is computed by handing them a free move: flip the side to move and search.
 * Whatever the engine plays is, by definition, the thing they most want to do
 * next. Costs one shallow search, and only when you actually ask for it.
 */

import { Chess } from 'chess.js';
import { netMaterial } from './grade.js';
import { scoreToWinProb } from './verdict.js';

/**
 * How much a free move must be worth before it counts as a threat.
 *
 * A free move is worth something in *any* position, so the bar cannot be zero.
 * Measured across quiet positions the cost of passing ran 3.4 to 6.3 win
 * percent; across positions with a real threat, 30.1 to 50.6. Fifteen sits in
 * the middle of that gap and is also the grader's own Mistake boundary, so
 * "serious" means the same thing here as it does in a verdict.
 */
const SERIOUS_WIN_PCT = 15;

/**
 * The position with the turn handed over, en passant dropped because it cannot
 * survive a pass. Only meaningful when the side passing is not in check: with
 * your king already attacked, "what if they moved again" means "what if they
 * took your king", and the search returns nonsense.
 */
export function nullMoveFen(fen) {
  const p = fen.split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[3] = '-';
  return p.join(' ');
}

/**
 * @param {Engine} engine
 * @param {string} fen      the real position, with you to move
 * @param {object} now      your own analysis of `fen`, for the before/after
 * @param {string} color    your colour
 * @returns {object} one of: {check}, {none}, or a described threat
 */
export async function findThreat(engine, fen, now, color, depth = 12) {
  const chess = new Chess(fen);
  // Being in check is not a threat to be discovered; it is already happening.
  if (chess.isCheck()) return { check: true };

  const passed = nullMoveFen(fen);
  const a = await engine.analyse(passed, depth);
  if (!a.bestmove) return { none: true };

  const after = new Chess(passed);
  const move = after.moves({ verbose: true })
    .find((m) => m.from + m.to + (m.promotion ?? '') === a.bestmove);
  if (!move) return { none: true };

  // Their score is from their side; put it back in your frame to compare with
  // where you stand now. The gap is what the free move would be worth to them.
  const mineNow = scoreToWinProb(now?.lines?.[0]?.score ?? now?.score ?? null);
  const mineAfter = 100 - scoreToWinProb(a.score);
  const costsWinPct = mineNow - mineAfter;

  const costsMaterial = -netMaterial(passed, a.pv, color);
  const mate = typeof a.score?.mate === 'number' && a.score.mate > 0 ? a.score.mate : null;

  return {
    san: move.san,
    from: move.from,
    to: move.to,
    // What they would be hitting. Null for a quiet build-up move.
    target: chess.get(move.to) ?? null,
    costsWinPct,
    costsMaterial,
    mate,
    serious: Boolean(mate) || costsMaterial > 0 || costsWinPct >= SERIOUS_WIN_PCT,
  };
}
