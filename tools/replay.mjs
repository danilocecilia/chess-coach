/**
 * Re-run recognition over a recorded session.
 *   node tools/replay.mjs                          the newest session, frames in trouble
 *   node tools/replay.mjs logs/<id> --from 900 --to 960
 *   node tools/replay.mjs logs/<id> --board 912    what the screen actually showed
 *   COACH_MOVE_THRESHOLD=3 node tools/replay.mjs logs/<id> --from 900
 *
 * The session log keeps every frame's pixels, so the decision can be taken
 * again off-screen: same model, same position, same frame, and this time the
 * whole ranking is printed instead of a boolean. Thresholds are read from the
 * environment as usual, which makes this the place to find out whether a
 * different one would have caught the move — without playing another game.
 *
 * `--board` is the one that ends most arguments: it draws what we believed
 * beside what each square actually looks like, and a board that has been reset
 * to the opening position, turned round, or moved is obvious at a glance.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync, constants } from 'node:zlib';
import path from 'node:path';
import { Chess } from 'chess.js';
import { BoardModel, CODES, decorated, gridOf, squareName } from '../src/board.js';
import { readFrames, fileHash } from '../src/log.js';
import { LOG_DIR, TEMPLATE_DIR } from '../src/config.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? dflt : Number(argv[i + 1]);
};
const dir = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? newest();

function newest() {
  if (!existsSync(LOG_DIR)) return null;
  const runs = readdirSync(LOG_DIR)
    .filter((d) => existsSync(path.join(LOG_DIR, d, 'session.jsonl'))).sort();
  return runs.length ? path.join(LOG_DIR, runs[runs.length - 1]) : null;
}

if (!dir) {
  console.error('No session logs found. Run `npm start` first, or pass a directory.');
  process.exit(1);
}

const events = readFileSync(path.join(dir, 'session.jsonl'), 'utf8').split('\n')
  .flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
const start = events.find((e) => e.ev === 'start');

/*
 * A hard kill leaves the gzip stream unterminated. Z_SYNC_FLUSH says to return
 * what did make it to disk rather than throwing — and the frames just before a
 * kill are usually the interesting ones.
 */
const gz = readFileSync(path.join(dir, 'frames.bin.gz'));
const frames = readFrames(gunzipSync(gz, { finishFlush: constants.Z_SYNC_FLUSH }));

const modelFile = path.join(TEMPLATE_DIR, 'model.json');
const model = BoardModel.fromJSON(JSON.parse(readFileSync(modelFile, 'utf8')));
const hash = fileHash(modelFile);
if (start?.model && hash !== start.model) {
  console.warn(`! templates have been re-calibrated since this session`
    + ` (${start.model} -> ${hash}).`);
  console.warn('! the numbers below are this model on those pixels, not what ran.\n');
}
const squareLimit = start?.limits?.squareLimit
  ?? (model.contrast * 0.15) ** 2;
// Sessions recorded before the bound existed get Infinity, which is the
// behaviour they actually ran with — a replay must not judge an old frame by a
// rule that was not in force when it went past.
const softLimit = start?.limits?.softLimit ?? Infinity;

const board = flag('board', null);
const byFrame = new Map(events.filter((e) => e.ev === 'frame').map((e) => [e.seq, e]));

/** Which frames to look at: what you asked for, else wherever it went wrong. */
let want;
if (board != null) want = [board];
else {
  const from = flag('from', null), to = flag('to', null);
  if (from != null) want = [...byFrame.keys()].filter((s) => s >= from && s <= (to ?? from + 20));
  else want = [...byFrame.values()].filter((f) => (f.w?.lost ?? 0) > 0).map((f) => f.seq).slice(0, 40);
}
if (!want.length) {
  console.log('Nothing to replay: no lost frames in this session. Pass --from <seq>.');
  process.exit(0);
}

