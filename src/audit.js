/**
 * What is wrong with your position, right now, with no engine involved.
 *
 * This is the half of coaching that is not about tactics: a piece nobody is
 * defending, a king still sitting in the centre, a rook that has not played a
 * move all game. A coach names these out loud, and every one of them is a fact
 * about the board rather than a judgement about it — so chess.js can find them
 * exactly, for free, and there is nothing for a model to hallucinate.
 *
 * The first version of the hint system had none of this. It was organised
 * around withholding the engine's move, which made "what can I say that is not
 * the move" the guiding question, and the answers came out as directionless
 * noise ("look at the kingside"). Naming a weakness in *your* position is the
 * opposite: it points at the problem, which is the part you are supposed to
 * solve.
 */

/** King is not capturable, so it must outrank everything as a target. */
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 99 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const other = (c) => (c === 'w' ? 'b' : 'w');

/** Home squares, for spotting a piece that has not played a move all game. */
const HOME = {
  w: { b1: 'n', g1: 'n', c1: 'b', f1: 'b', a1: 'r', h1: 'r' },
  b: { b8: 'n', g8: 'n', c8: 'b', f8: 'b', a8: 'r', h8: 'r' },
};

/** Every square holding a piece of `color`. */
function piecesOf(chess, color) {
  const out = [];
  for (const row of chess.board()) {
    for (const sq of row) if (sq && sq.color === color) out.push(sq);
  }
  return out;
}

/**
 * Pieces of `color` that are attacked and not adequately answered.
 *
 * Three separate problems, which a coach words differently because they need
 * different responses: nothing defends it, something cheaper attacks it, or it
 * is simply outnumbered.
 */
export function loosePieces(chess, color) {
  const them = other(color);
  const out = [];

  for (const { square, type } of piecesOf(chess, color)) {
    if (type === 'k') continue;                     // king safety is its own check
    const attackers = chess.attackers(square, them);
    if (!attackers.length) continue;

    // attackers() of your own square, by your own colour, is the defender list.
    const defenders = chess.attackers(square, color);
    const worth = VALUE[type];
    const cheapest = Math.min(...attackers.map((s) => VALUE[chess.get(s).type]));
    const what = `your ${NAME[type]} on ${square}`;

    if (!defenders.length) {
      out.push({ kind: 'hanging', square, severity: 100 + worth,
        text: `${what} is hanging — nothing is defending it` });
    } else if (cheapest < worth) {
      out.push({ kind: 'cheaper', square, severity: 50 + (worth - cheapest),
        text: `${what} is attacked by something cheaper than it` });
    } else if (attackers.length > defenders.length) {
      out.push({ kind: 'outnumbered', square, severity: 20 + worth,
        text: `${what} is attacked ${attackers.length} times and defended ${defenders.length}` });
    }
  }
  return out;
}

/** Minor pieces of `color` still sitting on their starting squares. */
function sleepingMinors(chess, color) {
  return Object.entries(HOME[color])
    .filter(([sq, type]) => 'nb'.includes(type)
      && chess.get(sq)?.type === type && chess.get(sq)?.color === color)
    .map(([sq]) => sq);
}

/**
 * A king still in the middle, while the opponent still has the pieces to punish
 * it. Both halves matter: a central king in a bare endgame is correct play.
 *
 * Deliberately silent in the opening. "Your king is still in the centre" is
 * true on move one and useless there, and filling the answer with things that
 * are technically true is exactly what made the first version of these hints
 * worthless. So it speaks when the weakness is real: the rights are gone and
 * the king is stuck, or you have developed and simply forgotten to castle.
 */
export function kingSafety(chess, color) {
  const them = other(color);
  const king = piecesOf(chess, color).find((p) => p.type === 'k');
  if (!king) return [];

  const file = king.square[0];
  if (file !== 'd' && file !== 'e') return [];

  const heavy = piecesOf(chess, them).filter((p) => p.type === 'q' || p.type === 'r');
  if (!heavy.length) return [];

  const rights = chess.getCastlingRights(color);
  const stuck = !rights.k && !rights.q;
  if (stuck) {
    return [{ kind: 'king', square: king.square, severity: 80,
      text: `your king is stuck in the centre on ${king.square} and can no longer castle` }];
  }
  // Still allowed to castle: only worth raising once the pieces are out and
  // castling is the move you are plainly putting off.
  if (sleepingMinors(chess, color).length > 1) return [];
  return [{ kind: 'king', square: king.square, severity: 60,
    text: `your pieces are out but your king is still on ${king.square} — castle` }];
}

/**
 * Pieces that have not moved at all.
 *
 * Not before move 6: every piece is at home on move one, and saying so is
 * noise rather than advice.
 */
export function development(chess, color) {
  const moveNumber = Number(chess.fen().split(' ')[5]) || 1;
  if (moveNumber < 6) return [];

  const minors = sleepingMinors(chess, color);
  if (minors.length < 2) return [];
  return [{
    kind: 'development',
    square: minors[0],
    severity: 10 + minors.length,
    text: `${minors.length} of your pieces have not moved yet (${minors.join(', ')})`,
  }];
}

/**
 * Everything worth saying about `color`'s position, worst first.
 * Ordered by severity so that pressing the key repeatedly walks down from the
 * thing that loses a game to the thing that merely loses time.
 */
export function audit(chess, color) {
  return [
    ...loosePieces(chess, color),
    ...kingSafety(chess, color),
    ...development(chess, color),
  ].sort((a, b) => b.severity - a.severity);
}
