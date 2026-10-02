/**
 * The session's wiring, without Stockfish.
 *
 * `play.test.js` covers the deck and the state machine; this covers the part
 * that only exists once the two are joined to an engine — which stage a move
 * lands in, what the coach is given to say, when the move is handed over, and
 * what reaches the history file.
 *
 * The engine is faked because none of that depends on how well it plays. What it
 * must do is behave like `Engine.analyse`: return a `bestmove`, a score in the
 * side-to-move's frame, and two lines when MultiPV 2 is asked for, since
 * `gradeMove` and the `c` topic both read exactly those.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { PlaySession } from '../src/play-server.js';
import { REVEAL_AFTER, TIPS_AFTER, TIP_ORDER } from '../src/play.js';

/* The costliest position in the logs this was built from. See play.test.js. */
const FEN = 'r1b1qNk1/1p1p1pp1/p5np/2pP4/2B1Q3/5N2/PP3PPP/R3K2R b KQ - 0 18';
const WRONG = 'g6f8';   // Nxf8 — what you played
const RIGHT = 'e8e4';   // Qxe4+ — what was there

const after = (fen, uci) => {
  const c = new Chess(fen);
  c.move(c.moves({ verbose: true }).find((m) => m.from + m.to + (m.promotion ?? '') === uci));
  return c.fen();
};
const AFTER_RIGHT = after(FEN, RIGHT);

/**
 * Enough of an engine to grade with.
 *
 * `best` names the move it prefers so `playedBest` can fire on the position that
 * matters; everywhere else it takes the first legal move, which is all a reply
 * has to be here. Scores are in the side-to-move's frame, as UCI reports them.
 */
class FakeEngine {
  constructor({ best = {}, score = () => ({ cp: 0 }) } = {}) {
    this.best = best;
    this.score = score;
    this.searches = 0;
  }

  async analyse(fen, depth = 18, { multipv = 1 } = {}) {
    this.searches++;
    const legal = new Chess(fen).moves({ verbose: true });
    const first = legal[0] ? legal[0].from + legal[0].to + (legal[0].promotion ?? '') : null;
    const bestmove = this.best[fen] ?? first;
    const score = this.score(fen);
    const line = { depth, multipv: 1, score, pv: bestmove ? [bestmove] : [] };
    return {
      bestmove, score, depth, pv: line.pv,
      lines: multipv > 1 ? [line, { ...line, multipv: 2, score: { cp: -40 } }] : [line],
    };
  }

  async quit() {}
}

const scenario = (o = {}) => ({
  key: FEN, id: 'test#36', kind: 'missed-threat', fen: FEN, color: 'b',
  played: WRONG, playedSan: 'Nxf8', best: RIGHT, bestSan: 'Qxe4+',
  drop: 94, phase: 'middlegame', when: '1 Oct, 02:37', ...o,
});

/**
 * A session in which exactly one move holds.
 *
 * Scores are in the side-to-move's frame, so "White to move and +900" is the
 * collapse that makes a Black move a Blunder. Every Black move except `RIGHT`
 * reaches such a position, which is what a drill position actually looks like —
 * and it is why the second wrong move has to fail too, or the escalation to
 * handing the move over could never be reached.
 */
const session = (o = {}) => new PlaySession({
  engine: new FakeEngine({
    best: { [FEN]: RIGHT },
    score: (fen) => (fen === AFTER_RIGHT
      ? { cp: -900 }                                      // White to move, and lost
      : fen.split(' ')[1] === 'w' ? { cp: 900 } : { cp: 0 }),
  }),
  scenarios: [scenario()],
  depth: 12,
  ...o,
});

const tones = (st) => st.coach.map((c) => c.tone);
const text = (st) => st.coach.map((c) => c.text).join(' | ');

/* ------------------------------------------------------------------ opening -- */

test('a session opens on the position, your move, your way round', async () => {
  const s = await session().begin();
  const st = s.state;
  assert.equal(st.stage, 'solve');
  assert.equal(st.board.fen, FEN);
  assert.equal(st.board.youToMove, true);
  assert.equal(st.board.flipped, true, 'you had Black, so Black is at the bottom');
  assert.equal(st.session.at, 1);
  assert.equal(st.session.total, 1);
});

