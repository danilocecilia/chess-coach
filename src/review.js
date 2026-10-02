/**
 * What you keep getting wrong.
 *
 * The grader answers "was that move bad" one move at a time, and that answer
 * goes up the scrollback the moment the next move lands. It never answers the
 * question the player actually has, which is the one a coach is for: *what do I
 * keep doing?*
 *
 * One blunder is an accident. Three blunders that are all "left a piece nobody
 * was defending" is a habit, and a habit is the thing worth training. That
 * pattern only exists across moves and across games, so it needs something that
 * looks at a whole game at once — which is all this is.
 *
 * ## Nothing here guesses
 *
 * Same rule as everywhere else in this project: the engine measures and nothing
 * invents. Every fault named below is a fact `chess.js` can check against a
 * position we stored and a line Stockfish actually returned — is the captured
 * piece defended, was that move already legal before yours, does this knight hit
 * two pieces at once. No model is asked what it thinks the problem was, for the
 * same reason `audit.js` does not ask one what is weak: the honest answer is
 * already computable, and a model could only blur it.
 *
 * So there is no fault here for "you play the opening badly" or "you are
 * impatient". Those may well be true and this file has no way to know them.
 *
 * ## Severity is the grader's, not a new one
 *
 * Faults are ranked by the win probability the move actually cost — `drop`,
 * straight from `classify()`. This file introduces no second opinion about how
 * bad anything is; it only says *what kind* of bad it was. So the review can
 * never disagree with the grade you were shown while playing.
 */

import { Chess } from 'chess.js';
import { exchangeSwing, hangingCapture, netMaterial, pvSteps, pvToSan } from './grade.js';
import { materialWord, scoreToWinProb } from './verdict.js';
import { kingSafety } from './audit.js';
import { nullMoveFen } from './threat.js';

/** Piece names, as a player says them out loud. */
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** For "is this worth winning": the king is not capturable, so it tops the scale. */
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 99 };

const other = (c) => (c === 'w' ? 'b' : 'w');

/** Grades arrive as an object from `gradeMove` and as a string from the log. */
export function labelName(g) {
  return typeof g.label === 'string' ? g.label : g.label?.name ?? '?';
}

/** The labels a review has anything to say about. */
const BAD = ['Inaccuracy', 'Mistake', 'Blunder'];
export const isBad = (g) => BAD.includes(labelName(g));

/* ------------------------------------------------------------ accuracy ---- */

/**
 * Lichess's published per-move accuracy curve.
 *
 * Deliberately borrowed rather than invented: the number is only useful if it
 * means the same thing as the number on the site you played the game on. A move
 * that costs nothing is 100%, and accuracy falls away sharply — 10% of win
 * probability is already down at 66%, which matches how much worse a Mistake
 * feels than an Inaccuracy.
 *
 * @param {number} drop  win probability lost, 0-100, as `classify` computes it
 */
