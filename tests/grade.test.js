import test from 'node:test';
import assert from 'node:assert/strict';
import { hangingMaterial, exchangeSwing, pvSteps, pvToSan } from '../src/grade.js';
import { classify, LABELS } from '../src/verdict.js';

/*
 * Positions from a real session — logs/2026-09-24T20-23-21, White — kept
 * because the game is the bug.
 *
 * White loses a bishop, a knight and a rook after the position is already lost,
 * and every one of those moves graded Excellent or Good: at -6.5 a hung bishop
 * moves win% by 0.4, and there is nothing left in the scale to report it with.
 * The engine scores below are the ones Stockfish returned at depth 18.
 *
 * `hanging` is not from the log — it is computed from the position, which is
 * the point of it. Re-grading this game a second time produced different
 * refutation lines for the same moves, because a side that is winning six ways
 * has no reason to prefer the line that takes the hanging piece. Anything read
 * off the pv therefore moves between runs; what is takeable on the board does
 * not.
 */
const GAME = [
  {
    ply: 17,
    san: 'Nxe5',
    fenBefore: 'r1b2rk1/pppp1ppp/3q3n/2bNp3/Pn2P3/1P1B1N2/2PP1PPP/R1BQ1RK1 w - - 1 9',
    fenAfter:  'r1b2rk1/pppp1ppp/3q3n/2bNN3/Pn2P3/1P1B4/2PP1PPP/R1BQ1RK1 b - - 0 9',
    scoreBefore: { cp: 179 },
    scoreAfter: { cp: -612 },
    playedBest: false,
    hanging: -3,                 // Qxe5, and nothing defends e5
    label: LABELS.BLUNDER,
    was: 'Blunder',
  },
  {
    ply: 19,
    san: 'Bb2',
    fenBefore: 'r1b2rk1/pppp1ppp/7n/2bNq3/Pn2P3/1P1B4/2PP1PPP/R1BQ1RK1 w - - 0 10',
    fenAfter:  'r1b2rk1/pppp1ppp/7n/2bNq3/Pn2P3/1P1B4/1BPP1PPP/R2Q1RK1 b - - 1 10',
    scoreBefore: { cp: -649 },
    scoreAfter: { cp: -662 },
    playedBest: false,
    hanging: -3,                 // Qxb2 takes the bishop for nothing
    label: LABELS.MISTAKE,
    was: 'Excellent',
  },
  {
    ply: 21,
    san: 'Ne7+',
    fenBefore: 'r1b2rk1/pppp1ppp/7n/2bN4/Pn2P3/1P1B4/1qPP1PPP/R2Q1RK1 w - - 0 11',
    fenAfter:  'r1b2rk1/ppppNppp/7n/2b5/Pn2P3/1P1B4/1qPP1PPP/R2Q1RK1 b - - 1 11',
    scoreBefore: { cp: -668 },
    scoreAfter: { cp: -1018 },
    playedBest: false,
    hanging: -3,                 // Bxe7 takes the knight
    label: LABELS.MISTAKE,
    was: 'Good',
  },
  {
    ply: 23,
    san: 'Bb5',
    fenBefore: 'r1b2rk1/ppppbppp/7n/8/Pn2P3/1P1B4/1qPP1PPP/R2Q1RK1 w - - 0 12',
    fenAfter:  'r1b2rk1/ppppbppp/7n/1B6/Pn2P3/1P6/1qPP1PPP/R2Q1RK1 b - - 1 12',
    scoreBefore: { cp: -1034 },
    scoreAfter: { cp: -1049 },
    playedBest: false,
    hanging: -1,                 // a pawn, which is under the floor
    label: LABELS.EXCELLENT,
    was: 'Excellent',
  },
  {
    ply: 25,
    san: 'c3',
    fenBefore: 'r1b2rk1/ppppbppp/7n/1B6/Pn1qP3/1P6/2PP1PPP/R2Q1RK1 w - - 2 13',
    fenAfter:  'r1b2rk1/ppppbppp/7n/1B6/Pn1qP3/1PP5/3P1PPP/R2Q1RK1 b - - 0 13',
    scoreBefore: { cp: -980 },
    scoreAfter: { cp: -983 },
    playedBest: true,
    hanging: -1,
    label: LABELS.BEST,
    was: 'Best',
  },
  {
    ply: 33,
    san: 'Rc4',
    fenBefore: 'r1b2rk1/pp1p1ppp/2p2b1n/8/Pq6/1P1B4/3P1PPP/2RQ1RK1 w - - 0 17',
    fenAfter:  'r1b2rk1/pp1p1ppp/2p2b1n/8/PqR5/1P1B4/3P1PPP/3Q1RK1 b - - 1 17',
    scoreBefore: { cp: -987 },
    scoreAfter: { cp: -994 },
    playedBest: false,
    hanging: 0,                  // Qxc4 loses the queen to Bxc4 — not hanging
    label: LABELS.EXCELLENT,
    was: 'Excellent',
  },
  {
    ply: 43,
    san: 'Re7',
    fenBefore: 'r1b2rk1/pp3ppp/2p2b1n/3p4/q5P1/3B1Q2/2RP1P1P/4R1K1 w - - 0 22',
    fenAfter:  'r1b2rk1/pp2Rppp/2p2b1n/3p4/q5P1/3B1Q2/2RP1P1P/6K1 b - - 1 22',
    scoreBefore: { cp: -1028 },
    scoreAfter: { cp: -1256 },
    playedBest: false,
    hanging: -5,                 // Bxe7 takes the rook
    label: LABELS.BLUNDER,
    was: 'Excellent',
  },
];

