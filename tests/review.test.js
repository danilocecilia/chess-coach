import test from 'node:test';
import assert from 'node:assert/strict';
import {
  faultOf, phaseOf, moveAccuracy, reviewGame, reviewAll, totalMaterial, labelName,
  gamesFromLog, trendOf, chronological, FAULTS,
} from '../src/review.js';

/*
 * Every position here is built so the answer is not a matter of judgement.
 * A knight on d4 with a rook on d1 and nothing defending it is hanging; there
 * is no reading of the position where it is not. That is the point: the faults
 * are measurements, so the tests should be checkable by eye.
 */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A graded move with the fields `faultOf` reads, so each test states only what it changes. */
const grade = (o) => ({
  san: '?', mover: 'b', label: 'Blunder', drop: 30,
  scoreBefore: { cp: 0 }, scoreAfter: { cp: -300 },
  bestMove: null, bestLine: [], refutation: [], materialSwing: 0, ...o,
});

test('a piece put where nothing defends it is hung', () => {
  // Black knight steps f3 -> d4, onto a square the rook on d1 already sees.
  const f = faultOf(grade({
    san: 'Nd4', mover: 'b',
    fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
    fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 1 2',
    refutation: ['d1d4'],
    materialSwing: -3,
  }));
  assert.equal(f.kind, 'hung');
  assert.match(f.text, /knight on d4/);
  assert.match(f.text, /Rxd4/);
});

test('a piece that was already attacked is a threat ignored, not a piece hung', () => {
  // Same rook, same knight — but the knight was on d4 before the move, and
  // Black spent the move walking the king instead of saving it.
  const f = faultOf(grade({
    san: 'Ke7', mover: 'b',
    fenBefore: '4k3/8/8/8/3n4/8/8/3RK3 b - - 0 1',
    fenAfter: '8/4k3/8/8/3n4/8/8/3RK3 w - - 1 2',
    refutation: ['d1d4'],
    materialSwing: -3,
  }));
  assert.equal(f.kind, 'missed-threat');
  assert.match(f.text, /already attacked/);
});

test('a rook that could always have moved to the square does not make it a missed threat', () => {
  // The guard on `standing`: d1-d4 was legal before too, but d4 was empty then,
  // so the knight was not something Black failed to save — he put it there.
  const f = faultOf(grade({
    san: 'Nd4', mover: 'b',
    fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
    fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 1 2',
    refutation: ['d1d4'],
    materialSwing: -3,
  }));
  assert.notEqual(f.kind, 'missed-threat');
});

test('a defended piece traded off is not a hung piece', () => {
  // Same knight to d4, but a pawn on c5 defends it: Rxd4 cxd4 wins the exchange
  // for Black. Whatever is wrong with this move, it is not that he dropped it.
  const f = faultOf(grade({
    san: 'Nd4', mover: 'b', drop: 12, label: 'Inaccuracy',
    fenBefore: '4k3/8/8/2p5/8/5n2/8/3RK3 b - - 0 1',
    fenAfter: '4k3/8/8/2p5/3n4/8/8/3RK3 w - - 1 2',
    refutation: ['d1d4', 'c5d4'],
  }));
  assert.notEqual(f.kind, 'hung');
  assert.notEqual(f.kind, 'lost-material');
});

test('a piece taken for free still counts, even when the long line nets out', () => {
  // The failure this was built for: over the whole principal variation the
  // material came back, so a knight taken on the very next move scored zero and
  // a 65% blunder was filed as a positional concession.
  const f = faultOf(grade({
    san: 'Nd4', mover: 'b', drop: 65,
    fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
    fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 1 2',
    refutation: ['d1d4'],
    materialSwing: 0,          // as the full-line measure reported it
  }));
  assert.equal(f.kind, 'hung');
});

test('an exchange you started that goes wrong is not filed as hanging a piece', () => {
  // Black plays Nxd4, and the recapture simply wins the knight back. That is a
  // trade misjudged, not a piece left standing en prise.
  const f = faultOf(grade({
    san: 'Nxd4', mover: 'b',
    fenBefore: '4k3/8/8/8/3P4/5n2/8/3RK3 b - - 0 1',
    fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 0 2',
    refutation: ['d1d4'],
  }));
  assert.equal(f.kind, 'lost-material');
  assert.match(f.text, /exchange/);
});

