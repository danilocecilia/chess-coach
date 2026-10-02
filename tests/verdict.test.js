import test from 'node:test';
import assert from 'node:assert/strict';
import { winProb, scoreToWinProb, classify, LABELS } from '../src/verdict.js';
import { parseInfo, negate } from '../src/engine.js';

test('winProb is centred and monotonic', () => {
  assert.equal(Math.round(winProb(0)), 50);
  assert.ok(winProb(300) > winProb(100));
  assert.ok(winProb(-300) < winProb(-100));
  assert.ok(winProb(2000) > 95);
});

test('mate scores pin to the ends of the scale', () => {
  assert.equal(scoreToWinProb({ mate: 3 }), 100);
  assert.equal(scoreToWinProb({ mate: -2 }), 0);
});

test('an even swap of a big eval while winning is not a blunder', () => {
  // +900 -> +700 is a 200cp drop, but barely moves win%: still totally winning.
  const { label } = classify({ before: { cp: 900 }, after: { cp: 700 } });
  assert.notEqual(label, LABELS.BLUNDER);
});

test('the same 200cp drop in a level position is a mistake', () => {
  // ~17.8 win% swing. Costly, but recoverable — the scale should say Mistake.
  const { label, drop } = classify({ before: { cp: 20 }, after: { cp: -180 } });
  assert.equal(label, LABELS.MISTAKE);
  assert.ok(drop > 15 && drop < 25, `drop was ${drop}`);
});

test('dropping a whole piece from level is a blunder', () => {
  const { label } = classify({ before: { cp: 20 }, after: { cp: -400 } });
  assert.equal(label, LABELS.BLUNDER);
});

test('playing the engine top move grades Best', () => {
  const { label } = classify({ before: { cp: 30 }, after: { cp: 28 }, playedBest: true });
  assert.equal(label, LABELS.BEST);
});

test('a winning sacrifice grades Brilliant', () => {
  const { label } = classify({
    before: { cp: 50 }, after: { cp: 60 }, playedBest: true, sacrificed: true,
  });
  assert.equal(label, LABELS.BRILLIANT);
});

test('walking into mate is a blunder', () => {
  const { label } = classify({ before: { cp: 0 }, after: { mate: -1 } });
  assert.equal(label, LABELS.BLUNDER);
});

/*
 * Delivering mate, which the score alone cannot say.
 *
 * UCI reports a mated board as `mate 0`, so negating it into the mover's frame
 * gives `-0` — not greater than zero, so the win read as 0%. Real numbers: in
 * logs/2026-09-30T20-09-59 the move `Qxf1#` graded **Blunder at -100%** for
 * mating, because a second mate (`Rxf1#`) was the engine's pick and so
 * `playedBest` did not cover for it. Five further mates in these logs recorded a
 * 100% drop each and were held to Best only by that accident.
 */
test('delivering mate is the best a move can be, not a 100% blunder', () => {
  const v = classify({ before: { mate: 1 }, after: { mate: 0 }, mated: true });
  assert.equal(v.label, LABELS.BEST);
  assert.equal(v.drop, 0);
  assert.equal(v.winAfter, 100);
});

test('mating by giving material away is Brilliant, not floored', () => {
  // A mate that sheds a queen on the way is still a mate. The material floor
  // must not reach it, which is why `mated` is answered before every band.
  const v = classify({
    before: { cp: 0 }, after: { mate: 0 }, mated: true, sacrificed: true, hanging: -9,
  });
  assert.equal(v.label, LABELS.BRILLIANT);
  assert.equal(v.drop, 0);
  assert.equal(v.floored, false);
});

test('without the board, the same scores read as a total loss', () => {
  // The bug, pinned: this is the identical position graded the old way.
  const v = classify({ before: { mate: 1 }, after: { mate: -0 } });
  assert.equal(v.drop, 100);
  assert.equal(v.label, LABELS.BLUNDER);
});

