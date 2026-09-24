/**
 * Long-lived Stockfish process spoken to over UCI.
 *
 * Stockfish is a native .exe, but it ships signed-enough to satisfy Smart App
 * Control on this machine (verified: no CodeIntegrity block events), so unlike
 * numpy it runs fine. We keep one process alive for the whole session because
 * spawning per move would cost more than the search itself.
 */

import { spawn } from 'node:child_process';

/**
 * UCI reports `score` from the perspective of whoever is to move. After a move
 * is played the turn flips, so an "after" score must be negated to stay in the
 * mover's frame. Everything downstream assumes the mover's frame.
 */
export function negate(score) {
  if (score == null) return null;
  if (typeof score.mate === 'number') return { mate: -score.mate };
  return { cp: -score.cp };
}

export class Engine {
  constructor(exePath, { threads = 2, hash = 256 } = {}) {
    this.exePath = exePath;
    this.opts = { threads, hash };
    this.proc = null;
    this.buf = '';
    this.queue = Promise.resolve(); // serialises analyses; one search at a time
    this.pending = null;
    this.dead = null;               // the error that ended the process, once it has
    this.multipv = 1;               // Stockfish's own default, tracked so it cannot go stale
  }

  async start() {
    this.proc = spawn(this.exePath, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout.on('data', (d) => this.#onData(d));
    this.proc.on('error', (e) => { this.#fail(e); });

    /*
     * Writing to a dead child is a shutdown condition, not a crash.
     *
     * On Windows, Ctrl+C is delivered to every process attached to the console,
     * so Stockfish is usually gone by the time `shutdown` sends it `quit`. The
     * write then fails asynchronously, as an `error` event on the pipe — which
     * no try/catch around the write can see, so it reached the process as an
     * unhandled 'error' and killed it on the way out. Swallowing it here is
     * safe because #send is already guarded on `writable`: anything that gets
     * past that guard and still fails is a pipe that closed underneath us.
     */
    this.proc.stdin.on('error', () => {});

    // A child that dies mid-game must settle whatever is waiting on it.
    // Otherwise `analyse` never resolves, the grading queue stops for good, and
    // the symptom is grades silently ceasing rather than an error.
    this.proc.on('exit', (code, signal) => {
      this.#fail(new Error(`Stockfish exited (${signal ?? `code ${code}`})`));
    });

    await this.#waitFor('uciok', () => this.#send('uci'));
    this.#send(`setoption name Threads value ${this.opts.threads}`);
    this.#send(`setoption name Hash value ${this.opts.hash}`);
    await this.#waitFor('readyok', () => this.#send('isready'));
    return this;
  }

  /** Settle whatever is waiting, and remember that nothing else will arrive. */
  #fail(err) {
    this.dead = err;
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  #send(cmd) {
    // `writable` goes false the moment the pipe closes, which is the ordinary
    // state of things during shutdown. Nothing is owed to a process that is
    // already gone, least of all a `quit`.
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(cmd + '\n');
  }

  #onData(chunk) {
    this.buf += chunk.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop(); // keep the partial line for next chunk
    for (const line of lines) this.#onLine(line.trim());
  }

  #onLine(line) {
    if (!this.pending) return;
    const p = this.pending;

    if (p.mode === 'token') {
      if (line.startsWith(p.token)) { this.pending = null; p.resolve(); }
      return;
    }

    if (line.startsWith('info ') && line.includes(' score ')) {
      const parsed = parseInfo(line);
      if (!parsed) return;
      /*
       * Deepest line seen *per multipv index*. Keeping one "deepest" slot for the
       * whole search is wrong the moment MultiPV is above 1: Stockfish emits the
       * indices in order at each depth, so index 2 arrives last and overwrites
       * index 1 at equal depth. The search would then hand back the best move
       * paired with the runner-up's score and pv — and since grade.js reads
       * exactly those fields, every grade would be quietly wrong.
       */
      const prev = p.lines.get(parsed.multipv);
      if (!prev || parsed.depth >= prev.depth) p.lines.set(parsed.multipv, parsed);
      return;
    }

    if (line.startsWith('bestmove')) {
      const bestmove = line.split(/\s+/)[1];
      this.pending = null;
      const lines = [...p.lines.keys()].sort((a, b) => a - b).map((k) => p.lines.get(k));
      const primary = p.lines.get(1) ?? lines[0] ?? null;
      p.resolve({
        bestmove: bestmove === '(none)' ? null : bestmove,
        score: primary?.score ?? null,
        pv: primary?.pv ?? [],
        depth: primary?.depth ?? 0,
        // Best first. One entry unless the caller asked for more, which keeps
        // every existing consumer reading exactly what it read before.
        lines,
      });
    }
  }

  #waitFor(token, trigger) {
    return new Promise((resolve, reject) => {
      this.pending = { mode: 'token', token, resolve, reject };
      trigger();
    });
  }

  /**
   * Analyse a position. Returns the score from the side-to-move's perspective.
   * @param {string} fen
   * @param {number} depth
   * @param {object} [o]
   * @param {number} [o.multipv]  how many lines to report. 1 keeps the result
   *                              identical to a single-line search, which is what
   *                              every grading caller relies on.
   */
  analyse(fen, depth = 18, { multipv = 1 } = {}) {
    // Chain onto the queue so concurrent callers can't interleave their searches.
    const run = () => new Promise((resolve, reject) => {
      // Asking a dead engine would hang: the commands go nowhere and no
      // `bestmove` is ever coming back to resolve this.
      if (this.dead) return reject(this.dead);
      this.pending = { mode: 'search', lines: new Map(), resolve, reject };
      // `setoption` is only legal between searches. Inside the queued run the
      // engine is idle by construction: the previous search resolved on its own
      // `bestmove`, which is the last thing it emits.
      if (multipv !== this.multipv) {
        this.#send(`setoption name MultiPV value ${multipv}`);
        this.multipv = multipv;
      }
      this.#send(`position fen ${fen}`);
      this.#send(`go depth ${depth}`);
    });
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async quit() {
    if (!this.proc) return;
    // `quit` first, so a live engine gets to exit on its own terms; #send is a
    // no-op if it has already gone, which on Ctrl+C is the usual case.
    this.#send('quit');
    const proc = this.proc;
    this.proc = null;
    this.dead ??= new Error('engine stopped');
    proc.kill();
  }
}

/** Pull depth, multipv index, score and pv out of a UCI `info` line. */
export function parseInfo(line) {
  const t = line.split(/\s+/);
  // Absent on a single-line search, where every line is implicitly the first.
  const out = { depth: 0, multipv: 1, score: null, pv: [] };

  for (let i = 0; i < t.length; i++) {
    if (t[i] === 'depth') out.depth = Number(t[i + 1]) || 0;
    else if (t[i] === 'multipv') out.multipv = Number(t[i + 1]) || 1;
    else if (t[i] === 'score') {
      if (t[i + 1] === 'cp') out.score = { cp: Number(t[i + 2]) };
      else if (t[i + 1] === 'mate') out.score = { mate: Number(t[i + 2]) };
    } else if (t[i] === 'pv') { out.pv = t.slice(i + 1); break; }
  }
  return out.score ? out : null;
}