test('the "— Nf6 instead" tail can be withheld, for a position still being solved', () => {
  /*
   * Reading a finished game, the move you should have played belongs in the
   * sentence. In a drill the same sentence is the answer to the question being
   * asked, so `play.js` turns it off and decides for itself when to give it up.
   */
  const g = grade({
    san: 'a6', mover: 'b', label: 'Inaccuracy', drop: 11,
    fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    fenAfter: 'rnbqkbnr/1ppppppp/p7/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    bestMove: 'e7e5', bestLine: ['e7e5'],
    refutation: ['d2d4'],
    materialSwing: 0,
  });
  assert.match(faultOf(g).text, /e5 instead/);

  const quiet = faultOf(g, { nameBest: false });
  assert.ok(!quiet.text.includes('instead'), 'the move must not survive in it');
  assert.equal(quiet.kind, faultOf(g).kind, 'and nothing else about the diagnosis changes');
  assert.match(quiet.text, /positional concession/);
});

test('a knight check hitting the king and a rook is a fork', () => {
  // White plays h3 and allows Nc2+, which hits e1 and a1 at once.
  const f = faultOf(grade({
    san: 'h3', mover: 'w',
    fenBefore: '4k3/8/8/8/1n6/8/7P/R3K3 w - - 0 1',
    fenAfter: '4k3/8/8/8/1n6/7P/8/R3K3 b - - 0 1',
    refutation: ['b4c2'],
    materialSwing: -5,
  }));
  assert.equal(f.kind, 'fork');
  assert.match(f.text, /king/);
  assert.match(f.text, /rook on a1/);
});

test('passing up a free piece is a missed win, not a loss', () => {
  // Rxd4 was there; White played h3. Nothing is lost — the cost is what was left.
  const f = faultOf(grade({
    san: 'h3', mover: 'w', label: 'Mistake', drop: 18,
    fenBefore: '4k3/8/8/8/3n4/8/7P/3RK3 w - - 0 1',
    fenAfter: '4k3/8/8/8/3n4/7P/8/3RK3 b - - 0 1',
    bestMove: 'd1d4', bestLine: ['d1d4'],
    refutation: ['e8e7'],
    materialSwing: 0,
  }));
  assert.equal(f.kind, 'missed-win');
  assert.match(f.text, /Rxd4/);
});

test('a move that allows mate is reported as mate, whatever the material says', () => {
  // The sacrifice in a mating line must not be read as material won.
  const f = faultOf(grade({
    san: 'Ka1', mover: 'w',
    fenBefore: '7k/8/8/8/8/8/r7/1K5r w - - 0 1',
    fenAfter: '7k/8/8/8/8/8/r7/K6r b - - 1 1',
    scoreAfter: { mate: -1 },
    refutation: ['h1b1'],
    materialSwing: 5,
  }));
  assert.equal(f.kind, 'allowed-mate');
  assert.match(f.text, /mate in 1/);
});

test('a move with nothing material in it is a positional concession', () => {
  const f = faultOf(grade({
    san: 'a6', mover: 'b', label: 'Inaccuracy', drop: 11,
    fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    fenAfter: 'rnbqkbnr/1ppppppp/p7/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    bestMove: 'e7e5', bestLine: ['e7e5'],
    refutation: ['d2d4'],
    materialSwing: 0,
  }));
  assert.equal(f.kind, 'positional');
});

test('a grade with no position attached classifies as nothing rather than as something', () => {
  // An older log, before the grade event carried the FENs. The honest answer is
  // "cannot say", and the report is expected to print that rather than guess.
  assert.equal(faultOf({ san: 'Nf6', label: 'Blunder', drop: 30 }), null);
  const r = reviewGame([{ san: 'Nf6', mover: 'w', label: 'Blunder', drop: 30 }]);
  assert.equal(r.faults[0].kind, 'unknown');
});

