/**
 * Turns a pair of engine evaluations into a human label.
 *
 * The important idea here: we never compare raw centipawns. Losing 200cp while
 * already up a queen is meaningless; losing 200cp in a level position loses the
 * game. Converting to win probability first makes the scale match how much the
 * move actually cost you.
 */

/** Lichess's logistic mapping from centipawns to win% (0-100), mover's POV. */
export function winProb(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/**
 * Normalise a Stockfish score into win%. `score` is {cp} or {mate}.
 * A forced mate is a certainty, so it pins to the ends of the scale rather
 * than running through the logistic.
 */
export function scoreToWinProb(score) {
  if (score == null) return 50;
  if (typeof score.mate === 'number') return score.mate > 0 ? 100 : 0;
  return winProb(Math.max(-2000, Math.min(2000, score.cp)));
}

export const LABELS = {
  BRILLIANT:  { name: 'Brilliant',  color: '#1baca6', glyph: '!!' },
  BEST:       { name: 'Best',       color: '#81b64c', glyph: '★'  },
  EXCELLENT:  { name: 'Excellent',  color: '#81b64c', glyph: '!'  },
  GOOD:       { name: 'Good',       color: '#95b776', glyph: '✓'  },
  INACCURACY: { name: 'Inaccuracy', color: '#f7c631', glyph: '?!' },
  MISTAKE:    { name: 'Mistake',    color: '#ffa459', glyph: '?'  },
  BLUNDER:    { name: 'Blunder',    color: '#fa412d', glyph: '??' },
};

/**
 * Grade a move.
 *
 * @param {object} p
 * @param {object} p.before       score before the move, from the mover's POV
 * @param {object} p.after        score after the move, from the mover's POV
 * @param {boolean} p.playedBest  did they play the engine's top choice
 * @param {boolean} p.sacrificed  did the move shed material
 * @returns {{label: object, drop: number, winBefore: number, winAfter: number}}
 */
export function classify({ before, after, playedBest = false, sacrificed = false }) {
  const winBefore = scoreToWinProb(before);
  const winAfter = scoreToWinProb(after);

  // Only losses count. Playing a move that "gains" win% usually just means the
  // engine's earlier pick was deep and it re-scored; that is not the player's doing.
  const drop = Math.max(0, winBefore - winAfter);

  let label;
  if (playedBest && sacrificed) label = LABELS.BRILLIANT;
  else if (playedBest)          label = LABELS.BEST;
  else if (drop < 2)            label = LABELS.EXCELLENT;
  else if (drop < 10)           label = LABELS.GOOD;
  else if (drop < 15)           label = LABELS.INACCURACY;
  else if (drop < 25)           label = LABELS.MISTAKE;
  else                          label = LABELS.BLUNDER;

  return { label, drop, winBefore, winAfter };
}

/**
 * Name a quantity of material the way a player says it out loud.
 * Shared by the grade explanation and the hint ladder, which word the same
 * swing differently ("you end up down a piece" vs "a piece to be won here")
 * but must agree on what to call it.
 */
export function materialWord(points) {
  const n = Math.abs(Math.round(points));
  if (n === 0) return null;
  return { 1: 'a pawn', 3: 'a piece', 5: 'a rook', 8: 'a queen', 9: 'a queen' }[n]
    ?? `${n} points of material`;
}

/** Pretty-print an engine score the way a human reads it: "+1.4", "M3". */
export function formatScore(score) {
  if (score == null) return '?';
  if (typeof score.mate === 'number') return `M${Math.abs(score.mate)}`;
  const pawns = score.cp / 100;
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
}
