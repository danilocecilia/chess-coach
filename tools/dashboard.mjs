/**
 * The review dashboard on its own, for looking back without playing.
 *
 *   npm run dashboard              serve it and open a browser
 *   npm run dashboard -- --port 8080
 *   npm run dashboard -- --no-open
 *
 * The coach serves this itself while it runs, so this is for the other half of
 * the time: going back over last week's games without starting a session, on a
 * machine where the board is not even open.
 *
 * It watches `logs/` and refreshes the page when anything lands, which means a
 * coach running in another terminal — or on the other side of a `--deep`
 * review — updates the tab you already have open.
 */

import { watch, existsSync } from 'node:fs';
import { Dashboard, DEFAULT_PORT } from '../src/dashboard.js';
import { LOG_DIR } from '../src/config.js';

const argv = process.argv.slice(2);
const value = (name, fallback) => (argv.includes(name)
  ? argv[argv.indexOf(name) + 1] : fallback);

const dash = new Dashboard({
  port: Number(value('--port', DEFAULT_PORT)),
  open: !argv.includes('--no-open'),
});

const url = await dash.start();
if (!url) {
  console.error(`Could not listen on port ${dash.port} — something else has it.`);
  console.error('Pass a different one:  npm run dashboard -- --port 8080');
  process.exit(1);
}

console.log(`review dashboard: ${url}`);
console.log('watching logs/ — it refreshes when a game is reviewed.');
console.log('Ctrl+C to stop.');

/*
 * Redrawn on any change under `logs/`, debounced.
 *
 * A single review writes one file, but a coach finishing a game writes the PGN
 * and the review together and a `--deep --all` pass writes one per session, so
 * without a debounce the page would reload several times for one event.
 */
if (existsSync(LOG_DIR)) {
  let pending = null;
  watch(LOG_DIR, { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => dash.notify(), 250);
  });
}

process.on('SIGINT', () => {
  dash.stop();
  process.exit(0);
});
