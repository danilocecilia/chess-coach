/**
 * One origin for everything, so the app can be an app.
 *
 * ## Why this exists
 *
 * The review page is served by `src/dashboard.js` on :7171, and a drill session
 * by `src/play-server.js` on :7272. Two ports is fine for two commands you run
 * on purpose. It stops being fine the moment this is installed as an app: an
 * installed PWA is scoped to one origin, and a link that leaves that scope does
 * not open in the app window — Edge either grows a browser bar inside the app or
 * hands the page to the default browser. Either way it stops feeling like a
 * program and starts feeling like a bookmark.
 *
 * So: one server, one port, and the two existing servers mounted on routes.
 * Mounted, not reimplemented — `handle` is the same method the standalone
 * servers dispatch through, so there is one copy of every behaviour and the
 * mounted view cannot drift from `npm run dashboard` or `npm run play`.
 *
 * ## What stays at the root, and why
 *
 * `/api/*` and `/events` are not namespaced. The client scripts ask for them by
 * absolute path — three `fetch('/api/…')` calls in `src/play-page.js`, one
 * `new EventSource('/events')` in `src/dashboard.js` — and a `<base href>` does
 * not rewrite root-relative URLs. Prefixing would mean editing those scripts and
 * the tests that pin them, a real cost for no gain: there is only ever one
 * session and one review, so nothing collides. The hub takes `/hub/api/*` for
 * itself instead.
 *
 * ## Why a taken port is fatal here
 *
 * `src/dashboard.js:99` resolves `null` when its port is taken, because a
 * dashboard is a convenience beside a game that is happening anyway. This is the
 * opposite case. Once the app is installed, its identity *is* its origin — a hub
 * that quietly moved to another port would leave the installed app pointing at
 * nothing. Better to fail loudly and say which process has it.
 *
 * ## No dependency
 *
 * `node:http` and a path switch, like everything else here.
 */

import { createServer } from 'node:http';
import { watch, existsSync } from 'node:fs';
import path from 'node:path';
import { Dashboard } from './dashboard.js';
import { PlaySession, PlayServer, json, readJson } from './play-server.js';
import { buildDeck, writeHistory } from './play-deck.js';
import { CoachControl } from './coach-control.js';
import { hubPage } from './hub-page.js';
import { rebuild } from './report.js';
import { Engine } from './engine.js';
import { ROOT, STOCKFISH, DEPTH, LOG_DIR } from './config.js';

const HOST = '127.0.0.1';
export const DEFAULT_PORT = Number(process.env.COACH_HUB_PORT ?? 7070);
const THREAT_DEPTH = Number(process.env.COACH_THREAT_DEPTH ?? 12);

/** Debounce for `logs/` changes. See the comment on {@link Hub.#watchLogs}. */
const SETTLE_MS = 250;

/** The one-shot tool the Setup card can run. */
const CALIBRATE = path.join(ROOT, 'src', 'calibrate.js');

export class Hub {
  constructor({ port = DEFAULT_PORT } = {}) {
    this.port = port;
    this.server = null;
    this.url = null;

    /*
     * Mounted, never started: the hub owns the socket. `mounted` is what lets
     * its `notify` push to the SSE clients it collected through `handle`.
     */
    this.dash = new Dashboard({ mounted: true });

    this.watcher = null;
    this.settle = null;

    /*
     * Play is built on demand and torn down after.
     *
     * A hub that held a `PlaySession` would hold an `Engine`, which means a
     * Stockfish resident for the whole login doing nothing. The hub is meant to
     * be cheap enough to start at logon and forget about, so the expensive parts
     * are only alive while they are being used.
     */
    this.play = null;
    this.engine = null;
    this.playPositions = null;

    /*
     * Starting and stopping the coach, which the hub does not own in any deeper
     * sense: it can adopt one a terminal started, and one it started outlives it.
     */
    this.coach = new CoachControl();
  }

