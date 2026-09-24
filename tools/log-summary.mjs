/**
 * What happened in a session, on one screen.
 *   node tools/log-summary.mjs                 the newest session
 *   node tools/log-summary.mjs logs/<id>       a particular one
 *
 * The first thing to run after a session that went wrong. It reads
 * session.jsonl and prints the timeline that matters: the moves, every episode
 * of lost sync with the frames it spans, every recovery attempt and why it was
 * refused — and then names the cause where the log is unambiguous about it.
 *
 * It only reads. tools/replay.mjs is where the pixels get reprocessed.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from '../src/config.js';

/** Runs are named by timestamp, so the newest is the last in sort order. */
function newest() {
  if (!existsSync(LOG_DIR)) return null;
  const runs = readdirSync(LOG_DIR)
    .filter((d) => existsSync(path.join(LOG_DIR, d, 'session.jsonl'))).sort();
  return runs.length ? path.join(LOG_DIR, runs[runs.length - 1]) : null;
}

const dir = process.argv[2] ?? newest();
if (!dir) {
  console.error('No session logs found. Run `npm start` first, or pass a directory.');
  process.exit(1);
}

const lines = readFileSync(path.join(dir, 'session.jsonl'), 'utf8').split('\n');
const events = [];
for (const l of lines) {
  if (!l.trim()) continue;
  // A session killed mid-write leaves one half-line at the end; that is not a
  // reason to refuse to read the 40 minutes in front of it.
  try { events.push(JSON.parse(l)); } catch { /* truncated tail */ }
}

const secs = (t) => `${(t / 1000).toFixed(1)}s`;
const frames = events.filter((e) => e.ev === 'frame');
const start = events.find((e) => e.ev === 'start');
const end = events.find((e) => e.ev === 'end');

console.log(`session ${path.basename(dir)}`);
if (start) {
  console.log(`  ${start.region.w}x${start.region.h} at (${start.region.x}, ${start.region.y})`
    + `   you are ${start.playerColor === 'w' ? 'White' : 'Black'}`
    + `   ${start.flipped ? 'black' : 'white'} at bottom`);
  console.log(`  squareLimit ${Math.round(start.limits.squareLimit)}`
    + `  threshold ${start.limits.threshold}  confidence ${start.limits.confidence}`
    + `  floor ${start.limits.floor ?? '—'}  allow ${start.limits.allow}`);
}
if (frames.length) {
  const span = frames[frames.length - 1].t - frames[0].t;
  const ms = frames.reduce((a, f) => a + (f.ms?.grab ?? 0) + (f.ms?.detect ?? 0), 0) / frames.length;
  console.log(`  ${frames.length} frames over ${secs(span)}`
    + `  (${(frames.length / (span / 1000)).toFixed(1)}/s, ${ms.toFixed(0)}ms of work per frame)`);
}
if (end) console.log(`  ended after ${end.moves} plies at ${end.fen}`);

/*
 * Episodes of lost sync, taken off the frame stream rather than the warnings:
 * `lost` counts settled frames that nothing explains, so it rising off zero is
 * the true start of the trouble — long before anything was printed about it.
 */
const episodes = [];
let open = null;
for (const f of frames) {
  const lost = f.w?.lost ?? 0;
  if (lost > 0 && !open) open = { from: f.seq, t: f.t, fen: f.fen, peak: lost };
  else if (lost > 0 && open) open.peak = Math.max(open.peak, lost);
  else if (lost === 0 && open) { episodes.push({ ...open, to: f.seq, until: f.t }); open = null; }
}
if (open) episodes.push({ ...open, to: frames[frames.length - 1]?.seq, until: frames[frames.length - 1]?.t, openEnded: true });

