/**
 * The session record: everything the watcher saw, kept.
 *
 * Detection computes a great deal per frame — a cost table, a ranking of every
 * legal move, squares outright wrong, the occlusion mask — and then throws all
 * of it away and keeps one boolean. That is the right shape for running, and
 * useless afterwards: when the tracked position has drifted away from the
 * screen, the numbers that would say *why* were discarded some hundreds of
 * frames ago, and the only evidence left is a line of text saying it happened.
 *
 * So a run writes three things into `logs/<timestamp>/`:
 *
 *   session.jsonl   one event per line: every frame's metrics, every move, every
 *                   recovery attempt *including the refused ones* and why
 *   frames.bin.gz   every frame's pixels, so the decision can be re-run offline
 *                   against different thresholds — see tools/replay.mjs
 *   game.pgn        the game as the coach believed it went, and `game-2.pgn`
 *                   onwards if a new game started while it was watching
 *
 * Keeping the pixels is what makes this a diagnosis rather than a hint. A
 * desync is a disagreement between what we thought and what was on screen, and
 * only one side of that is reconstructable from numbers.
 *
 * ## Cost
 *
 * A frame is 16KB of grayscale at ~6.7 frames a second. Raw that is 400MB an
 * hour, which nobody would leave switched on; gzipped over a mostly-still board
 * it is a small fraction of that, because consecutive frames of a board nobody
 * is touching are identical and deflate's window sees the last one. The metrics
 * line is ~400 bytes.
 *
 * Nothing here is ever awaited by the watch loop. A write that made the poll
 * miss its 150ms budget would change the very behaviour it is meant to observe
 * — dropped frames are how a move gets missed, which is how a desync starts.
 */

import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LOG_DIR } from './config.js';

/** Frame record header: seq and length, so the stream is self-describing. */
const HEADER = 8;

/** Numbers go in rounded: a tenth of a unit of mean squared error is noise. */
const r1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

/** A run whose directory name sorts chronologically and is legal on Windows. */
function stamp(d = new Date()) {
  return d.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

class SessionLog {
  constructor(dir) {
    this.dir = dir;
    this.t0 = Date.now();
    this.seq = 0;
    mkdirSync(dir, { recursive: true });
    this.events = createWriteStream(path.join(dir, 'session.jsonl'), { flags: 'a' });
    this.frames = createWriteStream(path.join(dir, 'frames.bin.gz'));
    this.gzip = createGzip();
    this.gzip.pipe(this.frames);
    // A log that dies must not take the session with it: a full disk is a
    // reason to stop recording, never a reason to stop coaching.
    for (const s of [this.events, this.frames, this.gzip]) {
      s.on('error', (e) => {
        if (this.broken) return;
        this.broken = true;
        console.error('log failed (continuing without it):', e.message);
      });
    }
    this.broken = false;
  }

  get enabled() { return true; }

  /** One event. `data` is merged in flat, so the file greps cleanly. */
  event(ev, data = {}) {
    if (this.broken) return;
    const line = JSON.stringify({ ev, t: Date.now() - this.t0, seq: this.seq, ...data });
    this.events.write(line + '\n');
  }

  /**
   * One frame: its pixels, and the numbers detection drew from them.
   *
   * Called once per poll with everything already computed — this does no
   * measuring of its own, so what the log says is exactly what the watcher
   * acted on rather than a second opinion taken a moment later.
   */
  frame(bytes, det, watcher, extra = {}) {
    if (this.broken) return this.seq++;
    const seq = this.seq++;

    const head = Buffer.allocUnsafe(HEADER);
    head.writeUInt32LE(seq, 0);
    head.writeUInt32LE(bytes.length, 4);
    this.gzip.write(head);
    this.gzip.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));

    this.events.write(JSON.stringify({
      ev: 'frame',
      t: Date.now() - this.t0,
      seq,
      still: r1(det.still),
      score: r1(det.score),
      lead: r1(det.margin),
      stillMisfits: det.stillMisfits,
      bestMisfits: det.bestMisfits,
      occluded: det.occluded,
      top: (det.top ?? []).map((c) => ({
        uci: c.uci, san: c.san, score: r1(c.score), misfits: c.misfits,
      })),
      w: {
        pending: watcher.pending, count: watcher.count,
        lost: watcher.lost, blind: watcher.blind,
        // Only when there was something to refuse, so an idle board does not
        // carry a null field on every frame of a long session.
        ...(watcher.refused ? { refused: watcher.refused } : {}),
      },
      ...extra,
    }) + '\n');
    return seq;
  }

  /**
   * The game as we believed it, written where a chess GUI can open it.
   *
   * Numbered, because a session can outlive a game: the coach now recognises a
   * fresh start position and begins again rather than staying lost, and a
   * second game writing over the first would lose the record of the one that
   * had just finished. The first keeps the plain name so the common case reads
   * the way it always did.
   *
   * @returns {string|null} the file written, for the line that announces it
   */
  pgn(text, n = 1) {
    if (this.broken || !text) return null;
    const name = n > 1 ? `game-${n}.pgn` : 'game.pgn';
    try {
      writeFileSync(path.join(this.dir, name), text + '\n');
      return name;
    } catch { return null; /* disk */ }
  }

  /** Flush and close. Awaited by shutdown, so the last frames survive Ctrl+C. */
  close() {
    if (this.closed) return this.closed;
    this.closed = new Promise((resolve) => {
      let left = 2;
      const done = () => { if (--left === 0) resolve(); };
      this.frames.on('close', done);
      this.events.on('close', done);
      this.gzip.end();       // flushes deflate, which ends `frames`
      this.events.end();
    });
    return this.closed;
  }
}

/** Same shape, no files. What `COACH_LOG=0` hands back. */
class NullLog {
  constructor() { this.seq = 0; this.dir = null; }
  get enabled() { return false; }
  event() {}
  frame() { return this.seq++; }
  pgn() { return null; }
  close() { return Promise.resolve(); }
}

/**
 * Open the log for this run.
 *
 * @param {object} [o]
 * @param {boolean} [o.enabled]  default on: a desync you did not record is a
 *                               desync you have to reproduce
 */
export function openLog({ enabled = process.env.COACH_LOG !== '0', dir = LOG_DIR } = {}) {
  if (!enabled) return new NullLog();
  try {
    return new SessionLog(path.join(dir, stamp()));
  } catch (e) {
    console.error('could not open the session log (continuing without it):', e.message);
    return new NullLog();
  }
}

/** Fingerprint of the templates in use, so a replay knows if they have changed. */
export function fileHash(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 12);
  } catch { return null; }
}

/** Read a session back: the events, and a seq -> frame lookup. See tools/replay.mjs. */
export function readFrames(buf) {
  const frames = new Map();
  let at = 0;
  while (at + HEADER <= buf.length) {
    const seq = buf.readUInt32LE(at);
    const len = buf.readUInt32LE(at + 4);
    if (at + HEADER + len > buf.length) break;          // truncated: a hard kill
    frames.set(seq, new Uint8Array(buf.subarray(at + HEADER, at + HEADER + len)));
    at += HEADER + len;
  }
  return frames;
}
