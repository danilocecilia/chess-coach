/**
 * Node-side client for ps/capture.ps1.
 *
 * The daemon is long-lived: PowerShell takes ~200ms to start, which would
 * dominate everything if we spawned per frame.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

/*
 * Pixels per square edge. 8 leaves only 64 numbers to tell a rook from a bishop,
 * which measured a detection margin of 6.2 against a threshold of 6 on a real
 * board — passing, but with nothing to spare. 16 measures 17.0.
 *
 * This number used to be capped by the repack loop. That loop ran in PowerShell
 * and grew as the square of this — 35ms/frame at 8, 56ms at 16, 105ms at 24,
 * against a 150ms poll — so 16 was simply the largest value that still fit. The
 * loop now runs here instead (see repack), where the same work costs about a
 * millisecond, and the frame budget no longer picks this number.
 *
 * Raising it is still not free, though: templates/model.json stores tiles of
 * SQ_BYTES floats, so changing SAMPLE invalidates any existing calibration and
 * every recorded session log alongside it.
 */
export const SAMPLE = 16;
export const SQ_BYTES = SAMPLE * SAMPLE;

/**
 * Raw BGRA rows from the daemon -> grayscale square-major tiles.
 *
 * Named for the direction it runs: grid.js exports an `unpack` that goes the
 * other way, square-major tiles back to a plain image. They are inverses, so
 * importing both into one module reads badly unless the names disagree.
 *
 * This is the loop that used to live in capture.ps1, moved here verbatim: same
 * Rec. 601 weights, same integer maths, same output bytes. That equivalence is
 * load-bearing — templates/model.json was calibrated against frames this loop
 * produced, and recorded sessions are replayed through the same templates, so
 * drifting by even one luma level here would quietly bias every match.
 *
 * Which is also why the rounding is spelled out. PowerShell's [byte] cast goes
 * through Convert.ToByte, which rounds half to *even*; assigning a float into a
 * Uint8Array truncates instead. Those disagree on exact .5 values, so we round
 * the way .NET did rather than the way JavaScript would. tests/capture.test.js
 * pins that with triples where the two rules give different answers.
 *
 * It held in the field too, which is better evidence than the tests: a later
 * recalibration of the same board through this loop reproduced the pre-change
 * numbers exactly — floor 15, allow 110, squareLimit 200.
 */
/**
 * One BGRA pixel at `p` -> one grey level, rounded the way .NET rounded it.
 *
 * Extracted so there is exactly one copy of this rule. The frames every
 * template was calibrated against came through it, so a second implementation
 * that drifted by a level would bias matches without ever failing loudly —
 * tests/capture.test.js pins the half-to-even cases that tell the two rules
 * apart.
 */
export function luma(raw, p) {
  const n = raw[p + 2] * 299 + raw[p + 1] * 587 + raw[p] * 114;
  const q = (n / 1000) | 0;
  const rem = n - q * 1000;
  return rem > 500 || (rem === 500 && (q & 1)) ? q + 1 : q;
}

export function repack(raw, stride, sample = SAMPLE) {
  const out = new Uint8Array(64 * sample * sample);
  for (let sq = 0; sq < 64; sq++) {
    const sr = Math.floor(sq / 8) * sample;   // top pixel row of this square
    const sc = (sq % 8) * sample;             // left pixel col of this square
    const base = sq * sample * sample;
    for (let r = 0; r < sample; r++) {
      const rowOff = (sr + r) * stride;
      for (let c = 0; c < sample; c++) {
        out[base + r * sample + c] = luma(raw, rowOff + (sc + c) * 4);
      }
    }
  }
  return out;
}

/** Full-resolution BGRA rows -> a plain grayscale image, row-major. */
export function flatten(raw, stride, w, h) {
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    const rowOff = r * stride, dst = r * w;
    for (let c = 0; c < w; c++) out[dst + c] = luma(raw, rowOff + c * 4);
  }
  return out;
}

