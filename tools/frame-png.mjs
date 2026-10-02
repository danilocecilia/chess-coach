/**
 * What the coach actually saw, as a picture.
 *
 *   node tools/frame-png.mjs                      newest session, first settled frame
 *   node tools/frame-png.mjs logs/<id> <seq>      a particular frame
 *   node tools/frame-png.mjs logs/<id> <seq> out.png 6
 *
 * Every other diagnostic here reports the board as numbers, which answers "how
 * badly does this fit" but never "what is on the screen". A recorded frame is
 * 64 grayscale tiles and nothing else, so it can be laid back out as an image
 * and looked at — which is how a theme change, a board that is the other way
 * round, and a region that has slipped are each obvious in one glance and
 * nearly indistinguishable in a table of costs.
 *
 * Written as a grayscale PNG with no dependencies: the tiles are already luma,
 * and zlib is in the standard library.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync, deflateSync, constants } from 'node:zlib';
import path from 'node:path';
import { readFrames } from '../src/log.js';
import { SAMPLE, SQ_BYTES } from '../src/capture.js';
import { LOG_DIR } from '../src/config.js';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));

/** CRC table, built once. Declared up here because the work below is top-level. */
let TABLE = null;

function newest() {
  if (!existsSync(LOG_DIR)) return null;
  const runs = readdirSync(LOG_DIR)
    .filter((d) => existsSync(path.join(LOG_DIR, d, 'frames.bin.gz'))).sort();
  return runs.length ? path.join(LOG_DIR, runs[runs.length - 1]) : null;
}

const dir = positional[0] ?? newest();
if (!dir) {
  console.error('No session logs found. Run `npm start` first, or pass a directory.');
  process.exit(1);
}

const frames = readFrames(gunzipSync(readFileSync(path.join(dir, 'frames.bin.gz')),
  { finishFlush: constants.Z_SYNC_FLUSH }));
const seqs = [...frames.keys()].sort((a, b) => a - b);
// Frame 0 has no predecessor to be compared against, so it is never recorded as
// settled; the one after it is the first that can be.
const seq = positional[1] != null ? Number(positional[1]) : seqs[1] ?? seqs[0];
const out = positional[2] ?? path.join(dir, `frame-${seq}.png`);
const scale = Number(positional[3] ?? 4);

const bytes = frames.get(seq);
if (!bytes) {
  console.error(`frame ${seq} is not in this log (have ${seqs[0]}..${seqs[seqs.length - 1]})`);
  process.exit(1);
}

// Tiles are square-major, a8 first and h1 last, so square s sits at row s>>3,
// column s&7 of the image — image order, not board order: this is the screen as
// it looked, with no orientation applied.
const side = 8 * SAMPLE;
const img = new Uint8Array(side * side);
for (let s = 0; s < 64; s++) {
  const tile = bytes.subarray(s * SQ_BYTES, (s + 1) * SQ_BYTES);
  const ry = (s >> 3) * SAMPLE, rx = (s & 7) * SAMPLE;
  for (let r = 0; r < SAMPLE; r++) {
    for (let c = 0; c < SAMPLE; c++) img[(ry + r) * side + rx + c] = tile[r * SAMPLE + c];
  }
}

// Nearest-neighbour, so a pixel stays a pixel: the point is to see what the
// model saw, not a prettier version of it. White grid lines mark the square
// boundaries the capture used, which is what makes a slipped region visible.
const W = side * scale;
const px = new Uint8Array(W * W);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) px[y * W + x] = img[((y / scale) | 0) * side + ((x / scale) | 0)];
}
for (let k = 0; k <= 8; k++) {
  const p = Math.min(k * SAMPLE * scale, W - 1);
  for (let i = 0; i < W; i++) { px[p * W + i] = 255; px[i * W + p] = 255; }
}

writeFileSync(out, png(px, W));
console.log(`${path.basename(dir)}  frame ${seq}  ->  ${out}`);

/** Minimal 8-bit grayscale PNG. */
function png(pixels, size) {
  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0;                                   // filter: none
    Buffer.from(pixels.subarray(y * size, (y + 1) * size)).copy(raw, y * (size + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;                                                 // bit depth
  ihdr[9] = 0;                                                 // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  TABLE ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
