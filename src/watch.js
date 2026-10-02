/**
 * Deciding when a detected move is real.
 *
 * Detection alone is not enough, because a sliding piece is a legal-looking
 * position at every instant of its journey. A pawn going e2-e4 passes over e3,
 * and "the same candidate twice" is satisfied inside a 300ms animation — so the
 * watcher used to accept e3, and from that moment the tracked position was
 * wrong and every later move was fitted against an imaginary board. One early
 * misread is unrecoverable, so the bar for accepting the first one is high:
 *
 *   quiet  the frame must be identical to the one before it. A settled board
 *          measures a pixel difference of exactly 0; anything moving does not.
 *   fits   the winning hypothesis must explain the pixels about as well as
 *          calibration did. A piece halfway between two squares fits nothing
 *          well, and neither does any move if we have already lost sync.
 *          Asked as a mean only where squares were not counted — where they
 *          were, the count answers the same question better, and a floor that
 *          has gone stale cannot then veto a board the count has proved. See
 *          the note in `feed`.
 *   beats  it must still beat "nothing changed" by the usual margin.
 *   alone  it must beat the *runner-up* hypothesis too. A board mid-repaint —
 *          chess.com fading in a blunder highlight, say — makes every candidate
 *          equally wrong at once, so the winner leads the field by almost
 *          nothing and which one wins is down to move generation order. That is
 *          how Ne4-f6 was once recorded as Ne4-d6, from a frame caught during
 *          the "??" badge animation, while the settled frame preferred f6 by a
 *          clear 41. detectMove has always returned this distance and called it
 *          the confidence signal; it simply was not consulted.
 *
 * And deciding when we have lost the board, which is a different question and
 * used to be answered with the same number. "The mean error is above the
 * calibration floor" cannot see a desync: measured on a real board, falling a
 * whole move behind moves that mean from 15.1 to 17.6 against a limit of 140,
 * so it took four plies of drift before anything was reported — long after the
 * point where recovery was still cheap. It also fired on things that were not
 * desyncs at all, because a modal or a piece in mid-flight puts hundreds of
 * units on a handful of squares and a mean over 64 carries that straight past
 * the limit.
 *
 * So the two questions are now asked separately:
 *
 *   blind  some squares show something that is not a chess square at all. We
 *          are not reading the board and we are not lost either — we wait.
 *   lost   the board reads clearly and *no* hypothesis explains it, counted in
 *          squares outright wrong rather than in mean error. Immediate, and it
 *          says nothing about whether the situation is recoverable: that is
 *          main.js's job, and it tries before it complains.
 */

/** Mean absolute difference per byte. Zero on a board that is not moving. */
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

/**
 * Pixel difference at or below which a frame counts as settled. A board that is
 * not moving measures exactly 0; anything mid-animation does not.
 */
export const QUIET = 0.5;

/**
 * How many foreign-looking squares we will read around before concluding we
 * cannot see the board at all.
 */
export const OCCLUDE_MAX = 6;

