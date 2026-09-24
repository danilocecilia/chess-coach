/**
 * The session log, tested as what it is: a record that has to survive being
 * read back. A log that loses the frames is worse than no log, because the
 * desync it was recording has already happened by the time you find out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { openLog, readFrames, fileHash } from '../src/log.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'coach-log-'));

/** A frame's worth of bytes with a recognisable pattern. */
const fakeFrame = (fill) => Uint8Array.from({ length: 64 * 256 }, (_, i) => (i + fill) % 256);

const det = {
  still: 12.34, score: 5.678, margin: 41.2, stillMisfits: 3, bestMisfits: 0, occluded: 1,
  top: [{ uci: 'e2e4', san: 'e4', score: 5.678, misfits: 0 },
        { uci: 'd2d4', san: 'd4', score: 60.1, misfits: 2 }],
};
const watcher = { pending: 'e2e4', count: 1, lost: 0, blind: 0 };

test('frames survive the round trip through gzip', async () => {
  const dir = tmp();
  try {
    const log = openLog({ dir });
    const sent = [fakeFrame(0), fakeFrame(7), fakeFrame(200)];
    for (const f of sent) log.frame(f, det, watcher, { fen: 'x' });
    await log.close();

    const gz = readFileSync(path.join(log.dir, 'frames.bin.gz'));
    const back = readFrames(gunzipSync(gz));
    assert.equal(back.size, 3);
    for (const [i, f] of sent.entries()) {
      assert.deepEqual([...back.get(i)], [...f], `frame ${i} came back changed`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every frame writes one metrics line, in order, with the numbers it judged on', async () => {
  const dir = tmp();
  try {
    const log = openLog({ dir });
    log.event('start', { fen: 'start' });
    log.frame(fakeFrame(1), det, watcher, { fen: 'a', settled: true });
    log.frame(fakeFrame(2), det, { ...watcher, lost: 4 }, { fen: 'b', settled: false });
    log.event('desync', { wrong: [{ sq: 'e4' }] });
    await log.close();

    const lines = readFileSync(path.join(log.dir, 'session.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.ev), ['start', 'frame', 'frame', 'desync']);
    assert.deepEqual(lines.map((l) => l.seq), [0, 0, 1, 2]);
    assert.equal(lines[1].fen, 'a');
    assert.equal(lines[2].w.lost, 4);
    // Rounded, but never to the point of losing which side of a limit it fell.
    assert.equal(lines[1].score, 5.7);
    assert.equal(lines[1].stillMisfits, 3);
    assert.equal(lines[1].top[0].uci, 'e2e4');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a truncated log still reads — a hard kill is when you most need it', async () => {
  const dir = tmp();
  try {
    const log = openLog({ dir });
    log.frame(fakeFrame(3), det, watcher, {});
    log.frame(fakeFrame(4), det, watcher, {});
    await log.close();

    const whole = gunzipSync(readFileSync(path.join(log.dir, 'frames.bin.gz')));
    // Cut the last frame in half, as a kill mid-write would.
    const cut = readFrames(whole.subarray(0, whole.length - 5000));
    assert.equal(cut.size, 1);
    assert.deepEqual([...cut.get(0)], [...fakeFrame(3)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('COACH_LOG=0 writes nothing and still answers every call', async () => {
  const dir = tmp();
  try {
    const log = openLog({ enabled: false, dir });
    assert.equal(log.enabled, false);
    log.event('start', {});
    assert.equal(log.frame(fakeFrame(0), det, watcher, {}), 0);
    assert.equal(log.frame(fakeFrame(0), det, watcher, {}), 1);   // seq still advances
    log.pgn('1. e4');
    await log.close();
    assert.equal(existsSync(path.join(dir, 'session.jsonl')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the PGN is written where a chess GUI can open it', async () => {
  const dir = tmp();
  try {
    const log = openLog({ dir });
    log.pgn('1. e4 e5 2. Nf3');
    await log.close();
    assert.match(readFileSync(path.join(log.dir, 'game.pgn'), 'utf8'), /1\. e4 e5 2\. Nf3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a second game does not write over the first', async () => {
  // A session can outlive a game now: the ladder recognises a fresh start
  // position and begins again, and the game that just finished is only on disk.
  const dir = tmp();
  try {
    const log = openLog({ dir });
    assert.equal(log.pgn('1. e4 e5 2. Nf3', 1), 'game.pgn');
    assert.equal(log.pgn('1. d4 d5', 2), 'game-2.pgn');
    await log.close();
    assert.match(readFileSync(path.join(log.dir, 'game.pgn'), 'utf8'), /1\. e4 e5 2\. Nf3/);
    assert.match(readFileSync(path.join(log.dir, 'game-2.pgn'), 'utf8'), /1\. d4 d5/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fileHash fingerprints the templates, and says so rather than throwing', async () => {
  assert.equal(fileHash(path.join(os.tmpdir(), 'no-such-model.json')), null);
  const dir = tmp();
  try {
    const log = openLog({ dir });
    log.pgn('x');
    assert.match(fileHash(path.join(log.dir, 'game.pgn')), /^[0-9a-f]{12}$/);
    await log.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
