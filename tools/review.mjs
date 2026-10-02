/**
 * What you need to work on.
 *
 *   node tools/review.mjs                  the newest session
 *   node tools/review.mjs logs/<id>        a particular one
 *   node tools/review.mjs --all            every session, and rebuild the page
 *   node tools/review.mjs --deep           re-grade with Stockfish (see below)
 *   node tools/review.mjs --pgn game.pgn   any PGN, from anywhere
 *   node tools/review.mjs --open           open the page when it is written
 *
 * Two sources, one analysis. `src/review.js` does not know or care which of
 * them produced the graded moves it is handed:
 *
 *   instant   the grades the coach already computed while you played. Free,
 *             immediate, and exactly what you were told at the time — but only
 *             your side, and only the moves it actually saw. A move played
 *             while the board was out of sync was never graded and is not here.
 *
 *   --deep    Stockfish walks the finished PGN: every move, both sides, one
 *             uniform depth, including the moves a desync swallowed. Costs
 *             about a search a ply — roughly a minute for a full game — and is
 *             the only way to review a session logged before the grade events
 *             carried enough to classify, or a game played somewhere else.
 *
 * Each session keeps its own `review.json`, and the page is rebuilt from all of
 * them. See `src/report.js`.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Chess } from 'chess.js';
import { LOG_DIR, STOCKFISH, DEPTH } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { gradeMove, toUci } from '../src/grade.js';
import { reviewGame, reviewAll, summarise, gamesFromLog, FAULTS } from '../src/review.js';
import { saveReview, loadReview, rebuild, titleOf } from '../src/report.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const opts = {
  deep: flag('--deep'),
  all: flag('--all'),
  open: flag('--open'),
  force: flag('--force'),
  pgn: value('--pgn'),
  color: value('--color'),
  depth: Number(value('--depth') ?? DEPTH),
};
const target = argv.find((a) => !a.startsWith('--')
  && a !== opts.pgn && a !== opts.color && String(opts.depth) !== a);

/**
 * Progress on one line, but only where one line is a thing that exists.
 * Piped into a file, `\r` is just a character, and 52 plies become 52 copies of
 * the same sentence.
 */
const live = process.stdout.isTTY;
const progress = (text) => { if (live) process.stdout.write('\r  ' + text + '   '); };
const settled = (text) => console.log((live ? '\r  ' : '  ') + text + '      ');

/** Runs are named by timestamp, so the newest is last in sort order. */
function sessions() {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .filter((d) => existsSync(path.join(LOG_DIR, d, 'session.jsonl')))
    .sort()
    .map((d) => path.join(LOG_DIR, d));
}

function events(dir) {
  const out = [];
  for (const line of readFileSync(path.join(dir, 'session.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    // A session killed mid-write leaves one half-line; that is not a reason to
    // refuse to read the hour in front of it.
    try { out.push(JSON.parse(line)); } catch { /* truncated tail */ }
  }
  return out;
}

/* ---------------------------------------------------------------- deep ---- */

/** Every PGN a session left behind, in the order they were played. */
function pgnsOf(dir) {
  return readdirSync(dir)
    .filter((f) => /^game(-\d+)?\.pgn$/.test(f))
    .sort((a, b) => (Number(/-(\d+)/.exec(a)?.[1] ?? 1) - Number(/-(\d+)/.exec(b)?.[1] ?? 1)));
}

/**
 * Re-grade a game from its PGN, both sides.
 *
 * Each position is searched once, not twice. The position after your move is
 * the one your opponent moves from, so the `after` search of one move is the
 * `before` search of the next — handed straight back through `gradeMove`'s own
 * `pre` parameter, which exists for exactly this. That is the difference
 * between one search a ply and two.
 */
async function deepGame(engine, pgnText, depth, onMove) {
  const chess = new Chess();
  try { chess.loadPgn(pgnText); } catch { return null; }

  const moves = chess.history({ verbose: true });
  if (!moves.length) return null;

  const graded = [];
  let pre = null;
  const board = new Chess();
  for (const [i, m] of moves.entries()) {
    const fenBefore = board.fen();
    const uci = toUci(m);
    const g = await gradeMove(engine, fenBefore, uci, depth, { pre });
    graded.push({
      san: g.san, uci, mover: g.mover, ply: i + 1, label: g.label.name, drop: g.drop,
      scoreBefore: g.scoreBefore, scoreAfter: g.scoreAfter,
      fenBefore: g.fenBefore, fenAfter: g.fenAfter,
      bestMove: g.bestMove, bestLine: (g.bestLine ?? []).slice(0, 8),
      refutation: (g.refutation ?? []).slice(0, 8), materialSwing: g.materialSwing,
      exchange: g.exchange, floored: g.floored,
    });
    // The search we already paid for, in the frame the next move needs it.
    pre = { fen: g.fenAfter, analysis: g.afterAnalysis };
    board.move(m);
    onMove?.(i + 1, moves.length);
  }
  return graded;
}

/* -------------------------------------------------------------- review ---- */

/** Turn one session directory into reviewed games. */
async function reviewSession(dir, engine) {
  const session = path.basename(dir);
  const out = [];

  // Which side you were on, per game of this session. The deep path needs this
  // as much as the live one does — it grades both sides, so the colour is what
  // decides whose review it is — and `gamesFromLog` is where that is tracked
  // properly through a flip or a new game.
  const played = existsSync(path.join(dir, 'session.jsonl'))
    ? gamesFromLog(events(dir)) : [];

  if (opts.deep) {
    const files = pgnsOf(dir);
    for (const [i, file] of files.entries()) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      const graded = await deepGame(engine, text, opts.depth,
        (at, of) => progress(`${session}/${file}  ${at}/${of} plies`));
      if (!graded?.length) { settled(`${session}/${file}  (no moves)`); continue; }
      out.push(finish(graded, {
        color: opts.color ?? played[i]?.color,
        session, n: i + 1, of: files.length, source: 'deep',
      }));
      settled(`${session}/${file}  ${graded.length} plies graded`);
    }
    return out;
  }

  for (const g of played) {
    if (!g.moves.length) continue;
    out.push(finish(g.moves, {
      color: opts.color ?? g.color, session, n: g.n, of: played.length, source: 'live',
    }));
  }
  return out;
}

/** One reviewed game, with the bits the page needs to label it. */
function finish(graded, { color, session, n, of, source }) {
  let r = reviewGame(graded, { color });
  /*
   * A colour that explains none of the moves explains nothing. Rather than
   * report a game as empty, fall back to letting the review read the side off
   * the moves themselves — which is what it does when no colour is given at
   * all, and which cannot be wrong about a session that grades one side.
   */
  if (!r.graded && graded.length) r = reviewGame(graded);
  return {
    ...r,
    id: `${session}#${n}`,
    session,
    title: titleOf(session, n, of),
    plies: graded.length,
    source,
  };
}

/* ----------------------------------------------------------------- run ---- */

function open(file) {
  // `start` is a cmd builtin, hence the shell; the empty first argument is the
  // window title that `start` otherwise steals from a quoted path.
  const url = 'file://' + file.replace(/\\/g, '/');
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* no browser is not a failure worth stopping for */ }
}

