/**
 * The coaching topics.
 *
 * Rungs of the old single ladder were about withholding the engine's move,
 * which produced sentences with no content in them. These are about what you
 * failed to see, so the tests are mostly "does it say the true thing" rather
 * than "does it avoid saying the forbidden thing".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { missCost, atStake, threatSteps, weaknessSteps, suggestSteps, answerSteps, TOPICS, KEYS } from '../src/hint.js';
import { nullMoveFen } from '../src/threat.js';
import { netMaterial } from '../src/grade.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Two engine lines with the given centipawn scores. */
const lines = (best, second, pv = ['g1f3', 'b8c6']) => [
  { score: { cp: best }, pv, depth: 18, multipv: 1 },
  { score: { cp: second }, pv: ['b1c3', 'b8c6'], depth: 18, multipv: 2 },
];

test('material is counted where the line ends, not partway through it', () => {
  /*
   * The bug this replaced, caught on a real engine line rather than in theory.
   * After 1.e4 e5 the engine's line for a free black move runs
   *
   *     Nf6 Nc3 d5 exd5 Nxd5 ...
   *
   * and a fixed four-ply window stops after exd5 and reports White a pawn up —
   * which Black takes back on the very next ply. A coach stating that as a fact
   * is worse than a coach saying nothing.
   */
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
  const pv = ['g8f6', 'b1c3', 'd7d5', 'e4d5', 'f6d5'];
  assert.equal(netMaterial(fen, pv, 'w'), 0, 'the pawn comes straight back');
  assert.equal(netMaterial(fen, pv.slice(0, 4), 'w'), 1, 'and a truncated line is what lied');
});

test('criticality borrows the grader\'s own bands', () => {
  const chess = new Chess(START);
  assert.equal(missCost(chess, lines(50, -850)).label.name, 'Blunder');
  assert.equal(missCost(chess, lines(30, 25)).label.name, 'Excellent');
  for (const [a, b] of [[50, -850], [50, -300], [50, -120], [50, -40], [30, 25]]) {
    assert.ok(missCost(chess, lines(a, b)).text, `no phrase for ${a}/${b}`);
  }
});

test('a forced move is called forced, from one legal move and no lines', () => {
  const forced = new Chess('7k/8/8/5N2/8/8/8/1K5R b - - 0 1');
  assert.equal(forced.moves().length, 1, 'fixture must have one legal move');
  assert.ok(missCost(forced, null).forced);
  // A single-line search is not evidence that a position is forced.
  assert.equal(missCost(new Chess(START), lines(50, -850).slice(0, 1)), null);
});

test('mate is reported as mate, not as the pawn taken on the way', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
  assert.match(atStake(fen, [{ score: { mate: 1 }, pv: ['f3f7'] }], 'w').text, /mate in one/);
  assert.match(atStake(fen, [{ score: { mate: -2 }, pv: ['f3f7'] }], 'w').text, /being mated/);
});

test('a quiet line does not claim the position is safe', () => {
  /*
   * This measures what your best line nets. Saying "nothing hangs" read as an
   * all-clear on a board that had mate in one on it, while the weaknesses topic
   * was correctly reporting f7 attacked twice and defended once.
   */
  const s = atStake(START, [{ score: { cp: 20 }, pv: ['g1f3', 'b8c6'] }], 'w');
  assert.ok(s.positional);
  assert.ok(!/nothing hangs/.test(s.text), `over-claims safety: ${s.text}`);
  assert.match(s.text, /best line/);
});

test('the threat topic names his move, and only his', () => {
  const steps = threatSteps({
    san: 'Nxe4', from: 'c3', to: 'e4', target: { type: 'n', color: 'w' },
    costsMaterial: 3, costsWinPct: 30, mate: null, serious: true,
  });
  assert.equal(steps.length, 3);
  assert.match(steps[1], /your knight on e4/);
  assert.match(steps[2], /Nxe4/);
  assert.match(steps[2], /wins a piece/);
});

test('his move is read out as well as notated', () => {
  /*
   * The overlay has no hover to hide a reading behind, and this line is the one
   * place the coach answers in pure notation. Both halves matter: the words so
   * the hint can be acted on today, the notation so it stops being needed.
   */
  const steps = threatSteps({
    san: 'Qxe8#', from: 'd8', to: 'e8', target: { type: 'r', color: 'w' },
    costsMaterial: 5, costsWinPct: 99, mate: 1, serious: true,
  });
  assert.match(steps[2], /Qxe8# \(queen takes on e8, checkmate\)/);
});

test('a free move is not dressed up as a threat', () => {
  const steps = threatSteps({ san: 'Nf6', to: 'f6', target: null,
    costsMaterial: 0, costsWinPct: 6, mate: null, serious: false });
  assert.equal(steps.length, 1);
  assert.match(steps[0], /nothing immediate/);
});

test('being in check is reported as the thing already happening', () => {
  assert.match(threatSteps({ check: true })[0], /in check/);
});

test('the weaknesses topic says so when there is nothing wrong', () => {
  const healthy = new Chess('r4rk1/pppq1ppp/2npbn2/4p3/4P3/2NPBN2/PPPQ1PPP/R4RK1 w - - 0 12');
  assert.match(weaknessSteps(healthy, 'w')[0], /nothing loose/);
});

test('every topic answers, and none of them needs the engine except the threat', () => {
  const chess = new Chess(START);
  const ctx = { fen: START, chess, lines: lines(50, -850), color: 'w', threat: null };
  for (const key of KEYS) {
    const topic = TOPICS[key];
    const steps = topic.steps(ctx);
    if (topic.needsThreat) assert.equal(steps, null, `${key} should wait for its search`);
    else assert.ok(steps.length > 0, `${key} produced nothing`);
  }
});

test('the suggest topic names the piece, then the move, then the line', () => {
  const chess = new Chess(START);
  const steps = suggestSteps(chess, lines(50, -850), START);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /knight on g1/);
  assert.match(steps[1], /Nf3/);
  assert.match(steps[2], /the line:/);
});

test('suggest handles castling', () => {
  const fen = 'r1bqk2r/ppppbppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const chess = new Chess(fen);
  const pv = ['e1g1'];
  const steps = suggestSteps(chess, [{ score: { cp: 50 }, pv, depth: 18, multipv: 1 }], fen);
  assert.ok(steps);
  assert.match(steps[0], /castling/);
  assert.match(steps[1], /O-O/);
});

test('suggest returns null when there are no lines', () => {
  const chess = new Chess(START);
  assert.equal(suggestSteps(chess, null, START), null);
  assert.equal(suggestSteps(chess, [], START), null);
});

test('answer shows the move directly without naming the piece first', () => {
  const chess = new Chess(START);
  const steps = answerSteps(chess, lines(50, -850), START);
  assert.equal(steps.length, 2);
  assert.match(steps[0], /Nf3/);
  assert.match(steps[0], /knight/);
  assert.match(steps[1], /the line:/);
});

test('answer returns null when there are no lines', () => {
  const chess = new Chess(START);
  assert.equal(answerSteps(chess, null, START), null);
  assert.equal(answerSteps(chess, [], START), null);
});

test('the null move hands over the turn and drops en passant', () => {
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
  const passed = nullMoveFen(fen).split(' ');
  assert.equal(passed[1], 'b', 'the turn must change hands');
  assert.equal(passed[3], '-', 'en passant cannot survive a pass');
});
