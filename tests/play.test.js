import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scenariosFrom, pickSet, allotment, priority, judge, record, summariseSession,
  Drill, PROMPTS, DRILLABLE, PASS, MIN_DROP, MIN_MOVE, COOLDOWN_DAYS, REVEAL_AFTER,
  CONTINUE_MOVES, TIPS_AFTER, TIP_ORDER,
} from '../src/play.js';

/*
 * The positions here are real ones out of `logs/`, not invented, so that every
 * assertion about a drill is checkable against a board. The main one is the
 * costliest single move in the whole history this was built from:
 *
 *   r1b1qNk1/... b KQ - 0 18   black to move, you played Nxf8 (g6f8) and lost
 *                              94% of your winning chances; Qxe4+ (e8e4) was
 *                              there, and takes the queen with check.
 *
 * Both moves are legal in it, which is what makes it a complete drill fixture:
 * one passes and one fails.
 */
const FEN = 'r1b1qNk1/1p1p1pp1/p5np/2pP4/2B1Q3/5N2/PP3PPP/R3K2R b KQ - 0 18';
const PLAYED = 'g6f8';   // Nxf8 — the mistake
const BEST = 'e8e4';     // Qxe4+ — what was there

/** A fault move as `review.json` stores one, stating only what each test changes. */
const move = (o = {}) => ({
  ply: 36, san: 'Nxf8', label: 'Blunder', drop: 94, phase: 'middlegame',
  fen: FEN, uci: PLAYED, best: 'Qxe4+', bestUci: BEST,
  why: 'your queen on e8 was already attacked before Nxf8, and Qxe8 takes it',
  playedLine: [{ uci: PLAYED, san: 'Nxf8' }], betterLine: [{ uci: BEST, san: 'Qxe4+' }],
  ...o,
});

/** A reviewed game carrying one fault of one kind. */
const game = (kind, moves, o = {}) => ({
  id: '2026-10-01T02-37-03#1', title: '1 Oct, 02:37', color: 'b', graded: 30,
  faults: [{ kind, count: moves.length, cost: 94, moves }], ...o,
});

/** A grade as `gradeMove` returns one — only the fields `judge` reads. */
const grade = (name, drop, san = '?') => ({ label: { name }, drop, san });

/* ------------------------------------------------------------------ deck --- */

test('a drillable fault with a position becomes a scenario', () => {
  const [s] = scenariosFrom([game('missed-threat', [move()])]);
  assert.equal(s.kind, 'missed-threat');
  assert.equal(s.fen, FEN);
  assert.equal(s.played, PLAYED);
  assert.equal(s.best, BEST);
  // Identity is the position, so the same one reached twice is one drill.
  assert.equal(s.key, FEN);
});

test('the side to move is read off the position, not the game', () => {
  // The game says you were White; the FEN says Black is to move. The FEN wins,
  // because seating you on the wrong side is unrecoverable.
  const [s] = scenariosFrom([game('missed-threat', [move()], { color: 'w' })]);
  assert.equal(s.color, 'b');
});

test('positional drift is not drillable', () => {
  // review.js calls it the residue to look at with an engine, not to train
  // against: there is no move that is recognisably right.
  assert.ok(!DRILLABLE.includes('positional'));
  assert.equal(scenariosFrom([game('positional', [move()])]).length, 0);
  assert.equal(scenariosFrom([game('unknown', [move()])]).length, 0);
});

test('a fault that barely cost anything is not worth a rep', () => {
  assert.equal(scenariosFrom([game('hung', [move({ drop: MIN_DROP - 1 })])]).length, 0);
  assert.equal(scenariosFrom([game('hung', [move({ drop: MIN_DROP })])]).length, 1);
});

test('the opening few moves are not a started match', () => {
  const early = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  assert.equal(scenariosFrom([game('hung', [move({ fen: early })])]).length, 0);
  assert.ok(MIN_MOVE > 2);
});

