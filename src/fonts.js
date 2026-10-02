/**
 * The two typefaces, carried inside the page.
 *
 * ## Why base64 and not a stylesheet link
 *
 * The design system asks for Figtree and JetBrains Mono, and the obvious way to
 * get them is the `@import` Google Fonts hands you. This page cannot take it.
 * `report.js` promises a file you double-click that works with the network off,
 * and two tests hold it to that — `tests/report.test.js` rejects any `src=` or
 * `href=` pointing at http, and `tests/play-page.test.js` rejects any `<link>`
 * at all.
 *
 * An `@import` inside `<style>` would in fact slip past both regexes: it is
 * neither an attribute nor a tag. That is the argument against it. The tests
 * say "no external script, style or font" and "nothing may be fetched", and a
 * rule you keep only where the check can see you is not a rule. Inlined bytes
 * are the honest version of the same intent, and they are the only version that
 * still renders on a train.
 *
 * ## Why two files for five weights
 *
 * Both families are variable fonts, so Google serves one file per family across
 * the whole weight axis — the five URLs its CSS returns for 500/700/800 are
 * byte-identical. Declaring a range (`font-weight: 500 800`) against one file is
 * what the format is for, and it costs 52KB raw rather than 125KB.
 *
 * Latin subset only. The page is English, the glyphs it actually needs beyond
 * ASCII are the grade marks (`★` `✓`), and those come from the UI font already.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');

/**
 * One `@font-face`, with the file in it.
 *
 * `font-display: swap` so the text is readable while the face decodes — on a
 * `file://` page that is a few milliseconds, but the fallback metrics are close
 * enough that the reflow does not jump.
 */
function face(family, file, weights) {
  const b64 = readFileSync(path.join(FONT_DIR, file)).toString('base64');
  return `@font-face {
    font-family: "${family}"; font-style: normal; font-weight: ${weights}; font-display: swap;
    src: url(data:font/woff2;base64,${b64}) format("woff2");
  }`;
}

/**
 * The faces, as CSS, ready to sit at the top of a page's one <style> block.
 *
 * Read once at module load: both pages are generated in the same process and
 * the files never change under us.
 */
export const FONTS = [
  face('Figtree', 'Figtree-var.woff2', '500 800'),
  face('JetBrains Mono', 'JetBrainsMono-var.woff2', '500 700'),
].join('\n');

/**
 * The stacks themselves.
 *
 * Segoe UI stays behind Figtree rather than being replaced by it. If the woff2
 * ever fails to decode the page is still set in something sane, and on the
 * machine this runs on Segoe is always there.
 */
export const SANS = '"Figtree", "Segoe UI", system-ui, -apple-system, sans-serif';
export const MONO = '"JetBrains Mono", Consolas, ui-monospace, monospace';