test('a first encounter is told what kind of mistake it was, a repeat is not', async () => {
  const fresh = await session().begin();
  assert.ok(text(fresh).includes('already attacked'), 'the class should be named once');

  const again = await session({ history: { [FEN]: { seen: 3, lastResult: 'pass' } } }).begin();
  assert.ok(!text(again).includes('already attacked'),
    'naming it on a repeat is most of the answer');
  assert.ok(text(again).includes('seen this one before'));
});

test('the cost is always stated — it is why the position is here', async () => {
  const s = await session().begin();
  assert.ok(text(s).includes('94%'));
  assert.ok(tones(s).includes('cost'));
});

/* -------------------------------------------------------------- your move --- */

test('replaying your own mistake fails, and the board does not move on', async () => {
  const s = await session().begin();
  const st = await s.move({ from: 'g6', to: 'f8' });
  assert.equal(st.stage, 'punished');
  assert.equal(st.board.fen, FEN, 'the rep position stays put');
  assert.equal(st.can.move, false);
  assert.equal(st.can.retry, true);
  assert.ok(tones(st).includes('miss'));
});

test('a failure names the fault from the board, not from a model', async () => {
  const s = await session().begin();
  const st = await s.move({ from: 'g6', to: 'f8' });
  // faultOf's own words, measured against the stored position.
  assert.ok(tones(st).includes('fault'), 'expected a named fault');
  assert.match(text(st), /queen on e8/);
});

test('the punishment is handed over as moves to play, not as a sentence', async () => {
  const s = await session().begin();
  const st = await s.move({ from: 'g6', to: 'f8' });
  assert.ok(st.animate.length >= 1);
  assert.equal(st.animate[0].by, 'you');
  assert.equal(st.animate[0].san, 'Nxf8');
});

/**
 * Miss the same position over and over, keeping what the coach said each time.
 *
 * Every Black move here except `RIGHT` loses, so each of these is a real miss
 * rather than a contrivance — which is what makes the ladder worth testing at
 * all.
 */
const missRepeatedly = async (s, times) => {
  const said = [];
  for (let i = 0; i < times; i++) {
    said.push(await s.move({ from: 'g8', to: 'h8' }));     // Kh8, which loses here
    if (i < times - 1) await s.retry();
  }
  return said;
};

test('a second miss names the loose piece, and still not the move', async () => {
  const s = await session().begin();
  const [first, second] = await missRepeatedly(s, 2);
  assert.equal(first.reveal, null);
  assert.ok(tones(first).includes('watch'), 'the first miss points');
  assert.equal(second.reveal, null, 'two misses is no longer enough to be told');
  assert.ok(tones(second).includes('weak'), 'but the loose piece is named');
});

test('from the third miss the coach answers instead of pointing again', async () => {
  const s = await session().begin();
  const said = await missRepeatedly(s, TIPS_AFTER);
  const last = said.at(-1);
  assert.equal(last.reveal, null, 'a tip is not the move');
  assert.ok(tones(last).includes('hint'), 'expected a real tip by now');
  // And it is the hint ladder's own words, not a second vocabulary invented for
  // drills — this is the same sentence `w` would have given you.
  assert.deepEqual(s.drill.told, ['w']);
  assert.ok(s.drill.asked.includes('w'), 'help is recorded however it arrived');
});

test('nothing says the move until the ladder gives it up', async () => {
  /*
   * The rule the whole project is organised around, checked the blunt way:
   * `Qxe4+` must not appear anywhere in anything the coach says until the last
   * rung. It is worth testing bluntly because the ways it leaks are indirect —
   * `faultOf` ends two of its sentences with "— Nf6 instead", which is right for
   * a finished game and wrong for a position you are still being asked to solve.
   */
  const s = await session().begin();
  const said = await missRepeatedly(s, REVEAL_AFTER);
  for (const [i, st] of said.slice(0, -1).entries()) {
    assert.ok(!text(st).includes('Qxe4'), `miss ${i + 1} named the move: ${text(st)}`);
  }
  assert.ok(text(said.at(-1)).includes('Qxe4+'), 'and then, finally, it does');
});

