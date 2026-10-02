#!/usr/bin/env node
/**
 * Play the positions you have already lost.
 *
 *   node tools/play.mjs                      a session from your worst habits
 *   node tools/play.mjs --dry-run            the deck and the picks, no engine
 *   node tools/play.mjs --kind missed-threat one habit for the whole session
 *   node tools/play.mjs --size 12
 *   node tools/play.mjs --port 7373 --no-open
 *
 * The deck is built out of `logs/*' + '/review.json`, so it needs games that have
 * been reviewed and nothing else — no re-grading, and no Stockfish at all until
 * a session actually starts.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { STOCKFISH, DEPTH, LOG_DIR } from '../src/config.js';
import { loadReview } from '../src/report.js';
import { FAULTS } from '../src/review.js';
import { scenariosFrom, pickSet, summariseSession, DRILLABLE } from '../src/play.js';
import { PlaySession, PlayServer, DEFAULT_PORT } from '../src/play-server.js';

const HISTORY = path.join(LOG_DIR, 'play-history.json');
const THREAT_DEPTH = Number(process.env.COACH_THREAT_DEPTH ?? 12);

/* ------------------------------------------------------------------ args ---- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const size = Number(value('size', 8));
const kind = value('kind');
const dry = flag('dry-run');

if (kind && !DRILLABLE.includes(kind)) {
  console.error(`unknown habit "${kind}". One of:\n  ${DRILLABLE.join('\n  ')}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ deck ---- */

/** Every reviewed game on disk, with the id the review is stored under. */
function reviewedGames() {
  const games = [];
  if (!existsSync(LOG_DIR)) return games;
  for (const session of readdirSync(LOG_DIR).sort()) {
    const found = loadReview(path.join(LOG_DIR, session));
    (found ?? []).forEach((g, i) => {
      if (g.graded > 0) games.push({ ...g, id: g.id ?? `${session}#${i + 1}` });
    });
  }
  return games;
}

const readHistory = () => {
  if (!existsSync(HISTORY)) return {};
  try {
    const data = JSON.parse(readFileSync(HISTORY, 'utf8'));
    return data?.scenarios ?? {};
  } catch { return {}; /* half-written, or from a future version */ }
};

/** Never a reason to lose a session: the record is a convenience, not the game. */
const writeHistory = (scenarios) => {
  try {
    mkdirSync(path.dirname(HISTORY), { recursive: true });
    writeFileSync(HISTORY, JSON.stringify({ version: 1, saved: new Date().toISOString(), scenarios }, null, 1));
    return true;
  } catch { return false; }
};

const games = reviewedGames();
const deck = scenariosFrom(games);
const history = readHistory();

if (!deck.length) {
  console.error('nothing to play yet.\n'
    + `  ${games.length} reviewed game${games.length === 1 ? '' : 's'} on disk, and no position in them`
    + ' is drillable.\n'
    + '  Play a game under the coach, or run:  node tools/review.mjs --deep --all');
  process.exit(1);
}

const chosen = pickSet(deck, { history, size, kind });

/* --------------------------------------------------------------- dry run ---- */

const seenOf = (s) => {
  const h = history[s.key];
  if (!h?.seen) return 'new';
  return `seen ${h.seen}x, last ${h.lastResult}`;
};

console.log(`\n${deck.length} positions worth replaying, from ${games.length} reviewed games.`);

const spread = new Map();
for (const s of deck) spread.set(s.kind, (spread.get(s.kind) ?? 0) + 1);
for (const [k, n] of [...spread.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(3)}  ${FAULTS[k]?.title ?? k}`);
}

console.log(`\nthis session — ${chosen.length} position${chosen.length === 1 ? '' : 's'}:`);
for (const [i, s] of chosen.entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. ${(FAULTS[s.kind]?.title ?? s.kind).padEnd(26)}`
    + ` ${s.drop.toFixed(0).padStart(3)}% lost   ${s.color === 'b' ? 'Black' : 'White'}`
    + `, move ${String(s.fen.split(' ')[5]).padEnd(3)} ${seenOf(s)}`);
}

if (dry) {
  console.log('\n(--dry-run: nothing started, no engine, no browser)\n');
  process.exit(0);
}

/* ---------------------------------------------------------------- session ---- */

const engine = await new Engine(STOCKFISH, { threads: 4 }).start();
const session = new PlaySession({
  engine, scenarios: chosen, history,
  depth: DEPTH, threatDepth: THREAT_DEPTH,
  // Written as each position is finished, not at exit: a tab closed or a process
  // killed is an ordinary way for a session to end, and spacing that forgets
  // what you did is worse than none.
  onResult: () => writeHistory(session.historyAfter()),
});
await session.begin();

const server = new PlayServer({
  session,
  port: Number(value('port', DEFAULT_PORT)),
  open: !flag('no-open'),
});

let url;
try {
  url = await server.start();
} catch (e) {
  console.error(`\ncould not listen on that port: ${e.message}`);
  console.error('  something else is using it — try:  node tools/play.mjs --port 7373\n');
  await engine.quit();
  process.exit(1);
}

console.log(`\nplay:  ${url}`);
console.log('       click a piece, then its square. t / w / c to ask. Ctrl+C to stop.\n');

/**
 * Stopping is a normal way to end a session.
 *
 * Nothing here is load-bearing: every finished position was written to the
 * history as it was finished, so this only prints and shuts the engine down. It
 * has to be that way round — a handler that owned the record would lose it on
 * any exit it did not see, and on Windows `kill -INT` does not reach Node at all.
 */
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.stop();
  await engine.quit();

  if (session.results.length) {
    console.log('\nhow that went:');
    for (const line of summariseSession(session.results)) console.log(line);
    console.log(`\n  kept in ${path.relative(process.cwd(), HISTORY)}`);
  } else {
    console.log('\nnothing finished — nothing recorded.');
  }
  console.log();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