export class MoveWatcher {
  /**
   * @param {object} o
   * @param {number|null} o.floor     fit error measured at calibration
   * @param {number} o.threshold      COACH_MOVE_THRESHOLD
   * @param {number} o.quiet          pixel difference that still counts as settled
   * @param {number} o.stable         settled frames that must agree
   * @param {number} o.patience       frames after which agreement alone is enough
   * @param {number} o.slack          how far above `floor` a fit may be
   * @param {number} o.allow          absolute headroom for squares the board
   *                                  legitimately repaints (see {@link fits})
   * @param {number} o.confidence     how far the winning hypothesis must lead
   *                                  the runner-up. Defaults to `threshold`: a
   *                                  settled real move clears it several times
   *                                  over, a mid-repaint frame barely at all.
   *                                  `tools/probe.mjs` prints it live, which is
   *                                  where to read a better value off your own
   *                                  board rather than trusting this one.
   * @param {number} o.occludeMax     how many foreign-looking squares we will
   *                                  read around before declaring we cannot see
   *                                  the board at all
   */
  constructor({ floor = null, threshold = 6, quiet = QUIET, stable = 2, patience = 12,
                slack = 2, allow = 0, confidence = null, occludeMax = OCCLUDE_MAX }) {
    Object.assign(this, { floor, threshold, quiet, stable, patience, slack, allow, occludeMax });
    this.confidence = confidence ?? threshold;
    this.prev = null;
    this.pending = null;
    this.count = 0;
    /** Consecutive settled frames that match neither the position nor any move. */
    this.lost = 0;
    /** Consecutive settled frames with too much foreign paint to read at all. */
    this.blind = 0;
    /**
     * Why the last frame's best candidate was not accepted: `threshold`,
     * `squares`, `mean`, `confidence`, or null for "nothing was proposed" and
     * for a frame that was accepted. Recorded, never acted on — the session log
     * reads it so that a refused move leaves a reason behind.
     */
    this.refused = null;
    /** Set by {@link relearnFloor}; cleared by the frame that supplies a new one. */
    this.floorPending = false;
    /** The floor most recently re-measured, so main.js can report it once. */
    this.relearned = null;
    /** Last frame's pixel difference and whether that counted as settled. Kept
     *  only so the session log can record the number the decision used, rather
     *  than measuring it a second time and reporting something subtly else. */
    this.diff = Infinity;
    this.settled = false;
    /** Accepted moves whose fit was above what calibration said this board costs.
     *  A count of "board.json is stale", not a reason to refuse anything. */
    this.overFloor = 0;
  }

  /**
   * Does this hypothesis explain the pixels as well as calibration did?
   *
   * Two terms, because they guard different things. `slack` scales with the
   * floor and covers the model simply being an imperfect fit. `allow` is flat,
   * and covers squares the board repaints for reasons no calibration frame can
   * contain: the last move's two highlighted squares, a check indicator, a
   * coach badge dropped over a square. Calibration sizes it from the board's
   * own contrast rather than a fixed grey level, so it travels across themes.
   *
   * The flat term was not needed while the appearance model was wrong, because
   * a floor inflated to ~336 gave the multiplicative term hundreds of units of
   * accidental headroom. Fixing the model collapsed the floor to single digits
   * and took that headroom with it, which would have turned every highlighted
   * board into "lost track".
   */
  fits(error) {
    return this.floor == null || error <= this.floor * this.slack + this.allow;
  }

  /**
   * Forget the fit floor: the board is no longer the one it was measured on.
   *
   * Called when the board turns round, which is the one change that keeps every
   * template valid and makes this one number wrong — square shade is (rank +
   * file) parity, which a rotation preserves, so the pieces still match while
   * the per-square backgrounds no longer line up with the screen positions they
   * were learned at.
   *
   * A null floor is not a gap: {@link fits} has no opinion without one, and the
   * per-square count — which is measured against this board rather than against
   * the calibration frame — is the better question anyway and is unaffected. So
   * the interval between forgetting and re-measuring is judged by the test that
   * was already doing the work.
   */
  relearnFloor() {
    this.floor = null;
    this.floorPending = true;
    this.relearned = null;
  }