export function moveAccuracy(drop) {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

/* --------------------------------------------------------------- phase ---- */

/** Non-king material on the board, both sides, in pawns. The opening is 78. */
export function totalMaterial(fen) {
  const board = new Chess(fen).board();
  let total = 0;
  for (const row of board) {
    for (const sq of row) {
      if (sq && sq.type !== 'k') total += { p: 1, n: 3, b: 3, r: 5, q: 9 }[sq.type];
    }
  }
  return total;
}

/**
 * Which part of the game a position is in.
 *
 * Phase is here to answer "where does it go wrong for me" — a player who is
 * level out of the opening and loses every endgame needs to hear that, and it
 * is invisible in a flat list of blunders.
 *
 * Both halves of each test matter. Move number alone calls a queenless
 * simplified position at move 9 an opening; material alone calls a sharp
 * gambit where everything is still on at move 30 an opening. The thresholds are
 * deliberately loose, because the only thing being asked of them is which third
 * of the game to file a mistake under.
 */
export function phaseOf(fen) {
  const moveNumber = Number(fen.split(' ')[5]) || 1;
  const left = totalMaterial(fen);
  const queens = (fen.split(' ')[0].match(/[qQ]/g) ?? []).length;

  // Two ways to be an endgame: very little left, or the queens are off and what
  // remains is thin. 24 is roughly a rook and a bishop each, plus pawns.
  if (left <= 24 || (queens === 0 && left <= 32)) return 'endgame';
  // Still nearly everything on the board, and early: nobody has done anything yet.
  if (moveNumber <= 12 && left >= 68) return 'opening';
  return 'middlegame';
}

/* -------------------------------------------------------------- faults ---- */

/** Squares of `color`'s pieces, king included. */
function piecesOf(chess, color) {
  const out = [];
  for (const row of chess.board()) {
    for (const sq of row) if (sq && sq.color === color) out.push(sq);
  }
  return out;
}

/** The refutation's first move, resolved against the position it is played in. */
function punishing(fenAfter, refutation) {
  if (!fenAfter || !refutation?.length) return null;
  const chess = new Chess(fenAfter);
  return chess.moves({ verbose: true })
    .find((m) => m.from + m.to + (m.promotion ?? '') === refutation[0]) ?? null;
}

/**
 * Was his punishing move already available *before* you moved?
 *
 * This is the difference between walking into something and ignoring something,
 * and they are different mistakes with different fixes. If the move that
 * punishes you was already legal a ply earlier, he was already threatening it
 * and you looked somewhere else — which is, per `threat.js`, the thing amateurs
 * actually lose games to.
 *
 * Asked by handing him the move in the earlier position, exactly as the `t`
 * topic does. Compared on from+to rather than SAN, because SAN is relative to
 * the position it is written in: the same knight jump is `Nxe5` in one and
 * `Ne5` in the other, and it is the same idea either way.
 */
function available(fenBefore, m1) {
  if (!fenBefore || !m1) return false;
  try {
    const passed = new Chess(nullMoveFen(fenBefore));
    return passed.moves({ verbose: true })
      .some((m) => m.from === m1.from && m.to === m1.to);
  } catch {
    // nullMoveFen on a position where he is already in check is meaningless,
    // and chess.js refuses to load it. Not a threat he was making, then.
    return false;
  }
}

/**
 * Was the piece he captures already standing there, already attackable?
 *
 * `available` on its own is too weak for a capture. A rook that could always
 * have moved to an empty d4 satisfies it, and then the knight you put on d4
 * this move gets reported as a threat you ignored — which is exactly backwards.
 * So a capture has to clear the stronger bar: the piece was on that square
 * before you moved, and taking it was already legal then.
 *
 * That is the line between the two mistakes. A piece that was already hanging
 * and that you left there is a threat you did not answer; a piece that became
 * capturable because of the move you just played is one you hung.
 */
function standing(fenBefore, m1, you) {
  if (!fenBefore || !m1?.captured) return false;
  const was = new Chess(fenBefore).get(m1.to);
  return Boolean(was) && was.color === you && was.type === m1.captured
    && available(fenBefore, m1);
}

/**
 * What the move costs over the capture sequence that answers it.
 *
 * Lives in `grade.js` because the grader needs the same number: it is what the
 * material floor in `classify` is applied to. The long argument for measuring
 * it this way rather than over the whole pv is on the function itself.
 *
 * Recomputed here rather than read off `g.exchange` so that a session logged
 * before the grader recorded it still reviews correctly.
 */
const immediateSwing = (g, you) => exchangeSwing(g.fenBefore, g.fenAfter, g.refutation, you);

/** Pieces of `color` that `from` attacks, worth at least `worth`. */
function hitsFrom(chess, from, color, worth) {
  return piecesOf(chess, color)
    .filter((p) => VALUE[p.type] >= worth && chess.attackers(p.square, other(color)).includes(from))
    .map((p) => `${NAME[p.type]} on ${p.square}`);
}

/**
 * Why one bad move was bad.
 *
 * Ordered, first match wins, most specific first — a move that hangs a rook
 * *and* is positionally loose is filed as hanging a rook, because that is the
 * thing to work on. Every branch is a measurement on positions we stored and
 * lines the engine returned; none of it is an opinion about the position.
 *
 * Returns null when the log does not carry enough to say — an older session, or
 * a grade written before this existed. Saying nothing is correct there, and the
 * report prints what is missing rather than inventing a fault to fill the row.
 *
 * @param {object} g  a graded move: fenBefore/fenAfter, refutation, bestLine,
 *                    bestMove, materialSwing, scoreBefore/After
 * @param {object} [o]
 * @param {boolean} [o.nameBest] two of these sentences end in "— Nf6 instead",
 *                    which is the right way to read a *finished* game and the
 *                    wrong way to read one you are still being asked to solve.
 *                    A drill passes false and decides for itself when the move
 *                    is given up; see the ladder in `play.js`.
 * @returns {{kind: string, text: string, line: string|null}|null}
 */
export function faultOf(g, { nameBest = true } = {}) {
  if (!g?.fenBefore || !g.fenAfter) return null;

  const you = g.mover ?? new Chess(g.fenBefore).turn();
  const them = other(you);
  const m1 = punishing(g.fenAfter, g.refutation);
  const line = m1 ? pvToSan(g.fenAfter, g.refutation, 5) : null;
  const swing = immediateSwing(g, you);
  // Whether you initiated this yourself. A piece taken after you captured is an
  // exchange you chose and misjudged; the same piece taken after a quiet move is
  // one you left standing there. Same loss, different mistake.
  const traded = g.san?.includes('x') ?? false;
  const bestSan = g.bestMove ? pvToSan(g.fenBefore, [g.bestMove], 1) : null;
  const instead = nameBest && bestSan ? ` — ${bestSan} instead` : '';

  /*
   * Mate first, and before any material test, because a mating attack is
   * usually *paid for* in material: counting the sacrifice would file a forced
   * mate as "you won a piece", which is true and completely beside the point.
   */
  const mateOn = typeof g.scoreAfter?.mate === 'number' && g.scoreAfter.mate < 0;
  const mateBefore = typeof g.scoreBefore?.mate === 'number' && g.scoreBefore.mate < 0;
  if (mateOn && !mateBefore) {
    const n = Math.abs(g.scoreAfter.mate);
    return {
      kind: 'allowed-mate',
      text: `${g.san} allows mate in ${n}${line ? ` — ${line}` : ''}`,
      line,
    };
  }

  /*
   * He takes something. Three different mistakes wear this shape, and they are
   * told apart by two local facts — was the piece defended, and did you start
   * the exchange — rather than by how the line eventually nets out.
   *
   * A defended piece taken by something of equal value is an ordinary trade and
   * is not a fault at all, so it falls through to the branches below.
   */
  if (m1 && m1.captured) {
    const undefended = !new Chess(g.fenAfter).attackers(m1.to, you).length;
    const cheaper = VALUE[m1.piece] < VALUE[m1.captured];
    if (undefended || cheaper || swing <= -1) {
      const what = `your ${NAME[m1.captured]} on ${m1.to}`;
      if (standing(g.fenBefore, m1, you)) {
        return {
          kind: 'missed-threat',
          text: `${what} was already attacked before ${g.san}, and ${m1.san} takes it`,
          line,
        };
      }
      if (traded) {
        // A recapture on the same square prints the same SAN as your own move,
        // and "Nxd5 ... — Nxd5 answers" reads like a typo rather than a reply.
        const answer = m1.san === g.san ? `he takes back on ${m1.to}` : `${m1.san} answers`;
        return {
          kind: 'lost-material',
          text: `${g.san} starts an exchange that loses it — ${answer}`
            + (materialWord(swing) ? `, and you come out ${materialWord(swing)} down` : ''),
          line,
        };
      }
      if (undefended) {
        return { kind: 'hung', text: `${what} had nothing defending it — ${m1.san} wins it`, line };
      }
      // Defended, and you did not start it — so either something cheaper takes
      // it, or the defence simply is not enough. Those read differently and the
      // branch is reached by either, so it must not claim the wrong one.
      return {
        kind: 'lost-material',
        text: cheaper
          ? `${what} is taken by something cheaper — ${m1.san}`
          : `${what} is not defended well enough — ${m1.san} costs you`
            + ` ${materialWord(swing) ?? 'the exchange'}`,
        line,
      };
    }
  }

  /*
   * The same fault, reached when the engine's line does not happen to take it.
   *
   * Every branch above reads the refutation, which is sound while the position
   * is competitive and unreliable once it is not: a side that is winning six
   * ways has no reason to return the line that picks up the loose piece. On the
   * game this was written for, `Bb2` hung a bishop and `Re7` hung a rook, and
   * on a re-grade neither pv began with the capture — so the branches above saw
   * nothing and the move came back "a positional concession", or worse, a
   * *missed win*, while a piece stood there to be taken.
   *
   * So ask the board instead, exactly as the grade's material floor does. This
   * has to agree with the label: a move floored to Mistake for hanging a piece
   * and then explained as positional is worse than either alone.
   */
  const hung = hangingCapture(g.fenAfter, you);
  if (hung && hung.points >= 2) {
    const what = `your ${NAME[hung.move.captured]} on ${hung.move.to}`;
    const cost = materialWord(hung.points) ?? `${hung.points} points`;
    if (standing(g.fenBefore, hung.move, you)) {
      return {
        kind: 'missed-threat',
        text: `${what} was already attacked before ${g.san}, and ${hung.move.san} still wins it`,
        line: hung.move.san,
      };
    }
    return {
      kind: 'hung',
      text: `${g.san} leaves ${what} there for nothing — ${hung.move.san} wins ${cost}`,
      line: hung.move.san,
    };
  }

  /*
   * There is deliberately no quiet version of that branch.
   *
   * It is tempting to say the same thing about a punishing move that captures
   * nothing — he could already have played it, so you ignored it — but
   * `available` carries no weight there. Almost every quiet move is legal a ply
   * earlier too, so the test fires on ordinary moves and files half the game
   * under "threats you ignored". Measured on the test positions: Nc2+ forking
   * king and rook, and a plain king step, both pass it.
   *
   * Proving a *quiet* threat means asking what the position was worth before
   * and after a free move, which is a search — `findThreat` in `threat.js` does
   * exactly that, and costs an engine this file does not have. So the quiet
   * case is left to the branches below, which name what actually happened
   * instead of guessing at what he intended.
   */

  if (m1) {
    // The position his punishing move creates, which is where the fork is.
    const after = new Chess(g.fenAfter);
    after.move(m1);
    const worth = VALUE[m1.piece];
    const hit = hitsFrom(after, m1.to, you, worth);
    // In check the king is one of the two things hit, and it is the reason the
    // fork works: you must answer the check and the other piece drops.
    const targets = after.isCheck() ? ['king', ...hit.filter((h) => !h.startsWith('king'))] : hit;
    if (targets.length >= 2) {
      return {
        kind: 'fork',
        text: `${m1.san} hits your ${targets.slice(0, 2).join(' and your ')} at once`,
        line,
      };
    }
  }

  if (swing <= -1) {
    return {
      kind: 'lost-material',
      text: `the exchanges after ${g.san} leave you ${materialWord(swing)} down${instead}`,
      line,
    };
  }

  /*
   * Nothing was given away — so the cost is what was passed up. Worth keeping
   * separate from every branch above: "you dropped a piece" and "you had a
   * piece to win and did not take it" feel the same in the grade and are
   * completely different things to practise.
   */
  const bestMate = typeof g.scoreBefore?.mate === 'number' && g.scoreBefore.mate > 0;
  if (bestMate && !(typeof g.scoreAfter?.mate === 'number' && g.scoreAfter.mate > 0)) {
    return {
      kind: 'missed-win',
      text: `you had mate in ${g.scoreBefore.mate}${bestSan ? ` with ${bestSan}` : ''}, and ${g.san} lets it go`,
      line: g.bestLine ? pvToSan(g.fenBefore, g.bestLine, 5) : null,
    };
  }
  if (g.bestLine?.length) {
    const won = netMaterial(g.fenBefore, g.bestLine, you);
    if (won >= 1) {
      return {
        kind: 'missed-win',
        text: `there was ${materialWord(won)} to be won${bestSan ? ` with ${bestSan}` : ''}, and ${g.san} passes it up`,
        line: pvToSan(g.fenBefore, g.bestLine, 5),
      };
    }
  }

  /*
   * The king was already a problem before this move and this move did not
   * address it. Checked late on purpose: if the attack has already produced a
   * concrete cost, one of the branches above has named it, and naming the cost
   * beats naming the condition that allowed it.
   */
  const before = new Chess(g.fenBefore);
  const king = kingSafety(before, you);
  if (king.length && (m1?.san.includes('+') || g.drop >= 10)) {
    return { kind: 'king-safety', text: `${king[0].text} — and ${g.san} does not fix it`, line };
  }

  return {
    kind: 'positional',
    text: `no material changes hands here — ${g.san} is a positional concession${instead}`,
    line,
  };
}

/**
 * How each fault reads as a heading, as a thing to go and work on, and as
 * something to learn from.
 *
 * `title` and `work` are the terminal's: `summarise()` and `tools/review.mjs`
 * print them, and they must stay one line each. The rest is the page's, and it
 * is the difference between a report that names your mistake and one you get
 * better from:
 *
 *   what       what the fault actually is, in a sentence
 *   why        why a human makes it — the attention failure behind it, not a
 *              restatement of the rule. This is the part that transfers: you
 *              cannot watch for a mistake you only know the name of
 *   checklist  what to do at the board, in order, while you still have the move
 *   drill      one thing to practise away from a game
 *
 * Written here, by hand, and not generated. Same rule as the rest of this file
 * and as `audit.js`: a model asked "why do players hang pieces" produces
 * plausible text that varies per run and is accountable to nobody, where the
 * honest answer is a short fixed piece of chess knowledge that either is or is
 * not good advice. It is also the one part of the page that must read the same
 * way twice, because it is the part you are supposed to remember.
 */
export const FAULTS = {
  'allowed-mate': {
    title: 'Walking into mate',
    work: 'check what his last move opened up before you commit to yours',
    what: 'Your move let a forced mate begin. Material stops counting the moment the king cannot be saved.',
    why: 'Mate arrives while you are counting something else. Checks and captures near your king change a position much faster than a material plan does, so a move that is right about the pawns can be losing on the spot.',
    checklist: [
      'After your candidate move, list every check he has — all of them, not the good-looking ones.',
      'For each check, find where your king goes. One legal square is a warning.',
      'Count his pieces aimed at your king against the ones defending it.',
      'If the count is against you, spend the move on defence. A tempo is cheaper than the game.',
    ],
    drill: 'Take the position before the mate, find his mating move yourself, then find the quiet move that would have stopped it.',
  },
  hung: {
    title: 'Hanging pieces',
    work: 'before you move, look at what of yours is undefended',
    what: 'You left a piece where it could simply be taken.',
    why: 'You checked what his last move threatened and not what your move stopped defending. A piece is usually hung by the move that walks away from it, not by the move that put it there — which is why it feels like it came from nowhere.',
    checklist: [
      'Picture the board as it will be after your move, not as it is now.',
      'Name every piece of yours that nothing defends.',
      'For each one, count his attackers.',
      'Only then play the move.',
    ],
    drill: 'For one whole game, say your undefended pieces out loud before every move. It costs ten seconds and it is the cheapest habit on this page.',
  },
  'missed-threat': {
    title: 'Ignoring his threat',
    work: 'after every one of his moves, ask what it is now attacking',
    what: 'Something of yours was already attacked, and your move looked somewhere else.',
    why: 'Attention follows your own plan. His move changed the position and you answered the position before it. This costs more than hanging a piece, because you were told first.',
    checklist: [
      'Every time he moves, ask one question before anything else: what does that move now attack?',
      'Follow the line it opened as well as the piece he touched — a bishop step uncovers a rook.',
      'Answer it, make a bigger threat, or prove it is not real.',
      'Only then go back to your own plan.',
    ],
    drill: 'Replay this game and, at each of his moves, name the threat out loud before you look at your reply.',
  },
  fork: {
    title: 'Forks and double attacks',
    work: 'watch squares that touch two of your pieces at once',
    what: 'One piece of his hit two of yours at once, so answering one loses the other.',
    why: 'Two pieces are safe individually and unsafe as a pair. Knights do most of this because their pattern is the one no other piece can cover, and checks do the rest, because a check is a threat you are not allowed to ignore.',
    checklist: [
      'Look for squares that touch two of your pieces — knight squares first.',
      'Watch your king and queen sharing a rank, file, diagonal or knight-distance.',
      'Ask whether he can reach one of those squares safely.',
      'Defend it, move one of the pair, or take the square away.',
    ],
    drill: 'In the position before the fork, put his knight on every empty square in turn and see which ones hit two of yours. The pattern is what you are training, not the position.',
  },
  'lost-material': {
    title: 'Losing exchanges',
    work: 'count attackers and defenders before entering a trade',
    what: 'You went into a sequence of captures that came out against you.',
    why: 'Counting the first capture is easy and counting the whole sequence is not. The usual error is a defender that does not really defend — it is pinned, it is already busy holding something else, or he can chase it away first.',
    checklist: [
      'Count attackers and defenders on the square, cheapest piece first on both sides.',
      'Check each of your defenders is actually free to recapture.',
      'Play the sequence out to the end, not to the first recapture.',
      'If it comes out level, ask whether you want the position it leaves.',
    ],
    drill: 'Count each of these exchanges again slowly and find the defender that was not one.',
  },
  'missed-win': {
    title: 'Missing what was there',
    work: 'when something of his is loose, look for the move that takes it',
    what: 'Something of his was free, or a forced win was on, and your move passed it up.',
    why: 'You were following your plan while the position changed underneath it. Gifts appear right after his mistakes, which is exactly when you are least likely to be looking for one.',
    checklist: [
      'Before continuing your plan, scan his loose pieces — undefended, or defended only once.',
      'Look at every check and every capture you have, including the ones that look silly.',
      'Ask what his last move stopped defending.',
      'Then go back to the plan.',
    ],
    drill: 'Find the winning move in each of these without reading the answer. Every one of them was on the board in front of you at the time.',
  },
  'king-safety': {
    title: 'King safety',
    work: 'castle earlier, and keep the king off open files',
    what: 'Your king was already exposed, and this move did not deal with it.',
    why: 'King safety is the one weakness that costs nothing until it costs everything. Nothing is hanging, the evaluation looks fine, and then the attack arrives with tempo and there is no move left that defends.',
    checklist: [
      'Castle early unless there is a concrete reason not to.',
      'Keep the pawns in front of your king where they are; each one pushed is a door.',
      'Count his attackers near your king against your defenders — not his whole army against yours.',
      'When the count is against you, trade attackers off. Every swap helps the defender.',
    ],
    drill: 'From these positions, work out his attacking plan three moves deep. Seeing the attack coming is what makes the defensive move obvious.',
  },
  positional: {
    title: 'Positional drift',
    work: 'nothing hangs in these — this is the slow kind, worth a look with an engine',
    what: 'Nothing was taken. The move made your position slightly worse: a weakened square, a worse piece, a file handed over.',
    why: 'These do not feel like mistakes, which is exactly what makes them habits. Each costs little and they compound, and by the time the position is unpleasant there is no single move to point at.',
    checklist: [
      'Before a quiet move, say what it improves.',
      'Find your worst-placed piece and ask whether this move helps it.',
      'Prefer a move that improves a piece to a move that merely does something.',
      'Check what it gives up permanently — a square or a pawn structure does not come back.',
    ],
    drill: 'For each of these, compare your move with the engine\'s for two minutes and write the difference down in one sentence.',
  },
  unknown: {
    title: 'Not classified',
    work: 're-run with --deep to have the engine say why these were bad',
    what: 'The log did not carry enough for the review to say what went wrong.',
    why: 'Either a session recorded before grades carried positions and lines, or a move the coach graded while the board was out of sync.',
    checklist: ['Re-run:  node tools/review.mjs --deep --all'],
    drill: 'A deep review grades every move of the saved game from scratch, and these will classify themselves.',
  },
};

/* -------------------------------------------------------------- review ---- */

/**
 * The position and the two moves, kept so the review can be *shown* and not
 * only described.
 *
 * Everything here was already searched and already written to the log
 * (`src/main.js` records `fenBefore`, `uci`, `bestMove` and `bestLine` for
 * exactly this reason), and then thrown away at this line for as long as the
 * report was a page of sentences. A sentence about a position you cannot see is
 * the weakest form this analysis can take: "your knight on d4 had nothing
 * defending it" is a fact you read, and the same position with the move hidden
 * is a fact you have to find, which is the one that stays.
 *
 * Carried only on moves that have a fault. The page inlines its whole dataset,
 * so a FEN on all 40 moves of every game is size spent on rows nothing draws —
 * and the trainer and the fault lists, which are the only things that show a
 * board, are built from bad moves alone.
 *
 * Returns null when the grade predates this being logged. That is not an error
 * and must not become one: the page degrades to the sentence it has today and
 * says which sessions need re-reviewing.
 */
function evidenceOf(g) {
  if (!g?.fenBefore) return null;
  return {
    fen: g.fenBefore,
    // from/to rather than SAN, so the page can highlight the squares without
    // carrying a SAN parser into the browser to find out where the move went.
    uci: g.uci ?? null,
    best: g.bestMove ? pvToSan(g.fenBefore, [g.bestMove], 1) : null,
    bestUci: g.bestMove ?? null,
    bestLine: g.bestLine?.length ? pvToSan(g.fenBefore, g.bestLine, 6) : null,
    /*
     * The same two lines again, walked out ply by ply, for the page to play.
     *
     * A bad move is rarely bad by itself — it is bad for the answer it allows,
     * and "He answers: Rxd4 Ke7" asks the reader to build that answer in their
     * head from the position they are looking at. These are the two lines the
     * text above already names, in the one form the browser can move a piece
     * with: `{ uci, san }`, so the board animates from the UCI and the caption
     * reads in the notation everything else on the page is written in.
     *
     * `refutation` was searched from the position *after* the move, so your own
     * move goes in front of it to make one line playable from `fen` — which is
     * also how it should be watched: the mistake, then the punishment.
     *
     * Cut to 6 plies each, the same lengths the sentences use, so the animation
     * and the text cannot tell different stories. ~240 bytes on a move that has
     * a fault, and nothing at all on the moves that do not: the same trade the
     * FEN above is here on.
     */
    playedLine: g.uci ? pvSteps(g.fenBefore, [g.uci, ...(g.refutation ?? [])], 6) : null,
    betterLine: g.bestLine?.length ? pvSteps(g.fenBefore, g.bestLine, 6) : null,
  };
}

/**
 * Win probability either side of the move, for the curve that shows where a
 * game was actually decided.
 *
 * Preferred off the grade, which computed it at the time; derived from the
 * score only as a fallback. Not derived when there is no score at all —
 * `scoreToWinProb(null)` answers 50, and a flat 50 is indistinguishable from a
 * genuinely level position, which would draw a curve through moves nobody ever
 * evaluated.
 */
const winOf = (have, score) => {
  const v = have ?? (score != null ? scoreToWinProb(score) : null);
  // One decimal. This lands on every graded move of every game and is inlined
  // into the page as text, where `51.1044443209752` is 12 characters of nothing:
  // it is drawn as a point on a 120px chart.
  return v == null ? null : Math.round(v * 10) / 10;
};

/**
 * One game, reviewed.
 *
 * @param {object[]} grades  graded moves in play order, either side
 * @param {object} [o]
 * @param {string} [o.color] whose review this is; defaults to the side that has
 *                           the most graded moves, which is the player, since a
 *                           live session grades only your side unless told
 *                           otherwise
 */
export function reviewGame(grades, { color, ...meta } = {}) {
  const all = (grades ?? []).filter((g) => g && g.san);
  const counts = { w: 0, b: 0 };
  for (const g of all) if (g.mover) counts[g.mover]++;
  const you = color ?? (counts.b > counts.w ? 'b' : 'w');

  const mine = all.filter((g) => (g.mover ?? you) === you);
  const labels = {};
  const phases = {};
  const faults = new Map();
  const moves = [];

  for (const g of mine) {
    const name = labelName(g);
    labels[name] = (labels[name] ?? 0) + 1;

    const phase = g.fenBefore ? phaseOf(g.fenBefore) : 'middlegame';
    /*
     * Accuracy is accumulated per phase, not only loss.
     *
     * Win probability lost per move answers "where does it go wrong" and
     * nothing else: it is unbounded, so one blunder in a short endgame outranks
     * a whole sloppy middlegame. Accuracy is the same measure the rest of the
     * page is stated in, and it is bounded, so the three phases can be compared
     * to each other and to your overall figure.
     *
     * `accMoves` is counted separately from `moves` so that a page built from a
     * mix of old and new reviews averages over the moves that actually carried
     * an accuracy, instead of dividing by a count that includes rows written
     * before this existed.
     */
    phases[phase] ??= { moves: 0, lost: 0, acc: 0, accMoves: 0 };
    phases[phase].moves++;
    phases[phase].lost += g.drop ?? 0;
    phases[phase].acc += moveAccuracy(g.drop ?? 0);
    phases[phase].accMoves++;

    // `faultOf` is only asked about moves that cost something. Explaining why a
    // Best move was best is a different feature, and a worse one: it would fill
    // the report with rows nobody needs to read.
    const fault = isBad(g) ? (faultOf(g) ?? { kind: 'unknown', text: null, line: null }) : null;
    const row = {
      ply: g.ply ?? null, san: g.san, label: name, drop: g.drop ?? 0, phase,
      scoreBefore: g.scoreBefore ?? null, scoreAfter: g.scoreAfter ?? null,
      // Both in the mover's frame, as `classify` and `gradeMove` leave them, so
      // a curve of these is the game from your side of the board.
      winBefore: winOf(g.winBefore, g.scoreBefore), winAfter: winOf(g.winAfter, g.scoreAfter),
      fault: fault?.kind ?? null, why: fault?.text ?? null, line: fault?.line ?? null,
      ...(fault ? evidenceOf(g) ?? {} : {}),
    };
    moves.push(row);

    if (fault) {
      const f = faults.get(fault.kind) ?? { kind: fault.kind, count: 0, cost: 0, moves: [] };
      f.count++;
      f.cost += g.drop ?? 0;
      f.moves.push(row);
      faults.set(fault.kind, f);
    }
  }

  /*
   * The same fault twice in one game.
   *
   * Worth separating from the count across games, because they are different
   * news. Hanging a piece in six games out of twenty is a weakness; hanging two
   * in the same game is the weakness running unattended — the first one was
   * pointed at you, on the board, minutes earlier, and the habit carried on
   * regardless. That is the clearest signal available here that a fault is
   * worth drilling rather than noting.
   */
  const at = new Map();
  for (const m of moves) {
    if (!m.fault) continue;
    at.set(m.fault, [...(at.get(m.fault) ?? []), m.ply]);
  }
  const repeats = [...at.entries()]
    .filter(([, plies]) => plies.length >= 2)
    .map(([kind, plies]) => ({ kind, count: plies.length, plies: plies.filter((p) => p != null) }))
    .sort((a, b) => b.count - a.count);

  const lost = mine.reduce((a, g) => a + (g.drop ?? 0), 0);
  return {
    ...meta,
    color: you,
    graded: mine.length,
    accuracy: mine.length
      ? mine.reduce((a, g) => a + moveAccuracy(g.drop ?? 0), 0) / mine.length : null,
    lost,
    avgLoss: mine.length ? lost / mine.length : 0,
    labels,
    phases,
    // Ranked by what each habit actually cost, not by how often it happened: a
    // single blunder that threw the game outranks four inaccuracies.
    faults: [...faults.values()].sort((a, b) => b.cost - a.cost),
    repeats,
    worst: moves.filter(isBadRow).sort((a, b) => b.drop - a.drop).slice(0, 5),
    moves,
  };
}

const isBadRow = (m) => BAD.includes(m.label);

/**
 * Oldest game first, whoever asked.
 *
 * A trend has to know which end is now, and the two callers disagree: the page
 * rebuilds newest-first because that is the reading order, while
 * `tools/review.mjs` walks sessions in sort order, which is oldest-first.
 * Depending on either would silently invert every verdict for one of them —
 * "improving" and "getting worse" are the same numbers read the other way
 * round, and nothing downstream could catch it.
 *
 * So order is taken from the id the reviews are stored under, `<session>#<n>`,
 * where the session is a timestamp directory. The game number is compared as a
 * number, or `#10` would sort before `#2`. Games with no id keep the order they
 * arrived in, which is all that can be said about them.
 */
export function chronological(games) {
  const key = (g) => {
    const m = /^(.*)#(\d+)$/.exec(g.id ?? '');
    return m ? [m[1], Number(m[2])] : null;
  };
  return [...(games ?? [])].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (!ka || !kb) return 0;
    return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] - kb[1];
  });
}