/* ------------------------------------------------- the material floor ---- */

/*
 * The bug these pin: win% has no room left in a decided position, so every move
 * after the game is lost graded Excellent no matter what it gave away. Numbers
 * below are the real ones from logs/2026-09-24T20-23-21.
 */

test('hanging a bishop in a lost position is not Excellent', () => {
  // ply 19 Bb2: -649 -> -662 is a 0.4% drop, and Qxb2 takes the bishop.
  const bare = classify({ before: { cp: -649 }, after: { cp: -662 } });
  assert.equal(bare.label, LABELS.EXCELLENT, 'precondition: win% alone says Excellent');

  const { label, floored } = classify({
    before: { cp: -649 }, after: { cp: -662 }, hanging: -3,
  });
  assert.equal(label, LABELS.MISTAKE);
  assert.equal(floored, true);
});

test('hanging a rook in a lost position is a blunder', () => {
  // ply 43 Re7: -1028 -> -1256, a 1.2% drop, and Bxe7 takes the rook.
  const { label } = classify({
    before: { cp: -1028 }, after: { cp: -1256 }, hanging: -5,
  });
  assert.equal(label, LABELS.BLUNDER);
});

test('the floor never improves a label', () => {
  // ply 17 Nxe5: a 56% drop *and* two points shed. The floor for -2 is Mistake;
  // the move is a Blunder and must stay one.
  const { label } = classify({
    before: { cp: 179 }, after: { cp: -612 }, hanging: -2,
  });
  assert.equal(label, LABELS.BLUNDER);
});

test('the engine own move is exempt from the floor', () => {
  // ply 25 c3 was Stockfish's first choice at -9.8. Given a whole piece hanging
  // to make the point: the engine's own move is not a mistake however it pays.
  const { label, floored } = classify({
    before: { cp: -980 }, after: { cp: -983 }, playedBest: true, hanging: -3,
  });
  assert.equal(label, LABELS.BEST);
  assert.equal(floored, false);
});

test('a quiet move in a lost position is still Excellent', () => {
  // The floor must not simply blanket a lost game: ply 23 Bb5 left only a pawn
  // takeable, and grading it as though it hung a piece is the bug mirrored.
  const { label, floored } = classify({
    before: { cp: -1034 }, after: { cp: -1049 }, hanging: -1,
  });
  assert.equal(label, LABELS.EXCELLENT);
  assert.equal(floored, false);
});

test('a pawn is below the floor', () => {
  const { label } = classify({ before: { cp: -900 }, after: { cp: -915 }, hanging: -1 });
  assert.equal(label, LABELS.EXCELLENT);
});

test('a sound sacrifice while the game is live is left alone', () => {
  // The whole reason the floor is gated on a decided position. A piece given up
  // from level with the evaluation holding is a sacrifice, not a Mistake.
  const { label, floored } = classify({
    before: { cp: 30 }, after: { cp: 25 }, hanging: -3,
  });
  assert.equal(label, LABELS.EXCELLENT);
  assert.equal(floored, false);
});

test('material is still floored when the game is decided the other way', () => {
  // +8 is just as saturated as -8: hanging a rook there also reads as ~0 drop.
  const { label } = classify({ before: { cp: 800 }, after: { cp: 770 }, hanging: -5 });
  assert.equal(label, LABELS.BLUNDER);
});

test('parseInfo pulls depth, score and pv', () => {
  const r = parseInfo('info depth 20 seldepth 28 score cp -34 nodes 1000 pv e2e4 e7e5 g1f3');
  assert.equal(r.depth, 20);
  assert.deepEqual(r.score, { cp: -34 });
  assert.deepEqual(r.pv, ['e2e4', 'e7e5', 'g1f3']);
});

test('negate flips both cp and mate', () => {
  assert.deepEqual(negate({ cp: 120 }), { cp: -120 });
  assert.deepEqual(negate({ mate: 4 }), { mate: -4 });
});
