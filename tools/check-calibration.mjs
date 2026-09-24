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
import { BoardModel } from '../src/board.js';
import { BOARD_CONFIG, TEMPLATE_DIR } from '../src/config.js';

const modelFile = path.join(TEMPLATE_DIR, 'model.json');
if (!existsSync(BOARD_CONFIG) || !existsSync(modelFile)) {
  console.error('Not calibrated yet. Run:  npm run calibrate');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(BOARD_CONFIG, 'utf8'));
const model = BoardModel.fromJSON(JSON.parse(readFileSync(modelFile, 'utf8')));

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
if (cfg.squareLimit > contrastLimit * 4) {
  problems.push(`squareLimit is ${(cfg.squareLimit / contrastLimit).toFixed(1)}x what this board's`
    + ` contrast implies (${cfg.squareLimit} against ${contrastLimit}).`
    + `\n    One square was far worse than the others when this was learned, and that`
    + `\n    square set the limit. A desync has to be this bad before anything notices.`);
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
