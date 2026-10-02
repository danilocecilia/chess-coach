/**
 * One-time setup: learn this board's appearance.
 *
 *   node src/calibrate.js            drag a rectangle around the board
 *   node src/calibrate.js --auto     find the board on your screens instead
 *
 * Calibration works from the standard starting position, which means the piece
 * layout is known exactly and the templates are learned from ground truth. An
 * earlier design read the board with a vision model instead; benchmarking
 * showed that to be both slower and less reliable than simply knowing.
 *
 * The two entry points differ only in where the rectangle comes from — a drag
 * or a search (find-board.js) — and neither is trusted: the rectangle is a
 * hint, measureGrid measures the grid inside it, and the checks below decide
 * whether what was found is a chess board at all. That is what makes automatic
 * detection safe to offer; it is allowed to propose a wrong rectangle because
 * this file can already prove one wrong.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { Capture } from './capture.js';
import { BoardModel, CODES, chooseOrientation, fenToGrid, squareName } from './board.js';
import { measureGrid } from './grid.js';
import { findBoards } from './find-board.js';
import { ROOT, BOARD_CONFIG, TEMPLATE_DIR, CAPTURE_DIR } from './config.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const AUTO = process.argv.includes('--auto');

/**
 * `--flipped true|false`, the escape hatch for a board whose orientation the
 * evidence cannot settle. Absent means "work it out", which is the normal path.
 *
 * Read here rather than where it is used, next to `AUTO` and before anything
 * has been started: a typo is worth refusing over — silently reading `--flipped
 * ture` as `false` would bake the wrong side into the templates — and this is
 * the last point where refusing costs nothing to clean up.
 */
const FORCED_FLIP = (() => {
  const i = process.argv.indexOf('--flipped');
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (v === 'true') return true;
  if (v === 'false') return false;
  console.error(`--flipped takes "true" or "false", not ${v === undefined ? 'nothing' : `"${v}"`}.`);
  process.exit(1);
})();

const fmt = (n) => (n == null ? '?' : n.toFixed(1));
const side = (f) => (f == null ? 'no opinion' : f ? 'black at bottom' : 'white at bottom');

/** Must match main.js: calibration should hold the bar detection will hold. */
const MOVE_THRESHOLD = Number(process.env.COACH_MOVE_THRESHOLD ?? 6);

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** Error of each square under the position we know it is in. */
function perSquare(model, frame, fen) {
  const table = model.costTable(frame);
  const grid = fenToGrid(fen, model.flipped);
  const out = [];
  for (let idx = 0; idx < 64; idx++) out.push(table[idx * CODES.length + grid[idx]]);
  return out;
}

/** Run the drag-to-select overlay and return the chosen rectangle. */
function pickRegion() {
  return new Promise((resolve, reject) => {
    const script = path.join(ROOT, 'ps', 'pick-region.ps1');
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => {
      const line = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
      if (!line) return reject(new Error('region picker produced no result'));
      const o = JSON.parse(line);
      o.ok ? resolve(o) : reject(new Error(o.error));
    });
  });
}

/**
 * Search every monitor for the board and take the best fit.
 *
 * Runners-up are printed rather than silently discarded: two boards on screen
 * at once is the one case where a search can be confidently wrong, and the
 * cheapest response is to say so and let the drag settle it.
 */
