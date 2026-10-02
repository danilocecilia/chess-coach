/**
 * Can the move list be read at all?
 *
 *   node tools/read-panel.mjs --pick        drag a rectangle around the move list
 *   node tools/read-panel.mjs               segment it and report
 *   node tools/read-panel.mjs --art         ...and draw every distinct shape found
 *   node tools/read-panel.mjs --png <file>  re-read a saved capture instead
 *
 * The question this answers is structural, and it needs no labels and no chess:
 * does the panel cut into rows on a fixed pitch, and do the tokens on those
 * rows stack into columns? A move list is a table, and a region that behaves
 * like one is a region worth reading. One that does not cannot be rescued
 * downstream, and the board stays the primary source.
 *
 * What it deliberately does *not* claim is that the runs it cuts are
 * characters. Measured on a real panel they frequently are not — see inkRuns
 * in src/panel.js — which is the finding that decides how recognition has to
 * be built, and the reason the shape report below is labelled as runs
 * throughout rather than quietly called glyphs.
 *
 * Deliberately not wired into the coach. The board pipeline is untouched by
 * everything here.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Capture, flatten } from '../src/capture.js';
import { segment, cut, cluster, rowPitch, columns } from '../src/panel.js';
import { ROOT, PANEL_CONFIG, CAPTURE_DIR } from '../src/config.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flag = (f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1]; };
const ART = has('--art');
const PNG = flag('--png');

/** Run a one-shot PowerShell script and parse its single JSON line. */
function ps(script, argv = []) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'ps', script), ...argv,
    ]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => {
      const line = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
      if (!line) return reject(new Error(`${script} produced no result`));
      const o = JSON.parse(line);
      o.ok ? resolve(o) : reject(new Error(o.error));
    });
  });
}

const RAMP = ' .:-=+*#%@';

/** One glyph as text, which is the fastest way to see whether a cut was clean. */
function art(g, indent = '    ') {
  const lines = [];
  for (let r = 0; r < g.h; r++) {
    let s = indent;
    for (let c = 0; c < g.w; c++) {
      s += RAMP[Math.min(RAMP.length - 1, (g.px[r * g.w + c] * RAMP.length / 256) | 0)];
    }
    lines.push(s);
  }
  return lines;
}

/** Draw several glyphs side by side, top-aligned. */
function artRow(glyphs, indent = '    ') {
  const blocks = glyphs.map((g) => art(g, ''));
  const height = Math.max(...blocks.map((b) => b.length));
  const lines = [];
  for (let r = 0; r < height; r++) {
    let s = indent;
    blocks.forEach((b, i) => {
      s += (b[r] ?? ' '.repeat(glyphs[i].w)) + '  ';
    });
    lines.push(s.trimEnd());
  }
  return lines;
}

async function main() {
  // Re-reading a saved capture, the way tools/replay.mjs re-reads recorded
  // frames: same segmentation, same numbers, no need to have the panel on
  // screen — which is what makes a bad cut arguable about after the fact.
  if (PNG) {
    const img = await ps('read-png.ps1', ['-Path', PNG]);
    console.log(`source:  ${PNG}  (${img.w}x${img.h})`);
    return report({
      pixels: flatten(Buffer.from(img.data, 'base64'), img.stride, img.w, img.h),
      w: img.w, h: img.h,
    }, PNG);
  }

  let region;
  if (has('--pick') || !existsSync(PANEL_CONFIG)) {
    console.log('Drag a rectangle around the move list.\n');
    console.log('Include the move numbers and both move columns. Leave out any');
    console.log('evaluation bars or accuracy graphics down the right-hand edge —');
    console.log('they are solid blocks, not text, and only add shapes to sort out.\n');
    console.log('Drag the whole list container, top to bottom — not a slice of it.');
    console.log('The container stays put on screen while the moves scroll inside it,');
    console.log('so a slice that holds the newest moves in a long game is blank at');
    console.log('the start of one, when the list has two rows at the top.\n');
    console.log('Blank space in the rectangle costs nothing: a row is found where');
    console.log('there is ink, and the threshold is read off a fixed count of the');
    console.log('strongest pixels rather than a share of the region, so an empty');
    console.log('panel and a full one are measured the same way.\n');
    const picked = await ps('pick-region.ps1');
    region = { x: picked.x, y: picked.y, w: picked.w, h: picked.h };
    writeFileSync(PANEL_CONFIG, JSON.stringify({ region }, null, 2));
    console.log(`saved ${PANEL_CONFIG}\n`);
  } else {
    ({ region } = JSON.parse(readFileSync(PANEL_CONFIG, 'utf8')));
  }

  console.log(`region:  ${region.w}x${region.h} at (${region.x}, ${region.y})`);

  const cap = await new Capture(region).start();
  let frame, shot;
  try {
    await new Promise((r) => setTimeout(r, 400));       // let the overlay finish closing
    frame = await cap.grabRaw();
    mkdirSync(CAPTURE_DIR, { recursive: true });
    shot = await cap.snap(path.join(CAPTURE_DIR, 'panel.png'));
  } finally {
    await cap.quit();
  }
  console.log(`capture: ${frame.w}x${frame.h}  ->  ${shot}`);
  console.log(`re-read it later with --png ${shot}`);
  return report(frame, shot);
}

