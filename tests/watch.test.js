/**
 * Acceptance tests for the move watcher.
 *
 * These are about the failure that actually happened on a real board: a pawn
 * going e2-e4 was read as e2-e3 in mid-slide, and every move after that was
 * graded against a position that did not exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveWatcher, frameDiff, Ladder, freshStart } from '../src/watch.js';

const FLOOR = 350;
const still = (n) => new Uint8Array(64 * 64).fill(n);

/**
 * A detection result: `score` is the winner's fit, `err` the position's,
 * `margin` how far the winner leads the runner-up.
 */
const det = (uci, { score = FLOOR, err = FLOOR + 400, margin = 50 } = {}) =>
  ({ uci, move: { san: uci }, score, still: err, margin });

test('accepts a landed move once the board settles', () => {
  const w = new MoveWatcher({ floor: FLOOR });
  const f = still(100);
  assert.equal(w.feed(f, det('e2e4')), null, 'first frame has nothing to compare to');
  const got = w.feed(f, det('e2e4'));
  assert.ok(got, 'second settled frame should accept');
  assert.equal(got.uci, 'e2e4');
});

test('refuses a piece caught in mid-slide', () => {
  // Halfway between squares, no hypothesis fits: e2e3 wins the comparison but
  // explains the pixels far worse than calibration did.
  const w = new MoveWatcher({ floor: FLOOR });
  const moving = det('e2e3', { score: FLOOR * 4, err: FLOOR * 5 });
  let frame = still(100);
  for (let i = 0; i < 6; i++) {
    frame = still(100 + i);              // pixels changing: the slide
    assert.equal(w.feed(frame, moving), null, `frame ${i} must not be accepted`);
  }
  // It lands: pixels stop moving and the real move fits.
  const landed = still(200);
  w.feed(landed, det('e2e4'));
  assert.ok(w.feed(landed, det('e2e4')), 'the landed move is accepted');
});

test('a still frame is not enough if the fit is bad', () => {
  const w = new MoveWatcher({ floor: FLOOR });
  const f = still(100);
  const bad = det('e2e4', { score: FLOOR * 3 });
  w.feed(f, bad);
  assert.equal(w.feed(f, bad), null, 'must explain the pixels, not merely win');
});

test('still beats a move by the margin, or nothing happens', () => {
  const w = new MoveWatcher({ floor: FLOOR, threshold: 6 });
  const f = still(100);
  const marginal = det('e2e4', { score: FLOOR, err: FLOOR + 3 });   // only 3 better
  w.feed(f, marginal);
  assert.equal(w.feed(f, marginal), null);
});

test('refuses a frame where the winner barely leads the runner-up', () => {
  /*
   * A board caught mid-repaint makes every candidate wrong at once, so the
   * field bunches and which one wins comes down to move generation order rather
   * than to pixels. That is how Ne4-f6 was once recorded as Ne4-d6, from a frame
   * during the blunder-badge animation: the settled frame preferred f6 by 41,
   * the transient one by almost nothing. Fitting well and beating "nothing
   * changed" were both satisfied, which is why neither existing guard caught it.
   */
  const w = new MoveWatcher({ floor: FLOOR, threshold: 6 });
  const f = still(100);
  const bunched = det('e4d6', { margin: 1 });
  w.feed(f, bunched);
  assert.equal(w.feed(f, bunched), null, 'a bunched field must not be accepted');

  // Same fit and same lead over standing still; only the field has separated.
  w.feed(f, det('e4f6'));
  assert.ok(w.feed(f, det('e4f6')), 'a clear winner is still accepted');
});

