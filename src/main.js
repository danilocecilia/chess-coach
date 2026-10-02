/**
 * The loop: watch the board, grade what you play, say why.
 *
 *   node src/main.js            grade only your moves
 *   node src/main.js --all      grade both sides
 *   node src/main.js --fen "…"  start from a position other than the opening,
 *                               given as a FEN (Forsyth-Edwards Notation — a
 *                               whole position on one line; README explains it)
 */

import { readFileSync, existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { Chess } from 'chess.js';
import { Capture } from './capture.js';
import { BoardModel, combine, decorated, gridOf, fenToGrid, indexOfSquare,
         orientationOf, ORIENTATION_MARGIN, inkTone, INK_MARGIN_RATIO } from './board.js';
import { measureGrid } from './grid.js';
import { MoveWatcher, Ladder, freshStart, frameDiff, QUIET, OCCLUDE_MAX } from './watch.js';
import { openLog, fileHash } from './log.js';
import { Engine } from './engine.js';
import { gradeMove } from './grade.js';
import { explain, shouldExplain } from './coach.js';
import { reviewGame, summarise } from './review.js';
import { saveReview, rebuild, titleOf } from './report.js';
import { Dashboard } from './dashboard.js';
import { TOPICS, KEYS } from './hint.js';
import { findThreat } from './threat.js';
import { Overlay } from './overlay.js';
import { formatScore } from './verdict.js';
import { STOCKFISH, DEPTH, BOARD_CONFIG, TEMPLATE_DIR } from './config.js';

const POLL_MS = 150;

/*
 * The recovery ladder, in settled frames at {@link POLL_MS} apart.
 *
 * Each rung fires on an exact count, which is what makes it run once per
 * episode: `lost` only moves on a settled frame, and a rung that succeeds
 * resets it to zero. The gaps are generous because the cheap rung is the one
 * that almost always works — a two-ply search finds a board that ran ahead
 * while we were looking at a dialog — and everything after it is for trouble
 * that is genuinely unusual.
 */
const RESYNC_AFTER = 8;     // ~1.2s: you moved and we missed it
const LOST_AFTER = 160;     // ~24s: every rung has failed; now it is worth saying
const BLIND_AFTER = 40;     // ~6s of a covered board before mentioning it
/**
 * ~30s of it before treating the region rather than the board as the problem.
 * Well past any modal, promotion picker or animation, and short of the 122
 * seconds a real session spent watching a blank rectangle in silence.
 */
const BLIND_LOST = 200;

/**
 * How often, in lost frames, to ask the log whether the screen is simply
 * showing a *new game*.
 *
 * Cheap — two scores off a cost table we already computed — but pointless on a
 * healthy board, so it runs only while we are lost. See {@link probeStart}.
 */
const PROBE_EVERY = 8;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** The men alone: what "the screen is showing a new game" is asked about. */
const START_MEN = START_FEN.split(' ')[0];
/** A move must beat "nothing changed" by this much mean-squared-error to count. */
const MOVE_THRESHOLD = Number(process.env.COACH_MOVE_THRESHOLD ?? 6);

/**
 * Accepted moves fitting worse than calibration promised before we say so.
 *
 * Enough that it is the calibration and not one decorated frame — a stale
 * board.json misses by that much on every move, so a handful is already
 * conclusive, and waiting longer only delays the one line that names the fix.
 */
const STALE_FLOOR_MOVES = 5;

/**
 * How far above `squareLimit` a square's tint-fitted residual may go and still
 * be excused as decorated rather than counted as wrong. See `BoardModel.excused`
 * for what the quantity is and why it is the right one.
 *
 * Two is a wide margin in both directions, which is the point: over every
 * settled frame of a real game the worst correctly-read square — the one the
 * last move landed on, highlight included — measured 0.59x the limit, while the
 * bishop a player was holding over g4 measured 3.66x. Anything between those
 * would do; a multiple near the middle survives a theme whose highlights are
 * heavier than this one's without letting a held piece through.
 *
 * It costs latency, never correctness, when it bites a real move: a genuine Qe7
 * in that session was accepted mid-flight at 2.24x and would now be accepted
 * four frames later at 0.40x, once the queen had actually landed. That is the
 * trade this whole file is built on — a missed move is recoverable and a wrong
 * one is not.
 */
const SOFT_SLACK = Number(process.env.COACH_SOFT_SLACK ?? 2);

/**
 * The threat search is a second search of a turn, so it runs shallower than the
 * grader. Finding *what* he is threatening does not need the depth that pricing
 * your move to a tenth of a pawn does.
 */
const THREAT_DEPTH = Number(process.env.COACH_THREAT_DEPTH ?? 12);

function parseArgs(argv) {
  return {
    all: argv.includes('--all'),
    fen: argv.includes('--fen') ? argv[argv.indexOf('--fen') + 1] : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(BOARD_CONFIG)) {
    console.error('Not calibrated yet. Run:  npm run calibrate');
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(BOARD_CONFIG, 'utf8'));
  const model = BoardModel.fromJSON(
    JSON.parse(readFileSync(path.join(TEMPLATE_DIR, 'model.json'), 'utf8')),
  );

  // The player is whoever sits at the bottom of the board. Read off the model
  // rather than the config so there is one orientation in play and not two —
  // and not `const`, because the board can turn out to be the other way round
  // (see `tryFlip`), which changes which side of it you are sitting on.
  let playerColor = model.flipped ? 'b' : 'w';
  const chess = args.fen ? new Chess(args.fen) : new Chess();

  // Written by calibration, which measures it off this board. The fallback is
  // for a board.json from before that existed: the contrast term alone is a
  // reasonable limit, just not one tuned to this theme.
  const squareLimit = cfg.squareLimit ?? (model.contrast * 0.15) ** 2;
  /** Derived, not calibrated: a multiple of the limit above. See {@link SOFT_SLACK}. */
  const softLimit = squareLimit * SOFT_SLACK;

  // Opened before anything that can fail, and declared before `shutdown`, so a
  // Ctrl+C during startup closes it rather than landing on a dead zone.
  const log = openLog();

  const cap = await new Capture(cfg.region).start();

  /** Which way round the board reads, from where the two colours are sitting. */
  const facingOf = (det) => orientationOf(
    Array.from({ length: 64 }, (_, i) => (det.mask[i] ? 0 : det.tint(i))),
  );

  /*
   * Which colour you are, read off the board instead of taken on trust.
   *
   * Orientation used to be settled once, at calibration, and then treated as
   * permanent. It is not: the templates belong to the board *skin*, which
   * changes when you change theme, but which end you sit at changes every time
   * you are handed the other colour — which is most games. Calibrating as White
   * and then playing as Black left every move of that game attributed to the
   * opponent, the coach advising the wrong side, and the one line that should
   * have caught it ("you are White") stated as a fact with nothing behind it.
   *
   * `orientationOf` answers this from a reading rather than from a fit, so it
   * works from any position and not only the opening. It is the same test
   * `readBoard` already uses to refuse an upside-down reading; here it is
   * allowed to *decide* rather than only to veto.
   *
   * What it cannot catch is templates whose colour labels were learned the
   * wrong way round, because it reports where the men the templates call White
   * are standing. That is calibration's problem and is settled there, by
   * `chooseOrientation`, which measures the men themselves.
   */
  const settledFrame = async (tries = 8) => {
    let prev = null;
    for (let i = 0; i < tries; i++) {
      const frame = await cap.grab();
      if (prev && frameDiff(frame, prev) <= QUIET) return frame;
      prev = frame;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  };

  const frame0 = await settledFrame();
  let facing0 = null, stale0 = null;
  if (frame0) {
    const det0 = model.detectMove(frame0, chess, { squareLimit, softLimit });
    stale0 = model.themeDrift(frame0);
    if (det0.occluded <= OCCLUDE_MAX) {
      const f = facingOf(det0);
      facing0 = { flipped: f.flipped, margin: f.margin, changed: false };
      if (f.flipped != null && f.margin >= ORIENTATION_MARGIN && f.flipped !== model.flipped) {
        model.flipped = f.flipped;
        playerColor = model.flipped ? 'b' : 'w';
        facing0.changed = true;
      }
    }
  }

  const engine = await new Engine(STOCKFISH, { threads: 4 }).start();
  const overlay = new Overlay({ x: cfg.region.x, y: cfg.region.y + cfg.region.h + 12 }).start();

  /*
   * The dashboard, served for as long as the coach is running.
   *
   * On by default, because the point of it is not having to run anything: a
   * review you have to go and ask for is one you ask for after you have stopped
   * caring about the game. `COACH_DASHBOARD=0` turns it off, and a port already
   * in use — the ordinary case of a second coach, or one left running — makes it
   * quietly do nothing rather than failing to start a game.
   *
   * Served but not opened, which is the one thing this must not do. Everything
   * here works by watching a region of the screen, so launching a browser window
   * at startup lands it over the board, takes the focus off the site you were
   * about to play on, and leaves the watch loop correctly reporting that it
   * cannot see a board. The URL is printed below and the page is live from the
   * first move; `COACH_OPEN=1` opts back in for a second monitor, and
   * `npm run dashboard` still opens a tab because there is no board to cover.
   */
  const dash = new Dashboard({ open: process.env.COACH_OPEN === '1' });
  if (process.env.COACH_DASHBOARD !== '0') await dash.start();

  console.log(`watching ${cfg.region.w}x${cfg.region.h} at (${cfg.region.x}, ${cfg.region.y})`);
  console.log(`you are ${playerColor === 'w' ? 'White' : 'Black'}; grading ${args.all ? 'both sides' : 'your moves'}`);
  // Said out loud, because it contradicts what calibration recorded and a
  // silent correction is indistinguishable from the bug it is correcting.
  if (facing0?.changed) {
    console.log(`        (read off the board — calibration had you as the other colour)`);
  } else if (!facing0) {
    console.log(`        (could not read the board to confirm this — from calibration)`);
  }

  /*
   * A theme change is the one failure that looks exactly like a desync from the
   * inside and is obvious from outside, so it is worth one frame at startup to
   * say it plainly rather than 24 seconds of the ladder failing correctly.
   */
  /*
   * Templates that name the wrong side White.
   *
   * This is the failure nothing downstream can see: the colour names live in
   * the templates, so a model learned the wrong way round reads its board
   * perfectly — zero squares wrong — and every check agrees with it, including
   * the facing check above, which can only report where the men *it has been
   * told* are White are standing. The only evidence is in the templates
   * themselves, and it is one subtraction.
   *
   * Not corrected here, only refused. `flipped` rotates the board mapping; it
   * does not relabel the templates, so flipping a mis-learned model would fix
   * the opening position and corrupt every position after it. The templates
   * have to be learned again.
   */
  /**
   * Stop before the first frame is judged, without leaving a capture daemon, a
   * Stockfish process and an always-on-top window behind.
   *
   * The two refusals below need the templates and one frame to reach their
   * verdict, so by the time they can be made everything is already up and the
   * ordinary `shutdown` path — which is bound to SIGINT and closes over state
   * declared further down — is not reachable yet. Hence an explicit teardown in
   * the same order.
   */
  const refuse = async () => {
    overlay.quit();
    await engine.quit();
    await cap.quit();
    dash.stop();
    await log.close();
    process.exitCode = 1;
  };

  /*
   * Refused, not warned.
   *
   * Calibration checks this before writing, so nothing it produces can fail
   * here — but a board.json written before that check existed still starts a
   * session, and two of them did. The templates label the dark men "White", so
   * the colour names are inverted in the only place the truth is recorded;
   * every later check is then made of the same mistake and agrees with it, and
   * the whole game is graded for the opponent. Playing on is worse than not
   * playing: the coach is confidently wrong for an hour and the log cannot say
   * so, because the log is written in the same inverted terms.
   *
   * Flipping is not the repair. `flipped` rotates the board mapping; it does not
   * relabel the templates, so it would fix the opening position and corrupt
   * every position after it. The templates have to be learned again.
   */
  const tone = inkTone(model);
  if (tone.consistent === false && tone.separation >= model.contrast * INK_MARGIN_RATIO) {
    console.error('\nThese templates have the two sides the wrong way round — what they call');
    console.error(`White is drawn darker (${tone.white.toFixed(0)}) than what they call Black`
      + ` (${tone.black.toFixed(0)}), by ${tone.separation.toFixed(0)} levels.`);
    console.error('Every move would be graded for the wrong player, and the log would record');
    console.error('the same mistake, so nothing afterwards could tell you it had happened.');
    console.error('\nRe-run `npm run calibrate` — it checks this before writing. Flipping the');
    console.error('board will not fix it: the templates themselves have to be learned again.');
    await refuse();
    return;
  }

  /*
   * Also refused, for the same reason: it is not recoverable by anything the
   * session can do. A theme or piece-set change leaves every template describing
   * a board that is no longer on screen, and the drift is measured in the one
   * part of a board no position can alter — the levels of its empty middle
   * ranks. Six sessions ran on a drift of 14.4 against a bar of 10.0, and the
   * message that told them so scrolled past before the first move; not one of
   * them graded anything, and one sat lost for nineteen minutes.
   *
   * It also disables the rung that would otherwise have saved them, which is
   * why warning is not enough. A new game is recognised by the start position
   * probing at *zero* squares wrong; under a changed theme the same physical
   * board probes at twelve, so the coach can neither track the game nor notice
   * the next one beginning.
   */
  if (stale0?.stale) {
    console.error(`\nThis is not the board that was calibrated. Its empty squares are`);
    console.error(`${stale0.light >= 0 ? '+' : ''}${stale0.light.toFixed(0)} light and`
      + ` ${stale0.dark >= 0 ? '+' : ''}${stale0.dark.toFixed(0)} dark against the templates`
      + ` (drift ${stale0.drift.toFixed(1)}).`);
    console.error('Nothing would grade: every piece would be measured against the appearance of');
    console.error('a different theme, and a new game could not be recognised either.');
    console.error('\nYou changed board theme or piece set. Re-run `npm run calibrate`.');
    await refuse();
    return;
  }
  console.log('log:    move (SAN), grade, evaluation in pawns, win% lost — see README > Notation');
  console.log('Coach:  t  what is he threatening');
  console.log('        w  what is weak in your position');
  console.log('        c  does this move matter');
  console.log('        press on the overlay window, or type here + Enter.');
  console.log('        press again for more on the same question. None name your move.');
  if (log.enabled) console.log(`log:    this session is being recorded to ${log.dir}`);
  if (dash.url) console.log(`review: ${dash.url} — open it once; it updates as you play`);
  else if (process.env.COACH_DASHBOARD !== '0') {
    console.log('review: the dashboard could not take a port; reviews still go to reports/');
  }
  console.log('Ctrl+C to stop.\n');

  let stopping = false;
  // Declared up here so Ctrl+C during startup — before the reader exists — does
  // not land on a temporal dead zone instead of shutting down.
  let keys = null;
  /** Which game of this session we are on; see `tryNewGame`. */
  let games = 1;

  /*
   * The graded moves of the game in progress, kept for the review.
   *
   * Kept here rather than read back out of the log afterwards because we
   * already have them: `gradeMove` returns everything the review needs, and a
   * session that was started with `COACH_LOG=0` has no log to read back. Reset
   * when a new game starts, so one game's blunders never land in the next
   * game's report.
   */
  let graded = [];
  /** Games of this session already finished and reviewed. */
  const reviews = [];

  /**
   * Everything reviewable about this session right now, finished games first
   * and the one in progress last.
   *
   * The game being played is included deliberately. A review you can only read
   * once the game is over is a review you read when you have stopped caring;
   * the moment it is worth seeing is two moves after you dropped a piece, and
   * that means the page has to know about a game that has not ended. It is the
   * same entry throughout — `n` does not change — so when the game does end it
   * is replaced rather than added beside itself.
   */
  const snapshot = () => {
    const session = log.dir ? path.basename(log.dir) : 'session';
    const all = [...reviews];
    if (graded.length) {
      all.push({
        ...reviewGame(graded, { color: playerColor }),
        n: games, plies: chess.history().length, source: 'live', playing: true,
      });
    }
    return all.map((g) => ({
      ...g,
      id: `${session}#${g.n}`,
      session,
      title: titleOf(session, g.n, all.length),
    }));
  };

  /**
   * Write the session's reviews out, and refresh anything watching.
   *
   * Wrapped whole, because nothing here is worth a session for. A review that
   * throws must not take the shutdown or the watch loop with it, and a full
   * disk is a reason to lose a report rather than a reason to lose the game
   * being played. Same rule `log.js` runs under.
   */
  const publish = () => {
    try {
      const all = snapshot();
      if (log.dir && all.length) saveReview(log.dir, all);
      dash.notify();
    } catch (e) {
      console.error('review failed (the game itself is safe in the log):', e.message);
    }
  };

  /** A game has ended: keep its review, and start the next one clean. */
  const finishGame = (n) => {
    if (!graded.length) return null;
    let r = null;
    try {
      r = reviewGame(graded, { color: playerColor });
      reviews.push({ ...r, n, plies: chess.history().length, source: 'live' });
      graded = [];
    } catch (e) {
      console.error('review failed (the game itself is safe in the log):', e.message);
      graded = [];
      return null;
    }
    publish();
    return r;
  };

  /** Print a finished game's review, and say where the rest of it lives. */
  const showReview = (r) => {
    if (!r) return;
    console.log('\nhow that went:');
    for (const line of summarise(r)) console.log(line);
    if (dash.url) return void console.log(`  the full review: ${dash.url}`);
    try {
      console.log(`  the full review, and every other game: ${rebuild().file}`);
    } catch (e) {
      console.error('  (could not write the review page:', e.message + ')');
    }
  };

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    keys?.close();
    overlay.quit();
    await engine.quit();
    await cap.quit();
    // Last, and awaited: the frames still sitting in the deflate buffer are
    // exactly the ones from just before you gave up and pressed Ctrl+C.
    log.event('end', { fen: chess.fen(), moves: chess.history().length, games });
    log.pgn(chess.pgn(), games);
    showReview(finishGame(games));
    // After the last review is written, so a tab open on the dashboard gets the
    // finished game pushed to it before the server goes away.
    dash.stop();
    await log.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);

  const watcher = new MoveWatcher({
    floor: cfg.floor ?? null, allow: cfg.allow ?? 0, threshold: MOVE_THRESHOLD,
    confidence: process.env.COACH_MOVE_CONFIDENCE
      ? Number(process.env.COACH_MOVE_CONFIDENCE) : undefined,
  });
  if (cfg.floor == null) {
    console.warn('note: no fit floor in board.json — re-run `npm run calibrate` for');
    console.warn('      stricter move acceptance.\n');
  }

  /*
   * The session record. Everything below that prints a line to the terminal
   * also writes it here with the numbers behind it, because a desync is only
   * explicable after the fact if the evidence was kept as it went past.
   */
  log.event('start', {
    argv: process.argv.slice(2),
    region: cfg.region,
    flipped: model.flipped,
    playerColor,
    /*
     * Where that colour came from, rather than only what it is. Four sessions'
     * logs recorded `playerColor: 'b'` as a bare fact and so could not answer
     * the one question being asked of them afterwards — why does it think that?
     * `calibrated` is what the templates were built with and what decided it;
     * `facing` is what the board itself said at startup.
     */
    orientation: {
      calibrated: model.orientation,
      facing: facing0,
      theme: stale0,
      // Measured from the loaded templates, so it is present even for a
      // model.json written before calibration recorded its reasons.
      tone: { white: tone.white, black: tone.black,
              separation: tone.separation, consistent: tone.consistent },
    },
    fen: chess.fen(),
    model: fileHash(path.join(TEMPLATE_DIR, 'model.json')),
    contrast: model.contrast,
    limits: {
      squareLimit, softLimit, floor: cfg.floor ?? null, allow: cfg.allow ?? 0,
      threshold: MOVE_THRESHOLD, confidence: watcher.confidence,
      occludeMax: watcher.occludeMax, quiet: watcher.quiet, stable: watcher.stable,
      patience: watcher.patience, slack: watcher.slack,
    },
    ladder: { resync: RESYNC_AFTER, lost: LOST_AFTER, blind: BLIND_AFTER, pollMs: POLL_MS },
    depth: DEPTH,
  });

  /** Which squares refute the position we think we are in, and what they show. */
  const diagnose = (det) => {
    const wrong = model.diagnose(det.table, gridOf(chess, model.flipped), squareLimit, {
      skip: det.mask, soft: decorated(chess, lastMove, model.flipped), tint: det.tint,
      softLimit,
    });
    // A square that is wrong either way was discounted, not believed. The log
    // has to say which, or a later reader wonders why a listed square did not
    // count — see `stale` in board.js.
    if (det.stale) {
      for (const w of wrong) {
        if (det.stale[indexOfSquare(w.sq, model.flipped)]) w.stale = true;
      }
    }
    return wrong;
  };

  /**
   * Is the screen showing the opening position?
   *
   * The one thing a forward search can never find, because it is not ahead of
   * us — it is a different game. Starting a second game without restarting the
   * coach puts the board back at move 1 while the tracked position is deep in
   * the last one, and every other rung of the ladder then fails for its own
   * separate reason. Asked in both orientations, since the site hands you the
   * other colour as readily as the same one.
   *
   * Cheap enough to ask on every lost frame: two scores off a cost table that
   * has already been computed. It began as an observation for the log, which is
   * how the case was diagnosed at all; `tryNewGame` is that observation acted
   * on, and both read the same numbers so the log cannot disagree with the
   * decision it explains.
   */
  const probeStart = (det, asFlipped = model.flipped) => {
    const out = {};
    /*
     * Keyed by how it relates to the orientation we are *currently reading in*,
     * not to an absolute one: for a player sitting on the black side, `same` is
     * already a flipped grid, and labelling it "the other way round" in the
     * summary inverts the meaning of the one line that has to be unambiguous.
     *
     * Which is exactly why the reference is a parameter. `tryFlip` toggles
     * `model.flipped` before proving the toggle, and calls `tryRead` while it is
     * toggled — so reading the live flag there labelled `same` and `turned`
     * backwards relative to every other event in the log. It was silent and
     * total: the same pair of numbers appears twice in an episode with the labels
     * swapped, and on one session the summary reported the start position
     * matching "the other way round" for a board being read the right way round,
     * sending the diagnosis after a flip that never happened. Callers inside a
     * speculative toggle pass the orientation the reader should be described
     * against.
     */
    for (const [key, flipped] of [['same', asFlipped], ['turned', !asFlipped]]) {
      const grid = fenToGrid(START_FEN, flipped);
      out[key] = {
        score: Math.round(model.scoreGrid(det.table, grid, det.mask) * 10) / 10,
        misfits: model.misfits(det.table, grid, squareLimit,
          { skip: det.mask, tint: det.tint, softLimit }),
      };
    }
    return out;
  };

  /** The last move we applied — where the board will be painting its highlight. */
  let lastMove = null;
  // Grading runs off the hot path so watching never blocks on Stockfish, but
  // strictly one at a time: `engine` is a single process and concurrent UCI
  // would interleave. This chain is that mutex — and nothing else. Tracking
  // must never wait on it (see below).
  let grading = Promise.resolve();
  const enqueue = (fn) => {
    grading = grading.then(fn).catch((e) => console.error('grade failed:', e.message));
  };

  /*
   * Coaching state.
   *
   * One analysis per turn of yours, started the moment it becomes your turn and
   * cached by FEN. It is not extra work: gradeMove needs a search of exactly
   * this position anyway, so running it now rather than after you move pays for
   * the `c` topic and halves the wait for the grade.
   *
   * MultiPV 2 always, whether or not you ask for anything, so a grade never
   * depends on whether you happened to press a key.
   *
   * `threat` is the exception: it needs a second search, of the position with
   * the turn handed over, so it is fetched lazily the first time you press `t`
   * and never paid for otherwise.
   */
  const coach = { fen: null, analysis: null, threat: null, step: {}, taken: false };

  const preAnalyse = (fen) => {
    Object.assign(coach, { fen, analysis: null, threat: null, step: {}, taken: false });
    enqueue(async () => {
      const analysis = await engine.analyse(fen, DEPTH, { multipv: 2 });
      // Only if we are still on that position: a move may have landed meanwhile.
      if (coach.fen === fen) coach.analysis = analysis;
    });
  };

  const ask = async (key) => {
    const topic = TOPICS[key];
    if (!topic) return;
    if (chess.turn() !== playerColor) return console.log('      (not your turn)');
    if (!coach.analysis) return console.log('      (still thinking — try again in a moment)');

    // The one topic that costs a search. Paid once per turn, only when asked.
    if (topic.needsThreat && !coach.threat) {
      const fen = coach.fen;
      console.log('      (looking at his threats...)');
      await new Promise((resolve) => enqueue(async () => {
        const found = await findThreat(engine, fen, coach.analysis, playerColor, THREAT_DEPTH);
        if (coach.fen === fen) coach.threat = found;
        resolve();
      }));
      if (coach.fen !== fen) return;              // a move landed while searching
    }

    const steps = topic.steps({
      fen: coach.fen, chess, lines: coach.analysis.lines,
      color: playerColor, threat: coach.threat,
    }) ?? [];

    const n = coach.step[key] ?? 0;
    if (n >= steps.length) {
      return console.log(`      (that is all on ${topic.label} — it will not name your move)`);
    }
    coach.step[key] = n + 1;
    coach.taken = true;
    log.event('ask', { key, topic: topic.label, step: n, text: steps[n], fen: coach.fen });
    console.log(`      .. ${steps[n]}`);
    overlay.hint(steps[n]);
  };

  const askKey = (key) => ask(key).catch((e) => console.error('coach failed:', e.message));

  // readline rather than a raw `data` listener: it does the line splitting and
  // CRLF handling itself, and behaves the same whether stdin is a console or a
  // pipe. `terminal: false` keeps it from drawing a prompt over the move log.
  keys = readline.createInterface({ input: process.stdin, terminal: false });
  keys.on('line', (line) => {
    const key = line.trim().toLowerCase()[0];
    if (KEYS.includes(key)) askKey(key);
  });

  /**
   * Advance the tracked position by one move, and grade it.
   *
   * Advancing is immediate and unconditional. `watcher.feed` has already
   * consumed this move and reset itself, so it will never be offered again:
   * skipping the apply — as gating this on a grade in flight used to — leaves
   * the tracked position one move behind the screen for good, and every later
   * move then fits nothing. An engine that is busy is a reason to delay a
   * grade, never a reason to stop watching.
   */
  const applyMove = (move, { recovered = false } = {}) => {
    const uci = move.from + move.to + (move.promotion ?? '');
    const fenBefore = chess.fen();
    const mover = chess.turn();
    // Captured before preAnalyse resets it for the next turn.
    const usedHint = mover === playerColor && coach.fen === fenBefore && coach.taken;

    chess.move(move);
    lastMove = move;
    if (chess.turn() === playerColor) preAnalyse(chess.fen());

    // A move we only found by re-syncing was never watched as it happened, so
    // it is marked `~`: the session log stays a truthful record of what was
    // actually seen, the same way `*` marks a move you took a hint on.
    const mine = mover === playerColor;
    const tag = recovered ? (mine ? 'you~' : 'opp~')
      : mine ? (usedHint ? 'you*' : 'you ') : 'opp ';
    // Read here, not inside the grade below: that runs a search later, by which
    // time the game has moved on and every move would be numbered wrongly.
    const ply = chess.history().length;
    log.event('apply', {
      tag: tag.trim(), san: move.san, uci, mover, recovered, usedHint,
      fenBefore, fenAfter: chess.fen(), ply,
    });
    if (!mine && !args.all) return void console.log(`[${tag}] ${move.san}`);

    enqueue(async () => {
      // Read at run time, not at accept time: this runs after preAnalyse in
      // the same queue, so the search it needs has already landed. The FEN
      // check is what makes a stale cache fail safe into a fresh search.
      const pre = coach.fen === fenBefore && coach.analysis
        ? { fen: coach.fen, analysis: coach.analysis } : null;

      const g = await gradeMove(engine, fenBefore, uci, DEPTH, { pre });

      /*
       * Everything the review needs, written as it goes past.
       *
       * The extra fields are what let a game be reviewed *without* an engine
       * afterwards — the positions and the lines Stockfish returned are the
       * whole evidence `review.js` classifies from, and a search that is not
       * recorded here has to be paid for again. The lines are cut at 8 plies:
       * ~300 bytes a move, against the 16KB frame this same loop already
       * records six times a second.
       */
      const row = {
        san: g.san, uci, mover: g.mover, ply,
        label: g.label.name, drop: g.drop,
        scoreBefore: g.scoreBefore, scoreAfter: g.scoreAfter,
        fenBefore: g.fenBefore, fenAfter: g.fenAfter,
        bestMove: g.bestMove, bestLine: (g.bestLine ?? []).slice(0, 8),
        refutation: (g.refutation ?? []).slice(0, 8), materialSwing: g.materialSwing,
        exchange: g.exchange, floored: g.floored,
      };
      if (mine) graded.push(row);
      log.event('grade', { ...row, cached: !!pre });
      // The dashboard follows the game rather than waiting for it to end.
      // Cheap — a review of the moves in hand, and a rebuild of a few KB of
      // JSON — and it runs on the grading queue, never the watch loop.
      if (mine) publish();
      console.log(`[${tag}] ${g.san.padEnd(7)} ${g.label.name.padEnd(11)}`
        + ` ${formatScore(g.scoreBefore)} -> ${formatScore(g.scoreAfter)}`
        + `  (-${g.drop.toFixed(1)}%)`);
      overlay.show(g);

      if (shouldExplain(g.label)) {
        const why = await explain(g);
        if (why) {
          console.log(`      ${why}`);
          overlay.addExplanation(why, g);
        }
      }
    });
  };

  /**
   * The board may have gone *backwards*.
   *
   * Everything else here assumes the screen has run ahead of us, because that
   * is what a missed move looks like. A board can also move the other way: a
   * takeback, a premove that reverts, a move-confirmation dialog dismissed.
   * Measured on a real session, a knight went to c6, sat there for ten settled
   * frames — long enough to be accepted and graded — and then went back to b8.
   * From that moment no forward search could reach the truth at any depth,
   * because the truth was behind us, and the coach spent the next fifteen
   * minutes lost on a perfectly ordinary game.
   *
   * This is the cheapest rung by a wide margin, and the most certain. A
   * forward search invents thousands of positions and picks one; here there is
   * nothing to search — the position is one we were in, exactly, and all it
   * costs is scoring it. On that session the undone position explained all 64
   * squares and beat what we believed by 245.
   *
   * Proven before it is kept, like every other rung: it must explain the board
   * completely and beat the tracked position by the usual margin, which a
   * board that has genuinely moved *on* will never let it do.
   */
  const tryUndo = (det, plies) => {
    const undone = [];
    for (let i = 0; i < plies; i++) {
      const m = chess.undo();
      if (!m) break;
      undone.unshift(m);
    }
    if (!undone.length) return false;              // nothing to take back

    const history = chess.history({ verbose: true });
    const prior = history[history.length - 1] ?? null;
    const grid = gridOf(chess, model.flipped);
    const score = model.scoreGrid(det.table, grid, det.mask);
    const misfits = model.misfits(det.table, grid, squareLimit, {
      skip: det.mask, tint: det.tint, soft: decorated(chess, prior, model.flipped),
      softLimit,
    });
    const margin = det.still - score;

    if (misfits > 0 || margin < watcher.confidence) {
      log.event('undo', {
        ok: false, plies: undone.length, reason: misfits > 0 ? 'misfits' : 'margin',
        line: undone.map((m) => m.san), misfits, margin,
      });
      for (const m of undone) chess.move(m);       // put the game back as it was
      return false;
    }

    log.event('undo', {
      ok: true, plies: undone.length, line: undone.map((m) => m.san),
      misfits, margin, fen: chess.fen(),
    });
    console.log(`\ntaken back: ${undone.map((m) => m.san).join(' ')} — the board went back`
      + ` ${undone.length === 1 ? 'a move' : `${undone.length} moves`}.`);
    console.log('(a move that was taken back keeps the grade it already got)');

    lastMove = prior;
    Object.assign(coach, { fen: null, analysis: null, threat: null, step: {}, taken: false });
    if (chess.turn() === playerColor) preAnalyse(chess.fen());
    watcher.reset();
    return true;
  };

  /**
   * The move we recorded was never played — a different one was.
   *
   * The failure this rung exists for is a move accepted while the player was
   * still deciding. You pick a bishop up, hold it over g4 while you think, and
   * for as long as you hold still the screen is pixel-identical to a board where
   * Bg4 has been played — `quiet` cannot tell a settled board from a settled
   * cursor. Then you play Be6 instead, and from that instant the truth is one
   * ply *sideways*: the position we were in before, with a different move out
   * of it. `tryUndo` cannot see it, because the board did not go back; no
   * forward search can, because the truth does not follow the phantom.
   *
   * `BoardModel.replaceLast` has the measurements and the reasoning. Here it is
   * held to the same bar as every other rung, which is the bar that matters:
   * every square explained, and a clear lead over the runner-up. A board that
   * has genuinely run *ahead* of us cannot clear it — the replacement would
   * leave the moves we actually missed unexplained — so this cannot quietly
   * swallow a plain desync that the searches below it should be handling.
   *
   * Unlike a takeback, the grade has to be withdrawn. A move taken back was
   * really played and really was a blunder; a move that never happened was
   * never anything, and leaving its grade standing would be the one thing this
   * whole file is built to avoid — telling you something about your game that
   * is not true.
   */
  const tryReplace = (det) => {
    const found = model.replaceLast(det.table, chess, {
      mask: combine(det.mask, det.stale), squareLimit, tint: det.tint, softLimit,
    });
    // `no` is set when the rung declined before ranking anything, and says which
    // of the four ways it was — see BoardModel.replaceLast.
    const ran = found && !found.no;
    const beats = ran ? det.still - found.score : 0;
    if (!ran || found.misfits > 0 || found.margin < watcher.confidence
        || beats <= MOVE_THRESHOLD) {
      log.event('replace', {
        ok: false,
        reason: !ran ? found.no : found.misfits > 0 ? 'misfits'
          : found.margin < watcher.confidence ? 'margin' : 'threshold',
        was: found?.was?.san ?? null, now: found?.move?.san ?? null,
        score: found?.score, misfits: found?.misfits, margin: found?.margin,
        beats, need: watcher.confidence,
        wrong: diagnose(det), start: probeStart(det),
      });
      return false;
    }

    // The grade already given out was given for a move that did not happen, so
    // it is withdrawn before the replacement is applied and graded in its place.
    // `coach` is deliberately left alone: the pre-analysis it holds is of the
    // position *before* the phantom, which is exactly the position the real move
    // was played from, so applyMove's own FEN check reuses that search rather
    // than paying for it again.
    const undone = chess.undo();
    log.event('replace', {
      ok: true, was: undone.san, now: found.move.san, uci: found.uci,
      score: found.score, misfits: found.misfits, margin: found.margin, beats,
      fen: chess.fen(),
    });
    // The same mistake happens to the opponent's moves, where "you were still
    // holding the piece" would be nonsense — there it is a frame caught while
    // the piece was over the wrong square, not a player thinking.
    console.log(`\n${undone.san} was never played — it was ${found.move.san}.`
      + (undone.color === playerColor ? ' (the piece was still in your hand.)' : ''));
    console.log(`(withdrawing the grade given for ${undone.san})`);
    applyMove(found.move, { recovered: true });
    watcher.reset();
    return true;
  };

  /**
   * It is not our board any more: a *new game* has started under us.
   *
   * The failure that ended a real session. Forty seconds before the log stops,
   * the screen matched the opening position on all 64 squares while the tracked
   * position was 26 moves into the previous game — and every rung failed for its
   * own separate and correct reason. The searches look ahead of a position the
   * board has left entirely; the undo looks behind it and finds the same game;
   * the flip finds the board the right way round already; and the re-read
   * refuses outright, because a board with *more* men on it than we are tracking
   * is not a position this game could have reached. That refusal is right — it
   * is the last thing standing between us and adopting a fiction — and it is
   * also the exact shape of a fresh game, which is why this exists to catch what
   * it correctly will not.
   *
   * So the answer is not a better reading. It is to stop tracking this game and
   * start the next one: the position is not *read* off the screen at all, it is
   * the opening position, known exactly, with its castling rights and move
   * number intact. That makes this stronger than the re-read below it despite
   * being far cheaper — the one recovery that gives back a position as good as
   * the one we started with.
   *
   * {@link freshStart} holds the bar it has to clear, which is total: every
   * square, nothing covering the board, and a clear lead over the position we
   * hold. A fresh game is not reachable by any legal move from a middlegame, so
   * nothing short of certainty should be allowed to throw a game away.
   *
   * ## Why this one is not a rung
   *
   * Every other rung waits its turn, because a search is expensive and a board
   * that has run two plies ahead will still be two plies ahead in ten seconds'
   * time. This is the opposite on both counts. It costs two scores off a cost
   * table that has already been computed, and what it looks for is a *window*
   * rather than a state: the opening position is on screen only until the first
   * move of the new game is played.
   *
   * Replayed against the session that found this, that window was four frames
   * wide — `lost` 1 to 4, six tenths of a second — and then the new game moved
   * on. It reopened 150 frames later and stayed open to the end. A rung at the
   * usual depth of 8 would have missed the first window and landed between the
   * two, which is to say it would have fixed nothing at all. So this is asked
   * on every lost frame, and it is the cheapness that buys that.
   */
  const tryNewGame = (det) => {
    // The same bar as accepting a move: a board caught mid-repaint is not
    // evidence of anything. `lost` only climbs on settled frames anyway, so
    // this costs no window that was ever open for long.
    if (!watcher.settled) return false;

    const probe = probeStart(det);
    const verdict = freshStart(probe, {
      still: det.still, confidence: watcher.confidence, occluded: det.occluded ?? 0,
    });
    if (!verdict.ok) {
      // "The screen is not the opening position" is the answer on almost every
      // lost frame there has ever been, and this runs on all of them; logging
      // it would bury the log in a line that says nothing. The numbers behind
      // it are in the `desync` and `probe` events regardless. A near miss is
      // another matter — it is the one case where this might have been wrong
      // to decline — so that is recorded, once, however long the episode runs.
      if (verdict.reason !== 'misfits' && !nearMiss) {
        nearMiss = true;
        log.event('newgame', {
          ...verdict, margin: Math.round((verdict.margin ?? 0) * 10) / 10,
          need: watcher.confidence, start: probe,
        });
      }
      return false;
    }

    /*
     * One last thing it could be instead: a takeback that happens to land on
     * the opening position. Same board either way, but a takeback is two moves
     * of a game we are still in, and `tryUndo` reaches it with the history
     * intact — so if the start is one or two plies behind us, this defers and
     * lets the cheaper rung have it a moment later.
     *
     * Asked here rather than up front because walking the history costs more
     * than the probe that gets us this far, and this is the one frame in a
     * session where the answer can matter.
     */
    const back = chess.history({ verbose: true }).slice(-2);
    if (back.some((m) => m.before.split(' ')[0] === START_MEN)) return false;

    const was = chess.fen();
    const plies = chess.history().length;
    // Written before the position is thrown away: this is the only record that
    // the game just finished ever happened.
    const saved = log.pgn(chess.pgn(), games);
    // Reviewed here for the same reason, and before `playerColor` may flip
    // below: the game that just ended was played from the side we are on now.
    const review = finishGame(games);
    games += 1;

    // The other side of the board is as likely as the same one. Orientation and
    // which colour we are coaching move together, exactly as in `tryFlip`.
    if (verdict.turned) {
      model.flipped = !model.flipped;
      playerColor = model.flipped ? 'b' : 'w';
    }

    /*
     * And then confirmed against the board rather than left to the probe.
     *
     * `verdict.turned` comes from which way round the opening position fitted
     * better, which is a comparison between two hypotheses; this is a reading
     * of where the two colours actually are. They agree on a clean board, and
     * when they do not it is this one that is right — a new game is the moment
     * the site hands you the other colour, so it is exactly the moment worth
     * spending a second opinion on. Costs nothing: the frame is already scored.
     */
    const facing = facingOf(det);
    const turnedBy = facing.flipped != null && facing.margin >= ORIENTATION_MARGIN
      && facing.flipped !== model.flipped;
    if (turnedBy) {
      model.flipped = facing.flipped;
      playerColor = model.flipped ? 'b' : 'w';
    }
    log.event('facing', {
      at: 'newgame', flipped: facing.flipped, margin: facing.margin,
      changed: turnedBy, agreed: !turnedBy && facing.flipped === model.flipped,
    });

    chess.reset();
    lastMove = null;
    Object.assign(coach, { fen: null, analysis: null, threat: null, step: {}, taken: false });
    if (chess.turn() === playerColor) preAnalyse(chess.fen());
    watcher.reset();
    // A rematch on the same board keeps its floor; one handed to you the other
    // way round does not, and this is the exact frame that invalidated it on the
    // session that lost half an hour to a stale one.
    if (verdict.turned) watcher.relearnFloor();

    log.event('newgame', {
      ok: true, game: games, turned: verdict.turned, flipped: model.flipped,
      playerColor, margin: Math.round(verdict.margin * 10) / 10, was, plies, pgn: saved,
    });
    const name = playerColor === 'w' ? 'White' : 'Black';
    console.log(`\na new game — the board is back in the opening position`
      + `${verdict.turned ? ', the other way round' : ''}, and you are ${name}.`
      + ' Starting over at move 1.');
    console.log(`(the last game ran ${plies} ${plies === 1 ? 'ply' : 'plies'} here`
      + `${saved ? `, kept as ${saved}` : ''})`);
    showReview(review);
    return true;
  };

  /*
   * Getting the board back.
   *
   * A board that has run ahead of us has run ahead by a small, known amount:
   * you moved and the opponent replied. So the position on screen is still only
   * a couple of plies out, and searching that far finds it — which is why
   * losing track is no longer a reason to restart.
   *
   * Every step here is validated before it is kept. A resync is applied only if
   * the line it found explains every square and leads the runner-up position
   * clearly; a re-measured region is kept only if the board actually reads
   * better through it, and put back if not. Recovery that cannot prove itself
   * is worse than none, because it would quietly invent a different fiction
   * than the one it replaced.
   */
  const tryResync = (det, plies) => {
    const found = model.resync(det.table, chess,
      { plies, mask: combine(det.mask, det.stale), squareLimit, tint: det.tint, softLimit });
    if (!found || found.misfits > 0 || found.margin < watcher.confidence) {
      // Why it was refused is the useful half. "Nothing within two plies
      // explains this board" and "the right line was there but the runner-up
      // was just as good" are different failures with different fixes.
      log.event('resync', {
        plies,
        ok: false,
        reason: !found ? 'no line' : found.misfits > 0 ? 'misfits' : 'margin',
        line: found?.line.map((m) => m.san) ?? null,
        score: found?.score, misfits: found?.misfits, margin: found?.margin,
        need: watcher.confidence,
        wrong: diagnose(det),
        start: probeStart(det),
      });
      return false;
    }
    log.event('resync', {
      plies, ok: true, line: found.line.map((m) => m.san),
      score: found.score, misfits: found.misfits, margin: found.margin,
    });
    console.log(`\nre-synced (${plies} ply): ${found.line.map((m) => m.san).join(' ')}`);
    for (const m of found.line) applyMove(m, { recovered: true });
    watcher.reset();
    return true;
  };

  /**
   * Several moves went by unseen, so no forward search will reach the truth —
   * read the board instead. Only taken when every square is unambiguous, and
   * only after the cheaper rungs have failed, because it throws away the one
   * guarantee the rest of the design buys: that the tracked position got here
   * through legal moves we actually watched.
   */
  /**
   * @param {object} det
   * @param {boolean} [describeAs]  the orientation this call's log lines should
   *        be labelled against. `tryFlip` reaches here with `model.flipped`
   *        already toggled to a value it has not yet proved, and passes the
   *        orientation the rest of the log is written in — see {@link probeStart}.
   */
  const tryRead = (det, describeAs = model.flipped) => {
    const fenWas = chess.fen();
    if (det.occluded > 0) {
      log.event('read', { ok: false, reason: 'occluded', occluded: det.occluded });
      return false;
    }
    const read = model.readBoard(det.tint, { squareLimit, mask: det.mask });
    if (!read) {
      log.event('read', {
        ok: false, reason: 'ambiguous', start: probeStart(det, describeAs),
        // Said outright, because the numbers alone cannot show it: this reading
        // was taken in a speculative orientation that may be reverted.
        ...(describeAs === model.flipped ? {} : { speculative: true }),
      });
      return false;
    }

    // Pieces leave a board; they never arrive. Promotion changes what a piece
    // is, never how many there are, so a reading that has gained material is
    // not a position this game could have reached and is refused — the one
    // check the per-square confidence test cannot make on its own.
    const count = (fen) => {
      const c = { w: 0, b: 0 };
      for (const row of fen.split(' ')[0]) {
        if (/[A-Z]/.test(row)) c.w++;
        else if (/[a-z]/.test(row)) c.b++;
      }
      return c;
    };
    const now = count(chess.fen()), got = count(read.fen);
    if (got.w > now.w || got.b > now.b) {
      /*
       * The reading is of a board with *more* men than the game we are
       * tracking, so it is not a position this game could have reached — and
       * this refusal is the last thing standing between us and adopting a
       * fiction. It is also exactly what a new game looks like from in here,
       * which is why the whole reading is recorded rather than just the
       * decision: if `read` is the opening position, the log has said so
       * outright and the answer is not a better reading but a new game.
       * `tryNewGame` should have taken that before this was ever reached, so
       * an `isStart` here is worth chasing — it means the board was covered,
       * or the opening position never held still while it was being watched.
       */
      log.event('read', {
        ok: false, reason: 'material', fen: read.fen,
        have: now, got, isStart: read.fen.split(' ')[0] === START_MEN,
      });
      return false;
    }

    chess.load(read.fen);
    lastMove = null;
    coach.fen = null;
    if (chess.turn() === playerColor) preAnalyse(chess.fen());
    watcher.reset();
    // Named rather than dumped: a bare FEN in the middle of a move log is the
    // one line here that means nothing unless you already read the notation.
    log.event('read', { ok: true, fen: read.fen, was: fenWas });
    const toMove = read.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
    console.log(`\nre-read the board from scratch — ${toMove} to move:`);
    console.log(`  ${read.fen}`);
    console.log('  (FEN: the whole position on one line — see "Notation" in the README)');
    console.log('(moves played while it was out of sight are not graded)');
    return true;
  };

  /**
   * The board may be the other way round from the one we calibrated on.
   *
   * Orientation is decided once, at calibration, from the start position — and
   * then never asked again, so starting a game on the other side of the board
   * (or pressing the site's flip button) left every later frame rotated 180
   * degrees from what we expected. Nothing fits, every rung fails, and the last
   * one "succeeds" by reading a board that is upside down: a real session
   * reported `RNBKQB1R/PPPP1PPP/5N2/...`, which is 1.d4 d5 2.Nc3 seen from the
   * wrong end, with the kings and queens apparently swapped.
   *
   * Re-calibration is not needed to fix it, because a 180 degree rotation is
   * the one change the templates survive intact: square shade is (r+c) parity
   * and (7-r)+(7-c) has the same parity, so the light and dark models still
   * apply; and `bare` is indexed by *image* square, while the site draws its
   * coordinates in image-fixed corners, so the learned backgrounds stay where
   * they are. Measured on this board, the rank digit changing under a flip
   * costs 3-5 against a wrong-square limit of 200. So the fix is one flag.
   *
   * The cost table, the occlusion mask and the tint reader are all computed per
   * image square and per piece code, with no orientation in them at all — which
   * is what makes this rung nearly free: the frame we already have is re-scored
   * the other way round without touching a pixel again.
   *
   * Proven before it is kept, like every other rung. If the templates themselves
   * were learned the wrong way round — a mis-detected orientation at calibration
   * rather than a flipped screen — the toggle fits *worse*, proves nothing, and
   * is put back, which leaves the honest "lost" message instead of a second
   * fiction on top of the first.
   */
  const tryFlip = (det) => {
    const was = playerColor;
    // Flipped together, because they are one fact: which way round the board is
    // and which end of it you are sitting at. tryRead below reads `playerColor`
    // to decide whose turn to pre-analyse, so it has to see the corrected one.
    model.flipped = !model.flipped;
    playerColor = model.flipped ? 'b' : 'w';

    const misfits = model.misfits(det.table, gridOf(chess, model.flipped), squareLimit, {
      skip: det.mask, tint: det.tint, soft: decorated(chess, lastMove, model.flipped),
      softLimit,
    });

    // Either the position was right all along and only the view was wrong, or
    // the board also ran ahead while we were making no sense of it — in which
    // case a clean read is itself the proof that this way round is the right one.
    // `was` is the orientation every other line of this episode is written in,
    // so the read's own log lines are labelled against it rather than against the
    // toggle we are still trying to prove.
    const proven = misfits === 0 || tryRead(det, was === 'b');
    if (!proven) {
      log.event('flip', { ok: false, misfits, tried: model.flipped });
      model.flipped = !model.flipped;
      playerColor = was;
      return false;
    }
    log.event('flip', { ok: true, misfits, flipped: model.flipped, playerColor });
    // The board turned round, so the floor no longer measures it — see
    // MoveWatcher.relearnFloor. board.json is deliberately left alone: the
    // orientation is a property of this game, and the next clean frame supplies
    // the number for this one.
    watcher.relearnFloor();

    const name = playerColor === 'w' ? 'White' : 'Black';
    console.log(`\nthe board is the other way round from the one calibrated — you are`
      + ` ${name}. Grading that side from here.`);
    console.log('(board.json is left alone: this is a property of the game, not the theme)');

    // tryRead has already done this on its path; this is the other one, where
    // the position never changed and only the side being coached did.
    if (misfits === 0) {
      Object.assign(coach, { fen: null, analysis: null, threat: null, step: {}, taken: false });
      if (chess.turn() === playerColor) preAnalyse(chess.fen());
      watcher.reset();
    }
    return true;
  };

  /** The board may simply have moved or been resized; the templates still hold. */
  const tryRegion = async () => {
    const pad = Math.round(cfg.region.w * 0.15);
    const found = await measureGrid({
      x: cfg.region.x - pad, y: cfg.region.y - pad,
      w: cfg.region.w + pad * 2, h: cfg.region.h + pad * 2,
    });
    if (!found.square) {
      log.event('region', { ok: false, reason: 'no grid' });
      return false;
    }

    const before = cfg.region;
    await cap.region(found.region.x, found.region.y, found.region.w, found.region.h);
    const probe = model.detectMove(await cap.grab(), chess, {
      squareLimit, softLimit, excuse: decorated(chess, lastMove, model.flipped),
    });
    if (probe.stillMisfits === 0 || probe.bestMisfits === 0) {
      log.event('region', {
        ok: true, from: before, to: found.region,
        stillMisfits: probe.stillMisfits, bestMisfits: probe.bestMisfits,
      });
      cfg.region = found.region;
      console.log(`\nboard had moved — region is now ${found.region.w}x${found.region.h}`
        + ` at (${found.region.x}, ${found.region.y})`);
      watcher.reset();
      return true;
    }
    log.event('region', {
      ok: false, reason: 'no better', from: before, tried: found.region,
      stillMisfits: probe.stillMisfits, bestMisfits: probe.bestMisfits,
      start: probeStart(probe),
    });
    await cap.region(before.x, before.y, before.w, before.h);
    return false;
  };

  if (chess.turn() === playerColor) preAnalyse(chess.fen());

  /** Runs each rung once per episode; see {@link Ladder} for why that is not free. */
  const ladder = new Ladder();
  /*
   * How many squares are wrong right now, which stands in for *which* ones are.
   * A coarse proxy deliberately: when the board runs on by another ply the count
   * essentially always changes, and comparing counts costs nothing, where
   * carrying the set of squares around would cost an allocation every frame on
   * the one path that must not get slower. See {@link Ladder#due}.
   */
  let shape = null;
  const due = (at) => ladder.due(watcher.lost, at, shape);
  /** Whether this episode has already reported a refused new game. */
  let nearMiss = false;
  /**
   * Whether this spell of blindness has already been escalated. A flag rather
   * than an exact frame count, because re-measuring the region takes about a
   * second and `blind` does not advance while it runs — the same stall that made
   * the ladder fire one search thirteen times.
   */
  let blindGaveUp = false;

  while (!stopping) {
    const t0 = Date.now();
    let frame;
    try {
      frame = await cap.grab();
    } catch (e) {
      // On the way out the daemon is torn down under this very call, and that
      // rejection is the shutdown working rather than a failure to report.
      if (stopping) break;
      log.event('error', { where: 'capture', message: e.message });
      console.error('capture failed:', e.message);
      break;
    }
    const grabbed = Date.now();

    // `h` pressed on the overlay window, which usually owns the keyboard.
    const pressed = overlay.takeKey();     // a key pressed on the overlay window
    if (pressed) askKey(pressed);

    const det = model.detectMove(frame, chess, {
      squareLimit, softLimit, excuse: decorated(chess, lastMove, model.flipped),
    });
    const detected = Date.now();
    const accepted = watcher.feed(frame, det);
    shape = det.stillMisfits;

    /*
     * board.json describing a board that is no longer on screen used to be
     * invisible. It does not stop moves being read — the per-square count does
     * that job and does it on this board's own terms — but every limit derived
     * from `floor` is then quietly wrong, and the session that found this ran
     * 210 seconds with a floor 4.4x too low without saying a word.
     *
     * Said once, after enough accepted moves to be sure it is the calibration
     * and not one decorated frame, and phrased as the action it implies.
     */
    if (watcher.overFloor === STALE_FLOOR_MOVES) {
      console.log(`\nthe board reads cleanly but costs more than calibration said it would`
        + ` (floor ${cfg.floor}).`);
      console.log('Nothing is wrong with the grading — moves are judged per square, not by');
      console.log('that number — but board.json describes a different board: a changed theme,');
      console.log('piece set, or board size. Re-run `npm run calibrate` when convenient.');
      watcher.overFloor++;                         // so this fires once, not every move
    }

    /*
     * The frame goes in before the move is applied, so `fen` is the position
     * the detection was actually made against — a log where the position had
     * already moved on would misattribute every accepted move by one ply,
     * which is precisely the error being hunted.
     */
    log.frame(frame, det, watcher, {
      fen: chess.fen(),
      // Recorded because the decoration mask is built from it: without it a
      // replay judges the last move's own highlight as a fault and reports
      // squares the session never counted.
      last: lastMove ? lastMove.from + lastMove.to : null,
      diff: Math.round(watcher.diff * 100) / 100,
      settled: watcher.settled,
      stale: det.staleCount,
      accepted: accepted?.uci ?? null,
      ms: { grab: grabbed - t0, detect: detected - grabbed },
    });

    // The moment it goes wrong, recorded in full: the squares that refute the
    // position, and whether the screen is showing a new game. One event, at
    // the transition, rather than the same 20 squares on every later frame.
    if (watcher.lost === 1) {
      log.event('desync', { fen: chess.fen(), wrong: diagnose(det), start: probeStart(det) });
    } else if (watcher.lost > 1 && watcher.lost % PROBE_EVERY === 0) {
      log.event('probe', { lost: watcher.lost, start: probeStart(det) });
    }

    if (accepted) applyMove(accepted.move);

    /*
     * The recovery ladder, cheapest rung first. Each runs once per episode, at
     * its own depth of trouble, and a rung that succeeds resets the watcher so
     * the next frame starts clean. The new-game check is the exception on both
     * counts — every frame, no depth — because it costs two scores and because
     * it is looking for something that closes; `tryNewGame` says why.
     *
     * Nothing here is on the critical path of a healthy board: `lost` returns
     * to zero the moment any hypothesis explains the screen, which on a board
     * we are tracking correctly is every frame.
     */
    if (watcher.lost === 0) { ladder.reset(); nearMiss = false; }
    // Asked on every lost frame rather than at a depth, because it is two
    // scores and because what it looks for does not wait: see `tryNewGame`.
    else if (tryNewGame(det)) { /* a different game — now being tracked */ }
    // Backwards before forwards: scoring two positions we have already been in
    // is far cheaper than searching thousands we have not, and a board that
    // went back is invisible to every other rung however deep it looks.
    // One ply is your own move taken back; two is a takeback that undid the
    // reply as well. Each is a single position to score, so both are tried
    // before anything searches.
    //
    // Then sideways, which is the third direction and the only other one that is
    // cheap: one undo and a single ply of moves, about thirty positions against
    // the nine hundred a two-ply resync scores. It goes before the search both
    // for that and because the phantom it catches is invisible to the search —
    // see `tryReplace`.
    else if (due(RESYNC_AFTER)) {
      tryUndo(det, 1) || tryUndo(det, 2) || tryReplace(det) || tryResync(det, 2);
    }
    else if (due(RESYNC_AFTER * 4)) tryResync(det, 3);
    // Before tryRead, not after: reading a board we are holding upside down is
    // exactly how a rotated position got adopted as fact.
    else if (due(RESYNC_AFTER * 7)) tryFlip(det);
    else if (due(RESYNC_AFTER * 10)) tryRead(det);
    else if (due(RESYNC_AFTER * 13)) await tryRegion();
    else if (due(LOST_AFTER)) {
      log.event('lost', { fen: chess.fen(), wrong: diagnose(det), start: probeStart(det) });
      console.warn('\nLost track of the board, and re-syncing did not get it back — what is on');
      console.warn('screen matches neither the position I think we are in nor anything within');
      console.warn('three plies of it, either way round — and it is not a new game either.');
      console.warn('Grades from here are unreliable.');
      console.warn('Restart, or re-run `npm run calibrate` if the board theme has changed or');
      console.warn('the pieces are not the ones it learned.\n');
    }

    // One escalation per spell of blindness, re-armed when the board comes back.
    // Kept here with the rest of the blindness bookkeeping and deliberately not
    // above the ladder: written there it became the head of the ladder's own
    // if/else chain, which gated every rung on `blind !== 0` — on being unable to
    // read the board, the one state in which no rung can prove anything. The
    // session that found it lost sync at 23.7s and got its first recovery attempt
    // at 589.4s, when the game ended and a dialog finally covered the board.
    if (watcher.blind === 0) blindGaveUp = false;

    // Being unable to see the board is not the same as having lost it, and the
    // difference matters: this clears on its own, so it is worth saying once
    // rather than doing nothing visible while a dialog sits there.
    if (watcher.blind === BLIND_AFTER) {
      log.event('blind', { occluded: det.occluded });
      console.log('(something is covering the board — waiting for it to clear)');
    }

    /*
     * Waiting is right for a dialog and wrong for a region that is not a board.
     *
     * The occlusion path holds rather than counting itself lost, which is
     * correct — a promotion picker clears. But nothing ever gave up on it, and
     * "covered" and "there is no board here" are indistinguishable from the
     * inside: a blank surface still satisfies the *empty*-square hypothesis on
     * the 32 empty squares, so `occluded` pins at exactly 32, never approaches
     * 64, and never looks total. Measured on a real session: 122 seconds and 784
     * frames of a region holding a flat white surface — zero contrast between
     * the two square shades, which no chess board can have — with `blind`
     * reaching 744 against this budget of 40, not one `desync` event emitted, no
     * rung ever run, and `log-summary` afterwards reporting "Nothing went wrong
     * in this session."
     *
     * So a board still unreadable long after anything modal would have cleared
     * is treated as a region problem, which is a thing the ladder can actually
     * act on: re-measure it, and if that finds nothing, say so instead of
     * waiting out the rest of the session in silence.
     */
    if (watcher.blind >= BLIND_LOST && !blindGaveUp) {
      blindGaveUp = true;
      const secs = (watcher.blind * POLL_MS / 1000).toFixed(0);
      log.event('blind', { occluded: det.occluded, at: 'escalate', frames: watcher.blind });
      console.log(`\nthe board has been unreadable for about ${secs}s — longer than a dialog.`);
      if (!await tryRegion()) {
        console.log('Re-measuring the region found no grid either, so this is probably not');
        console.log('the board any more: it was closed, moved to another screen, or the');
        console.log('region was never right. `npm run calibrate` re-measures it.');
        console.log('(still watching, in case it comes back)');
      }
    }

    const elapsed = Date.now() - t0;
    if (elapsed < POLL_MS) await new Promise((r) => setTimeout(r, POLL_MS - elapsed));
  }

  await shutdown();
}

main().catch((e) => { console.error(e); process.exit(1); });