/** A fault happening this often per 10 of your moves, which is the comparable rate. */
const per10 = (cost, graded) => (graded ? (cost / graded) * 10 : 0);

/**
 * Is this habit getting better?
 *
 * The question the whole report is for, and the one place on the page that
 * could flatter you with noise, so the bar it has to clear is stated rather
 * than buried:
 *
 *   - measured as cost per 10 of your moves, never per game. Games differ in
 *     length by a factor of three here, and a rate is the only thing two of
 *     them can be compared on.
 *   - the newer half against the older half, not last-game-against-previous.
 *     One game is a mood.
 *   - four games with the habit in view before any verdict at all, and at least
 *     two games where it actually happened. A line drawn through one event is
 *     not a direction.
 *   - a ±15% band in the middle reads as flat, because a 4% move in a number
 *     built out of blunders is not evidence of anything.
 *
 * Refusing is a normal outcome here and the page prints the reason.
 *
 * @param {object[]} history  per-game `{ per10, count }`, oldest first
 */
export function trendOf(history, { min = 4, band = 0.15 } = {}) {
  const h = history ?? [];
  const seen = h.filter((x) => x.count > 0).length;
  if (h.length < min) {
    return { verdict: 'unknown', games: h.length, reason: `only ${h.length} game${h.length === 1 ? '' : 's'} with this so far` };
  }
  if (seen < 2) {
    return { verdict: 'unknown', games: h.length, reason: 'it has only happened once' };
  }

  // Equal halves. On an odd count the middle game belongs to neither, which is
  // the honest way to split it and keeps the two means the same weight.
  const half = Math.floor(h.length / 2);
  const mean = (a) => a.reduce((s, x) => s + x.per10, 0) / a.length;
  const was = mean(h.slice(0, half));
  const now = mean(h.slice(h.length - half));
  const change = was > 0 ? (now - was) / was : now > 0 ? 1 : 0;

  return {
    verdict: Math.abs(change) <= band ? 'flat' : change < 0 ? 'improving' : 'worsening',
    was, now, change, games: h.length,
  };
}