async function autoRegion() {
  console.log('Set the board to the standard starting position, then leave it');
  console.log('fully visible — nothing overlapping it.\n');
  console.log('Looking for a board on your screens...');

  const { screens, candidates } = await findBoards();
  for (const s of screens) {
    console.log(`  scanned ${s.w}x${s.h} at (${s.x}, ${s.y})${s.primary ? '  (primary)' : ''}`);
  }

  if (!candidates.length) {
    throw new Error(
      'No 8x8 grid of alternating squares found on any monitor.\n'
      + 'The board may be partly covered, smaller than 160px, or on a screen\n'
      + 'this process cannot see. Run `npm run calibrate` and drag instead.',
    );
  }

  const [best, ...rest] = candidates;
  console.log(`\nfound:   ${best.w}x${best.h} at (${best.x}, ${best.y})`
    + `  on ${best.screen.name}  (shade separation ${best.score.toFixed(0)})`);
  for (const c of rest) {
    console.log(`  also:  ${c.w}x${c.h} at (${c.x}, ${c.y})`
      + `  (separation ${c.score.toFixed(0)})`);
  }
  if (rest.length) {
    console.log('More than one candidate. If the wrong one was taken, run');
    console.log('`npm run calibrate` and drag around the board you want.');
  }
  return { x: best.x, y: best.y, w: best.w, h: best.h };
}