console.log(`${path.basename(dir)}  ${frames.size} frames recorded`
  + `   squareLimit ${Math.round(squareLimit)}\n`);

for (const seq of want) {
  const rec = byFrame.get(seq);
  const bytes = frames.get(seq);
  if (!rec || !bytes) { console.log(`#${seq}: not in the log`); continue; }

  // The position as it was when this frame was judged, straight off the log —
  // no re-derivation, so a replay cannot drift the way the session did. The
  // last move comes with it, because the squares the board is expected to be
  // decorating are derived from it; judging a frame without it counts the
  // move's own highlight as a fault. Logs written before it was recorded get
  // `null` and the slightly harsher reading that implies.
  const chess = new Chess(rec.fen);
  const last = rec.last ? { from: rec.last.slice(0, 2), to: rec.last.slice(2, 4) } : null;
  const excuse = decorated(chess, last, model.flipped);
  const det = model.detectMove(bytes, chess, { squareLimit, softLimit, excuse });

  console.log(`#${seq}  ${(rec.t / 1000).toFixed(1)}s  ${rec.settled ? 'settled' : `moving (${rec.diff})`}`
    + `  lost ${rec.w.lost}  blind ${rec.w.blind}  occluded ${det.occluded}`);
  console.log(`  believed  ${rec.fen}`);
  console.log(`  still ${det.still.toFixed(1)} (${det.stillMisfits} sq wrong)`
    + `   lead ${Number.isFinite(det.margin) ? det.margin.toFixed(1) : 'inf'}`);
  for (const [i, c] of det.top.entries()) {
    console.log(`   ${i === 0 ? '>' : ' '} ${c.san.padEnd(8)} ${c.uci.padEnd(6)}`
      + ` score ${c.score.toFixed(1).padStart(8)}  ${c.misfits} sq wrong`
      + `  beats still by ${(det.still - c.score).toFixed(1)}`);
  }

  const wrong = model.diagnose(det.table, gridOf(chess, model.flipped), squareLimit, {
    skip: det.mask, soft: excuse, tint: det.tint, softLimit,
  });
  if (wrong.length) {
    console.log(`  squares refuting it: ${wrong.map((w) =>
      `${w.sq} want ${w.want} (${w.wantCost}) looks like ${w.best} (${w.bestCost})`
      // A square whose tinted reading names the right piece and is still refused
      // was refused for being displaced — a piece held over it, not on it.
      + (w.tint === w.want && w.tintCost != null ? ` [tint ${w.tintCost} > ${Math.round(softLimit)}]` : '')
      + `${w.occluded ? ' [covered]' : ''}${w.soft ? ' [decorated]' : ''}`).join('\n                      ')}`);
  }

  if (board != null) drawBoards(det, chess);
  console.log('');
}

/**
 * Two boards side by side: the one we thought we were in, and the one the
 * pixels describe square by square.
 *
 * The right-hand side is the per-square reader — the thing the design avoids
 * as a *primary* source because one bad square invents a position. Here that
 * objection does not apply: nothing is being decided, it is being shown.
 */
function drawBoards(det, chess) {
  const believed = gridOf(chess, model.flipped);
  const letter = (code) => (code === '.' ? '.' : code[0] === 'w' ? code[1].toUpperCase() : code[1]);

  console.log('\n     believed            on screen         (as seen, top of screen first)');
  for (let r = 0; r < 8; r++) {
    let a = '', b = '';
    for (let c = 0; c < 8; c++) {
      const idx = r * 8 + c;
      a += ` ${letter(CODES[believed[idx]])}`;
      const seen = det.mask[idx] ? '?' : letter(CODES[det.tint(idx)]);
      // Upper case marks disagreement in the eye, not in the piece colour.
      b += ` ${seen}`;
    }
    console.log(`   ${a}     ${b}    ${squareName(r * 8, model.flipped)[1]}`);
  }
  console.log('     (? = covered by something that is not a chess square)');
}