test('a stale floor cannot veto a move that leaves no square wrong', () => {
  /*
   * The failure this comes from, measured on a real session: board.json said
   * the board cost 43.4 to read, the board on screen actually cost 189 with
   * every square correct, and `fits` — a mean test — refused 100 of the 107
   * settled frames whose winner explained all 64 squares. 93%. Every move had
   * to come back through the two-ply ladder instead, and the game was lost.
   *
   * Where squares are counted, the count is the answer. A hypothesis that
   * leaves nothing wrong has already proved what the mean was asked to prove.
   */
  const w = new MoveWatcher({ floor: FLOOR, allow: 0, slack: 2 });
  const f = still(100);
  // Well over floor*slack + allow, and yet not one square is wrong.
  const clean = { ...det('e2e4', { score: FLOOR * 6, err: FLOOR * 9 }),
                  occluded: 0, stillMisfits: 2, bestMisfits: 0 };

  assert.equal(w.feed(f, clean), null, 'first frame has nothing to compare to');
  const got = w.feed(f, clean);
  assert.ok(got, 'a fully-explained board must be accepted however stale the floor');
  assert.equal(got.uci, 'e2e4');
  assert.ok(w.overFloor > 0, 'and it must be counted, so the staleness can be reported');
});

test('without a square count, the mean still guards acceptance', () => {
  // tools/probe.mjs and a board.json predating misfit counts come through here,
  // and for those the mean is the only test there is. Removing it for them
  // would accept a piece caught in mid-slide.
  const w = new MoveWatcher({ floor: FLOOR, allow: 0, slack: 2 });
  const f = still(100);
  const noCount = det('e2e4', { score: FLOOR * 6, err: FLOOR * 9 });

  w.feed(f, noCount);
  assert.equal(w.feed(f, noCount), null, 'nothing fits, and nothing counted the squares');
});

test('reports losing track when nothing on screen fits', () => {
  const w = new MoveWatcher({ floor: FLOOR });
  const f = still(100);
  const nonsense = det('e2e4', { score: FLOOR * 6, err: FLOOR * 6 });
  w.feed(f, nonsense);
  for (let i = 0; i < 25; i++) w.feed(f, nonsense);
  assert.ok(w.lost > 20, `expected a desync signal, got ${w.lost}`);
});

test('a covered board is held, not called lost', () => {
  /*
   * The failure this whole layer exists for. A promotion picker, a game-over
   * modal or a piece in mid-flight puts hundreds of units of error on a handful
   * of squares, and a mean over 64 carries that straight past the fit limit —
   * so the board would sit there settled, perfectly well tracked, being
   * reported as desynced. Not seeing the board and having lost it are different
   * states and only one of them is worth acting on.
   */
  const w = new MoveWatcher({ floor: FLOOR, occludeMax: 6 });
  const f = still(100);
  const covered = { ...det('e2e4', { score: FLOOR * 6, err: FLOOR * 6 }),
                    occluded: 12, stillMisfits: 9, bestMisfits: 9 };
  for (let i = 0; i < 30; i++) w.feed(f, covered);
  assert.equal(w.lost, 0, 'a covered board must never accumulate lost frames');
  assert.ok(w.blind > 20, `expected the blind counter to run instead, got ${w.blind}`);
});

test('one wrong square is enough to be lost, without waiting for the mean', () => {
  /*
   * The old test was the mean error against the calibration floor, and it could
   * not see a desync at all: measured on a real board, being a whole move behind
   * moved the mean from 15.1 to 17.6 against a limit of 140. Four plies of drift
   * before anything was noticed, by which point recovery was hopeless. Counting
   * squares that are outright wrong makes it immediate — which is the whole
   * point, because the cheap recovery only works while the board is close.
   */
  const w = new MoveWatcher({ floor: FLOOR });
  const f = still(100);
  // Fits comfortably on the mean; two squares are simply wrong.
  const desynced = { ...det('e2e4', { score: FLOOR, err: FLOOR }),
                     occluded: 0, stillMisfits: 2, bestMisfits: 2 };
  w.feed(f, desynced);
  for (let i = 0; i < 8; i++) w.feed(f, desynced);
  assert.ok(w.lost >= 8, `expected an immediate desync signal, got ${w.lost}`);

  // And it clears the instant some hypothesis explains every square again.
  w.feed(f, { ...desynced, bestMisfits: 0 });
  assert.equal(w.lost, 0);
});

test('reset lets a recovered position start clean', () => {
  const w = new MoveWatcher({ floor: FLOOR });
  const f = still(100);
  // margin 1: the field is bunched, so nothing is accepted and `lost` can climb.
  const desynced = { ...det('e2e4', { margin: 1 }), occluded: 0, stillMisfits: 2, bestMisfits: 2 };
  for (let i = 0; i < 10; i++) w.feed(f, desynced);
  assert.ok(w.lost > 0);
  w.reset();
  assert.equal(w.lost, 0);
  assert.equal(w.blind, 0);
});