async function main() {
  let picked;
  if (AUTO) {
    picked = await autoRegion();
  } else {
    console.log('Set the board to the standard starting position, then drag a');
    console.log('rectangle around just the 8x8 grid (no coordinates or borders).\n');
    picked = await pickRegion();
    console.log(`dragged: ${picked.w}x${picked.h} at (${picked.x}, ${picked.y})`);
  }

  const ratio = picked.w / picked.h;
  if (ratio < 0.8 || ratio > 1.25) {
    console.warn(`warning: that is not close to square (ratio ${ratio.toFixed(2)}).`);
    console.warn('A chess board is; check you dragged around the board and not a window.');
  }

  // The drag only has to be close. Measure where the grid actually is, so an
  // included border or a few pixels of slop do not shift every square.
  const found = await measureGrid(picked);
  let region = found.region;
  if (found.square) {
    const t = found.trim;
    console.log(`grid:    ${region.w}x${region.h} at (${region.x}, ${region.y})`
      + `  (trimmed ${t.left}/${t.top}/${t.right}/${t.bottom} l/t/r/b)`);
  } else {
    region = picked;
    console.warn(`warning: could not measure a square grid (${found.region.w}x${found.region.h});`);
    console.warn('using the dragged region as-is.');
  }

  const cap = await new Capture({ x: region.x, y: region.y, w: region.w, h: region.h }).start();
  try {
    // Give the UI a moment to settle after the overlay closes.
    await new Promise((r) => setTimeout(r, 400));
    const frame = await cap.grab();

    // Keep a full-resolution copy of what we just learned from, so a failure can
    // be looked at rather than guessed about.
    mkdirSync(CAPTURE_DIR, { recursive: true });
    const shot = await cap.snap(path.join(CAPTURE_DIR, 'calibration.png'));

    /*
     * Orientation is measured, not guessed at — but not by asking which way
     * round fits better, which is the one question that cannot answer it.
     *
     * `learn` fits its templates to whatever pixels sit under the grid it is
     * handed, so a model learned the wrong way round explains its own
     * calibration frame exactly as well as the right one. Not approximately:
     * measured on four real boards across two themes, `still` came out
     * bit-identical both ways. A tie every time meant the sort decided it, the
     * sort is stable, and `build(false)` was first — so this used to answer
     * "white at bottom" unconditionally, whatever was on the screen, while
     * printing a fit comparison that looked like evidence.
     *
     * The cost was a game graded for the wrong player, and it was invisible
     * from inside: the colour names live in the templates, so every later check
     * is made of the same mistake and agrees with it.
     *
     * `chooseOrientation` asks two questions that are not made of the
     * templates' labelling — how the men are inked, and which end of the board
     * is brighter — and declines to answer when they disagree. See src/board.js.
     */
    const trial = new BoardModel({ flipped: false }).learn(frame, START);
    const choice = chooseOrientation(trial, frame);
    const ink = choice.ink, lit = choice.brightness;

    console.log('orientation:');
    console.log(`  ink       white ${fmt(ink.white)} vs black ${fmt(ink.black)}`
      + `  (apart by ${fmt(ink.separation)}, needs ${fmt(choice.bar)})`
      + `  -> ${side(choice.byInk)}`);
    console.log(`  brightness far ${fmt(lit.top)} vs near ${fmt(lit.bottom)}`
      + `  -> ${side(lit.flipped)}`);

    const forced = FORCED_FLIP;
    if (forced != null) {
      console.log(`  overridden by --flipped ${forced}`);
    } else if (choice.flipped == null) {
      /*
       * Refusing beats guessing. Getting this wrong does not degrade the
       * grading, it inverts it — every move of the game is attributed to the
       * wrong player — and unlike a bad region or a stale theme it produces no
       * symptom the session can see. So the one case where the evidence is not
       * clear is the one case a human has to settle.
       */
      console.error('\nCannot tell which way round this board is.');
      if (!choice.decisive) {
        console.error(`The two sides are drawn too similarly (${fmt(ink.separation)} apart,`
          + ` needs ${fmt(choice.bar)}) to say which one is White.`);
      } else {
        console.error(`The men say ${side(choice.byInk)} and the brightness says`
          + ` ${side(lit.flipped)}, and they cannot both be right.`);
      }
      console.error('\nCheck the board is in the opening position and the region is the 8x8');
      console.error('grid alone, then calibrate again. If it is already both, say which it is:');
      console.error('  npm run calibrate -- --flipped true     (you are Black, black at bottom)');
      console.error('  npm run calibrate -- --flipped false    (you are White, white at bottom)');
      // Not `process.exit`: the capture daemon is shut down in the `finally`
      // below, and exiting here would step over it and leave it running.
      process.exitCode = 1;
      return;
    }

    const flipped = forced ?? choice.flipped;
    console.log(`  ${flipped ? 'black at bottom (flipped) — you are Black'
      : 'white at bottom — you are White'}`);

    // Re-learned rather than mirrored: `bare` is indexed by image square and
    // the shade of each is taken through `flipped`, so the chosen orientation
    // has to be the one the templates were built under.
    const model = flipped === trial.flipped
      ? trial : new BoardModel({ flipped }).learn(frame, START);
    model.orientation = {
      decidedBy: forced != null ? 'override' : 'ink+brightness',
      ink: { white: ink.white, black: ink.black, separation: ink.separation, bar: choice.bar },
      brightness: { top: lit.top, bottom: lit.bottom, flipped: lit.flipped },
      agree: choice.agree,
    };

    /*
     * Sanity check.
     *
     * What matters most is the same thing main.js keys on: the start position
     * must explain the frame better than any legal successor does.
     *
     * The absolute floor is worth looking at too, though for a long time this
     * comment argued the opposite — that a floor in the hundreds was simply the
     * within-class variance of a real board (anti-aliasing, fractional square
     * edges, shadows) and said nothing. That was wrong, and it talked us out of
     * the one number that was shouting. The floor was ~336 because the
     * appearance model was wrong, not because real boards are noisy; with the
     * model fixed the same board sits near 7. So the floor is checked against
     * the board's own contrast now: a template set that genuinely describes the
     * board fits it to a few percent of that, whatever the theme.
     */
    const check = model.detectMove(frame, new Chess(START));
    const margin = check.score - check.still;

    const contrast = Math.abs(mean(model.empty.light) - mean(model.empty.dark));
    console.log(`\nsquare contrast: ${contrast.toFixed(1)} (light vs dark)`);
    console.log(`noise floor: ${check.still.toFixed(1)}`
      + `  best rival: ${check.score.toFixed(1)} (${check.uci})`
      + `  margin: ${margin.toFixed(1)}`);
    console.log(`captured frame: ${shot}`);

    if (contrast < 10) {
      console.error('\nThe two square shades look identical, so this region is not a chess board.');
      console.error(`Open ${shot} to see what was actually captured.`);
      process.exitCode = 1;
      return;
    }
    if (margin <= 0) {
      console.error('\nA legal move explains this frame better than the start position does.');
      console.error(`Either the board is not in the starting position, or the region is not the`);
      console.error(`8x8 grid. Open ${shot} to check — it should be the grid alone, no border`);
      console.error('and no coordinates.');
      if (AUTO) {
        console.error('The search found something board-shaped that is not your board;');
        console.error('run `npm run calibrate` and drag around it instead.');
      }
      process.exitCode = 1;
      return;
    }
    // A floor far above this means the templates do not describe the board,
    // which no amount of re-dragging will fix. Worth separating from a region
    // problem, because the two need opposite responses and the symptom — moves
    // never detected — is identical.
    const fitLimit = (contrast * 0.1) ** 2;
    if (check.still > fitLimit) {
      console.warn(`\nwarning: the templates fit this board poorly (${check.still.toFixed(1)},`
        + ` expected under ${fitLimit.toFixed(0)}).`);
      console.warn('The region looks measurable but the piece appearance model is not matching.');
      console.warn('Re-dragging will not help; this is a bug worth reporting.');
    } else if (margin < MOVE_THRESHOLD) {
      console.warn(`\nwarning: margin ${margin.toFixed(1)} is below the detection threshold of`
        + ` ${MOVE_THRESHOLD}, so real moves may be missed.`);
      console.warn(`The fit itself is good, so check ${shot} for a region that is off by a`);
      console.warn('square or two, or lower COACH_MOVE_THRESHOLD.');
    }

    // `floor` is what a correct reading of this board costs. main.js refuses any
    // hypothesis far above it, which is how a piece caught mid-slide — fitting
    // nothing well — is told apart from a move that has actually landed.
    // `allow` is watch.js's flat headroom for squares the board repaints on its
    // own — the last move's two highlights, a check glow, a coach badge. Priced
    // as three squares shifting by half this board's contrast, so it scales with
    // the theme instead of being a grey-level constant that suits one skin.
    const allow = Math.round(3 * (contrast / 2) ** 2 / 64);

    /*
     * `squareLimit` is the other half: the error at which one square stops
     * being noisy and starts being *wrong*. That distinction is what lets a
     * desync be caught the moment it happens instead of four plies later, and
     * the gap it sits in is wide — on the board this was developed against, the
     * worst correctly-read square cost 111 and the cheapest wrongly-read one
     * cost 277.
     *
     * Measured from this board rather than assumed, because the gap is what
     * matters and both ends of it move with the theme: take the worst square of
     * a known-correct reading and leave most of a doubling of headroom above it.
     * The contrast term is only a floor under that, for a board so clean that
     * its worst square says nothing useful.
     */
    const costs = perSquare(model, frame, START);
    const worst = Math.max(...costs);
    const squareLimit = Math.round(Math.max(worst * 1.8, (contrast * 0.12) ** 2));
    console.log(`worst square: ${worst.toFixed(0)}  ->  wrong-square limit ${squareLimit}`);

    /*
     * Is this board clean enough to learn from?
     *
     * Everything above asks whether the *region* is right. This asks whether
     * anything is sitting on the board that will not be there later — a stale
     * last-move highlight being the one that actually happened — because
     * calibration cannot tell a decoration from the board itself. It measures
     * both, learns both, and then every limit it derives is quietly wrong.
     *
     * Two halves, because a decoration lands on two kinds of square and only
     * one of them is visible to a fit:
     *
     *   an occupied square    the piece no longer matches its own template, so
     *                         it shows up as an outlier in `costs` — and drags
     *                         squareLimit up with it, blinding the desync test
     *   an empty square       its background is learned *with* the decoration
     *                         in it, fits perfectly here, and then misfits by
     *                         thousands forever once the decoration clears
     *
     * Warned rather than refused: a theme this has not seen may legitimately
     * paint something into one square, and the cost of being wrong here is one
     * glance at the capture. The cost of staying silent was measured at two
     * sessions and twenty-one minutes with nothing graded.
     */
    /*
     * The median of the *occupied* squares, not of all 64.
     *
     * `[...costs].sort()[32]` was the intent and not the effect: backgrounds are
     * learned per square, so all 32 empty squares fit themselves at a cost of
     * exactly 0, and the 32nd of 64 sorted costs is therefore 0.00 on every
     * calibration ever written. That made `median * 8` zero, the whole
     * comparison collapse to the contrast term, and the test fire on four of
     * seven good calibrations while still naming nothing useful. The occupied
     * median is the number the message claims to print — 9 to 10 on a clean
     * board here, against a `worst` of 1508 on the one that was decorated.
     */
    const grid = fenToGrid(START, flipped);
    const held = costs.filter((_, i) => grid[i] !== 0).sort((a, b) => a - b);
    const median = held[held.length >> 1];
    const suspect = worst > Math.max(median * 8, (contrast * 0.12) ** 2)
      ? squareName(costs.indexOf(worst), flipped) : null;
    const odd = model.oddBackgrounds();

    if (suspect || odd.length) {
      console.warn('\nwarning: something on this board is not part of the board.');
      if (suspect) {
        console.warn(`  ${suspect} costs ${worst.toFixed(0)} where a typical square costs`
          + ` ${median.toFixed(0)} — that square does not look like the piece standing on it.`);
      }
      for (const o of odd) {
        console.warn(`  ${o.sq} is ${o.delta > 0 ? 'brighter' : 'darker'} than every other`
          + ` ${o.shade} square by ${Math.abs(o.delta).toFixed(0)} levels`
          + ` (${o.mean} against ${o.expected}).`);
      }
      console.warn('  A last-move highlight left over from the previous game is the usual');
      console.warn(`  cause. Open ${shot}: if any square is tinted, start a fresh game so the`);
      console.warn('  board is clean, and calibrate again.');
      console.warn('  Calibrating on a tinted square is not cosmetic — the tint is learned as');
      console.warn('  the square, and once it clears no move can ever explain the board again.');
    }

    /*
     * The last question, and the only one that is refused outright: can this
     * calibration see a move at all? See {@link BoardModel#blindMoves}. Every
     * warning above describes a board that is probably wrong; this one describes
     * a board that provably cannot work, so nothing is written and the session
     * cannot be started on it.
     *
     * Refused rather than repaired. Clamping `squareLimit` to a sane value
     * recovers nineteen of the twenty moves on the board that found this and
     * leaves the twentieth — the one whose destination square had the highlight
     * on it — invisible at every limit. A repair would call that board fixed and
     * still lose the game to 1.d4.
     */
    const blind = model.blindMoves(frame, START, squareLimit);
    if (blind.length) {
      console.error(`\nThis calibration cannot see ${blind.length} of the 20 opening moves.`);
      console.error(`  ${blind.slice(0, 8).join(' ')}${blind.length > 8 ? ' …' : ''}`);
      console.error('Each of those would leave no square wrong, so playing it would look');
      console.error('exactly like standing still and would never be detected.');
      if (suspect) {
        console.error(`\nThe cause is above: ${suspect} costs ${worst.toFixed(0)} against a typical`
          + ` ${median.toFixed(0)}, which set the wrong-square limit to ${squareLimit}.`);
      }
      console.error(`\nOpen ${shot}. A last-move highlight from the previous game is the usual`);
      console.error('cause — start a fresh game so the board is clean, then calibrate again.');
      console.error('Nothing was written; your previous calibration is untouched.');
      process.exitCode = 1;
      return;
    }

    writeFileSync(BOARD_CONFIG, JSON.stringify({
      region, flipped, floor: Number(check.still.toFixed(1)), allow, squareLimit,
    }, null, 2));
    writeFileSync(path.join(TEMPLATE_DIR, 'model.json'), JSON.stringify(model.toJSON()));
    console.log(`\nsaved ${BOARD_CONFIG}`);
    console.log(`saved ${path.join(TEMPLATE_DIR, 'model.json')}`);
    console.log('\nCalibrated. Run `npm start` to begin coaching.');
  } finally {
    await cap.quit();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