export class Capture {
  constructor({ x, y, w, h, sample = SAMPLE }) {
    Object.assign(this, { x, y, w, h, sample });
    this.proc = null;
    this.buf = '';
    this.waiters = [];                // FIFO: one per outstanding command
    this.dead = null;                 // the error that ended the daemon, once it has
  }

  async start() {
    const script = path.join(ROOT, 'ps', 'capture.ps1');
    this.proc = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-X', this.x, '-Y', this.y, '-W', this.w, '-H', this.h, '-Sample', this.sample,
    ].map(String), { stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (d) => this.#onData(d));
    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error('[capture]', s);
    });

    /*
     * See the matching comment in engine.js. Windows delivers Ctrl+C to every
     * process on the console, so the daemon is usually gone before we send it
     * `quit`; the write then fails asynchronously as an `error` event that no
     * try/catch around the write can catch, and an unhandled one is fatal.
     */
    this.proc.stdin.on('error', () => {});

    // A daemon that dies mid-session must settle the outstanding commands.
    // Otherwise `grab` never resolves and the watch loop stops dead without
    // saying anything — main.js is ready for a rejection, not for silence.
    this.proc.on('exit', (code, signal) => {
      this.#abort(new Error(`capture daemon exited (${signal ?? `code ${code}`})`));
    });

    const hello = await this.#next();   // daemon announces readiness
    if (!hello.ready) throw new Error('capture daemon failed to start');
    return this;
  }

  #onData(chunk) {
    this.buf += chunk.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      const w = this.waiters.shift();
      if (!w) continue;
      try {
        const o = JSON.parse(t);
        o.ok ? w.resolve(o) : w.reject(new Error(o.error ?? 'capture failed'));
      } catch (e) { w.reject(e); }
    }
  }

  #next() {
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Fail every outstanding command, and every later one. */
  #abort(err) {
    this.dead = err;
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w.reject(err);
  }

  #cmd(line) {
    // Nothing would ever answer, so say so now rather than wait forever.
    if (this.dead) return Promise.reject(this.dead);
    if (!this.proc?.stdin.writable) return Promise.reject(new Error('capture daemon is gone'));
    const p = this.#next();
    this.proc.stdin.write(line + '\n');
    return p;
  }

  /** @returns {Uint8Array} 64 squares * SQ_BYTES grayscale, a8 first, h1 last. */
  async grab() {
    const { data, stride } = await this.#cmd('grab');
    return repack(Buffer.from(data, 'base64'), stride, this.sample);
  }

  /**
   * The region at native resolution, grayscale.
   *
   * For the move list, where `grab`'s downsample would leave a glyph a few
   * pixels across. Costs the full region per call rather than 16KB, so it is
   * not something to put on the board's poll.
   *
   * @returns {{pixels: Uint8Array, w: number, h: number}}
   */
  async grabRaw() {
    const { data, stride, w, h } = await this.#cmd('raw');
    return { pixels: flatten(Buffer.from(data, 'base64'), stride, w, h), w, h };
  }

  /** Full-resolution PNG, used once at calibration for the vision call. */
  async snap(file) {
    const { path: p } = await this.#cmd(`snap ${file}`);
    return p;
  }

  async region(x, y, w, h) {
    Object.assign(this, { x, y, w, h });
    return this.#cmd(`region ${x} ${y} ${w} ${h}`);
  }

  async quit() {
    if (!this.proc) return;
    // Ask it to go before killing it, but only if it is still there to ask.
    if (this.proc.stdin.writable) this.proc.stdin.write('quit\n');
    const proc = this.proc;
    this.proc = null;
    this.#abort(new Error('capture stopped'));
    proc.kill();
  }
}

/** Slice one square's tile out of a frame. */
export function square(frame, sq) {
  return frame.subarray(sq * SQ_BYTES, (sq + 1) * SQ_BYTES);
}
