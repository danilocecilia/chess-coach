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

/** Best to worst. The material floor takes the worse of two labels. */
const SEVERITY = [
  LABELS.BRILLIANT, LABELS.BEST, LABELS.EXCELLENT, LABELS.GOOD,
  LABELS.INACCURACY, LABELS.MISTAKE, LABELS.BLUNDER,
];

const worse = (a, b) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

/*
 * Where the win-probability scale stops being able to report a loss.
 *
 * Win% is the right measure while the game is live and the wrong one once it is
 * decided, because the logistic runs out of room. Measured on a real game
 * (logs/2026-09-24T20-23-21): at -6.5 a hung bishop cost 0.4 win% and graded
 * Excellent; at -10 a hung rook cost 1.2 and also graded Excellent. The same
 * bishop hung from a level position costs 25.7 and grades Blunder.
 *
 * So outside this band the label cannot come from win% alone, and the floor
 * below takes over. Inside it the floor stays out of the way — which is what
 * keeps a sound sacrifice sound: giving up a piece and holding the evaluation
 * is a real sacrifice while the game is live, and that is exactly the case
 * win% already grades correctly.
 */
const LIVE = { low: 25, high: 75 };

/** Material left takeable, and the best the move can still grade. */
const FLOOR = [
  { lost: 5, label: LABELS.BLUNDER },   // a rook, a queen, a piece for nothing
  { lost: 2, label: LABELS.MISTAKE },   // the exchange, or a piece for a pawn
];

/**
 * Grade a move.
 *
 * @param {object} p
 * @param {object} p.before       score before the move, from the mover's POV
 * @param {object} p.after        score after the move, from the mover's POV
 * @param {boolean} p.playedBest  did they play the engine's top choice
 * @param {boolean} p.sacrificed  did the move shed material
 * @param {number} p.hanging      material the move leaves takeable, in pawns,
 *                                from the mover's POV — `hangingMaterial` in
 *                                grade.js. Zero or negative. Only consulted
 *                                once the game is decided; see LIVE above.
 * @param {boolean} p.mated       did this move deliver checkmate. Asked of the
 *                                board, not of a score, for the reason below.
 * @returns {{label: object, drop: number, winBefore: number, winAfter: number,
 *            floored: boolean}}
 */
export function classify({
  before, after, playedBest = false, sacrificed = false, hanging = 0, mated = false,
}) {
  const winBefore = scoreToWinProb(before);

  /*
   * Mate is the one result a score cannot report in the mover's frame.
   *
   * UCI writes `mate 0` for "the side to move is mated", so the position after
   * your mating move comes back as `{mate: 0}` — and negating it into your frame
   * gives `{mate: -0}`, which is not greater than zero, so `scoreToWinProb`
   * reads the win as 0%. Measured on a real game: `Qxf1#` graded **Blunder,
   * -100%** for winning, and five more mates recorded a 100% drop each, held to
   * Best only because they happened to be the engine's own move too.
   *
   * There is no number that fixes this, because `mate 0` is genuinely asymmetric
   * — the same score means "I lost" to one side and "I won" to the other. So the
   * question is asked of the board instead, where it is a fact, and answered
   * before any of the bands below: ending the game is the best a move can be,
   * however much material it gave up to do it.
   */
  if (mated) {
    return {
      label: sacrificed ? LABELS.BRILLIANT : LABELS.BEST,
      drop: 0, winBefore, winAfter: 100, floored: false,
    };
  }

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

  /*
   * The engine's own move is exempt. In a lost position the best move on the
   * board often still sheds something, and "Stockfish's first choice" is not a
   * mistake however it is paid for — the same reason a sacrifice it picks
   * grades Brilliant rather than Blunder.
   */
  const decided = winBefore < LIVE.low || winBefore > LIVE.high;
  const floor = playedBest || !decided
    ? null
    : FLOOR.find((f) => -hanging >= f.lost)?.label ?? null;

  // A floor, never a ceiling: it can only make a label worse. A move that hangs
  // a bishop *and* costs 40% of the win probability stays a Blunder.
  if (floor) label = worse(label, floor);

  return { label, drop, winBefore, winAfter, floored: Boolean(floor) };
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
