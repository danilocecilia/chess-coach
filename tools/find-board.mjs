/**
 * Dev tool: look for the board on every monitor and report, changing nothing.
 *   node tools/find-board.mjs
 *
 * Answers "can it see my board without being told where it is?" before you let
 * it calibrate from that answer. Prints every candidate with its shade
 * separation — the margin by which the lightest dark square still lost to the
 * darkest light one — and saves a PNG of the winning rectangle, which is the
 * fastest way to tell "found the wrong thing" from "found nothing".
 *
 * Writes no config. `npm run calibrate:auto` is the same search, followed by
 * the real calibration.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { findBoards } from '../src/find-board.js';
import { Capture } from '../src/capture.js';
import { CAPTURE_DIR } from '../src/config.js';

const t0 = Date.now();
const { screens, candidates } = await findBoards();
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`${screens.length} monitor${screens.length === 1 ? '' : 's'}, scanned in ${secs}s:`);
for (const s of screens) {
  console.log(`  ${s.name}  ${s.w}x${s.h} at (${s.x}, ${s.y})${s.primary ? '  (primary)' : ''}`);
}

if (!candidates.length) {
  console.log('\nNo board found.');
  console.log('It looks for 8x8 cells of equal pitch whose shades alternate, on the');
  console.log('empty middle ranks — so put the board in the starting position, leave');
  console.log('it unobstructed, and make sure it is at least 160px across.');
  process.exit(1);
}

console.log('\ncandidates, best first:');
for (const c of candidates) {
  console.log(`  ${String(c.w).padStart(5)}x${String(c.h).padEnd(5)} at `
    + `(${c.x}, ${c.y})  separation ${c.score.toFixed(1)}  on ${c.screen.name}`);
}

const best = candidates[0];
mkdirSync(CAPTURE_DIR, { recursive: true });
const cap = await new Capture({ x: best.x, y: best.y, w: best.w, h: best.h }).start();
try {
  const shot = await cap.snap(path.join(CAPTURE_DIR, 'found-board.png'));
  console.log(`\nsaved ${shot}`);
  console.log('That rectangle is padded outwards on purpose — calibration trims it');
  console.log('onto the grid. It is right if the board is inside it with a little slop.');
} finally {
  await cap.quit();
}