async function main() {
  let dirs;
  if (opts.pgn) dirs = [];
  else if (opts.all) dirs = sessions();
  else if (target) dirs = [path.resolve(target)];
  else {
    const all = sessions();
    dirs = all.length ? [all[all.length - 1]] : [];
  }

  if (!opts.pgn && !dirs.length) {
    console.error('No session logs found. Run `npm start` first, or pass --pgn <file>.');
    process.exit(1);
  }

  const engine = opts.deep || opts.pgn
    ? await new Engine(STOCKFISH, { threads: 4 }).start() : null;
  if (engine) console.log(`grading at depth ${opts.depth} — about a second a ply\n`);

  const reviewed = [];
  try {
    if (opts.pgn) {
      const file = path.resolve(opts.pgn);
      const graded = await deepGame(engine, readFileSync(file, 'utf8'), opts.depth,
        (at, of) => progress(`${path.basename(file)}  ${at}/${of} plies`));
      settled(`${path.basename(file)}  ${graded?.length ?? 0} plies graded`);
      if (!graded?.length) {
        console.error('No moves in that PGN.');
        process.exit(1);
      }
      reviewed.push(finish(graded, {
        color: opts.color, session: path.basename(file, '.pgn'), n: 1, of: 1, source: 'deep',
      }));
    } else {
      for (const dir of dirs) {
        const games = await reviewSession(dir, engine);
        if (!games.length) continue;    // nothing here; leave what is on disk

        /*
         * A deep review is strictly better than a live one — every move, both
         * sides, one depth — so a later `--all` pass must not quietly downgrade
         * it back. This is the same instinct as the recovery ladder in
         * `main.js`: never replace something proven with something weaker
         * without being told to.
         */
        const held = loadReview(dir);
        if (!opts.force && games[0].source === 'live' && held?.[0]?.source === 'deep') {
          console.log(`  ${path.basename(dir)}  keeping the deeper review already on disk`
            + ' (--force to replace it)');
          reviewed.push(...held);
          continue;
        }
        saveReview(dir, games);
        reviewed.push(...games);
      }
    }
  } finally {
    await engine?.quit();
  }

  /* --- the page --- */
  const built = rebuild();
  const played = reviewed.filter((g) => g.graded > 0);

  if (!played.length) {
    console.log('\nNo graded moves in that session.');
    if (!opts.deep) console.log('Try --deep: it grades the saved PGN from scratch.');
  }

  for (const g of played) {
    console.log(`\n${g.title}  —  ${g.plies} plies, you were`
      + ` ${g.color === 'w' ? 'White' : 'Black'}`);
    for (const line of summarise(g)) console.log(line);
  }

  if (played.length > 1) {
    const all = reviewAll(played);
    console.log(`\nacross these ${all.games} games — accuracy ${all.accuracy.toFixed(1)}%`);
    for (const f of all.faults.slice(0, 3)) {
      console.log(`  ${(FAULTS[f.kind] ?? FAULTS.unknown).title.padEnd(26)}`
        + ` ${String(f.count).padStart(3)} moves   ${f.cost.toFixed(0)}%`);
    }
  }

  console.log(`\npage: ${built.file}`);
  console.log(`      ${built.games} game${built.games === 1 ? '' : 's'} in it`);
  if (opts.open) open(built.file);
  else console.log('      (--open to open it in a browser)');
}

main().catch((e) => { console.error(e); process.exit(1); });