  /**
   * @param {Uint8Array} frame  the frame `det` was computed from
   * @param {object} det        result of BoardModel.detectMove
   * @returns {{move: object, uci: string}|null}
   */
  feed(frame, det) {
    const diff = frameDiff(frame, this.prev);
    const settled = diff <= this.quiet;
    this.diff = diff;
    this.settled = settled;
    this.prev = frame;

    // Too much of the board is covered by something that is not a board —
    // a promotion picker, a game-over modal, a piece in mid-flight. Hold: this
    // is not a move, and it is emphatically not evidence that we are lost.
    if ((det.occluded ?? 0) > this.occludeMax) {
      if (settled) this.blind++;
      this.pending = null;
      this.count = 0;
      return null;
    }
    if (settled) this.blind = 0;

    // Losing sync looks like this: the board is sitting still, we can see it
    // clearly, and neither the position we think we are in nor any move out of
    // it explains it — counted in squares that are outright wrong, excluding
    // the ones the board is expected to be decorating.
    if (settled) {
      // Callers that do not ask detectMove for a square limit — tools/probe.mjs,
      // a board.json predating one — get the old mean test rather than a
      // counter that would read "lost" on every frame for want of a number.
      const counted = det.stillMisfits != null && det.bestMisfits != null;
      const explained = counted
        ? det.stillMisfits === 0 || det.bestMisfits === 0
        : this.fits(det.still) || this.fits(det.score);
      if (explained) this.lost = 0;
      else this.lost++;

      /*
       * A floor measured in the other orientation describes nothing.
       *
       * `floor` is what a correct reading of this board costs, and it is written
       * once at calibration. Turn the board round — a new game that hands you
       * the other colour, or the site's flip button — and the number survives
       * while the thing it measured does not. Measured on a real session: the
       * new-game rung correctly turned the board at frame 2, after which a
       * *perfect* reading of the opening position cost 188.6 against a recorded
       * floor of 43.4. The budget was 203.8 and correct readings ran to 302, so
       * the mean test had negative headroom from the second frame on; 48 of 58
       * moves had to come back through the recovery ladder and the game was
       * eventually lost outright.
       *
       * So an orientation change invalidates it (see {@link relearnFloor}) and
       * the next frame that reads cleanly supplies a new one. That frame is the
       * best possible measurement of the quantity: the tracked position with no
       * square wrong is exactly what calibration measured, on the board as it
       * now is.
       */
      if (this.floorPending && counted && det.stillMisfits === 0) {
        this.floor = det.still;
        this.floorPending = false;
        this.relearned = det.still;
      }
    }

    /*
     * `explains` is the same square count, asked of acceptance rather than of
     * loss, and it is the guard that keeps one missed move from becoming a
     * wrecked game. When the board has already run ahead of us, some innocent
     * legal move still wins the mean comparison by a mile — with d4 missed and
     * cxd4 on screen, "d3" beat standing still and was accepted, leaving the
     * tracked position two plies wrong instead of one and putting the real
     * position out of reach of a two-ply search.
     *
     * The bar is the whole board, not an improvement on standing still. Merely
     * doing better is not enough, because a move that explains *part* of a
     * board that has run ahead is still the wrong move: with d4 missed and
     * Nxd4 on screen, Nf3-d4 accounted for the knight and left the two pawns
     * wrong, and was accepted for being a clear improvement on doing nothing.
     *
     * And accepting a wrong move is far worse than missing a right one. A
     * missed move leaves the truth a couple of plies ahead, where resync finds
     * it. A wrong move moves us onto a line the game never played, and nothing
     * reachable from there is the real position — no search forward can ever
     * get back. That asymmetry is why this is strict and why the recovery
     * ladder is allowed to be patient.
     */
    const counted = det.stillMisfits != null && det.bestMisfits != null;
    const explains = !counted || det.bestMisfits === 0;

    /*
     * The mean test is asked only when squares were not counted, which is the
     * same structure the loss test above already uses and for the same reason:
     * where a per-square count exists it is strictly the better question, and
     * laying a mean on top of it can only refuse things the count has already
     * proved.
     *
     * That is not hypothetical. Measured on a real session, `fits` was the
     * sole reason 100 of the 107 settled frames whose winner explained all 64
     * squares were thrown away — 93% — because the floor in board.json no
     * longer described the board on screen. Calibration had recorded 43.4; the
     * opening position itself, read correctly with zero misfits, cost 189. The
     * budget lands at 203.8 while a *correct* reading of that board ranged
     * 188-317, so the mean was not separating right from wrong, it was cutting
     * the right answers roughly in half. Every move in that game had to come
     * back through the two-ply ladder instead, at a second or two each, and the
     * game was eventually lost outright.
     *
     * The count does not drift that way. It is measured against squareLimit,
     * which is a property of this board rather than of the calibration frame,
     * and a hypothesis that leaves no square wrong has already answered the
     * question `fits` was asked to answer — a piece caught mid-slide fits
     * nothing well *per square*, and shows up as misfits, not as a mean.
     */
    const fitsWell = counted ? explains : this.fits(det.score);

    if (!det.uci || det.still - det.score <= this.threshold || !fitsWell
        || !explains || (det.margin ?? Infinity) < this.confidence) {
      /*
       * Why, and not only that it happened.
       *
       * Every rung of the ladder logs its refusals and the reason for them. This
       * gate logged nothing, and it is the gate a move has to pass — so a move
       * refused here left no trace at all beyond `accepted: null` on a frame
       * whose winner explained every square, which no tool surfaced and no
       * summary named. One session lost 330 seconds to exactly that, invisibly,
       * and finding it afterwards meant reading the raw frame records by hand.
       *
       * Ordered as the conditions are evaluated, except that a square count
       * outranks the mean: where squares were counted `fitsWell` *is* `explains`,
       * so naming the mean there would misattribute the refusal to a budget that
       * was never consulted.
       */
      this.refused = !det.uci ? null
        : det.still - det.score <= this.threshold ? 'threshold'
        : !explains ? 'squares'
        : !fitsWell ? 'mean'
        : 'confidence';
      this.pending = null;
      this.count = 0;
      return null;
    }
    this.refused = null;

    // A reading that explains every square while costing far more than
    // calibration said it should is not a reason to refuse the move — but it
    // does mean board.json describes a board that is no longer on screen, and
    // that is worth saying once rather than leaving to be inferred from a game
    // that grades strangely. main.js reads this; nothing here acts on it.
    if (counted && this.floor != null && !this.fits(det.score)) this.overFloor++;

    this.count = det.uci === this.pending ? this.count + 1 : 1;
    this.pending = det.uci;

    // Normally we wait for the board to settle. `patience` is the escape hatch
    // for a board with something perpetually animating on it, where waiting for
    // a still frame would mean never accepting anything.
    const enough = settled ? this.stable : this.patience;
    if (this.count < enough) return null;

    this.pending = null;
    this.count = 0;
    this.lost = 0;
    this.blind = 0;
    return { move: det.move, uci: det.uci };
  }

