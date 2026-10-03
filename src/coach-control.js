/**
 * Start, watch and stop the live coach on someone else's behalf.
 *
 * ## Why stopping is a file and not a signal
 *
 * `src/main.js` tears down through `shutdown()`: final PGN, final review, then
 * the overlay, Stockfish and the capture daemon. Reaching that is the whole job
 * here, because the alternative is not "a slightly less tidy exit" — it is three
 * orphaned processes and an always-on-top window with nothing behind it.
 *
 * A signal cannot reach it. On Windows a signal sent from another process does
 * not arrive at Node at all (`tools/play.mjs` records the same finding), and
 * `child.kill()` becomes `TerminateProcess`, which runs no handler.
 *
 * The child's stdin would work — `src/main.js` reads lines from it and its own
 * comment notes the reader behaves the same on a console or a pipe. But a pipe
 * only reaches a child you own, and the case that matters most is the one where
 * you do not: the hub gets restarted, a coach launched from a terminal is still
 * watching a board, and the thing the two share is the filesystem. One channel
 * that covers both beats two channels that each cover half, so this writes `q`
 * to {@link CONTROL_FILE}, which the coach already polls every 150ms.
 *
 * ## No dependency
 *
 * `node:child_process` and `node:fs`, like everything else here.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, PID_FILE } from './config.js';
import { CONTROL_FILE, STATE_FILE } from './overlay.js';

/** How long a stop is given before we admit it did not work. */
const STOP_TIMEOUT_MS = 15_000;

/** How often to look for the pidfile while waiting on a coach we do not own. */
const POLL_MS = 200;

/**
 * Lines of coach output kept for a tab that connects late.
 *
 * Enough to show how the session started and what the last few moves were,
 * which is what someone opening the page actually wants. The log on disk is in
 * `logs/`; this is a window, not a record.
 */
const SCROLLBACK = 500;

/**
 * Is this pid alive?
 *
 * `process.kill(pid, 0)` sends nothing and only asks. On Windows a pid that is
 * gone throws `ESRCH`, but one that is alive and not ours throws `EPERM` — so
 * `EPERM` is a yes, and treating it as a no would make every adopted coach look
 * dead.
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The pidfile, or null if it is absent, unreadable or half-written. */
function readPidFile(file) {
  try {
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(data?.pid) ? data : null;
  } catch {
    return null;              // mid-write, or from another version
  }
}

export class CoachControl {
  /**
   * The three paths are injectable for one reason: tests.
   *
   * Every one of them is a real file in `ROOT` that a live coach is reading or
   * writing, so a test that exercised the defaults would be reaching into a
   * session someone might be in the middle of — writing a stale pidfile under a
   * running coach, or sweeping the control file just as a hint was asked for.
   * Pointing them at a scratch directory is the difference between a test suite
   * you can run while using the app and one you cannot.
   */
  constructor({ pidFile = PID_FILE, controlFile = CONTROL_FILE, stateFile = STATE_FILE } = {}) {
    this.pidFile = pidFile;
    this.controlFile = controlFile;
    this.stateFile = stateFile;
    this.child = null;
    this.startedAt = null;
    this.lines = [];
    this.clients = new Set();
    this.buf = '';
    /*
     * A one-shot tool — calibration, so far. It shares the log with the coach
     * rather than getting a channel of its own, and the two can never overlap:
     * both drive the same screen, so `runOnce` refuses while a coach is up.
     */
    this.oneShot = null;
    this.oneShotLabel = null;
  }

