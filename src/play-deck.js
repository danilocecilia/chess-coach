/**
 * The deck a play session is dealt from, and the record of what you have seen.
 *
 * This used to live inline in `tools/play.mjs`, which was fine while the CLI was
 * the only way to start a session. The hub starts one too, and a second copy of
 * "find the reviewed games, read the spacing record, pick a set" is exactly the
 * kind of duplication that drifts: the CLI would keep spacing you had already
 * earned while the hub quietly re-dealt the same positions.
 *
 * What stayed behind in the tool is everything that prints. This module returns
 * data and decides nothing — not even whether an empty deck is an error, because
 * the CLI answers that with a paragraph about running a review and the hub
 * answers it with a disabled button.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';
import { loadReview } from './report.js';
import { scenariosFrom, pickSet } from './play.js';

export const HISTORY = path.join(LOG_DIR, 'play-history.json');

/** Every reviewed game on disk, with the id the review is stored under. */
export function reviewedGames() {
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

export const readHistory = () => {
  if (!existsSync(HISTORY)) return {};
  try {
    const data = JSON.parse(readFileSync(HISTORY, 'utf8'));
    return data?.scenarios ?? {};
  } catch { return {}; /* half-written, or from a future version */ }
};

/** Never a reason to lose a session: the record is a convenience, not the game. */
export const writeHistory = (scenarios) => {
  try {
    mkdirSync(path.dirname(HISTORY), { recursive: true });
    writeFileSync(HISTORY, JSON.stringify({ version: 1, saved: new Date().toISOString(), scenarios }, null, 1));
    return true;
  } catch { return false; }
};

/**
 * Everything a session needs, without starting one.
 *
 * No engine and no Stockfish: the deck comes out of `logs/*' + '/review.json`,
 * so this can be called to find out whether a session is even possible — which
 * is what the hub does to decide whether its Play button is live.
 *
 * `chosen` is guarded rather than left to `pickSet`, because an empty deck is an
 * ordinary state (a fresh install has one) and not something a caller should
 * have to protect itself against before asking.
 */
export function buildDeck({ size = 8, kind = null } = {}) {
  const games = reviewedGames();
  const deck = scenariosFrom(games);
  const history = readHistory();
  const chosen = deck.length ? pickSet(deck, { history, size, kind }) : [];
  return { games, deck, history, chosen };
}