console.log('\ntimeline');
const interesting = events.filter((e) => e.ev !== 'frame');
for (const e of interesting) {
  const at = `  ${secs(e.t).padStart(8)}  #${String(e.seq).padStart(5)}  `;
  switch (e.ev) {
    case 'apply':
      console.log(`${at}${e.tag.padEnd(5)} ${e.san.padEnd(8)}${e.recovered ? ' (by recovery)' : ''}`);
      break;
    case 'grade':
      console.log(`${at}      ${e.san.padEnd(8)} ${e.label} (-${e.drop.toFixed(1)}%)`);
      break;
    case 'desync':
      console.log(`${at}LOST SYNC — ${e.wrong.length} squares wrong`);
      console.log(`${' '.repeat(at.length)}  believed ${e.fen}`);
      console.log(`${' '.repeat(at.length)}  ${describeStart(e.start)}`);
      console.log(`${' '.repeat(at.length)}  ${e.wrong.slice(0, 8).map(sq).join('  ')}`);
      break;
    case 'undo':
      console.log(`${at}taken back  ${e.ok ? `OK: ${e.line.join(' ')} — the board went back`
        : `refused (${e.reason}) — ${e.line.join(' ')} does not explain it`}`);
      break;
    case 'replace':
      console.log(`${at}replaced    ${e.ok
        ? `OK: ${e.was} never happened — it was ${e.now}`
        : `refused (${e.reason})${e.now ? ` — best instead of ${e.was} was ${e.now}` : ''}`}`);
      break;
    case 'resync':
      console.log(`${at}resync ${e.plies}ply  ${e.ok ? `OK: ${e.line.join(' ')}`
        : `refused (${e.reason})${e.line ? ` — best was ${e.line.join(' ')}` : ''}`}`);
      break;
    case 'read':
      console.log(`${at}re-read  ${e.ok ? `OK: ${e.fen}` : `refused (${e.reason})`}`
        + (e.reason === 'material' ? `\n${' '.repeat(at.length)}  saw ${e.fen}`
          + `\n${' '.repeat(at.length)}  ${e.isStart ? '*** that is the OPENING POSITION ***'
            : `had ${e.have.w}+${e.have.b} men, screen shows ${e.got.w}+${e.got.b}`}` : ''));
      break;
    case 'newgame':
      console.log(`${at}new game  ${e.ok
        ? `OK — the last game ran ${e.plies} plies; starting over as`
          + ` ${e.playerColor === 'w' ? 'White' : 'Black'}`
          + `${e.turned ? ', the board turned round' : ''}`
          + `${e.pgn ? ` (kept as ${e.pgn})` : ''}`
        : `refused (${e.reason})${e.reason === 'margin'
          ? ` — the opening position fits, but leads by only ${Math.round(e.margin)}`
            + ` of the ${e.need} needed` : ''}`}`);
      break;
    case 'flip':
      console.log(`${at}flip     ${e.ok ? `OK — you are now ${e.playerColor === 'w' ? 'White' : 'Black'}`
        : `refused (${e.misfits} squares still wrong)`}`);
      break;
    case 'region':
      console.log(`${at}region   ${e.ok ? `OK — now ${e.to.w}x${e.to.h} at (${e.to.x}, ${e.to.y})`
        : `refused (${e.reason})`}`);
      break;
    case 'lost':
      console.log(`${at}GAVE UP — every rung failed`);
      console.log(`${' '.repeat(at.length)}  ${describeStart(e.start)}`);
      break;
    case 'blind':
      console.log(`${at}covered  ${e.occluded} squares foreign`);
      break;
    case 'ask':
      console.log(`${at}asked ${e.key}   ${e.text}`);
      break;
    case 'error':
      console.log(`${at}ERROR ${e.where}: ${e.message}`);
      break;
    default: break;
  }
}

/**
 * One refuting square.
 *
 * The two cases read completely differently and used to print the same way.
 * When the expected piece is *also* the best fit, nothing is standing on the
 * wrong square — the square simply costs too much, which means it is painted
 * with something we did not anticipate: a selection, a hover, an arrow. That
 * printed as "e4:bq->bq", which reads as a typo rather than as the diagnosis
 * it is.
 */
function sq(w) {
  if (w.occluded) return `${w.sq}:covered`;
  if (w.want === w.best) return `${w.sq}:${w.want} tinted(${w.wantCost})`;
  return `${w.sq}:${w.want}->${w.best}`;
}

/**
 * `same` is the orientation we are reading in; `turned` is that one rotated.
 * Older logs wrote `flipped` for the second key and meant the same thing, so
 * every reader goes through here rather than reaching into the object — which
 * is how the verdict below came to crash on a log written the new way.
 */
function turned(s) {
  return s.turned ?? s.flipped;
}

function describeStart(s) {
  if (!s) return 'start-position probe: not taken';
  const other = turned(s);
  const best = s.same.misfits <= other.misfits ? s.same : other;
  const which = s.same.misfits <= other.misfits
    ? 'read the way we are reading the board' : 'read the other way round';
  return `start-position probe: ${best.misfits} squares off, ${which}`
    + (best.misfits === 0 ? '  <<< the screen IS the opening position' : '');
}

console.log('\nepisodes of lost sync');
if (!episodes.length) console.log('  none — the board was tracked the whole way');
for (const e of episodes) {
  console.log(`  #${e.from}-${e.to}  ${secs(e.t)} to ${secs(e.until)}`
    + `  (${((e.until - e.t) / 1000).toFixed(0)}s, peak lost ${e.peak})`
    + `${e.openEnded ? '  — never recovered' : ''}`);
  console.log(`     believed: ${e.fen}`);
}

/*
 * The verdict, but only where the log is unambiguous. Everything else is left
 * to replay.mjs and a human — a summary that guesses is worse than one that
 * points at the frames and says look here.
 */
const startHits = events.filter((e) => e.start
  && (e.start.same.misfits === 0 || turned(e.start).misfits === 0));
const material = events.filter((e) => e.ev === 'read' && e.reason === 'material');
const restarts = events.filter((e) => e.ev === 'newgame' && e.ok);