test('the tips are spent in order, and the move comes last of all', async () => {
  const s = await session().begin();
  const said = await missRepeatedly(s, REVEAL_AFTER);

  const tips = said.slice(TIPS_AFTER - 1, REVEAL_AFTER - 1);
  assert.equal(tips.length, TIP_ORDER.length);
  for (const st of tips) assert.equal(st.reveal, null, 'no tip may name the move');
  assert.deepEqual(s.drill.told, TIP_ORDER, 'each topic spent once, in order');

  const last = said.at(-1);
  assert.ok(last.reveal, 'the move is given up once the tips run out');
  assert.equal(last.reveal.san, 'Qxe4+');
});

test('the move that was there passes, and he answers', async () => {
  const s = await session().begin();
  const st = await s.move({ from: 'e8', to: 'e4' });
  assert.equal(st.stage, 'continue');
  assert.ok(tones(st).includes('hit'));
  assert.ok(tones(st).includes('opp'), 'he should have replied in the same round trip');
  assert.equal(st.board.youToMove, true, 'and it is your move again');
});

test('every move in the continuation is graded too', async () => {
  const s = await session().begin();
  await s.move({ from: 'e8', to: 'e4' });
  const legal = s.drill.chess.moves({ verbose: true })[0];
  const st = await s.move({ from: legal.from, to: legal.to });
  assert.ok(tones(st).some((t) => t === 'hit' || t === 'miss'),
    'a continuation move gets a verdict, which is what makes this a session');
});

/* ------------------------------------------------------------ take-backs --- */

/**
 * Solve the rep, then play one move of the continuation.
 *
 * `nth` picks which legal move: the fake engine prefers the first one, so 0 is a
 * move that grades as Best and anything else is a miss. That is the only way to
 * choose a *failing* continuation move deliberately here.
 */
const pick = (s, nth = 0) => {
  const m = s.drill.chess.moves({ verbose: true })[nth];
  return { from: m.from, to: m.to };
};
const intoContinuation = async (s, nth = 0) => {
  await s.move({ from: 'e8', to: 'e4' });
  return s.move(pick(s, nth));
};

test('there is nothing to take back until you are past the rep', async () => {
  const s = await session().begin();
  assert.equal(s.state.can.back, false, 'not before you have moved');
  await s.move({ from: 'g6', to: 'f8' });
  assert.equal(s.state.can.back, false, 'and not while the punishment is showing');
  assert.ok((await s.back()).error, 'and asking anyway is refused, not obeyed');
});

test('the rep move is not takeable back — that is what retry is for', async () => {
  const s = await session().begin();
  await s.move({ from: 'e8', to: 'e4' });
  assert.equal(s.state.can.back, false);
  assert.ok((await s.back()).error, 'un-solving the drill is not a take-back');
});

test('a move in the continuation comes back, and his answer with it', async () => {
  const s = await session().begin();
  await s.move({ from: 'e8', to: 'e4' });
  const node = s.drill.fen;                      // the position you were asked to move at
  const played = s.drill.played.length;
  const st = await intoContinuation(s);
  assert.equal(st.can.back, true);

  const back = await s.back();
  assert.equal(back.board.fen, node, 'exactly the position you left');
  assert.equal(back.board.youToMove, true);
  assert.equal(back.can.move, true, 'and the board is yours to touch again');
  assert.equal(s.drill.played.length, played);
  assert.ok(tones(back).includes('back'), 'and it says what came off');
});

test('a bad continuation move says the way out, rather than leaving you in it', async () => {
  const s = await session().begin();
  await s.move({ from: 'e8', to: 'e4' });
  // What the engine would have preferred here — the move the fault sentence
  // would name if the drill let it, and the one thing it must not say while you
  // are still being asked to find a better one.
  const better = s.drill.chess.moves({ verbose: true })[0].san;

  const st = await s.move(pick(s, 1));
  assert.ok(tones(st).includes('miss'));
  assert.ok(text(st).includes('take it back'), 'the button is named at the moment it is wanted');
  assert.ok(!text(st).includes(better), `it named ${better} instead of letting you find it`);
});