test('a row missing the position or either move is dropped, not patched', () => {
  const kinds = [{ fen: null }, { uci: null }, { bestUci: null }];
  for (const missing of kinds) {
    assert.equal(scenariosFrom([game('hung', [move(missing)])]).length, 0);
  }
});

test('a move that mated is never a drill, whatever the stored grade says', () => {
  /*
   * The real row this guards: `Qxf1#` filed as a 100% blunder for "missing"
   * `Rxf1#`, in a position where both moves are mate. The grader bug behind it
   * is fixed, but reviews already written still carry the old drop, and a deck
   * that trusted them would hand you "you won — find the better way to win".
   */
  const mated = move({ san: 'Qxf1#', drop: 100, best: 'Rxf1#' });
  assert.equal(scenariosFrom([game('missed-win', [mated])]).length, 0);
  // A check is not a mate, and is perfectly drillable.
  assert.equal(scenariosFrom([game('missed-win', [move({ san: 'Qxf1+' })])]).length, 1);
});

test('the same position twice is one scenario', () => {
  const deck = scenariosFrom([
    game('missed-threat', [move(), move({ ply: 40 })]),
  ]);
  assert.equal(deck.length, 1);
});

test('a game with nothing graded contributes nothing', () => {
  assert.equal(scenariosFrom([game('hung', [move()], { graded: 0 })]).length, 0);
});

/* -------------------------------------------------------------- choosing --- */

/** A deck of `n` positions of one kind, each costing `drop`. */
const deckOf = (kind, n, drop = 20) => Array.from({ length: n }, (_, i) => ({
  key: `${kind}-${i}`, kind, drop, fen: FEN, color: 'b', played: PLAYED, best: BEST,
}));

test('a session is weighted by what each fault has cost', () => {
  // 10 positions at 50 against 10 at 10: the expensive fault should dominate.
  const deck = [...deckOf('missed-threat', 10, 50), ...deckOf('king-safety', 10, 10)];
  const share = allotment(deck, 8);
  assert.equal(share.get('missed-threat') + share.get('king-safety'), 8);
  assert.ok(share.get('missed-threat') > share.get('king-safety'),
    'the costlier habit should get more of the session');
});

test('every slot is allocated even when the split does not divide', () => {
  const deck = [
    ...deckOf('missed-threat', 5, 30), ...deckOf('fork', 5, 20), ...deckOf('hung', 5, 7),
  ];
  for (const size of [1, 3, 7, 8, 11]) {
    const total = [...allotment(deck, size).values()].reduce((a, b) => a + b, 0);
    assert.equal(total, size, `size ${size} should be fully allocated`);
  }
});

test('a position you failed comes back before a new one', () => {
  const failed = { key: 'a', kind: 'hung', drop: 10 };
  const unseen = { key: 'b', kind: 'hung', drop: 10 };
  const now = Date.now();
  const history = { a: { seen: 1, lastResult: 'fail', lastSeen: new Date(now).toISOString() } };
  assert.ok(priority(failed, history.a, now) > priority(unseen, undefined, now));
});

test('a position passed just now is held back, but can still fill a session', () => {
  const s = { key: 'a', kind: 'hung', drop: 10 };
  const now = Date.now();
  const justPassed = { seen: 1, lastResult: 'pass', lastSeen: new Date(now).toISOString() };
  const longAgo = {
    seen: 1, lastResult: 'pass',
    lastSeen: new Date(now - (COOLDOWN_DAYS + 30) * 86400e3).toISOString(),
  };
  assert.ok(priority(s, justPassed, now) < priority(s, longAgo, now));
  // Held back, not excluded: a deck that has all been passed must still deal.
  const deck = deckOf('hung', 3);
  const history = Object.fromEntries(deck.map((d) => [d.key, justPassed]));
  assert.equal(pickSet(deck, { history, size: 3, now }).length, 3);
});