test('a perpetually animating board still gets moves through', () => {
  // Something on the board never stops moving, so no frame is ever settled.
  const w = new MoveWatcher({ floor: FLOOR, patience: 12 });
  let got = null;
  for (let i = 0; i < 20 && !got; i++) got = w.feed(still(100 + i), det('e2e4'));
  assert.ok(got, 'patience should eventually accept a consistent candidate');
});

test('frameDiff is zero for identical frames and positive otherwise', () => {
  assert.equal(frameDiff(still(7), still(7)), 0);
  assert.equal(frameDiff(still(7), still(9)), 2);
  assert.equal(frameDiff(null, still(7)), Infinity);
});

/*
 * The ladder, and the way a slow rung used to jam it.
 */

test('a rung runs once per episode, even when a slow one stalls the counter', () => {
  /*
   * The real failure, reproduced from the session that found it. The three-ply
   * resync took 13.9s against a 150ms poll, so the frame that landed after it
   * could not be settled — and `lost` only advances on settled frames. It sat
   * on 32, the exact count the ladder tested for, and the same 14-second search
   * fired on every iteration: thirteen times, 192 seconds, while the real game
   * ran twenty moves further out of reach.
   */
  const ladder = new Ladder();
  assert.equal(ladder.due(32, 8), true, 'the cheap rung is due the moment it is passed');
  assert.equal(ladder.due(32, 32), true);

  // The counter is stuck at 32 because nothing since has been settled.
  for (let i = 0; i < 13; i++) {
    assert.equal(ladder.due(32, 32), false, 'a rung must not run twice on a stalled counter');
    assert.equal(ladder.due(32, 8), false);
  }

  // Deeper rungs still come due as the counter finally advances.
  assert.equal(ladder.due(56, 56), true);
  assert.equal(ladder.due(80, 80), true);
  assert.equal(ladder.due(80, 56), false);
});

test('turning the board round forgets the floor, and a clean frame supplies a new one', () => {
  /*
   * The other way the same number went wrong. `floor` is written once at
   * calibration and describes the board it was measured on; a rotation keeps
   * every template valid — square shade is (rank + file) parity, which a
   * rotation preserves — while making this one number describe nothing. On a
   * real session the new-game rung correctly turned the board at frame 2, after
   * which a perfect reading of the opening position cost 188.6 against a
   * recorded floor of 43.4, and the mean test had negative headroom from then
   * on: 48 of 58 moves came back through the ladder and the game was lost.
   */
  const w = new MoveWatcher({ floor: FLOOR, allow: 0, slack: 2 });
  assert.equal(w.fits(FLOOR * 6), false, 'the floor has an opinion to begin with');

  w.relearnFloor();
  assert.equal(w.floor, null);
  assert.equal(w.fits(FLOOR * 6), true,
    'with no floor the mean has no opinion, and the square count does the work');

  // A frame where the tracked position leaves nothing wrong is exactly what
  // calibration measured, on the board as it now is.
  const f = still(100);
  const clean = { ...det('e2e4', { score: 50, err: 175 }),
                  occluded: 0, stillMisfits: 0, bestMisfits: 0 };
  w.feed(f, clean);
  w.feed(f, clean);
  assert.equal(w.floor, 175, 'the new floor is what a correct reading of this board costs');
  assert.equal(w.floorPending, false);
  assert.equal(w.relearned, 175, 'and it is reported, so the session can say so once');

  // A frame that does not read cleanly cannot supply one.
  const w2 = new MoveWatcher({ floor: FLOOR, allow: 0, slack: 2 });
  w2.relearnFloor();
  const murky = { ...det('e2e4', { score: 50, err: 175 }),
                  occluded: 0, stillMisfits: 3, bestMisfits: 0 };
  w2.feed(f, murky);
  w2.feed(f, murky);
  assert.equal(w2.floor, null, 'a board three squares wrong is not a measurement of anything');
});