  start() {
    return new Promise((resolve, reject) => {
      // So the first `/review` is current rather than whatever was left on disk.
      // `Dashboard.handle` can recover a *missing* page, but not a stale one.
      try { rebuild(); } catch { /* it can be built on first request */ }

      this.server = createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, HOST, () => {
        // Port 0 asks the OS for a free one, which is what a test wants.
        this.port = this.server.address()?.port ?? this.port;
        this.url = `http://${HOST}:${this.port}/`;
        this.#watchLogs();
        resolve(this.url);
      });
    });
  }

  /*
   * Redraw the review on any change under `logs/`, debounced.
   *
   * Lifted from `tools/dashboard.mjs`, for the reason given there: one review
   * writes one file, but a coach finishing a game writes the PGN and the review
   * together and a `--deep --all` pass writes one per session, so without this
   * the page would reload several times for one event.
   *
   * Watching the directory rather than listening to the coach is deliberate. It
   * means the review stays live whether the coach was started by this hub, by a
   * terminal, or not at all — the hub never has to be told.
   */
  #watchLogs() {
    if (!existsSync(LOG_DIR)) return;
    this.watcher = watch(LOG_DIR, { recursive: true }, () => {
      clearTimeout(this.settle);
      this.settle = setTimeout(() => this.dash.notify(), SETTLE_MS);
    });
  }

  handle(req, res) {
    // `route`, not `path`, so it cannot shadow node:path above.
    const route = (req.url ?? '/').split('?')[0];

    if (route === '/') return void this.#home(res);

    // The review and its event stream. `/events` keeps its root path because
    // the script injected into the page hardcodes it.
    if (route === '/review') return void this.dash.handle(req, res, '/');
    if (route === '/events') return void this.dash.handle(req, res, '/events');

    if (route === '/play') {
      if (!this.play) return void this.#noSession(res);
      return void this.play.handle(req, res, '/');
    }

    if (route.startsWith('/hub/api/')) {
      return void this.#control(req, res, route.slice('/hub/api/'.length));
    }

    /*
     * The session's own API, unprefixed and unrewritten.
     *
     * A 503 rather than a 404 when there is no session: the path is right and
     * the server is here, there is just nothing to answer with yet. `call()` in
     * `src/play-page.js` renders the message, so a page left open after a
     * session ended says so instead of breaking.
     */
    if (route === '/api' || route.startsWith('/api/')) {
      if (!this.play) return void json(res, 503, { error: 'no session' });
      return void this.play.handle(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }

  /**
   * The hub's own API, under its own prefix.
   *
   * Namespaced precisely because `/api/*` is not: the session's client asks for
   * that by absolute path, so the hub stays out of its way and takes `/hub/api/*`
   * for the things only this page calls.
   *
   * Every mutating action answers with whatever the underlying call returned —
   * `{ok}` or `{error}` — and always with 200. The page shows `error` as a
   * sentence, so an HTTP status would be a second channel saying the same thing
   * less precisely. A genuinely broken request still gets 400 or 500.
   */
  async #control(req, res, action) {
    if (action === 'log') return void this.coach.attach(req, res);

    if (action === 'status') {
      return void json(res, 200, {
        coach: this.coach.status(),
        tool: this.coach.tool(),
        play: { running: !!this.play, positions: this.playPositions },
      });
    }

    /*
     * A map rather than a switch, for two reasons.
     *
     * It is one list, so an action cannot be routed without also being known to
     * the guards below — a switch needed the method check to come first, which
     * answered 405 ("POST only") for paths that simply do not exist, and that
     * sends someone looking for a bug in their request instead of their URL.
     *
     * And the key order is the answer order: unknown before wrong-method before
     * malformed body, so the most specific complaint wins.
     */
    const run = {
      'coach-start': (body) => this.coach.start({ all: !!body.all, fen: body.fen ?? null }),
      'coach-stop': () => this.coach.stop(),
      'play-start': (body) => this.startPlay({ size: body.size, kind: body.kind }),
      'play-stop': () => this.stopPlay(),
      'calibrate': (body) => this.coach.runOnce({
        label: 'calibration',
        args: body.auto ? [CALIBRATE, '--auto'] : [CALIBRATE],
      }),
      'cleanup': () => this.coach.cleanupLeftovers(),
    }[action];

    if (!run) return void json(res, 404, { error: `unknown action ${action}` });
    if (req.method !== 'POST') return void json(res, 405, { error: 'POST only' });

    let body = {};
    try {
      body = await readJson(req);
    } catch (e) {
      return void json(res, 400, { error: e.message });
    }

    try {
      json(res, 200, await run(body));
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  }

  /**
   * Build a drill session and mount it.
   *
   * Everything expensive happens here and nowhere else: `buildDeck` reads only
   * `logs/*' + '/review.json`, so the deck is known before Stockfish is started,
   * and an empty deck costs nothing.
   */
  async startPlay({ size = 8, kind = null } = {}) {
    if (this.play) return { error: 'a session is already running' };

    const { games, deck, history, chosen } = buildDeck({ size, kind });
    if (!deck.length) {
      return {
        error: `nothing to play yet — ${games.length} reviewed game`
          + `${games.length === 1 ? '' : 's'} on disk, no drillable position in them`,
      };
    }

    const engine = await new Engine(STOCKFISH, { threads: 4 }).start();
    const session = new PlaySession({
      engine,
      scenarios: chosen,
      history,
      depth: DEPTH,
      threatDepth: THREAT_DEPTH,
      // Written as each position is finished, not at exit — the same reasoning as
      // `tools/play.mjs`: a tab closed is an ordinary way for a session to end,
      // and spacing that forgets what you did is worse than none.
      onResult: () => writeHistory(session.historyAfter()),
    });
    await session.begin();

    this.engine = engine;
    this.play = new PlayServer({ session, open: false });
    this.playPositions = chosen.length;
    return { ok: true, positions: chosen.length };
  }

  /** Drop the session and give Stockfish back. Safe to call with none running. */
  async stopPlay() {
    const engine = this.engine;
    this.play = null;
    this.engine = null;
    this.playPositions = null;
    await engine?.quit();
    return { ok: true };
  }

  async stop() {
    clearTimeout(this.settle);
    this.watcher?.close();
    this.watcher = null;
    this.dash.stop();
    this.coach.detachAll();
    await this.stopPlay();
    this.server?.close();
    this.server = null;
    /*
     * A coach this hub started is deliberately left alone. It writes its own
     * final PGN and review through `shutdown()`, and the next hub to come up
     * adopts it from the pidfile — taking it down here would turn "I restarted
     * the hub" into "I lost the game I was recording".
     */
  }

  /* ------------------------------------------------------------- pages --- */

  /*
   * Never cached. The page reads its state from `/hub/api/status` on a timer, so
   * a cached shell would still be correct — but the shell is also where the
   * drill habits come from, and those change as games are reviewed.
   */
  #home(res) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(hubPage({ port: this.port }));
  }

  #noSession(res) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>chess-coach — play</title>
<body>
<h1>No session running</h1>
<p>Start one from the <a href="/">hub</a>.</p>
</body>
`);
  }
}