  /** Called when main.js resyncs, so the recovered position starts clean. */
  reset() {
    this.pending = null;
    this.count = 0;
    this.lost = 0;
    this.blind = 0;
  }
}

/**
 * Which rungs of the recovery ladder have already run in this episode.
 *
 * The ladder used to fire on an exact count — `lost === 32` — on the reasoning
 * that `lost` advances by one per settled frame, so an exact test runs a rung
 * exactly once. That holds only while every rung is cheap relative to the poll.
 *
 * The three-ply resync is not: measured at 13.9s on a real middlegame, ninety
 * times the poll interval. The board moves while it runs, so the frame that
 * lands afterwards is not settled, so `lost` does not advance — and sits on the
 * very count that launched the search. On a real session it fired thirteen
 * times in a row and burned 192 seconds, while the game ran about twenty moves
 * ahead and out of reach of any recovery. The search was not wrong; it was
 * asked the same question thirteen times, against a more hopeless board each
 * time.
 *
 * So the ladder tracks what it has run rather than inferring it from a counter
 * that a slow rung can stall.
 */
export const LADDER_RETRIES = 3;

export class Ladder {
  constructor() {
    this.fired = new Map();          // rung -> { shape, tries }
  }

  /**
   * Is this rung due — reached, and not yet run against *this* board?
   * Records the answer, so asking twice about the same board answers once.
   *
   * Once per episode was too few, for the same reason thirteen times in a row
   * was too many: what makes a repeat worth paying for is the board having
   * changed under it. Measured on a real session, the two-ply rung ran while the
   * truth was one ply ahead and refused; the board then ran on to exactly two
   * plies ahead — squarely inside that rung's reach — and it never ran again,
   * because it had already been ticked off. The three-ply search went instead,
   * spent 15 seconds, and came back to a board four plies gone.
   *
   * So a rung re-arms when `shape` changes and not otherwise. A refused search
   * repeated against an unchanged board is the same question twice and is
   * refused again; repeated against a board that has moved on it is a different
   * question with a real chance of a different answer. Capped all the same, so a
   * board that churns cannot make a slow rung monopolise the poll.
   *
   * @param {number} lost     settled frames spent lost
   * @param {number} at       the count this rung is due at
   * @param {*} [shape]       a value standing for the current arrangement of
   *                          wrong squares; `null` keeps the old once-only
   *                          behaviour, which is what the cheap rungs want
   */
  due(lost, at, shape = null) {
    if (lost < at) return false;
    const prev = this.fired.get(at);
    if (!prev) {
      this.fired.set(at, { shape, tries: 1 });
      return true;
    }
    if (shape === null || shape === prev.shape || prev.tries >= LADDER_RETRIES) return false;
    this.fired.set(at, { shape, tries: prev.tries + 1 });
    return true;
  }