/**
 * Every game together — which is the only view that can answer the question
 * this whole file exists for.
 *
 * A fault in one game is an accident; the same fault in six is the thing to go
 * and train. So the ranking that matters is this one, and the per-game reviews
 * are the evidence under it.
 */
export function reviewAll(games) {
  const played = chronological((games ?? []).filter((g) => g && g.graded > 0));
  const faults = new Map();

  for (const game of played) {
    for (const f of game.faults ?? []) {
      const at = faults.get(f.kind) ?? { kind: f.kind, count: 0, cost: 0, games: 0, moves: [] };
      at.count += f.count;
      at.cost += f.cost;
      at.games++;
      at.moves.push(...f.moves.map((m) => ({ ...m, game: game.id, when: game.title })));
      faults.set(f.kind, at);
    }
  }

  /*
   * The history a trend is drawn through, and the reason it includes games
   * where the fault did *not* happen.
   *
   * Listing only the games that show a fault is the obvious thing and it makes
   * the one outcome you are working for invisible: a habit you have fixed stops
   * appearing, so its history simply stops, and the last few points are the
   * games where you still had it. Read as a trend that says "no change", right
   * up to the point the fault disappears from the page altogether.
   *
   * Counting a clean game as a zero is what makes "improving" mean it stopped.
   * The span starts at the first game the fault appeared in — there is nothing
   * to say about a habit you had not exhibited yet, and padding the front with
   * zeros would report every newly-noticed fault as getting worse.
   */
  for (const [kind, at] of faults) {
    const first = played.findIndex((g) => (g.faults ?? []).some((f) => f.kind === kind));
    at.history = played.slice(first).map((g) => {
      const f = (g.faults ?? []).find((x) => x.kind === kind);
      const cost = f?.cost ?? 0;
      return {
        id: g.id ?? null, title: g.title ?? null, cost, count: f?.count ?? 0,
        per10: per10(cost, g.graded),
      };
    });
    at.trend = trendOf(at.history);
    at.repeatedGames = played.filter((g) => (g.repeats ?? []).some((r) => r.kind === kind)).length;
  }

  const graded = played.reduce((a, g) => a + g.graded, 0);
  return {
    games: played.length,
    graded,
    // Weighted by moves, not a mean of means: a 4-move fragment should not
    // count as much as a full game when both are averaged together.
    accuracy: graded
      ? played.reduce((a, g) => a + (g.accuracy ?? 0) * g.graded, 0) / graded : null,
    faults: [...faults.values()]
      .map((f) => ({ ...f, moves: f.moves.sort((a, b) => b.drop - a.drop).slice(0, 8) }))
      .sort((a, b) => b.cost - a.cost),
    phases: played.reduce((acc, g) => {
      for (const [p, v] of Object.entries(g.phases ?? {})) {
        acc[p] ??= { moves: 0, lost: 0, acc: 0, accMoves: 0 };
        acc[p].moves += v.moves;
        acc[p].lost += v.lost;
        // Absent on reviews written before phases carried accuracy. Adding zero
        // for them would be a lie about their moves; leaving them out of both
        // sums means the average is over the moves that have one.
        acc[p].acc += v.acc ?? 0;
        acc[p].accMoves += v.accMoves ?? 0;
      }
      return acc;
    }, {}),
    /*
     * The same game split by which colour you had.
     *
     * A gap here is one of the few findings on this page that names its own
     * fix: consistently worse as Black usually means the opening, because it is
     * the half of the game where the two colours are actually playing different
     * positions.
     */
    byColor: played.reduce((acc, g) => {
      const c = g.color === 'b' ? 'b' : 'w';
      acc[c] ??= { games: 0, graded: 0, acc: 0, accMoves: 0, lost: 0 };
      acc[c].games++;
      acc[c].graded += g.graded;
      acc[c].lost += g.lost ?? 0;
      if (g.accuracy != null) {
        acc[c].acc += g.accuracy * g.graded;
        acc[c].accMoves += g.graded;
      }
      return acc;
    }, {}),
  };
}