test('a rung re-arms when the board moves under it, but not otherwise', () => {
  /*
   * The other half of the failure above. Once per episode stopped the same
   * search being asked thirteen times about one board; it also stopped it being
   * asked once about a *different* board. On a real session the two-ply rung ran
   * while the truth was one ply ahead, refused, and then the board ran on to
   * exactly two plies ahead — inside that rung's reach — and it never ran again,
   * because it had already been ticked off.
   *
   * So the question is whether the arrangement of wrong squares has changed, not
   * whether the rung has run.
   */
  const ladder = new Ladder();
  assert.equal(ladder.due(32, 32, 3), true, 'first look at a board three squares wrong');
  assert.equal(ladder.due(32, 32, 3), false, 'the same board is the same question');

  assert.equal(ladder.due(32, 32, 4), true, 'the board moved; worth asking again');
  assert.equal(ladder.due(32, 32, 4), false);

  // Capped, so a board that churns cannot make a slow rung monopolise the poll.
  assert.equal(ladder.due(32, 32, 5), true);
  for (const shape of [6, 7, 8]) {
    assert.equal(ladder.due(32, 32, shape), false, 'three attempts is the limit');
  }

  // A rung that passes no shape keeps the strict once-only behaviour, which is
  // what the cheap rungs want: asking them twice costs more than it can return.
  const cheap = new Ladder();
  assert.equal(cheap.due(8, 8), true);
  assert.equal(cheap.due(8, 8), false);

  // And an episode ending re-arms everything, shape or no shape.
  ladder.reset();
  assert.equal(ladder.due(32, 32, 9), true);
});

test('a rung is not skipped when the counter jumps past it', () => {
  // `lost` advances one frame at a time today, but an exact-match test was what
  // broke above; a threshold test must not introduce the opposite failure.
  const ladder = new Ladder();
  assert.equal(ladder.due(100, 8), true, 'a rung passed over is still owed');
  assert.equal(ladder.due(100, 32), true);
});

test('recovering ends the episode and arms the ladder again', () => {
  const ladder = new Ladder();
  assert.equal(ladder.due(8, 8), true);
  assert.equal(ladder.due(8, 8), false);
  ladder.reset();
  assert.equal(ladder.due(8, 8), true, 'the next episode gets its own cheap rung');
});

/*
 * The new-game rung. Taken from the session that found it: 26 moves in, the
 * screen went back to the opening position, and the coach spent its last forty
 * seconds searching for a middlegame that was not there any more.
 */

/** The opening position scored both ways round, as main.js measures it. */
const probe = (same, turned = { score: 900, misfits: 31 }) =>
  ({ same: { score: 400, misfits: 0, ...same }, turned });

test('a screen that is exactly the opening position is a new game', () => {
  const got = freshStart(probe(), { still: 1200, confidence: 6 });
  assert.equal(got.ok, true);
  assert.equal(got.turned, false, 'it matched the way we are already reading the board');
  assert.equal(got.margin, 800);
});

test('the new game may be the other way round — you got the other colour', () => {
  const got = freshStart(probe({ score: 950, misfits: 28 }, { score: 380, misfits: 0 }),
    { still: 1200, confidence: 6 });
  assert.equal(got.ok, true);
  assert.equal(got.turned, true);
});

test('one square short of the opening position is not a new game', () => {
  /*
   * The whole board or nothing. A fresh game is not reachable by any legal move
   * from the position we hold, so adopting one throws a real game away — and a
   * resemblance is exactly what a middlegame with a few pieces back on their
   * home squares looks like.
   */
  const got = freshStart(probe({ misfits: 1 }), { still: 1200, confidence: 6 });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'misfits');
});

test('a covered board cannot prove a new game', () => {
  // The hidden squares are left out of the count above, and they are precisely
  // the ones that would have to disagree for this not to be a fresh game.
  const got = freshStart(probe(), { still: 1200, confidence: 6, occluded: 2 });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'occluded');
});

test('being lost on move 1 does not restart the game', () => {
  // We are already in the opening position, so it fits — but it is no better
  // than what we hold, and "recovering" here would throw away a game for
  // nothing. The margin is what tells the two apart.
  const got = freshStart(probe(), { still: 402, confidence: 6 });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'margin');
  assert.equal(got.margin, 2);
});
