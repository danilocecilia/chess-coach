/**
 * Dev tool: watch recognition only — no engine, no coach, no overlay.
 *   node tools/probe.mjs
 *
 * Answers "is it seeing my board?" directly, by printing the numbers detection
 * actually keys on for every frame:
 *
 *   still    error if nothing has changed since the last accepted move
 *   best     error of the best legal-move hypothesis, and which move that is
 *   margin   still - best; a move is accepted once this clears the threshold
 *
 * Sitting on a still board, margin should hover well below the threshold. Make a
 * move and it should jump, the named move should be the one you played, and the
 * position should follow along. If margin never clears the threshold on a real
 * move, lower COACH_MOVE_THRESHOLD; if it clears on a still board, raise it.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { Capture } from '../src/capture.js';
import { BoardModel } from '../src/board.js';
import { BOARD_CONFIG, TEMPLATE_DIR } from '../src/config.js';

const THRESHOLD = Number(process.env.COACH_MOVE_THRESHOLD ?? 6);
const STABLE_FRAMES = 2;

if (!existsSync(BOARD_CONFIG)) {
  console.error('Not calibrated yet. Run:  npm run calibrate');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(BOARD_CONFIG, 'utf8'));
const model = BoardModel.fromJSON(
  JSON.parse(readFileSync(path.join(TEMPLATE_DIR, 'model.json'), 'utf8')),
);

const chess = new Chess(process.argv[2] ?? undefined);
const cap = await new Capture(cfg.region).start();

console.log(`region ${cfg.region.w}x${cfg.region.h} at (${cfg.region.x}, ${cfg.region.y})`
  + `  ${cfg.flipped ? 'black' : 'white'} at bottom  threshold ${THRESHOLD}`);
console.log('Play a move. Ctrl+C to stop.\n');

process.on('SIGINT', async () => { await cap.quit(); process.exit(0); });

let pending = null, count = 0;
for (;;) {
  const det = model.detectMove(await cap.grab(), chess);
  const margin = det.still - det.score;

  // `lead` is the distance to the runner-up hypothesis. It is the number that
  // separates a real move from a board caught mid-repaint: a settled move leads
  // by tens, a transient by almost nothing. Watch it while a blunder badge or a
  // move highlight animates, and set COACH_MOVE_CONFIDENCE under the smallest
  // lead you see on a move you actually played.
  const lead = det.margin;
  const bar = margin > THRESHOLD ? '**' : '  ';
  process.stdout.write(`\r${bar} still ${det.still.toFixed(1).padStart(8)}`
    + `  best ${det.score.toFixed(1).padStart(8)} ${(det.uci ?? '----').padEnd(6)}`
    + `  margin ${margin.toFixed(1).padStart(8)}`
    + `  lead ${(Number.isFinite(lead) ? lead.toFixed(1) : 'inf').padStart(8)}   `);

  if (margin > THRESHOLD && det.uci) {
    count = det.uci === pending ? count + 1 : 1;
    pending = det.uci;
    if (count >= STABLE_FRAMES) {
      const san = det.move.san;
      chess.move(det.move);
      console.log(`\n-> ${san}   ${chess.fen()}`);
      pending = null; count = 0;
    }
  } else {
    pending = null; count = 0;
  }

  await new Promise((r) => setTimeout(r, 150));
}