const grade = (m) => classify({
  before: m.scoreBefore,
  after: m.scoreAfter,
  playedBest: m.playedBest,
  hanging: hangingMaterial(m.fenAfter, 'w'),
});

for (const m of GAME) {
  test(`ply ${m.ply} ${m.san}: ${-m.hanging} points hanging`, () => {
    assert.equal(hangingMaterial(m.fenAfter, 'w'), m.hanging);
  });

  test(`ply ${m.ply} ${m.san} grades ${m.label.name} (was ${m.was})`, () => {
    assert.equal(grade(m).label, m.label);
  });
}

test('every piece thrown away is now graded as costing something', () => {
  for (const m of GAME) {
    if (m.hanging > -2 || m.playedBest) continue;
    const { label } = grade(m);
    assert.ok(
      [LABELS.MISTAKE, LABELS.BLUNDER].includes(label),
      `ply ${m.ply} ${m.san} left ${-m.hanging} points hanging and graded ${label.name}`,
    );
  }
});

test('the quiet moves in the same lost position are left alone', () => {
  // The floor has to be able to tell these apart from the three above, or it is
  // just relabelling a lost game and says nothing.
  for (const m of GAME.filter((x) => x.hanging > -2)) {
    assert.equal(grade(m).floored, false, `ply ${m.ply} ${m.san} was floored`);
  }
});

/* ------------------------------------------- static exchange evaluation ---- */

test('a defended piece is not hanging', () => {
  // ply 33: the rook on c4 is attacked by the queen and defended by Bd3, so
  // Qxc4 Bxc4 loses the queen. Counting attackers alone would call this -5.
  const m = GAME.find((g) => g.ply === 33);
  assert.equal(hangingMaterial(m.fenAfter, 'w'), 0);
});

test('hangingMaterial only answers for the side not to move', () => {
  const m = GAME.find((g) => g.ply === 19);
  assert.equal(hangingMaterial(m.fenAfter, 'b'), 0);   // Black is to move
});

test('a starting position has nothing hanging', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(hangingMaterial(start, 'b'), 0);
});

/* -------------------------------------------------- the exchange, as run ---- */

test('exchangeSwing stops at the first quiet move', () => {
  // Still what the review quotes back, and still measured over the engine's own
  // line: ply 19's logged refutation ran Qxb2 Nxb4 Bxb4 c3, and counting stops
  // at the pawn push.
  const m = GAME.find((g) => g.ply === 19);
  const pv = ['e5b2', 'd5b4', 'c5b4', 'c2c3', 'b4c3'];
  assert.equal(exchangeSwing(m.fenBefore, m.fenAfter, pv, 'w'), -3);
  assert.equal(exchangeSwing(m.fenBefore, m.fenAfter, pv.slice(0, 1), 'w'), -3);
});

test('a refutation that starts quietly costs nothing', () => {
  const m = GAME.find((g) => g.ply === 33);
  assert.equal(exchangeSwing(m.fenBefore, m.fenAfter, ['b4e7', 'c4f4'], 'w'), 0);
});

test('no refutation is not a material loss', () => {
  const m = GAME[0];
  assert.equal(exchangeSwing(m.fenBefore, m.fenAfter, [], 'w'), 0);
  assert.equal(exchangeSwing(m.fenBefore, m.fenAfter, undefined, 'w'), 0);
});

/* ------------------------------------------------------- a line, walked ---- */

test('a line is walked out as both the notation and the squares', () => {
  const m = GAME.find((g) => g.ply === 19);
  const steps = pvSteps(m.fenAfter, ['e5b2', 'd5b4', 'c5b4'], 6);

  // SAN for the reader, UCI for whatever has to move a piece from one square to
  // another without parsing it.
  assert.deepEqual(steps, [
    { uci: 'e5b2', san: 'Qxb2' },
    { uci: 'd5b4', san: 'Nxb4' },
    { uci: 'c5b4', san: 'Bxb4' },
  ]);
  // The same walk the sentences are written from, so the two cannot disagree.
  assert.equal(pvToSan(m.fenAfter, ['e5b2', 'd5b4', 'c5b4'], 6), 'Qxb2 Nxb4 Bxb4');
});

test('a line that stops playing is cut there rather than thrown away', () => {
  const m = GAME.find((g) => g.ply === 19);
  // A pv is only as legal as the position it was searched from, and a stale one
  // is the shape this has to survive: one good move, then nonsense.
  assert.deepEqual(pvSteps(m.fenAfter, ['e5b2', 'h1h8', 'd5b4'], 6),
    [{ uci: 'e5b2', san: 'Qxb2' }]);
  assert.deepEqual(pvSteps(m.fenAfter, [], 6), []);
  assert.deepEqual(pvSteps(m.fenAfter, undefined, 6), []);
});

test('a line is cut to the plies asked for, so the page and the text agree', () => {
  const m = GAME.find((g) => g.ply === 19);
  assert.equal(pvSteps(m.fenAfter, ['e5b2', 'd5b4', 'c5b4'], 2).length, 2);
});