function report(frame, shot) {
  const { map, floor, gap, rows, bars } = segment(frame.pixels, frame.w, frame.h);
  console.log(`ink floor ${floor}   token gap ${gap}px`);
  if (bars.size) {
    const xs = [...bars].sort((a, b) => a - b);
    console.log(`masked ${bars.size} bar column${bars.size > 1 ? 's' : ''}`
      + ` at x${xs[0]}-${xs[xs.length - 1]} — a scrollbar or a rule, not text.`);
  }

  if (!rows.length) {
    console.error(`\nNo text found. Open ${shot} — if that is not the move list,`);
    console.error('re-run with --pick.');
    process.exitCode = 1;
    return;
  }

  /*
   * Row pitch is the panel's version of the board's nine lines: a move list
   * lays its rows out on a fixed step, so an even pitch is evidence the bands
   * really are rows and not an artefact of the threshold. An uneven one says
   * rows were split or merged, which is visible here and nowhere later.
   */
  const { pitch, onPitch, steps } = rowPitch(rows);
  const heights = rows.map((r) => r.band.bottom - r.band.top + 1);

  console.log(`\nrows: ${rows.length}   pitch ${pitch}px, kept by ${onPitch}/${steps}`
    + ` steps   height ${Math.min(...heights)}-${Math.max(...heights)}px`);

  if (steps && onPitch < steps * 0.8) {
    console.warn('warning: the row spacing is uneven, so some band is not one row.');
    console.warn('Usually graphics caught alongside the text — re-pick a narrower');
    console.warn('region, or look at the capture.');
  }

  console.log('\nrows as segmented — each token as its run count:\n');
  for (const [i, r] of rows.entries()) {
    console.log(`  ${String(i + 1).padStart(3)}  y${String(r.band.top).padStart(4)}  `
      + r.tokens.map((t) => `x${String(t[0].x0).padStart(3)}:${'#'.repeat(t.length)}`).join('  '));
  }

  /*
   * The structural check, and the one that says a move list was found rather
   * than some other text: a move list is a table, so its tokens stack into a
   * few columns at fixed x with near-full occupancy. A number column, one or
   * two move columns, and then whatever graphics were caught at the edge —
   * which give themselves away by *not* sharing an x, because a bar drawn to
   * length starts wherever its length puts it.
   *
   * Columns are found by proximity rather than by count: nothing here knows
   * how many a move list ought to have, and a panel that lists only one side
   * has fewer.
   */
  const cols = columns(rows);
  const solid = cols.filter((c) => c.n >= rows.length * 0.5);
  console.log(`\ncolumns: ${cols.length} found, ${solid.length} in half the rows or more`);
  for (const c of solid) {
    console.log(`  x~${String(c.x).padStart(3)}   ${c.n}/${rows.length} rows`
      + `   spread ${c.spread}px`);
  }
  const loose = cols.length - solid.length;
  if (loose) {
    console.log(`  ${loose} other token group${loose > 1 ? 's' : ''} at no shared x`
      + ' — graphics rather than text.');
    console.log('  Harmless to the reading, but re-pick a narrower region to be rid of them.');
  }

  const ok = solid.length >= 2 && onPitch >= steps * 0.8;
  console.log(ok
    ? `\nThis reads as a move list: ${rows.length} rows on a ${pitch}px pitch,`
      + ` ${solid.length} aligned columns.`
    : '\nThis does not have the shape of a move list. Check the capture above.');

  // One row drawn in full. If a cut is wrong this is where it shows, and no
  // amount of arithmetic about shapes would say so.
  const sample = rows[Math.min(2, rows.length - 1)];
  console.log(`\nrow ${rows.indexOf(sample) + 1}, run by run:\n`);
  for (const line of artRow(sample.boxes.map((b) => cut(map, frame.w, b)))) console.log(line);

  /*
   * How much of the alphabet arrives as single characters?
   *
   * A run is a character only when its neighbours happen not to touch it, and
   * at move-list sizes they often do — on a real panel `e4` came back as one
   * 15x10 run and `exd5` as one 29x10 run. So this is not a score to pass. It
   * counts how much free labelled material a panel offers for learning an
   * alphabet, and recognition itself must not lean on it, because which runs
   * are single characters is not knowable from the runs.
   */
  const glyphs = [];
  for (const [i, r] of rows.entries()) {
    for (const box of r.boxes) glyphs.push({ row: i, box, glyph: cut(map, frame.w, box) });
  }
  const { clusters, worstKept, closest } = cluster(glyphs, 100);
  const repeated = clusters.filter((c) => c.members.length > 1);

  console.log(`\nruns: ${glyphs.length} cut into ${clusters.length} distinct shapes,`
    + ` ${repeated.length} seen more than once`);
  console.log(`worst match kept ${worstKept.toFixed(0)},`
    + ` closest refused ${Number.isFinite(closest) ? closest.toFixed(0) : 'none comparable'}`
    + (worstKept > 0 && Number.isFinite(closest)
      ? `  —  ${(closest / worstKept).toFixed(0)}x apart` : ''));
  console.log('A repeated shape is a repeated run, which need not be one character.');

  console.log('\nshapes seen most often:\n');
  for (const cl of (ART ? clusters : repeated.slice(0, 10))) {
    console.log(`  #${cl.id}  seen ${cl.members.length}x   ${cl.centroid.w}x${cl.centroid.h}px`);
    if (ART) for (const line of art(cl.centroid, '      ')) console.log(line);
  }
  if (!ART) console.log('\n  --art draws every shape, which is how a bad cut is spotted.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
