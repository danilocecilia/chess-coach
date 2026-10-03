#!/usr/bin/env node
/**
 * Everything on one port.
 *
 *   npm run hub
 *   npm run hub -- --port 8080
 *
 * Serves the review, a drill session and the hub itself from a single origin,
 * which is what lets this be installed as an app rather than opened as two
 * bookmarks. See the header of `src/hub.js` for why that matters.
 *
 * Cheap to leave running: no Stockfish and no screen capture until something
 * asks for them.
 */

import { Hub, DEFAULT_PORT } from '../src/hub.js';

const argv = process.argv.slice(2);
const value = (name, fallback) => (argv.includes(name)
  ? argv[argv.indexOf(name) + 1] : fallback);

const hub = new Hub({ port: Number(value('--port', DEFAULT_PORT)) });

let url;
try {
  url = await hub.start();
} catch (e) {
  console.error(`\ncould not listen on port ${hub.port}: ${e.message}`);
  console.error('  something else has it — try:  npm run hub -- --port 8080\n');
  process.exit(1);
}

console.log(`\nchess-coach: ${url}`);
console.log(`  review   ${url}review`);
console.log(`  play     ${url}play`);
console.log('\nCtrl+C to stop.\n');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await hub.stop();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