test('a session is the size asked for, and --kind spends it all on one fault', () => {
  const deck = [...deckOf('missed-threat', 10, 50), ...deckOf('fork', 10, 20)];
  assert.equal(pickSet(deck, { size: 6 }).length, 6);
  const only = pickSet(deck, { size: 5, kind: 'fork' });
  assert.equal(only.length, 5);
  assert.ok(only.every((s) => s.kind === 'fork'));
});

test('a fault that runs out of positions does not shrink the session', () => {
  // fork has 1 position but its cost would earn it more than one slot.
  const deck = [...deckOf('missed-threat', 10, 10), ...deckOf('fork', 1, 500)];
  assert.equal(pickSet(deck, { size: 6 }).length, 6);
});

test('an empty deck asks for nothing rather than failing', () => {
  assert.deepEqual(pickSet([], { size: 8 }), []);
  assert.deepEqual(pickSet(deckOf('hung', 3), { size: 3, kind: 'fork' }), []);
});

/* --------------------------------------------------------------- judging --- */

test('a move passes exactly when the coach would not have criticised it', () => {
  for (const name of PASS) assert.equal(judge(grade(name, 0)).pass, true, name);
  for (const name of ['Inaccuracy', 'Mistake', 'Blunder']) {
    assert.equal(judge(grade(name, 20)).pass, false, name);
  }
});

test('judging reads a label written either way', () => {
  // review.json stores the label as a string; gradeMove returns an object.
  assert.equal(judge({ label: 'Best', drop: 0 }).pass, true);
  assert.equal(judge({ label: { name: 'Best' }, drop: 0 }).pass, true);
});

/* --------------------------------------------------------------- prompts --- */

test('every drillable fault has a prompt, and none of them names a move', () => {
  for (const kind of DRILLABLE) {
    const p = PROMPTS[kind];
    assert.ok(p, `${kind} needs a prompt`);
    for (const field of ['ask', 'watch', 'miss', 'hit']) {
      assert.equal(typeof p[field], 'string', `${kind}.${field}`);
      assert.ok(p[field].length > 0, `${kind}.${field} is empty`);
      /*
       * The one thing a prompt must never contain. SAN for a piece move is a
       * capital letter and a square; this would catch "play Nf6" or "Qxe4" in
       * any of them. Pawn moves and square names on their own are allowed —
       * "your pawn on f7" is naming a weakness, which is the whole point.
       */
      assert.doesNotMatch(p[field], /\b[KQRBN]x?[a-h][1-8]\b/,
        `${kind}.${field} must not name a move`);
    }
  }
});

/* ----------------------------------------------------------------- drill --- */

const drill = (o) => new Drill({
  key: FEN, kind: 'missed-threat', fen: FEN, color: 'b',
  played: PLAYED, best: BEST, drop: 94,
}, o);

test('a drill opens on the stored position with you to move', () => {
  const d = drill();
  assert.equal(d.fen, FEN);
  assert.equal(d.youToMove, true);
  assert.equal(d.stage, 'solve');
});

test('legality is decided here, because chess.js cannot go to the browser', () => {
  const d = drill();
  assert.equal(d.validate({ from: 'e8', to: 'e4' }).ok, true);
  assert.equal(d.validate({ from: 'e8', to: 'e4' }).san, 'Qxe4+');
  assert.equal(d.validate({ from: 'a8', to: 'a4' }).ok, false);   // blocked by its own pawn
  assert.ok(d.legalFrom('e8').some((m) => m.to === 'e4'));
});

test('the move that was there passes and the position plays on', () => {
  const d = drill();
  const out = d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  assert.equal(out.pass, true);
  assert.equal(d.stage, 'continue');
  assert.equal(d.solved, true);
  assert.equal(d.clean, true);
  // The move is on the board, and it is now his turn.
  assert.notEqual(d.fen, FEN);
  assert.equal(d.youToMove, false);
});