test('accuracy is 100 for a free move and falls away fast', () => {
  assert.ok(moveAccuracy(0) > 99);
  assert.ok(moveAccuracy(10) < 70 && moveAccuracy(10) > 60);
  assert.ok(moveAccuracy(50) < 15);
  assert.equal(moveAccuracy(1000), 0);
});

test('phases are told apart by material as well as by move number', () => {
  assert.equal(phaseOf(START), 'opening');
  assert.equal(totalMaterial(START), 78);
  // Everything still on, but long past the opening.
  assert.equal(phaseOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 30'), 'middlegame');
  // Rook and king each: an endgame on move 9 is still an endgame.
  assert.equal(phaseOf('4k3/8/8/8/8/8/8/R3K3 w - - 0 9'), 'endgame');
});

test('a game review counts labels, ranks faults by cost, and averages accuracy', () => {
  const moves = [
    grade({ san: 'Nd4', label: 'Blunder', drop: 30, mover: 'b',
      fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
      fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 1 2',
      refutation: ['d1d4'], materialSwing: -3 }),
    grade({ san: 'e5', label: 'Best', drop: 0, mover: 'b' }),
    grade({ san: 'a6', label: 'Inaccuracy', drop: 11, mover: 'b',
      fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      fenAfter: 'rnbqkbnr/1ppppppp/p7/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      refutation: ['d2d4'], materialSwing: 0 }),
  ];
  const r = reviewGame(moves, { color: 'b' });

  assert.equal(r.graded, 3);
  assert.deepEqual(r.labels, { Blunder: 1, Best: 1, Inaccuracy: 1 });
  // The blunder cost 30 and the inaccuracy 11, so hanging outranks drifting.
  assert.equal(r.faults[0].kind, 'hung');
  assert.equal(r.faults[1].kind, 'positional');
  assert.ok(r.accuracy > 50 && r.accuracy < 90, `accuracy was ${r.accuracy}`);
  assert.equal(r.worst[0].san, 'Nd4');
});

test('the player is the side with the moves, since a session grades one side', () => {
  const r = reviewGame([
    grade({ san: 'a6', mover: 'b', label: 'Best', drop: 0 }),
    grade({ san: 'h6', mover: 'b', label: 'Best', drop: 0 }),
    grade({ san: 'e4', mover: 'w', label: 'Best', drop: 0 }),
  ]);
  assert.equal(r.color, 'b');
  assert.equal(r.graded, 2);
});

test('across games, a habit outranks a one-off however bad the one-off was', () => {
  const hang = (drop) => grade({ san: 'Nd4', label: 'Blunder', drop, mover: 'b',
    fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
    fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 1 2',
    refutation: ['d1d4'], materialSwing: -3 });
  const drift = (drop) => grade({ san: 'a6', label: 'Inaccuracy', drop, mover: 'b',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    fenAfter: 'rnbqkbnr/1ppppppp/p7/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    refutation: ['d2d4'], materialSwing: 0 });

  const all = reviewAll([
    reviewGame([hang(20), drift(12)], { color: 'b', id: 'g1' }),
    reviewGame([hang(20), hang(18)], { color: 'b', id: 'g2' }),
  ]);

  assert.equal(all.games, 2);
  assert.equal(all.faults[0].kind, 'hung');
  assert.equal(all.faults[0].count, 3);
  assert.equal(all.faults[0].games, 2);
  // Every recorded example carries the game it came from, so the page can link back.
  assert.ok(all.faults[0].moves.every((m) => m.game));
  assert.equal(all.graded, 4);
});

test('games with nothing graded are left out rather than drawn empty', () => {
  const all = reviewAll([reviewGame([], { id: 'empty' }), reviewGame([
    grade({ san: 'e5', label: 'Best', drop: 0, mover: 'b' }),
  ], { id: 'real' })]);
  assert.equal(all.games, 1);
});

test('a session splits into games at each new game the coach recognised', () => {
  const games = gamesFromLog([
    { ev: 'start', seq: 0, playerColor: 'w' },
    { ev: 'grade', seq: 3, san: 'e4' },
    { ev: 'newgame', seq: 8, ok: true, playerColor: 'w' },
    { ev: 'grade', seq: 11, san: 'd4' },
    { ev: 'grade', seq: 14, san: 'c4' },
  ]);
  assert.equal(games.length, 2);
  assert.deepEqual(games.map((g) => g.moves.length), [1, 2]);
  assert.deepEqual(games.map((g) => g.n), [1, 2]);
});

test('a new game the other way round changes which side the review is of', () => {
  /*
   * The bug this exists for, from a real session: a new game was recognised
   * turned round two frames in, so every move graded afterwards was White's
   * while the `start` event still said Black — and the game reviewed as having
   * no moves in it at all.
   */
  const games = gamesFromLog([
    { ev: 'start', seq: 0, playerColor: 'b' },
    { ev: 'newgame', seq: 2, ok: true, turned: true, playerColor: 'w' },
    { ev: 'grade', seq: 24, san: 'e4' },
  ]);
  assert.equal(games[1].color, 'w');
});

test('a flip inside a game has the last word on which side you are', () => {
  const games = gamesFromLog([
    { ev: 'start', seq: 0, playerColor: 'w' },
    { ev: 'grade', seq: 4, san: 'e5' },
    { ev: 'flip', seq: 6, ok: true, playerColor: 'b' },
  ]);
  assert.equal(games[0].color, 'b');
});

test('a refused new game is not a boundary', () => {
  const games = gamesFromLog([
    { ev: 'start', seq: 0, playerColor: 'w' },
    { ev: 'newgame', seq: 5, ok: false, reason: 'margin' },
    { ev: 'grade', seq: 9, san: 'e4' },
  ]);
  assert.equal(games.length, 1);
  assert.equal(games[0].color, 'w');
});

test('labelName reads both shapes a grade arrives in', () => {
  assert.equal(labelName({ label: 'Blunder' }), 'Blunder');
  assert.equal(labelName({ label: { name: 'Blunder' } }), 'Blunder');
});

/* ------------------------------ faults the engine's line does not name ---- */

/*
 * The refutation is only one of the lines that win. When the position is
 * already decided the engine has no reason to return the one that picks up the
 * loose piece, and every fault branch that reads the pv then sees nothing.
 *
 * These are the two moves from logs/2026-09-24T20-23-21 that the grade's
 * material floor now catches, handed a refutation that walks past the hanging
 * piece — which is what Stockfish actually returned on a re-grade.
 */

test('a hung bishop is named even when the refutation ignores it', () => {
  const f = faultOf(grade({
    san: 'Bb2', mover: 'w', label: 'Mistake', drop: 0.4,
    fenBefore: 'r1b2rk1/pppp1ppp/7n/2bNq3/Pn2P3/1P1B4/2PP1PPP/R1BQ1RK1 w - - 0 10',
    fenAfter: 'r1b2rk1/pppp1ppp/7n/2bNq3/Pn2P3/1P1B4/1BPP1PPP/R2Q1RK1 b - - 1 10',
    refutation: ['d5b4', 'c5b4', 'c2c3'],   // wins, but never takes on b2
    bestMove: 'd5b4', bestLine: ['d5b4'],
    scoreBefore: { cp: -649 }, scoreAfter: { cp: -662 },
  }));
  assert.equal(f.kind, 'hung');
  assert.match(f.text, /bishop on b2/);
  assert.match(f.text, /Qxb2/);
});

test('a hung rook is named even when the refutation ignores it', () => {
  const f = faultOf(grade({
    san: 'Re7', mover: 'w', label: 'Blunder', drop: 1.2,
    fenBefore: 'r1b2rk1/pp3ppp/2p2b1n/3p4/q5P1/3B1Q2/2RP1P1P/4R1K1 w - - 0 22',
    fenAfter: 'r1b2rk1/pp2Rppp/2p2b1n/3p4/q5P1/3B1Q2/2RP1P1P/6K1 b - - 1 22',
    refutation: ['c2c1', 'c8g4'],
    bestMove: 'h2h3', bestLine: ['h2h3'],
    scoreBefore: { cp: -1028 }, scoreAfter: { cp: -1256 },
  }));
  assert.equal(f.kind, 'hung');
  assert.match(f.text, /rook on e7/);
  assert.match(f.text, /a rook/);
});

test('both routes to a hung piece agree on the fault', () => {
  // Same move, same position; only the line the engine happened to return
  // differs. The player is told the same thing either way.
  const position = {
    san: 'Bb2', mover: 'w', label: 'Mistake', drop: 0.4,
    fenBefore: 'r1b2rk1/pppp1ppp/7n/2bNq3/Pn2P3/1P1B4/2PP1PPP/R1BQ1RK1 w - - 0 10',
    fenAfter: 'r1b2rk1/pppp1ppp/7n/2bNq3/Pn2P3/1P1B4/1BPP1PPP/R2Q1RK1 b - - 1 10',
    bestMove: 'd5b4', bestLine: ['d5b4'],
    scoreBefore: { cp: -649 }, scoreAfter: { cp: -662 },
  };
  const takes = faultOf(grade({ ...position, refutation: ['e5b2', 'd5b4'] }));
  const walks = faultOf(grade({ ...position, refutation: ['d5b4', 'c5b4'] }));
  assert.equal(takes.kind, 'hung');
  assert.equal(walks.kind, 'hung');
});

test('a defended piece is not reported as hanging', () => {
  // Rc4 is attacked by the queen and defended by the bishop on d3, so Qxc4
  // Bxc4 simply loses the queen. This move graded Excellent and must stay a
  // move the review says nothing about.
  const f = faultOf(grade({
    san: 'Rc4', mover: 'w', label: 'Inaccuracy', drop: 12,
    fenBefore: 'r1b2rk1/pp1p1ppp/2p2b1n/8/Pq6/1P1B4/3P1PPP/2RQ1RK1 w - - 0 17',
    fenAfter: 'r1b2rk1/pp1p1ppp/2p2b1n/8/PqR5/1P1B4/3P1PPP/3Q1RK1 b - - 1 17',
    refutation: ['b4e7', 'c4f4'],
    bestMove: 'd1c2', bestLine: ['d1c2'],
    scoreBefore: { cp: -987 }, scoreAfter: { cp: -994 },
  }));
  assert.notEqual(f.kind, 'hung');
});

/* ------------------------------------------------- what the page is shown --- */

/*
 * The trainer can only ask you to find a move in a position it still has. These
 * cover the trip from a logged grade to a row the page can draw a board from,
 * and — just as important — what happens when the log predates that.
 */

/** A hung knight, with everything a grade written today carries. */
const hung = (o = {}) => grade({
  san: 'Nd4', label: 'Blunder', drop: 30, mover: 'b',
  fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
  fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 1 2',
  uci: 'f3d4', refutation: ['d1d4'], materialSwing: -3,
  bestMove: 'f3g5', bestLine: ['f3g5', 'e1e2'],
  winBefore: 50, winAfter: 20, ...o,
});

test('a move that cost something carries the position it happened in', () => {
  const r = reviewGame([hung()], { color: 'b' });
  const [move] = r.moves;

  assert.equal(move.fen, '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1');
  assert.equal(move.uci, 'f3d4');
  // The engine move as a player reads it, and as the page highlights it.
  assert.equal(move.best, 'Ng5');
  assert.equal(move.bestUci, 'f3g5');
  assert.equal(move.bestLine, 'Ng5 Ke2');
});

test('a move that cost something carries both lines, ready to be played out', () => {
  const r = reviewGame([hung()], { color: 'b' });
  const [move] = r.moves;

  /*
   * Your move in front of the refutation, which was searched from the position
   * after it: one line, playable from the position on the card, and watched in
   * the order it happened — the mistake, then the punishment.
   */
  assert.deepEqual(move.playedLine, [
    { uci: 'f3d4', san: 'Nd4' },
    { uci: 'd1d4', san: 'Rxd4' },
  ]);
  // The same line the sentence above it names, so the board and the text cannot
  // tell different stories.
  assert.deepEqual(move.betterLine.map((s) => s.san), move.bestLine.split(' '));
  assert.equal(move.betterLine[0].uci, 'f3g5');
});

test('a move with no refutation recorded still carries the move you played', () => {
  // The half of the evidence that is always there. The page falls back to it,
  // and one move is still worth watching.
  const r = reviewGame([hung({ refutation: [] })], { color: 'b' });
  assert.deepEqual(r.moves[0].playedLine, [{ uci: 'f3d4', san: 'Nd4' }]);
});

test('a move that cost nothing carries no position, since nothing will draw it', () => {
  const r = reviewGame([grade({
    san: 'e5', label: 'Best', drop: 0, mover: 'b',
    fenBefore: START, uci: 'e7e5',
  })], { color: 'b' });
  assert.equal(r.moves[0].fen, undefined);
});

test('a grade logged before positions were recorded still reviews, without one', () => {
  // Exactly the shape an older session.jsonl holds: a label and a cost, no FEN.
  const r = reviewGame([{ san: 'Nd4', label: 'Blunder', drop: 30, mover: 'b', ply: 21 }],
    { color: 'b' });
  assert.equal(r.graded, 1);
  assert.equal(r.moves[0].fen, undefined);
  assert.equal(r.moves[0].fault, 'unknown');
  assert.equal(r.moves[0].winBefore, null);
});

test('win probability either side of a move is carried for the curve', () => {
  const r = reviewGame([hung({ winBefore: undefined, winAfter: undefined,
    scoreBefore: { cp: 0 }, scoreAfter: { cp: -300 } })], { color: 'b' });
  // Derived from the score when the grade did not record it, and level is 50.
  assert.equal(Math.round(r.moves[0].winBefore), 50);
  assert.ok(r.moves[0].winAfter < 25, `winAfter was ${r.moves[0].winAfter}`);
});

/* ----------------------------------------------------------- recurrence --- */

test('the same fault twice in one game is a repeat', () => {
  const r = reviewGame([hung({ ply: 21 }), hung({ ply: 31 })], { color: 'b' });
  assert.deepEqual(r.repeats, [{ kind: 'hung', count: 2, plies: [21, 31] }]);
});

test('the same fault in two different games is not a repeat', () => {
  const all = reviewAll([
    reviewGame([hung()], { color: 'b', id: 's#1' }),
    reviewGame([hung()], { color: 'b', id: 's#2' }),
  ]);
  assert.equal(all.faults[0].games, 2);
  assert.equal(all.faults[0].repeatedGames, 0);
});

/* -------------------------------------------------------------- trends ---- */

test('games are put in the order they were played, whichever end the caller starts from', () => {
  const ids = (games) => chronological(games).map((g) => g.id);
  const games = [{ id: 'a#1' }, { id: 'a#2' }, { id: 'a#10' }, { id: 'b#1' }];

  assert.deepEqual(ids(games), ['a#1', 'a#2', 'a#10', 'b#1']);
  // The page hands them over newest-first; the answer must not change.
  assert.deepEqual(ids([...games].reverse()), ['a#1', 'a#2', 'a#10', 'b#1']);
  // Game 10 of a session is after game 2 of it, not before.
  assert.deepEqual(ids([{ id: 'a#10' }, { id: 'a#2' }]), ['a#2', 'a#10']);
});

test('no verdict on a habit that has not been seen in enough games', () => {
  const t = trendOf([{ per10: 4, count: 1 }, { per10: 3, count: 1 }, { per10: 2, count: 1 }]);
  assert.equal(t.verdict, 'unknown');
  assert.match(t.reason, /3 games/);
});

test('no verdict on a habit that has only happened once, however many games are in view', () => {
  const t = trendOf([{ per10: 9, count: 1 }, ...Array(5).fill({ per10: 0, count: 0 })]);
  assert.equal(t.verdict, 'unknown');
  assert.match(t.reason, /once/);
});

test('a small change is flat, because a count of blunders is not a precise number', () => {
  const t = trendOf([
    { per10: 10, count: 1 }, { per10: 10, count: 1 },
    { per10: 9.5, count: 1 }, { per10: 10, count: 1 },
  ]);
  assert.equal(t.verdict, 'flat');
});

test('a habit that stopped happening reads as improving, not as absent', () => {
  /*
   * The failure this is here for: counting only the games a fault appears in
   * makes the one outcome you are working towards invisible. Three games of
   * hanging pieces followed by three clean ones is the shape of a habit being
   * fixed, and it has to read that way.
   */
  const game = (id, moves) => reviewGame(moves, { color: 'b', id });
  const clean = grade({ san: 'e5', label: 'Best', drop: 0, mover: 'b' });

  const all = reviewAll([
    game('s#1', [hung(), clean]), game('s#2', [hung(), clean]), game('s#3', [hung(), clean]),
    game('s#4', [clean, clean]), game('s#5', [clean, clean]), game('s#6', [clean, clean]),
  ]);

  const f = all.faults.find((x) => x.kind === 'hung');
  assert.equal(f.history.length, 6, 'the clean games count as zeros, not as gaps');
  assert.deepEqual(f.history.map((h) => h.count), [1, 1, 1, 0, 0, 0]);
  assert.equal(f.trend.verdict, 'improving');
});

test('a habit that arrived late is not reported as getting worse from before it existed', () => {
  const game = (id, moves) => reviewGame(moves, { color: 'b', id });
  const clean = grade({ san: 'e5', label: 'Best', drop: 0, mover: 'b' });

  const all = reviewAll([
    game('s#1', [clean, clean]), game('s#2', [clean, clean]),
    game('s#3', [hung(), clean]), game('s#4', [hung(), clean]),
  ]);

  const f = all.faults.find((x) => x.kind === 'hung');
  // The history starts where the habit does, so the two clean games before it
  // are not evidence about it.
  assert.equal(f.history.length, 2);
  assert.equal(f.trend.verdict, 'unknown');
});

/* ------------------------------------------------------ colour and phase --- */

test('accuracy is split by the colour you had', () => {
  const clean = grade({ san: 'e5', label: 'Best', drop: 0, mover: 'b' });
  const asWhite = grade({ san: 'e4', label: 'Best', drop: 0, mover: 'w' });
  const all = reviewAll([
    reviewGame([hung(), clean], { color: 'b', id: 's#1' }),
    reviewGame([asWhite, asWhite], { color: 'w', id: 's#2' }),
  ]);

  assert.equal(all.byColor.w.games, 1);
  assert.equal(all.byColor.b.games, 1);
  // The accuracy curve tops out a whisker under 100; see `moveAccuracy`.
  assert.ok(all.byColor.w.acc / all.byColor.w.accMoves > 99.9);
  assert.ok(all.byColor.b.acc / all.byColor.b.accMoves < 90);
});

test('phase accuracy averages over the moves that carried one, not over all of them', () => {
  const r = reviewGame([hung()], { color: 'b', id: 's#2' });
  // A review written before phases carried accuracy: moves and loss, nothing else.
  const old = reviewGame([hung()], { color: 'b', id: 's#1' });
  for (const p of Object.values(old.phases)) { delete p.acc; delete p.accMoves; }

  const all = reviewAll([old, r]);
  const phase = Object.values(all.phases)[0];
  assert.equal(phase.moves, 2);
  assert.equal(phase.accMoves, 1, 'the older game contributes moves but no accuracy');
  assert.ok(phase.acc / phase.accMoves < 100);
});

/* --------------------------------------------------------- the write-ups --- */

test('every fault a review can produce has something to teach about it', () => {
  for (const [kind, f] of Object.entries(FAULTS)) {
    assert.ok(f.title && f.work, `${kind} has no heading`);
    assert.ok(f.what && f.why, `${kind} has no explanation`);
    assert.ok(f.checklist?.length, `${kind} has nothing to do at the board`);
    assert.ok(f.drill, `${kind} has nothing to practise`);
    // The terminal prints these on one line each.
    assert.ok(!f.work.includes('\n') && !f.title.includes('\n'), `${kind} wraps`);
  }
});
