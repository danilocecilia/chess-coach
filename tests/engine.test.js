/**
 * Integration test: real Stockfish, real positions.
 * This is the test that proves the judge actually judges.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { gradeMove, material } from '../src/grade.js';
import { LABELS } from '../src/verdict.js';
import { STOCKFISH } from '../src/config.js';

// White queen on f3, black knight on f6 defended by the g7 pawn.
// Qxf6?? hangs the queen for a knight — about as clear a blunder as exists.
const HANGING = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

let engine;
test.before(async () => { engine = await new Engine(STOCKFISH, { threads: 4 }).start(); });
test.after(async () => { await engine?.quit(); });

test('engine completes a UCI handshake and searches', async () => {
  const r = await engine.analyse(HANGING, 12);
  assert.ok(r.bestmove, 'expected a bestmove');
  assert.ok(r.score, 'expected a score');
  assert.ok(r.depth >= 12, `expected depth >= 12, got ${r.depth}`);
});

test('Qxf6 is graded a blunder', async () => {
  const g = await gradeMove(engine, HANGING, 'f3f6', 16);
  assert.equal(g.san, 'Qxf6');
  assert.equal(g.label, LABELS.BLUNDER, `graded ${g.label.name}, drop ${g.drop.toFixed(1)}`);
  assert.ok(g.drop > 25, `expected a big win% drop, got ${g.drop.toFixed(1)}`);
});

test("the engine's own top move is graded Best", async () => {
  const { bestmove } = await engine.analyse(HANGING, 16);
  const g = await gradeMove(engine, HANGING, bestmove, 16);
  assert.equal(g.label, LABELS.BEST, `graded ${g.label.name}`);
});

/*
 * The real position this was found in: logs/2026-09-30T20-09-59, move 39, Black.
 * Two mates are available — Rxf1# and Qxf1# — so the engine picks one and the
 * other is not `playedBest`. Graded through the score alone, mating with the
 * queen came back **Blunder, -100%**, because UCI answers `mate 0` for a mated
 * board and negating that gives `-0`.
 */
const MATE_IN_ONE = '4kr2/1p5p/2p1p3/2b3pP/4R3/8/r7/2q2N1K b - - 4 39';

test('mating with the move the engine did not pick is still not a blunder', async () => {
  const { bestmove } = await engine.analyse(MATE_IN_ONE, 12);
  // The premise: the engine prefers the rook, so the queen mate is not Best by
  // accident. If Stockfish ever changes its mind the test still holds.
  const other = bestmove === 'f8f1' ? 'c1f1' : 'f8f1';
  const g = await gradeMove(engine, MATE_IN_ONE, other, 12);
  assert.match(g.san, /#$/, `expected a mating move, got ${g.san}`);
  assert.equal(g.drop, 0, `mating cost ${g.drop.toFixed(1)}% of the win probability`);
  assert.equal(g.label, LABELS.BEST, `graded ${g.label.name}`);
});

test('a mating move is not searched past the end of the game', async () => {
  const g = await gradeMove(engine, MATE_IN_ONE, 'f8f1', 12);
  assert.equal(g.label, LABELS.BEST);
  // Nothing to punish and nothing to quote: the board has no continuation.
  assert.deepEqual(g.refutation, []);
  assert.equal(g.winAfter, 100);
});

test('a MultiPV search reports the best line first, and a worse runner-up', async () => {
  const r = await engine.analyse(HANGING, 12, { multipv: 2 });
  assert.equal(r.lines.length, 2, 'expected two lines');
  assert.equal(r.lines[0].pv[0], r.bestmove, 'line 1 must be the move bestmove names');
  assert.equal(r.score, r.lines[0].score, 'the headline score must be line 1, not the last seen');
  assert.ok(r.lines[0].score.cp >= r.lines[1].score.cp, 'line 2 must not outrank line 1');
});

test('a default search after a MultiPV one is single-line again', async () => {
  /*
   * Two traps in one. Stockfish emits multipv 1 then 2 at each depth, so keeping
   * "the deepest line" in a single slot hands back the best move paired with the
   * runner-up's score — silently wrong grades, not an error. And MultiPV is a
   * setoption: left set, it would leak into every later search.
   */
  await engine.analyse(HANGING, 12, { multipv: 2 });
  const r = await engine.analyse(HANGING, 12);
  assert.equal(r.lines.length, 1, 'MultiPV must not persist into the next search');
  assert.equal(r.lines[0].pv[0], r.bestmove);
  assert.equal(r.pv[0], r.bestmove, 'the reported pv must start with the reported best move');
});

test('a dead engine fails its callers instead of crashing or hanging', async () => {
  /*
   * Ctrl+C on Windows reaches every process on the console, so Stockfish is
   * usually gone before `shutdown` sends it `quit`. That write fails as an
   * asynchronous `error` event on the pipe — which the try/catch around the
   * write cannot see — and an unhandled one killed the process on the way out:
   *
   *     Error: write EPIPE ... at Engine.quit (src/engine.js:135:21)
   *
   * The other half is that nothing settled the promise a search was waiting on,
   * so an engine that died mid-game took the grading queue with it in silence.
   * node:test fails this on an unhandled 'error', which is the assertion for
   * the first half; the rejection is the assertion for the second.
   */
  const e = await new Engine(STOCKFISH, { threads: 1 }).start();
  e.proc.kill();

  /*
   * Block the event loop so the child's exit cannot be observed before `quit`
   * writes. That is the state a SIGINT handler genuinely runs in, and it is why
   * guarding the write on `stdin.writable` cannot fix this on its own: the
   * stream is still writable here — Node has simply not been told yet. Without
   * the `error` listener this line is `write EPIPE` and the process dies.
   */
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  assert.equal(e.proc.stdin.writable, true, 'the race needs a still-writable pipe');
  await e.quit();
  await e.quit();                       // idempotent: shutdown can be reached twice

  await assert.rejects(() => e.analyse(HANGING, 8), /exited|stopped/,
    'a search on a dead engine must reject, not wait for a bestmove that is not coming');
  // Give the deferred pipe error a turn to land, and fail this test if unhandled.
  await new Promise((r) => setTimeout(r, 100));
});

test('material counts from the requested side', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(material(start, 'w'), 0, 'start position is balanced');
  // Black is down a knight here.
  assert.ok(material('rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'w') > 0);
});