  /**
   * What is running, cheapest question first.
   *
   * `owned` means we spawned it and hold its pipes, so there is a live log.
   * `adopted` means a coach is running that we did not start — the pidfile says
   * so and the pid answers — and all we can offer is the ability to stop it.
   * A pidfile whose pid is gone is swept here rather than reported.
   */
  status() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return { coach: 'owned', pid: this.child.pid, since: this.startedAt, log: true };
    }

    const file = readPidFile(this.pidFile);
    if (file && alive(file.pid)) {
      return { coach: 'adopted', pid: file.pid, since: file.started ?? null, log: false };
    }
    if (file) {
      // It said a coach was here and the pid disagrees: a hard kill, or a crash.
      try { rmSync(this.pidFile, { force: true }); } catch { /* it may be read-only */ }
    }
    return { coach: 'off', pid: null, since: null, log: false };
  }

  /**
   * Spawn a coach.
   *
   * `COACH_DASHBOARD=0` because the hub serves the review itself — two servers
   * would fight over a port, and the one that lost would be the child's, which
   * nobody is looking at anyway.
   */
  start({ all = false, fen = null } = {}) {
    const running = this.status();
    if (running.coach !== 'off') {
      return { error: `a coach is already running (${running.coach}, pid ${running.pid})` };
    }

    const args = [path.join(ROOT, 'src', 'main.js')];
    if (all) args.push('--all');
    if (fen) args.push('--fen', fen);

    this.lines = [];
    this.buf = '';
    this.child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, COACH_DASHBOARD: '0', COACH_OPEN: '0' },
    });
    this.startedAt = new Date().toISOString();

    this.child.stdout.on('data', (d) => this.#ingest(d));
    this.child.stderr.on('data', (d) => this.#ingest(d));
    this.child.on('exit', (code) => {
      this.#push(code ? `[coach exited with code ${code}]` : '[coach stopped]');
      this.child = null;
      this.startedAt = null;
    });
    // A spawn that never got off the ground still has to be reportable.
    this.child.on('error', (e) => this.#push(`[could not start the coach: ${e.message}]`));

    return { ok: true, pid: this.child.pid };
  }

  /**
   * Ask the coach to stop, and wait until it really has.
   *
   * Deliberately never kills. A `TerminateProcess` here would cost the final PGN
   * that `shutdown()` writes and strand the children it would otherwise close,
   * which is the exact damage this class exists to avoid. If the wait runs out,
   * say so and let the caller decide — an honest "it did not stop" beats a
   * silent amputation.
   */
  async stop({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
    const before = this.status();
    if (before.coach === 'off') return { ok: true, was: 'off' };

    const owned = before.coach === 'owned';
    const exited = owned
      ? new Promise((resolve) => this.child.once('exit', resolve))
      : null;

    try {
      this.#command('q');
    } catch (e) {
      return { error: `could not write the stop request: ${e.message}` };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (owned) {
        const done = await Promise.race([
          exited.then(() => true),
          new Promise((r) => setTimeout(() => r(false), POLL_MS)),
        ]);
        if (done) return { ok: true, was: 'owned' };
      } else {
        // No pipe to wait on, so the pidfile is the signal — and because the
        // coach removes it last of all, its absence means the teardown finished.
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (this.status().coach === 'off') return { ok: true, was: 'adopted' };
      }
    }

    return {
      error: 'the coach did not stop within '
        + `${Math.round(timeoutMs / 1000)}s — it may be finishing a review`,
      stillRunning: this.status(),
    };
  }

  /**
   * Tidy up after a coach that was killed rather than stopped.
   *
   * Does not go looking through the process table. Guessing which `powershell`
   * belongs to which dead session is how a cleanup button ends up closing a
   * window someone is using. Instead: ask the overlay to close itself the way it
   * knows how, sweep the files that are definitely stale, and name in words what
   * may still be running so the person can decide.
   */
  cleanupLeftovers() {
    const live = this.status();
    if (live.coach !== 'off') {
      return { error: `a coach is running (${live.coach}, pid ${live.pid}) — stop it first` };
    }

    const done = [];
    if (existsSync(this.stateFile)) {
      // ps/overlay.ps1 polls this and closes the window when it sees `quit`.
      try {
        writeFileSync(this.stateFile + '.tmp', JSON.stringify({ quit: true }));
        renameSync(this.stateFile + '.tmp', this.stateFile);
        done.push('asked a leftover overlay window to close');
      } catch { /* it will be swept below anyway */ }
    }
    for (const [file, label] of [[this.pidFile, '.coach.pid'], [this.controlFile, '.hint-request']]) {
      if (!existsSync(file)) continue;
      try { rmSync(file, { force: true }); done.push(`removed a stale ${label}`); } catch { /* ignore */ }
    }

    return {
      ok: true,
      done,
      warning: 'A capture daemon (ps/capture.ps1) and a Stockfish from a killed '
        + 'session can still be running. Nothing here guesses at those — check '
        + 'Task Manager for powershell.exe and stockfish-windows-x86-64-universal.exe.',
    };
  }

  /** Whether a one-shot tool is in flight, and which. */
  tool() {
    const live = this.oneShot && this.oneShot.exitCode === null && !this.oneShot.killed;
    return { running: live ? this.oneShotLabel : null };
  }

  /**
   * Run a one-shot tool, streaming it into the same log as the coach.
   *
   * Refused while a coach is up, and that is not politeness: calibration spawns
   * a region picker over the whole screen and rewrites `board.json` and
   * `templates/model.json` underneath a session that has those loaded. Letting
   * the two run together would desync a live game and blame the board.
   */
  runOnce({ label, args }) {
    const inFlight = this.tool().running;
    if (inFlight) return { error: `${inFlight} is still running` };

    const live = this.status();
    if (live.coach !== 'off') {
      return { error: `stop the coach first — ${label} drives the same screen` };
    }

    this.oneShotLabel = label;
    this.oneShot = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#push(`[${label} started]`);
    this.oneShot.stdout.on('data', (d) => this.#ingest(d));
    this.oneShot.stderr.on('data', (d) => this.#ingest(d));
    this.oneShot.on('exit', (code) => {
      this.#push(`[${label} ${code ? `failed with code ${code}` : 'finished'}]`);
    });
    this.oneShot.on('error', (e) => this.#push(`[${label} could not start: ${e.message}]`));
    return { ok: true };
  }

  /* ----------------------------------------------------------- the log --- */

  /** Hand a client the scrollback, then every line as it arrives. */
  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    for (const line of this.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  /** Let go of every attached client. The server itself is the hub's to close. */
  detachAll() {
    for (const res of this.clients) { try { res.end(); } catch { /* already gone */ } }
    this.clients.clear();
  }

  /*
   * Chunks are not lines.
   *
   * The same split-and-keep-the-tail used by `src/capture.js`: a write can
   * arrive cut mid-line, and half a verdict pushed to the page as its own event
   * would be worse than a few milliseconds of delay.
   */
  #ingest(chunk) {
    this.buf += chunk.toString();
    const parts = this.buf.split('\n');
    this.buf = parts.pop();
    for (const line of parts) this.#push(line.replace(/\r$/, ''));
  }

  #push(line) {
    this.lines.push(line);
    if (this.lines.length > SCROLLBACK) this.lines.shift();
    const framed = `data: ${JSON.stringify(line)}\n\n`;
    for (const res of this.clients) {
      try { res.write(framed); } catch { this.clients.delete(res); }
    }
  }

  /** One letter, written the way the overlay writes it: tmp then rename. */
  #command(letter) {
    const tmp = this.controlFile + '.tmp';
    writeFileSync(tmp, letter);
    renameSync(tmp, this.controlFile);    // atomic on NTFS
  }
}