test('replaying your own mistake fails and does not advance the board', () => {
  // The single most important behaviour in the file: the move that cost 94%
  // must not be accepted just because you played it before.
  const d = drill();
  const out = d.attempt(PLAYED, grade('Blunder', 94, 'Nxf8'));
  assert.equal(out.pass, false);
  assert.equal(d.stage, 'punished');
  assert.equal(d.fen, FEN, 'a failed attempt stays on the rep position');
  assert.equal(d.solved, false);
});

test('the move is given away last, after every tip has been spent', () => {
  /*
   * The ladder, counted out: the tips are what you get for missing, and the move
   * is what is left when they run out. Nothing may hand it over earlier — that
   * is the whole of the project's one rule, bent as little as it can be.
   */
  assert.equal(REVEAL_AFTER, TIPS_AFTER + TIP_ORDER.length);

  const d = drill();
  for (let miss = 1; miss < REVEAL_AFTER; miss++) {
    assert.equal(d.attempt('g8h8', grade('Mistake', 20)).reveal, false,
      `miss ${miss} must not name the move`);
    d.reset();
  }
  assert.equal(d.attempt(PLAYED, grade('Blunder', 94)).reveal, true);
});

test('misses are counted against the position, and survive a reset', () => {
  const d = drill();
  assert.equal(d.misses, 0);
  d.attempt(PLAYED, grade('Blunder', 94));
  assert.equal(d.misses, 1);
  d.reset();
  assert.equal(d.misses, 1, 'going again does not wipe what the position has cost you');
  assert.equal(d.attempt('g8h8', grade('Mistake', 20)).misses, 2);
});

test('being shown the move is not solving it', () => {
  const d = drill();
  d.attempt(PLAYED, grade('Blunder', 94));
  d.reset({ reveal: true });
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  assert.equal(d.solved, true);
  assert.equal(d.clean, false, 'two attempts is not clean');
  assert.equal(d.revealed, true);
  // And the history must carry that, or spacing would treat it as learned.
  assert.equal(record({}, [d.result()])[FEN].lastResult, 'fail');
});

test('asking for a hint costs you the clean result', () => {
  const d = drill();
  d.asked.push('t');
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  assert.equal(d.solved, true);
  assert.equal(d.clean, false);
});

test('a reset puts the position and the continuation back', () => {
  const d = drill();
  d.attempt(PLAYED, grade('Blunder', 94));
  d.reset();
  assert.equal(d.fen, FEN);
  assert.equal(d.stage, 'solve');
  assert.deepEqual(d.played, []);
  assert.equal(d.left, CONTINUE_MOVES);
});

test('the continuation runs for your three moves and then stops', () => {
  /*
   * Walked along the line the engine actually returned for this position —
   * Qxe4+ Be2 Nxf8 d6 b5 — so the accounting is checked against a real
   * continuation rather than whatever the move generator happens to list first.
   * Be2 is forced-ish for a reason worth noting: Qxe4+ is check, which is why
   * "his reply" here cannot be an arbitrary developing move.
   */
  const d = drill();
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));      // yours, 1 of 3
  assert.equal(d.left, CONTINUE_MOVES - 1);

  assert.equal(d.play('c4e2').ok, true);           // Be2, his — blocks the check
  assert.equal(d.played.at(-1).by, 'opp');
  assert.equal(d.left, CONTINUE_MOVES - 1, 'his move does not spend your allowance');

  assert.equal(d.play('g6f8').ok, true);           // Nxf8, yours, 2 of 3
  assert.equal(d.left, CONTINUE_MOVES - 2);
  assert.equal(d.stage, 'continue');

  d.play('d5d6');                                  // his
  d.play('b7b5');                                  // yours, 3 of 3
  assert.equal(d.left, 0);
  assert.equal(d.stage, 'done', 'three of your moves is the whole continuation');
});