  /** An episode ends the moment the board is explained again. */
  reset() {
    this.fired.clear();
  }
}

/**
 * Is the screen showing a *new game* rather than a position ahead of us?
 *
 * The one thing no search can find. Every other rung looks for the truth near
 * the tracked position — two plies on, one move back, the same position the
 * other way round — and a second game is none of those: it is move 1 of a
 * different game while we are deep in the last one. A real session sat lost for
 * the final forty seconds on exactly this, with the screen matching the opening
 * position on all 64 squares while the ladder searched for a middlegame.
 *
 * The decision is kept here, away from the resetting it causes, because the bar
 * is the whole of it. Three conditions, all necessary:
 *
 *   misfits   every square agrees with the opening position — the same total
 *             proof the other rungs demand, not a resemblance
 *   occluded  nothing foreign on the board. A mask hides squares from the count
 *             above, and hidden squares are exactly the ones that would have to
 *             disagree for this not to be a fresh game
 *   margin    and it beats the position we hold by the usual confidence. At
 *             move 0 the two are the same board and the margin is ~0, which is
 *             what stops a desync on the first move being "recovered" by
 *             throwing the game away and starting it again.
 *
 * @param {{same: {score: number, misfits: number},
 *          turned: {score: number, misfits: number}}} probe
 *        the opening position scored both ways round, as `main.js` measures it:
 *        `same` in the orientation we are reading in, `turned` rotated
 * @param {object} o
 * @param {number} o.still       how well the tracked position explains the frame
 * @param {number} o.confidence  margin the winner must lead it by
 * @param {number} [o.occluded]  squares the frame is hiding from us
 * @returns {{ok: boolean, reason?: string, turned?: boolean,
 *            score?: number, margin?: number}}
 */
export function freshStart(probe, { still, confidence, occluded = 0 }) {
  // Either way round: a site hands you the other colour as readily as the same
  // one, and a rematch with the board flipped is still a rematch.
  const pick = probe?.same?.misfits === 0 ? { turned: false, ...probe.same }
    : probe?.turned?.misfits === 0 ? { turned: true, ...probe.turned }
    : null;
  if (!pick) return { ok: false, reason: 'misfits' };
  if (occluded > 0) return { ok: false, reason: 'occluded', occluded };

  const margin = still - pick.score;
  if (margin < confidence) {
    return { ok: false, reason: 'margin', turned: pick.turned, margin };
  }
  return { ok: true, turned: pick.turned, score: pick.score, margin };
}
