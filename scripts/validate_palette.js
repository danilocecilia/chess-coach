/**
 * The contrast checker this project has been citing but never had.
 *
 * `report.js` has carried a comment since the first commit claiming the palette
 * was "validated against both surfaces (`scripts/validate_palette.js`: all
 * checks pass, ≥3:1 on each)". The file was never committed, so the claim was
 * honour-system — and the palette has now been replaced wholesale by a design
 * system that states a specific ratio in almost every token's usage note. A
 * claim that specific should be executable.
 *
 * ## What it does and does not check
 *
 * Only pairs that actually meet on screen, and only at the threshold the pair
 * genuinely needs. Over-strict checking is its own failure: a validator that
 * cries about a chart gridline gets switched off, and then nothing is checked.
 *
 * So: text is held to 4.5:1, marks and large text to 3:1, and decoration — the
 * hairlines, the gridlines, the board — to nothing at all. `muted` is checked
 * on `plane` and `surface` but deliberately NOT on `surface-raised`, because
 * the design system's own rule is that it never goes there (it would be 4.4:1,
 * and `secondary` is what belongs on a raised fill).
 *
 * Run it directly (`node scripts/validate_palette.js`) for the table;
 * `tests/palette.test.js` runs the same checks as part of `npm test`.
 */

import { pathToFileURL } from 'node:url';
import { INK, FIXED } from '../src/report.js';
import { LABELS } from '../src/verdict.js';

/** sRGB channel to linear light, per WCAG 2.1. */
const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Relative luminance of a `#rgb` or `#rrggbb`. */
export function luminance(hex) {
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not an opaque hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two opaque colours, 1 to 21. */
export function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = 4.5;
const LARGE = 3;

/**
 * Every pair worth holding to a number, in both themes.
 *
 * `need` is the threshold and `why` is the sentence that should appear if it
 * ever fails — the point of a check is to say what to do about it.
 */
function pairs(mode) {
  const ink = INK[mode];
  const on = (name) => ink[name];
  const out = [];

  const add = (fg, bg, need, what) => out.push({ mode, fg, bg, need, what });

  for (const ground of ['plane', 'surface', 'surface-raised']) {
    add(on('primary'), on(ground), TEXT, `primary text on ${ground}`);
    add(on('secondary'), on(ground), TEXT, `secondary text on ${ground}`);
  }
  // muted is a small label, and the design system restricts it to these two.
  for (const ground of ['plane', 'surface']) {
    add(on('muted'), on(ground), TEXT, `muted label on ${ground}`);
  }

  for (const ground of ['plane', 'surface']) {
    add(on('series'), on(ground), LARGE, `chart mark on ${ground}`);
    add(on('brand-ink'), on(ground), LARGE, `brand mark and focus ring on ${ground}`);
  }
  // The meter bar sits on a raised track, not on the page.
  add(on('brand-ink'), on('surface-raised'), LARGE, 'accuracy meter on its track');

  // The verdict line is the one place a grade colour is the text itself, and it
  // is set at 24px+ bold precisely so 3:1 is the bar it has to clear.
  add(LABELS.BLUNDER.color, on('surface'), LARGE, 'Blunder as a verdict line on surface');

  return out;
}

/** The theme-independent pairs: ink on the brand green and on each grade. */
function fixedPairs() {
  const out = [{ mode: 'any', fg: FIXED['on-brand'], bg: FIXED.brand, need: TEXT, what: 'on-brand text on brand' }];
  for (const l of Object.values(LABELS)) {
    out.push({
      mode: 'any', fg: FIXED['on-grade'], bg: l.color, need: TEXT,
      what: `grade badge glyph on ${l.name}`,
    });
  }
  // The overlay is always dark, whatever the report is set to.
  for (const k of ['overlay-verdict', 'overlay-eval', 'overlay-why', 'overlay-hint']) {
    out.push({
      mode: 'any', fg: FIXED[k], bg: FIXED['overlay-bg'], need: k === 'overlay-eval' ? LARGE : TEXT,
      what: `${k} on the overlay panel`,
    });
  }
  return out;
}

/** Every check, with the ratio each pair actually achieves. */
export function check() {
  return [...pairs('dark'), ...pairs('light'), ...fixedPairs()]
    .map((c) => ({ ...c, got: ratio(c.fg, c.bg) }))
    .map((c) => ({ ...c, ok: c.got >= c.need }));
}

// pathToFileURL rather than string-building: on Windows argv[1] is a drive path
// and the hand-rolled comparison silently never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = check();
  for (const r of rows) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    console.log(
      `${mark} ${r.got.toFixed(2).padStart(5)}:1  (needs ${r.need})  ${r.mode.padEnd(5)} ${r.what}`,
    );
  }
  const bad = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - bad.length}/${rows.length} pass`);
  if (bad.length) process.exitCode = 1;
}
