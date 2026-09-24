/** Shared paths and tunables. */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Optional .env; the key is often already exported in the shell, so a missing
// file is not an error.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env, fine */ }

export const STOCKFISH = path.join(
  ROOT, 'engines', 'stockfish', 'stockfish-windows-x86-64-universal.exe',
);

if (!existsSync(STOCKFISH)) {
  throw new Error(`Stockfish not found at ${STOCKFISH} — see README for the download step.`);
}

/** Search depth. 18 is ~100ms/position here; drop to 15 if the overlay lags. */
export const DEPTH = Number(process.env.COACH_DEPTH ?? 18);

export const CAPTURE_DIR = path.join(ROOT, 'captures');
export const TEMPLATE_DIR = path.join(ROOT, 'templates');
export const BOARD_CONFIG = path.join(ROOT, 'board.json');
/** The move-list region, when one has been picked. See tools/read-panel.mjs. */
export const PANEL_CONFIG = path.join(ROOT, 'panel.json');
/** One directory per run, written by src/log.js. See README > Diagnosing a desync. */
export const LOG_DIR = path.join(ROOT, 'logs');

/**
 * Jev == OpenRouter. The local :59444 router is Claude Code's own, not ours.
 *
 * There is deliberately no vision model here. The original design used one to
 * read the board at calibration, but benchmarking showed vision models are
 * unreliable at chess positions, and calibrating from the known start position
 * is exact and free. Jev is used only where it measurably wins: explanations.
 *
 * Model chosen by benchmark: correct, names the better move, ~1.5s, $0.00003
 * per explained move.
 */
export const JEV = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: process.env.JEV_API_KEY,
  coachModel: process.env.COACH_MODEL ?? 'qwen/qwen3-30b-a3b-instruct-2507',
};
