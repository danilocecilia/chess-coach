import test from 'node:test';
import assert from 'node:assert/strict';
import {
  faultOf, phaseOf, moveAccuracy, reviewGame, reviewAll, totalMaterial, labelName,
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

test('labelName reads both shapes a grade arrives in', () => {
  assert.equal(labelName({ label: 'Blunder' }), 'Blunder');
  assert.equal(labelName({ label: { name: 'Blunder' } }), 'Blunder');
});
