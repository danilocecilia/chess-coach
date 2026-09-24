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
import { material, netMaterial, pvToSan, toUci } from './grade.js';
import { materialWord } from './verdict.js';
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
 * What the move costs *now*, over the capture sequence that answers it.
 *
 * Not `materialSwing`, which nets the whole principal variation. That is the
 * right measure for "what does this line finally win" — it is what `netMaterial`
 * exists for, and why it counts at the end of a pv rather than at a fixed ply —
 * and it is the wrong measure for "what did this move drop", because a piece
 * handed over now and a pawn structure repaired nine plies later come out as
 * zero.
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
 */
function immediateSwing(g, you) {
  if (!g.refutation?.length) return 0;
  const chess = new Chess(g.fenAfter);
  let plies = 0;
  for (const uci of g.refutation) {
    const m = chess.moves({ verbose: true }).find((x) => toUci(x) === uci);
    if (!m?.captured) break;                        // the sequence has gone quiet
    chess.move(m);
    plies++;
  }
  return plies ? material(chess.fen(), you) - material(g.fenBefore, you) : 0;
}

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
 * @returns {{kind: string, text: string, line: string|null}|null}
 */
export function faultOf(g) {
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
  const instead = bestSan ? ` — ${bestSan} instead` : '';

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
        return {
          kind: 'lost-material',
          text: `${g.san} starts an exchange that loses it — ${m1.san} answers`
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

/** How each fault reads as a heading, and as a thing to go and work on. */
export const FAULTS = {
  'allowed-mate':  { title: 'Walking into mate',  work: 'check what his last move opened up before you commit to yours' },
  hung:            { title: 'Hanging pieces',     work: 'before you move, look at what of yours is undefended' },
  'missed-threat': { title: 'Ignoring his threat', work: 'after every one of his moves, ask what it is now attacking' },
  fork:            { title: 'Forks and double attacks', work: 'watch squares that touch two of your pieces at once' },
  'lost-material': { title: 'Losing exchanges',   work: 'count attackers and defenders before entering a trade' },
  'missed-win':    { title: 'Missing what was there', work: 'when something of his is loose, look for the move that takes it' },
  'king-safety':   { title: 'King safety',        work: 'castle earlier, and keep the king off open files' },
  positional:      { title: 'Positional drift',   work: 'nothing hangs in these — this is the slow kind, worth a look with an engine' },
  unknown:         { title: 'Not classified',     work: 're-run with --deep to have the engine say why these were bad' },
};

/* -------------------------------------------------------------- review ---- */

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
    phases[phase] ??= { moves: 0, lost: 0 };
    phases[phase].moves++;
    phases[phase].lost += g.drop ?? 0;

    // `faultOf` is only asked about moves that cost something. Explaining why a
    // Best move was best is a different feature, and a worse one: it would fill
    // the report with rows nobody needs to read.
    const fault = isBad(g) ? (faultOf(g) ?? { kind: 'unknown', text: null, line: null }) : null;
    const row = {
      ply: g.ply ?? null, san: g.san, label: name, drop: g.drop ?? 0, phase,
      scoreBefore: g.scoreBefore ?? null, scoreAfter: g.scoreAfter ?? null,
      fault: fault?.kind ?? null, why: fault?.text ?? null, line: fault?.line ?? null,
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
    worst: moves.filter(isBadRow).sort((a, b) => b.drop - a.drop).slice(0, 5),
    moves,
  };
}

const isBadRow = (m) => BAD.includes(m.label);

/**
 * Every game together — which is the only view that can answer the question
 * this whole file exists for.
 *
 * A fault in one game is an accident; the same fault in six is the thing to go
 * and train. So the ranking that matters is this one, and the per-game reviews
 * are the evidence under it.
 */
export function reviewAll(games) {
  const played = (games ?? []).filter((g) => g && g.graded > 0);
  const faults = new Map();

  for (const game of played) {
    for (const f of game.faults ?? []) {
      const at = faults.get(f.kind) ?? { kind: f.kind, count: 0, cost: 0, games: 0, moves: [] };
      at.count += f.count;
      at.cost += f.cost;
      at.games++;
      at.moves.push(...f.moves.map((m) => ({ ...m, game: game.id })));
      faults.set(f.kind, at);
    }
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
        acc[p] ??= { moves: 0, lost: 0 };
        acc[p].moves += v.moves;
        acc[p].lost += v.lost;
      }
      return acc;
    }, {}),
  };
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