/**
 * Split a session's events into games, with the side you were on for each.
 *
 * Pure, like everything else here — it takes the parsed events and returns
 * groups of graded moves, so the file that reads the disk stays the one file
 * that reads the disk.
 *
 * A session can hold more than one game: the coach recognises a fresh start
 * position and begins again rather than staying lost, and `newgame` marks
 * exactly where. Splitting on it keeps game 2's blunders out of game 1's report.
 *
 * ## The colour is tracked, not read once
 *
 * `start` records the colour at startup, and the coach can change it while
 * running — `tryNewGame` may hand you the other colour, `tryFlip` corrects a
 * board that was the other way round all along. Both write the new
 * `playerColor` into the log, so the value in force is knowable exactly.
 *
 * Taking the startup one instead is not a small error. Measured on a real
 * session: a new game was recognised the other way round two frames in, so all
 * ten moves graded afterwards were White's while `start` still said Black — and
 * the game reviewed as having no moves in it at all.
 */
export function gamesFromLog(events) {
  const start = events.find((e) => e.ev === 'start');
  const grades = events.filter((e) => e.ev === 'grade');
  const cuts = events.filter((e) => e.ev === 'newgame' && e.ok);

  const games = [];
  let from = 0;
  let color = start?.playerColor;
  for (const cut of [...cuts, { seq: Infinity, playerColor: null }]) {
    const within = (e) => e.seq >= from && e.seq < cut.seq;
    const flips = events.filter((e) => e.ev === 'flip' && e.ok && within(e));
    games.push({
      moves: grades.filter(within),
      // A flip inside the game is the later correction, so it has the last word.
      color: flips.length ? flips[flips.length - 1].playerColor : color,
      source: 'live',
      n: games.length + 1,
    });
    from = cut.seq;
    color = cut.playerColor ?? color;
  }
  return games;
}

/**
 * The review as a few lines of terminal, printed when a game ends.
 *
 * Short on purpose. The page is where a review is actually read; this is the
 * part that has to survive being glanced at on the way out.
 */
export function summarise(review) {
  const out = [];
  if (!review.graded) return ['  no graded moves — nothing to review'];

  const acc = review.accuracy;
  out.push(`  ${review.graded} of your moves graded, accuracy ${acc.toFixed(1)}%`
    + `  (${Object.entries(review.labels).map(([k, v]) => `${v} ${k}`).join(', ')})`);

  const worst = review.faults[0];
  if (worst) {
    const f = FAULTS[worst.kind] ?? FAULTS.unknown;
    out.push(`  most costly habit: ${f.title.toLowerCase()}`
      + ` — ${worst.count} ${worst.count === 1 ? 'move' : 'moves'},`
      + ` ${worst.cost.toFixed(0)}% of win probability`);
    if (worst.moves[0]?.why) out.push(`    e.g. ${worst.moves[0].why}`);
  }
  return out;
}
