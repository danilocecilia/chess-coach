/**
 * Is the saved calibration one worth playing on?
 *   node tools/check-calibration.mjs
 *
 * Reads templates/model.json and board.json and says whether they were learned
 * from a clean board. Needs no screen and changes nothing, so it is safe to run
 * before a session — and it is the fastest way to know whether a re-calibration
 * actually came out better than the one it replaced.
 *
 * What it is looking for is a decoration that was learned as part of the board.
 * Calibration cannot tell one from the other: it measures what is on the square
 * and stores it. A last-move highlight left over from the previous game is
 * learned as the square's own appearance, fits perfectly for as long as it is
 * there, and then misfits by thousands the moment it clears — under every
 * hypothesis at once, which is what makes it fatal rather than merely noisy.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BoardModel, CODES, fenToGrid, LEARNED_FROM } from '../src/board.js';
import { SQ_BYTES } from '../src/capture.js';
import { BOARD_CONFIG, TEMPLATE_DIR } from '../src/config.js';

const modelFile = path.join(TEMPLATE_DIR, 'model.json');
if (!existsSync(BOARD_CONFIG) || !existsSync(modelFile)) {
  console.error('Not calibrated yet. Run:  npm run calibrate');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(BOARD_CONFIG, 'utf8'));
const model = BoardModel.fromJSON(JSON.parse(readFileSync(modelFile, 'utf8')));

const startGrid = fenToGrid(LEARNED_FROM, model.flipped);
const contrastLimit = Math.round((model.contrast * 0.12) ** 2);
console.log(`board  ${cfg.region.w}x${cfg.region.h} at (${cfg.region.x}, ${cfg.region.y})`
  + `   ${cfg.flipped ? 'black' : 'white'} at bottom   contrast ${model.contrast.toFixed(1)}`);
console.log(`limits floor ${cfg.floor}   allow ${cfg.allow}   squareLimit ${cfg.squareLimit}`
  + `   (a clean board of this contrast gives about ${contrastLimit})`);

const problems = [];

/*
 * squareLimit is set from the worst square of a known-correct reading, so a
 * value far above what this board's contrast alone implies means one square
 * was much worse than the rest — and calibration took that square's trouble as
 * this board's normal noise. Every later wrong square is then measured against
 * a limit sized by a decoration.
 */
/*
 * The ratio at which this becomes worth saying is much higher than it looks,
 * and the first version of this check was set inside the good population. On
 * eleven real calibrations the ratio read 1.46-5.45 on the seven that worked —
 * including 5.28 and 5.45 on the two boards that graded 29- and 26-move games —
 * and 21.82 on the one that was genuinely blinded by a decoration. At 4x it
 * therefore flagged the cleanest session in the corpus and would have talked
 * someone into re-calibrating a board that was working, which is the one way a
 * check like this can do harm. The safe interval is (5.45, 21.82]; 10 sits
 * near its geometric centre.
 *
 * It is kept as a hint rather than a verdict because the ratio does not decide
 * anything on its own — the blind-move sweep below does, and it needs no
 * threshold at all.
 */
if (cfg.squareLimit > contrastLimit * 10) {
  problems.push(`squareLimit is ${(cfg.squareLimit / contrastLimit).toFixed(1)}x what this board's`
    + ` contrast implies (${cfg.squareLimit} against ${contrastLimit}).`
    + `\n    One square was far worse than the others when this was learned, and that`
    + `\n    square set the limit. A desync has to be this bad before anything notices.`);
}

/*
 * Can this calibration see a move at all?
 *
 * The same question `npm run calibrate` now refuses on, asked without a screen.
 * There is no frame here, so one is built from the templates: the appearance
 * they predict for the start position *is* a perfect reading of it, and the cost
 * of a move against that frame is exactly the template distance between the two
 * positions. That is the quantity squareLimit has to sit below, so this tests
 * the limit against the piece set it was derived from — which is the half of the
 * failure a tool with no screen can still prove.
 *
 * A board that passes here can still be wrong in a way only a real frame shows;
 * a board that fails here cannot work at all.
 */
const synthetic = new Uint8Array(64 * SQ_BYTES);
for (let idx = 0; idx < 64; idx++) {
  const exp = model.predict(CODES[startGrid[idx]], idx);
  for (let i = 0; i < SQ_BYTES; i++) {
    synthetic[idx * SQ_BYTES + i] = Math.max(0, Math.min(255, Math.round(exp[i])));
  }
}
const blind = model.blindMoves(synthetic, LEARNED_FROM, cfg.squareLimit);
if (blind.length) {
  problems.push(`${blind.length} of the 20 opening moves would leave no square wrong:`
    + `\n    ${blind.slice(0, 8).join(' ')}${blind.length > 8 ? ' …' : ''}`
    + `\n    Playing one of those would look exactly like standing still, so it could`
    + `\n    never be detected. This calibration cannot be played on — re-run`
    + `\n    \`npm run calibrate\` on a board with no last-move highlight on it.`);
}

const fitLimit = (model.contrast * 0.1) ** 2;
if (cfg.floor != null && cfg.floor > fitLimit) {
  problems.push(`the noise floor is ${cfg.floor}, above the ${fitLimit.toFixed(0)} this board's`
    + ` contrast implies.\n    The templates do not describe this board as well as they should.`);
}

const odd = model.oddBackgrounds();
for (const o of odd) {
  problems.push(`${o.sq} was learned ${Math.abs(o.delta).toFixed(0)} levels`
    + ` ${o.delta > 0 ? 'brighter' : 'darker'} than every other ${o.shade} square`
    + ` (${o.mean} against ${o.expected}).`
    + `\n    That is a decoration learned as the square itself. Once it clears, ${o.sq}`
    + `\n    misfits under every hypothesis and no move can be accepted at all.`);
}

/*
 * Orientation is not a fault, so it is reported rather than counted as a
 * problem — but it is reported every time, because "looks clean" reads as
 * "ready to play" and this is the one way a clean calibration can still be the
 * wrong one for the next game.
 */
const side = model.flipped ? 'Black' : 'White';
const bottom = model.flipped ? 'black' : 'white';

console.log('');
if (!problems.length) {
  console.log('This calibration looks clean.');
} else {
  console.log(`${problems.length} problem${problems.length > 1 ? 's' : ''}:\n`);
  for (const p of problems) console.log(`  - ${p}\n`);
  console.log('Fix: start a fresh game so the board is in the opening position with no');
  console.log('highlight on any square — not a rematch that still shows the last move —');
  console.log('then run `npm run calibrate` and check captures/calibration.png.');
  process.exitCode = 1;
}

console.log(`\nIt is for a board with ${bottom} at the bottom, so it expects you to be ${side}.`);
console.log(`If your next game has you as ${side === 'White' ? 'Black' : 'White'}, the board is`
  + ' turned round from this one: the templates');
console.log('survive a rotation, so the coach works it out and says so, but it spends a few');
console.log('seconds lost first and those moves go ungraded. Calibrating from the side you');
console.log('will actually play avoids that.');