test('unwinding the same ply three times draws a tip out of the coach', async () => {
  const s = await session().begin();
  await s.move({ from: 'e8', to: 'e4' });
  let st = null;
  for (let i = 0; i < TIPS_AFTER; i++) {
    await s.move(pick(s));
    st = await s.back();
  }
  assert.equal(s.drill.misses, TIPS_AFTER);
  assert.ok(tones(st).includes('hint'), 'the same ladder as the rep, at a later ply');
  // Nothing is ever revealed out here: there is no stored best move past the rep,
  // and this is live play by any other name.
  assert.equal(st.reveal, null);
});

test('an illegal move is refused without blanking the session', async () => {
  const s = await session().begin();
  const out = await s.move({ from: 'a8', to: 'a4' });
  assert.ok(out.error, 'expected a refusal');
  // And the real state is still there to draw — a mis-click must not wipe it.
  assert.equal(s.state.board.fen, FEN);
  assert.equal(s.state.stage, 'solve');
});

test('you cannot move while the punishment is on screen', async () => {
  const s = await session().begin();
  await s.move({ from: 'g6', to: 'f8' });
  const out = await s.move({ from: 'e8', to: 'e4' });
  assert.ok(out.error);
});

/* ------------------------------------------------------------------ dots ---- */

test('legal squares come from the one move generator that will judge the move', async () => {
  const s = await session().begin();
  assert.ok(s.legal('e8').moves.some((m) => m.to === 'e4'));
  assert.deepEqual(s.legal('f8').moves, [], 'not his pieces');
  assert.deepEqual(s.legal(null).moves, []);
});

test('nothing can be picked up while a failed attempt is showing', async () => {
  const s = await session().begin();
  await s.move({ from: 'g6', to: 'f8' });
  assert.deepEqual(s.legal('e8').moves, []);
});

/* ---------------------------------------------------------------- asking ---- */

test('w answers for free and is recorded against your clean count', async () => {
  const s = await session().begin();
  const st = await s.hint('w');
  assert.ok(tones(st).includes('hint'));
  assert.deepEqual(s.drill.asked, ['w']);
  // Asked for help, so finding it does not count as finding it unaided.
  await s.move({ from: 'e8', to: 'e4' });
  assert.equal(s.drill.clean, false);
});

test('pressing the same topic again goes deeper, then runs out', async () => {
  const s = await session().begin();
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const st = await s.hint('w');
    const last = st.coach.at(-1);
    if (last.tone === 'note') {
      assert.match(last.text, /will not name your move/);
      return;
    }
    seen.add(last.text);
  }
  assert.ok(seen.size > 0);
});

test('an unknown topic is refused', async () => {
  const s = await session().begin();
  assert.ok((await s.hint('x')).error);
});

/* --------------------------------------------------------------- the end ---- */

test('advancing banks the result and ends with a summary', async () => {
  const s = await session().begin();
  await s.move({ from: 'e8', to: 'e4' });
  const st = await s.next();
  assert.equal(st.stage, 'session-done');
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].pass, true);
  assert.ok(st.summary.join(' ').includes('1 positions'));
});

test('a position solved only after being shown it is still owed next time', async () => {
  const s = await session().begin();
  await missRepeatedly(s, REVEAL_AFTER);         // the last one gives the move up
  await s.retry();
  await s.move({ from: 'e8', to: 'e4' });
  await s.next();
  const h = s.historyAfter(new Date('2026-10-01T12:00:00Z'));
  assert.equal(h[FEN].lastResult, 'fail', 'being shown the move is not learning it');
  assert.equal(h[FEN].seen, 1);
});

test('skipping records the position as unsolved and moves on', async () => {
  const s = await session().begin();
  const st = await s.skip();
  assert.equal(st.stage, 'session-done');
  assert.equal(s.results[0].pass, false);
});

test('a found-first-time position is recorded as clean', async () => {
  const s = await session().begin();
  await s.move({ from: 'e8', to: 'e4' });
  await s.next();
  const h = s.historyAfter();
  assert.equal(h[FEN].lastResult, 'clean');
  assert.equal(h[FEN].clean, 1);
});
