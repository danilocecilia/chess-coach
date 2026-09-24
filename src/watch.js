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
  constructor({ floor = null, threshold = 6, quiet = 0.5, stable = 2, patience = 12,
                slack = 2, allow = 0, confidence = null, occludeMax = 6 }) {
    Object.assign(this, { floor, threshold, quiet, stable, patience, slack, allow, occludeMax });
    this.confidence = confidence ?? threshold;
    this.prev = null;
    this.pending = null;
    this.count = 0;
    /** Consecutive settled frames that match neither the position nor any move. */
    this.lost = 0;
    /** Consecutive settled frames with too much foreign paint to read at all. */
    this.blind = 0;
    /** Last frame's pixel difference and whether that counted as settled. Kept
     *  only so the session log can record the number the decision used, rather
     *  than measuring it a second time and reporting something subtly else. */
    this.diff = Infinity;
    this.settled = false;
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

    if (!det.uci || det.still - det.score <= this.threshold || !this.fits(det.score)
        || !explains || (det.margin ?? Infinity) < this.confidence) {
      this.pending = null;
      this.count = 0;
      return null;
    }

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
export class Ladder {
  constructor() {
    this.fired = new Set();
  }

  /**
   * Is this rung due — reached, and not yet run this episode?
   * Records the answer, so asking twice at the same depth answers once.
   */
  due(lost, at) {
    if (lost < at || this.fired.has(at)) return false;
    this.fired.add(at);
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