test('a move of yours comes back off the board, and his answer with it', () => {
  // Same real line as the continuation test above: Qxe4+ Be2 Nxf8 d6.
  const d = drill();
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  d.play('c4e2');
  const node = d.fen;                               // where you were asked to move
  d.play('g6f8');                                   // Nxf8, yours
  d.play('d5d6');                                   // and his answer to it

  const out = d.undo();
  assert.equal(out.ok, true);
  assert.equal(out.san, 'Nxf8', 'it names the move it took off');
  assert.equal(d.fen, node, 'the position is the one you were looking at, exactly');
  assert.equal(d.youToMove, true);
  assert.equal(d.left, CONTINUE_MOVES - 1, 'and the move is yours to spend again');
  assert.equal(d.played.at(-1).san, 'Be2', 'nothing before your move was touched');
});

test('the rep move itself is not a take-back', () => {
  // Un-solving the drill is not retrying the continuation — that is what the
  // punished stage and `reset` are for, and they record a failure.
  const d = drill();
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  assert.equal(d.canUndo, false);
  const out = d.undo();
  assert.equal(out.ok, false);
  assert.equal(d.solved, true);
  assert.notEqual(d.fen, FEN);
});

test('a take-back is help, and is recorded as such', () => {
  const d = drill();
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  d.play('c4e2');
  d.play('g6f8');
  assert.equal(d.clean, true, 'found first time, so far');

  d.undo();
  assert.equal(d.takebacks, 1);
  assert.equal(d.misses, 1, 'the node you came back to has now cost you one');
  assert.equal(d.clean, false, 'a line you unwound is not a line you found');
  assert.equal(d.result().takebacks, 1);
});

test('a take-back rescues a continuation that just ran out', () => {
  const d = drill();
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  d.play('c4e2'); d.play('g6f8'); d.play('d5d6'); d.play('b7b5');
  assert.equal(d.stage, 'done');

  assert.equal(d.canUndo, true, 'the last move of a drill is still a move you played');
  d.undo();
  assert.equal(d.stage, 'continue');
  assert.equal(d.left, 1);
  assert.equal(d.youToMove, true);
});

test('an illegal continuation move is refused, not applied', () => {
  const d = drill();
  d.attempt(BEST, grade('Best', 0, 'Qxe4+'));
  const before = d.fen;
  assert.equal(d.play('a1a8').ok, false);
  assert.equal(d.fen, before);
});

/* --------------------------------------------------------------- history --- */

test('a session folds into the record the next one reads', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const h = record({}, [
    { key: 'a', kind: 'hung', pass: true, clean: true, attempts: 1 },
    { key: 'b', kind: 'fork', pass: false, clean: false, attempts: 3 },
  ], now);
  assert.equal(h.a.seen, 1);
  assert.equal(h.a.passed, 1);
  assert.equal(h.a.clean, 1);
  assert.equal(h.a.lastResult, 'clean');
  assert.equal(h.a.lastSeen, now.toISOString());
  assert.equal(h.b.failed, 1);
  assert.equal(h.b.lastResult, 'fail');
});

test('seeing a position again adds to it rather than replacing it', () => {
  const first = record({}, [{ key: 'a', kind: 'hung', pass: true, clean: true }]);
  const second = record(first, [{ key: 'a', kind: 'hung', pass: false, clean: false }]);
  assert.equal(second.a.seen, 2);
  assert.equal(second.a.passed, 1);
  assert.equal(second.a.failed, 1);
});

test('the summary says what is still costing you', () => {
  const out = summariseSession([
    { key: 'a', kind: 'missed-threat', pass: true, clean: false },
    { key: 'b', kind: 'missed-threat', pass: true, clean: false },
    { key: 'c', kind: 'hung', pass: true, clean: true },
  ]);
  assert.match(out[0], /3 positions, 1 found first time, 3 found in the end/);
  assert.match(out[1], /missed-threat/);
  assert.deepEqual(summariseSession([]), ['  nothing played']);
});
