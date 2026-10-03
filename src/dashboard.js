/**
 * The review page, served and kept current, so nothing has to be run.
 *
 * `report.js` writes a file you can double-click, and that stays the fallback
 * that needs nothing at all. What it cannot do is change while you are looking
 * at it: a game reviewed at move 40 is a page you have to remember to reopen,
 * and the moment the review is most interesting — mid-game, right after you
 * blundered — is exactly when nobody is going to go and run a command.
 *
 * So this serves the same page on localhost and pushes a refresh whenever it
 * changes. The coach starts it; `npm run dashboard` starts it on its own for
 * looking back over old games without playing.
 *
 * ## What it deliberately is not
 *
 * Not a second renderer. The served page is the generated file, byte for byte,
 * with one script appended — so there is one page, one data path, and no way
 * for the served view and the file to disagree. Anything the page learns to do
 * it learns once.
 *
 * Not on the network. It binds to 127.0.0.1, so it is reachable from this
 * machine and nowhere else. Your games are not interesting to anyone, but a
 * process that quietly starts listening on every interface because it wanted to
 * show you a chart is not a thing this project is going to do.
 *
 * No dependency, like everything else here: `node:http`, an event stream, and
 * six lines of client script.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { rebuild, REPORT_FILE } from './report.js';

const HOST = '127.0.0.1';
export const DEFAULT_PORT = Number(process.env.COACH_PORT ?? 7171);

/**
 * Reload on a ping, and come back to where you were reading.
 *
 * A full reload rather than a data re-render, because the page is generated
 * whole and re-rendering it in place would mean two ways of building the same
 * view. The cost of that choice is losing your scroll position, which for a
 * page that refreshes after every move is the difference between usable and
 * infuriating — so the scroll is carried across, and so is whichever game or
 * habit you had opened.
 */
const LIVE = `
<script>
(() => {
  const KEY = 'coach:view';
  try {
    const was = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (was) addEventListener('load', () => {
      scrollTo(0, was.y || 0);
      document.querySelectorAll('details.fault').forEach((d, i) => {
        d.open = (was.faults || []).includes(i);
      });
    });
  } catch {}
  const remember = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        y: scrollY,
        faults: [...document.querySelectorAll('details.fault')]
          .flatMap((d, i) => (d.open ? [i] : [])),
      }));
    } catch {}
  };
  const es = new EventSource('/events');
  es.onmessage = () => { remember(); location.reload(); };
  addEventListener('beforeunload', remember);
})();
</script>
`;

export class Dashboard {
  constructor({ port = DEFAULT_PORT, open = false, mounted = false } = {}) {
    this.port = port;
    this.wantOpen = open;
    /*
     * Set when another server owns the socket and only calls `handle` — see
     * `src/hub.js`. There is then no `this.server` for `notify` to check, and
     * without a second way to tell it is live a mounted dashboard would accept
     * SSE clients and then never push anything to them: the page would sit
     * there, connected, going stale after every graded move.
     */
    this.mounted = mounted;
    this.server = null;
    this.clients = new Set();
    this.url = null;
  }

  /**
   * Listen, and hand back the URL — or null, which is not an error.
   *
   * A port already taken is the ordinary case of having two coaches open, or
   * having left one running. It is a reason to do without a dashboard, never a
   * reason to fail to start a game, so everything here degrades to null and the
   * caller carries on.
   */
  start() {
    return new Promise((resolve) => {
      try { rebuild(); } catch { /* the page can be built on first request */ }

      this.server = createServer((req, res) => this.handle(req, res));
      this.server.on('error', () => resolve(null));           // port taken, no permission
      this.server.listen(this.port, HOST, () => {
        // Port 0 asks the OS for a free one, which is what a test wants and
        // what a second coach could fall back to; either way the URL has to
        // name the port we actually got rather than the one we asked for.
        this.port = this.server.address()?.port ?? this.port;
        this.url = `http://${HOST}:${this.port}/`;
        if (this.wantOpen) openBrowser(this.url);
        resolve(this.url);
      });
    });
  }

  /**
   * Answer one request.
   *
   * `mounted` names the route to dispatch on when something else owns the
   * server, so the same branches a standalone dashboard reaches are reachable
   * from a shared origin. `src/hub.js` serves this page at `/review` — but
   * `/events` has to stay at the root, because the injected script above
   * hardcodes `new EventSource('/events')` and so does `tests/dashboard.test.js`.
   * Hence a mount point passed per request rather than a prefix stripped here:
   * the two routes move independently.
   */
  handle(req, res, mounted = null) {
    const path = mounted ?? (req.url ?? '/').split('?')[0];

    if (path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }

    if (path !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return void res.end('not found');
    }

    let html;
    try {
      html = readFileSync(REPORT_FILE, 'utf8');
    } catch {
      // Nothing built yet, or it was deleted under us. One rebuild, then admit it.
      try {
        rebuild();
        html = readFileSync(REPORT_FILE, 'utf8');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return void res.end(`could not build the review page: ${e.message}`);
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Always the current one: a cached dashboard is the problem this solves.
      'Cache-Control': 'no-store',
    });
    res.end(html.replace('</body>', LIVE + '</body>'));
  }

  /**
   * Something changed — rebuild the page and tell every open tab.
   *
   * Never throws and never blocks the caller in any way that matters: this is
   * called from the watch loop's grading queue, and a dashboard that cannot
   * write its page is not a reason to stop coaching.
   */
  notify() {
    if (!this.server && !this.mounted) return;
    try { rebuild(); } catch { return; }
    for (const res of this.clients) {
      try { res.write('data: 1\n\n'); } catch { this.clients.delete(res); }
    }
  }

  stop() {
    for (const res of this.clients) { try { res.end(); } catch { /* already gone */ } }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }
}

/** Open the default browser, and shrug if there isn't one. */
export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty argument is the window title it
      // would otherwise take from the quoted URL.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* no browser is not a failure worth reporting */ }
}