/*
 * A square that is wrong from the very first frame is not a desync at all: the
 * position never moved, so nothing can have drifted. It is a square that was
 * decorated when the templates were learned — the tint is stored as the
 * square's own appearance and misfits forever once it clears, under every
 * hypothesis, which is why no move is ever accepted and no rung ever recovers.
 */
const first = events.find((e) => e.ev === 'desync');
const born = first && first.seq <= 5 && first.wrong.length && first.wrong.length <= 3
  && !first.wrong.some((w) => w.occluded) ? first.wrong : null;

console.log('\nverdict');
if (born) {
  const names = born.map((w) => w.sq).join(', ');
  console.log(`  Lost sync on frame ${first.seq}, before anything on the board had moved —`);
  console.log(`  so this is not drift. ${born.length > 1 ? 'These squares were' : `${names} was`}`
    + ' already wrong against the opening position:');
  for (const w of born) {
    console.log(`    ${w.sq}: expected ${w.want}, the pixels look like ${w.best}`
      + ` (${w.wantCost} against ${w.bestCost})`);
  }
  console.log('  That is the signature of a square that was decorated when the templates');
  console.log('  were learned — a last-move highlight left over from the previous game.');
  console.log('  It is learned as the square itself, then misfits under every hypothesis');
  console.log('  once it clears, so no move can ever be accepted. Confirm and fix with:');
  console.log('    node tools/check-calibration.mjs');
} else if (restarts.length) {
  /*
   * The same signature as the case below, but with the rung that handles it
   * having fired. Worth saying plainly rather than leaving a session that
   * recovered itself looking like one that broke: the episodes above are real,
   * and every one of them ended.
   */
  console.log(`  A NEW GAME started under the coach${restarts.length > 1
    ? `, ${restarts.length} times` : ''} — the screen matched the opening`);
  console.log('  position exactly while it was lost. No search can reach that, because it');
  console.log('  is not a position ahead of or behind the tracked one; it is a different');
  console.log('  game. The ladder recognised it and started over:');
  for (const g of restarts) {
    console.log(`    ${secs(g.t).padStart(8)}  after ${g.plies} plies`
      + `${g.turned ? ', the board turned round' : ''}`
      + `${g.pgn ? ` — the finished game is in ${g.pgn}` : ''}`);
  }
  console.log('  Moves played between the new game starting and it being noticed are not');
  console.log('  graded, so a game that begins while the coach is looking elsewhere may be');
  console.log('  missing its first move or two.');
} else if (startHits.length) {
  const flipped = startHits.some((e) => turned(e.start).misfits === 0 && e.start.same.misfits > 0);
  console.log('  A NEW GAME started under the coach: while it was lost, the screen matched');
  console.log(`  the opening position exactly${flipped ? ', the other way round (you swapped colours)' : ''}.`);
  console.log('  No forward search can recover that, and the re-read refuses a board with');
  console.log(`  more men on it than the game could have${material.length
    ? ` (refused ${material.length}x, "material" above)` : ''}.`);
  console.log('  The ladder has a rung for exactly this, and it did not fire: either this');
  console.log('  log predates it, or a `new game refused` line above says what stopped it.');
} else if (first && first.wrong.length === 2 && !first.wrong.some((w) => w.occluded)
    && first.wrong.filter((w) => w.want === '.').length === 1) {
  /*
   * Two squares, one that gained a piece and one that lost one, is a single
   * move's worth of difference. Just after we accepted a move, that is the
   * board going back rather than forward — a takeback, a premove reverting, a
   * confirmation dismissed — which no forward search can reach.
   */
  console.log('  Two squares changed, one emptied and one filled: exactly one move\'s worth.');
  console.log(`    ${first.wrong.map(sq).join('  ')}`);
  console.log('  Neither square is ahead of the tracked position, so this is not a missed');
  console.log('  move, and no forward search reaches it. Two things look like this:');
  console.log('    BACKWARDS  the board returned to a position we were in — a takeback, a');
  console.log('               premove reverting, a move confirmation dismissed. Look for a');
  console.log('               `taken back` line above.');
  console.log('    SIDEWAYS   the move we recorded was never played and a different one was,');
  console.log('               which is what happens when a move is accepted while the piece');
  console.log('               is still being held over a square. If the emptied square is the');
  console.log('               destination of the move accepted just before, that is this.');
  console.log('               Look for a `replaced` line above.');
  console.log('  A log still showing this means both rungs were refused, and their lines say');
  console.log('  why. `[tint N > M]` on a refuted square means a piece was held, not placed.');
} else if (episodes.length) {
  console.log('  Lost sync, but the screen was not the opening position — so it is a missed');
  console.log('  or misread move, an animation, a flip or a moved region. Look at the first');
  console.log(`  frame of the first episode:\n    node tools/replay.mjs ${dir} --board ${episodes[0].from}`);
} else {
  console.log('  Nothing went wrong in this session.');
}
