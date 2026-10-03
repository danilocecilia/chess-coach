/**
 * Notation, read out in words.
 *
 * Algebraic notation is a thing you learn by having it decoded beside you until
 * you stop needing the decoding, so the two places that name a move — the
 * report, on hover, and the coach's hint line — both read it out. It lives in
 * its own module because those two are otherwise unrelated: the report builds a
 * page, the coach answers a keypress mid-game, and neither should have to
 * import the other to say "knight takes on f8".
 */

/**
 * A move in notation, read out in words: `Nxf8` -> "knight takes on f8".
 *
 * ## Why it is structural, and not looked up in the position
 *
 * With the position in hand this could say far more — *which* knight, and what
 * it took. It deliberately does not. Half the moves on the report page are
 * inside variations the engine returned, where no position was ever stored, and
 * a reading that works on the move you played but not on the three that answer
 * it teaches the notation in exactly the half of the cases where it is already
 * obvious. Structure is also the thing being learned: that the capital letter is
 * the piece, that `x` is a capture, that the square comes last.
 *
 * ## Why it is shipped as source
 *
 * The report embeds it into the page by `String(sanWords)` rather than writing
 * it inside the page script, so it can be exported and unit-tested as an
 * ordinary function. Everything it needs is inside it — nothing is closed over,
 * because on the other side of that trip there is nothing to close over. Keep it
 * that way: a reference to anything in this module's scope would arrive at the
 * page as a ReferenceError.
 *
 * Returns null for anything that is not a move, which is what keeps this off
 * free text: `your pawn on f5` contains a square, not a move, and a tooltip
 * reading "pawn to f5" over it would be teaching the notation wrongly.
 */
export function sanWords(san) {
  const NAME = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
  const s = String(san == null ? '' : san).trim().replace(/[!?]+$/, '');
  const end = (t) => (/#$/.test(s) ? t + ', checkmate' : /\+$/.test(s) ? t + ', with check' : t);

  if (/^(?:O-O-O|0-0-0)[+#]?$/.test(s)) return end('castles queenside');
  if (/^(?:O-O|0-0)[+#]?$/.test(s)) return end('castles kingside');

  const m = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?[+#]?$/.exec(s);
  if (!m) return null;

  /*
   * A pawn move never says where it came from except to name the file it
   * captures from: `d5` and `exd5` are moves, `d4d5` is not — that is UCI, and
   * reading it as "the pawn on d4 to d5" would put a confident sentence under
   * something this page never writes. Refusing leaves it as plain text.
   */
  if (!m[1] && (m[3] || (m[2] && !m[4]))) return null;
  const piece = m[1] ? NAME[m[1]] : 'pawn';

  // Where it came from, when the notation had to say — two pieces of the same
  // kind could have gone there, which is the whole reason the letter is there.
  let who = piece;
  if (m[2] && m[3]) who = 'the ' + piece + ' on ' + m[2] + m[3];
  else if (m[2]) who = 'the ' + piece + ' on the ' + m[2] + '-file';
  else if (m[3]) who = 'the ' + piece + ' on rank ' + m[3];

  const verb = m[4] ? ' takes on ' : ' to ';
  const promo = m[6] ? ', promoting to a ' + NAME[m[6]] : '';
  return end(who + verb + m[5] + promo);
}

/**
 * The same reading, inline: `Qxe8` -> `Qxe8 (queen takes on e8)`.
 *
 * For the places that say a move out loud rather than render it as a field you
 * can hover — the coach's hint line on the overlay, and the same sentence in the
 * terminal. Neither has a hover, and a hint naming a move you cannot yet read is
 * not a hint.
 *
 * The notation is kept and the words added beside it, rather than replaced: the
 * point is to stop needing this, which only happens if the notation stays in
 * front of you. Anything sanWords refuses comes back untouched, so this is safe
 * on a move that turns out not to be one.
 */
export function spellMove(san) {
  const words = sanWords(san);
  return words ? `${san} (${words})` : String(san ?? '');
}
