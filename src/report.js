/**
 * The review, as a page you can actually read.
 *
 * A terminal dump answers "how did that game go" and nothing else. The question
 * this project is for — *what do I keep getting wrong* — only has an answer
 * across games, and comparing twelve sessions by scrolling back through twelve
 * terminals is not comparing them at all. So the reviews are written out as one
 * page, newest first, with the habits ranked above the games that evidence them.
 *
 * ## Why a generated file and not a server
 *
 * Everything is inlined — the data as JSON in a script tag, the CSS, the charts
 * drawn by a few dozen lines of vanilla JS. No server, no build step, no CDN, no
 * dependency, and it works with the network off.
 *
 * That is not only taste. A `file://` page cannot `fetch` its siblings, so a
 * page that read `logs/*​/review.json` at load time would need a web server in
 * front of it — a process to start, a port to pick and something else to fail
 * before you can look at your own games. Inlining is what keeps it a file you
 * double-click. A season of games is a few hundred KB of JSON, which is less
 * than one of the frames this project logs every 150ms.
 *
 * ## Colour
 *
 * Marks are one hue, because every chart here shows one measure. Charts with a
 * series per fault would need a categorical palette, and there is nothing
 * categorical to say: "which habit cost the most" is a magnitude, and magnitude
 * is a bar.
 *
 * The grade colours are the ones `verdict.js` already gives the overlay, so a
 * Blunder is the same red in both places. They are used only as a tint behind a
 * written label, never as the thing that tells two values apart — measured as a
 * palette they fail outright, and they should: `Best` #81b64c and `Good` #95b776
 * are 5.6 ΔE apart, which is a distinction no reader can make and the site they
 * come from never asks anyone to. Beside the word "Blunder" the colour is
 * reinforcement, and reinforcement is all it has to be.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { LABELS } from './verdict.js';
import { FAULTS, reviewAll } from './review.js';
import { LOG_DIR, ROOT } from './config.js';
import { FONTS, SANS, MONO } from './fonts.js';
import { OVERLAY_INK } from './overlay.js';

/** Where the page is written. One file, so a bookmark keeps working. */
export const REPORT_FILE = path.join(ROOT, 'reports', 'index.html');

/**
 * The ink, in both themes, from the Chess Coach design system.
 *
 * Checked rather than asserted: `scripts/validate_palette.js` holds every pair
 * that actually meets on screen to 4.5:1 as text and 3:1 as a mark, in both
 * themes, and `tests/palette.test.js` runs it with the suite. It is worth
 * having — it caught the design system handing one green to both the brand fill
 * and the focus ring, which is 2.1:1 on a white page.
 */
/*
 * Exported so the play page is the same page, visually.
 *
 * `src/play-page.js` is a second generated page, and the one thing it must not
 * do is invent a second palette: two pages of the same tool whose boards are
 * slightly different greens is the kind of detail that reads as a bug. Only the
 * tokens are shared — the pages build their own CSS from them, because what they
 * lay out has nothing in common.
 */
export const INK = {
  dark: { surface: '#262421', plane: '#302e2b', 'surface-raised': '#3c3936',
    primary: '#ffffff', secondary: '#c3c2c0', muted: '#a8a6a3',
    grid: '#3c3936', axis: '#4b4845', series: '#5c9ded',
    border: 'rgba(255,255,255,0.06)',
    'brand-ink': '#81b64c',
    'shadow-press-neutral': '0 4px 0 0 rgba(0,0,0,0.35)',
    'shadow-float': '0 8px 24px rgba(0,0,0,0.45)',
    // A board is a picture, not data ink, so it keeps its own two shades — but
    // dimmed here, because a full-brightness board on a dark page is the one
    // thing on it bright enough to read as a lamp. The design system flattened
    // these to one pair for both themes; the lamp is still real, so they stay
    // split and only the light pair takes its values.
    'board-light': '#b3b79c', 'board-dark': '#5c7043' },
  light: { surface: '#ffffff', plane: '#f2f1ee', 'surface-raised': '#e8e6e1',
    primary: '#1c1a18', secondary: '#4f4c48', muted: '#66635e',
    grid: '#e3e1dc', axis: '#c9c6c0', series: '#2a78d6',
    border: 'rgba(28,26,24,0.08)',
    // The coach green is a 2.1:1 mark on a white page. As a fill it is fine —
    // the ink on it is dark — but a focus ring and a meter bar are marks, and
    // the design system only ever measured this green against dark. The light
    // theme takes the pressed green instead, which is the same hue three stops
    // down and already in the palette.
    'brand-ink': '#45753c',
    'shadow-press-neutral': '0 4px 0 0 rgba(28,26,24,0.18)',
    'shadow-float': '0 8px 24px rgba(28,26,24,0.16)',
    'board-light': '#ebecd0', 'board-dark': '#739552' },
};

/**
 * The tokens that do not turn with the theme.
 *
 * The coach green is the one colour the product owns, and a green that shifted
 * between themes would stop being that. The overlay set is here for the same
 * reason from the other direction: that panel floats over the chess site in its
 * own dark, whatever the report is set to.
 *
 * `focus` is the brand green rather than a fourth blue, because a focus ring is
 * the only mark on the page that has to be found rather than read.
 */
export const FIXED = {
  brand: '#81b64c', 'brand-press': '#45753c', 'on-brand': '#1c1a18', focus: 'var(--brand-ink)',
  'on-grade': '#1c1a18',
  'board-highlight': 'rgba(246,246,105,0.55)',
  'overlay-bg': OVERLAY_INK.bg, 'overlay-verdict': OVERLAY_INK.verdict,
  'overlay-eval': OVERLAY_INK.eval, 'overlay-why': OVERLAY_INK.why,
  'overlay-hint': OVERLAY_INK.hint,
  'shadow-press': '0 4px 0 0 #45753c',
  'radius-sm': '5px', radius: '8px', 'radius-pill': '999px',
};

/**
 * The two squares a move touches, marked on the board.
 *
 * The same two colours the grades already use, for the same two meanings: the
 * move you played is a Blunder red, the move that was there is a Best green. A
 * third meaning would need a third colour nobody has learned yet; these two are
 * on every other row of the page.
 *
 * Theme-independent, because they are laid over the board's own shades rather
 * than over the page, and the board does not change with the theme.
 */
export const MARK = { played: '#fa412d', best: '#81b64c' };

/**
 * A move in notation, read out in words: `Nxf8` -> "knight takes on f8".
 *
 * ## Why it is structural, and not looked up in the position
 *
 * With the position in hand this could say far more — *which* knight, and what
 * it took. It deliberately does not. Half the moves on this page are inside
 * variations the engine returned, where no position was ever stored, and a
 * reading that works on the move you played but not on the three that answer it
 * teaches the notation in exactly the half of the cases where it is already
 * obvious. Structure is also the thing being learned: that the capital letter is
 * the piece, that `x` is a capture, that the square comes last.
 *
 * ## Why it lives here and is shipped as source
 *
 * It is embedded into the page by `String(sanWords)` rather than written inside
 * the page script, so it can be exported and unit-tested as an ordinary
 * function. Everything it needs is inside it — nothing is closed over, because
 * on the other side of that trip there is nothing to close over.
 *
 * Returns null for anything that is not a move, which is what keeps this off
 * free text: `your pawn on f5` contains a square, not a move, and a tooltip
 * reading "pawn to f5" over it would be teaching the notation wrongly.
 */
export function sanWords(san) {
  const NAME = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
  const s = String(san == null ? '' : san).trim().replace(/[!?]+$/, '');
  const end = (t) => (/#$/.test(s) ? t + ', checkmate' : /\+$/.test(s) ? t + ', with check' : t);

  if (/^(?:O-O-O|0-0-0)[+#]?$/.test(s)) return end('castles queenside');
  if (/^(?:O-O|0-0)[+#]?$/.test(s)) return end('castles kingside');

  const m = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?[+#]?$/.exec(s);
  if (!m) return null;

  /*
   * A pawn move never says where it came from except to name the file it
   * captures from: `d5` and `exd5` are moves, `d4d5` is not — that is UCI, and
   * reading it as "the pawn on d4 to d5" would put a confident sentence under
   * something this page never writes. Refusing leaves it as plain text.
   */
  if (!m[1] && (m[3] || (m[2] && !m[4]))) return null;
  const piece = m[1] ? NAME[m[1]] : 'pawn';

  // Where it came from, when the notation had to say — two pieces of the same
  // kind could have gone there, which is the whole reason the letter is there.
  let who = piece;
  if (m[2] && m[3]) who = 'the ' + piece + ' on ' + m[2] + m[3];
  else if (m[2]) who = 'the ' + piece + ' on the ' + m[2] + '-file';
  else if (m[3]) who = 'the ' + piece + ' on rank ' + m[3];

  const verb = m[4] ? ' takes on ' : ' to ';
  const promo = m[6] ? ', promoting to a ' + NAME[m[6]] : '';
  return end(who + verb + m[5] + promo);
}

/** JSON safe to sit inside a <script> tag. */
function embed(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export const vars = (mode) => Object.entries(INK[mode])
  .map(([k, v]) => `    --${k}: ${v};`).join('\n')
  + '\n' + Object.entries(MARK).map(([k, v]) => `    --mark-${k}: ${v};`).join('\n');

/**
 * The tokens written once, at the top: the theme-independent set, the radii,
 * and the grade scale.
 *
 * The grade colours are derived from `LABELS` rather than written out again, so
 * `verdict.js` stays the one place a Blunder is told what colour it is. The CSS
 * wants them as custom properties (`--grade-blunder`), the page script wants
 * them as data (`R.gradeColors`), and both come off the same object.
 */
export const fixedVars = () => Object.entries(FIXED)
  .map(([k, v]) => `    --${k}: ${v};`).join('\n')
  + '\n' + Object.values(LABELS)
    .map((l) => `    --grade-${l.name.toLowerCase()}: ${l.color};`).join('\n');

/*
 * Dark is the default, and light is the alternate — the reverse of how this
 * page started. The product is read beside a chess board on a dark site, and a
 * white page next to it is the thing you notice instead of the position.
 */
const STYLE = `
${FONTS}

  :root {
    color-scheme: dark;
${fixedVars()}
${vars('dark')}
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      color-scheme: light;
${vars('light')}
    }
  }
  :root[data-theme="light"] {
    color-scheme: light;
${vars('light')}
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 16px 96px;
    background: var(--plane);
    color: var(--primary);
    font: 500 15px/22px ${SANS};
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; margin: 0 auto; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  /* Hierarchy is weight, not colour: 800 for the page's one h1, 700 for the
     sections under it. The old h2 was a 12px uppercase label in muted, which
     made every section heading read as a form field. */
  h1 { font-size: 32px; line-height: 38px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 4px; }
  h2 {
    font-size: 20px; line-height: 26px; font-weight: 700; letter-spacing: -0.01em;
    margin: 40px 0 16px;
  }
  .sub { color: var(--secondary); margin: 0 0 8px; }
  .note { color: var(--muted); font-size: 13px; line-height: 18px; }
  /* The one uppercase style: stat keys, table headers, tags. */
  .label {
    font-size: 12px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--muted);
  }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px;
  }

  /* Stat tiles: the number is the chart. */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; }
  .tile .k {
    font-size: 12px; line-height: 16px; font-weight: 700; color: var(--muted);
    letter-spacing: 0.06em; text-transform: uppercase;
  }
  .tile .v { font-size: 34px; line-height: 40px; font-weight: 800; letter-spacing: -0.02em; margin-top: 4px; }
  /* A tile whose value is a phrase, not a figure: 34px wraps and bursts the card. */
  .tile .v.word { font-size: 20px; line-height: 40px; font-weight: 700; letter-spacing: -0.01em; }
  .tile .u { font-size: 18px; font-weight: 700; color: var(--secondary); }
  .tile .sub { color: var(--muted); font-size: 13px; line-height: 18px; margin: 6px 0 0; }
  /* Accuracy earns a meter; it is the one tile whose value has a ceiling. */
  .meter { height: 8px; border-radius: var(--radius-sm); background: var(--surface-raised); margin-top: 12px; overflow: hidden; }
  .meter > i { display: block; height: 100%; border-radius: var(--radius-sm); background: var(--brand-ink); }

  /* The headline: what to work on. The green tag is the only green above the
     fold, so the eye lands on the one thing the page is actually for. */
  .work {
    margin-top: 10px; padding: 20px; border-radius: var(--radius);
    background: var(--surface); border: 1px solid var(--border);
  }
  .work b { font-weight: 700; }
  .tag {
    display: inline-block; font-size: 12px; line-height: 16px; font-weight: 800;
    letter-spacing: 0.06em; text-transform: uppercase;
    background: var(--brand); color: var(--on-brand); border-radius: var(--radius-sm); padding: 4px 8px;
  }

  /* Habits are a stack of rounded rows rather than a ruled list. The one ruled
     table on the page is the games table; everything else separates by tone. */
  details.fault {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  }
  details.fault + details.fault { margin-top: 8px; }
  details.fault > summary {
    cursor: pointer; padding: 12px 16px; display: flex; align-items: center; gap: 12px;
    list-style: none; border-radius: var(--radius);
    font-size: 17px; line-height: 24px; font-weight: 700;
  }
  details.fault > summary:hover { background: var(--surface-raised); }
  details.fault > summary::-webkit-details-marker { display: none; }
  details.fault > summary::after {
    content: "›"; color: var(--muted); transition: transform .15s; display: inline-block;
    margin-left: 4px;
  }
  details.fault[open] > summary::after { transform: rotate(90deg); }
  .fault .title { font-weight: 700; }
  .fault .meta {
    margin-left: auto; display: flex; gap: 8px; align-items: center; white-space: nowrap;
  }
  /* Each number gets its own pill, so "73 moves" and "−27.1% each" stop running
     together into one grey string. */
  .fault .meta > span {
    font-size: 13px; line-height: 18px; font-weight: 700; color: var(--secondary);
    background: var(--surface-raised); border-radius: var(--radius-sm); padding: 2px 8px;
  }
  .fault .body { padding: 0 16px 16px; }
  .fault .why { color: var(--secondary); margin: 0 0 12px; }

  ul.moves { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  /* Sunken on the card, so a move reads as evidence sitting inside the habit
     rather than as another row of the page. */
  ul.moves li {
    background: var(--plane); border-radius: var(--radius-sm); padding: 8px 12px;
    font-size: 14px; line-height: 20px;
  }
  /* Moves and engine numbers are mono: a move list is a column of things that
     should line up, and tabular figures are the whole reason to set them. */
  .san { font: 700 14px/20px ${MONO}; font-variant-numeric: tabular-nums; }
  /* A move you can hover to have it read out. Dotted rather than solid: it is
     an aid, not a link, and the page should not look like it is full of them. */
  .mv {
    cursor: help; text-decoration: underline dotted;
    text-decoration-color: var(--axis); text-underline-offset: 3px;
  }
  .mv:hover { text-decoration-color: var(--series); }
  .drop { font: 500 13px/18px ${MONO}; color: var(--muted); font-variant-numeric: tabular-nums; }
  .line { color: var(--secondary); }

  /* Grade chips: the colour is a tint behind a word, never the word itself.
     The dot grew into the badge the grade already has on the overlay — the
     annotation mark the site itself uses (!! ★ ! ✓ ?! ? ??). It carries the
     glyph in --on-grade rather than white: white on Inaccuracy yellow is
     1.6:1. The word stays beside it, because Best, Excellent and Good are
     near enough the same green that the colour alone names nothing. */
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 3px;
    border-radius: var(--radius-pill); font-size: 13px; line-height: 18px; font-weight: 700;
    white-space: nowrap; background: var(--tint); color: var(--primary);
  }
  .chip .dot {
    display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
    background: var(--tint-dot); color: var(--on-grade); font: 800 11px/1 ${SANS}; flex: none;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }

  /* The game on the board right now. A pulsing dot rather than a colour, so it
     reads as "still going" and not as another grade. */
  .now {
    display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px;
    color: var(--series); font-weight: 600;
  }
  .now .pip {
    width: 7px; height: 7px; border-radius: 50%; background: var(--series);
    animation: pulse 1.8s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  @media (prefers-reduced-motion: reduce) { .now .pip { animation: none; } }

  table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 20px; }
  th {
    text-align: left; font-size: 12px; font-weight: 700; color: var(--muted);
    letter-spacing: 0.06em; text-transform: uppercase; padding: 0 12px 10px 0;
    border-bottom: 1px solid var(--axis);
  }
  td { padding: 12px 12px 12px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
  td:first-child { font-weight: 700; }
  /* The date is one label; wrapping it mid-phrase ("game" / "2") reads as two. */
  tr.game td:first-child { white-space: nowrap; }
  /* Right-aligned, but still with a gutter: at padding-right 0 the header of
     the next column butts straight onto this one ("ACCURACYGRADES"). */
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 18px; }
  tr.game { cursor: pointer; }
  tr.game:hover td { background: var(--surface-raised); }
  tr.detail td { background: var(--plane); }

  svg { display: block; width: 100%; height: auto; overflow: visible; }
  /* A floating label reads as lifted off the page, not inverted out of it: the
     old tip was a black pill in light mode and a white one in dark, which made
     it the brightest thing on screen exactly where the eye already was. */
  .tip {
    position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: var(--surface-raised); color: var(--primary); font-size: 13px; line-height: 18px;
    padding: 8px 12px; border-radius: var(--radius-sm); white-space: nowrap; z-index: 20;
    box-shadow: var(--shadow-float);
  }
  .tip span { color: var(--secondary); }

  /* Controls look pressable: a 4px bottom edge that the button drops into when
     you push it. Green is the primary; everything else is raised neutral. */
  .toggle, .btn {
    font: 700 14px/20px ${SANS}; border: 0; cursor: pointer; border-radius: var(--radius-sm);
    padding: 10px 16px; background: var(--surface-raised); color: var(--secondary);
    box-shadow: var(--shadow-press-neutral);
  }
  .toggle { float: right; }
  .toggle:active, .btn:active { transform: translateY(2px); box-shadow: none; }
  .btn.primary { background: var(--brand); color: var(--on-brand); box-shadow: var(--shadow-press); }
  /* ---- the board ---------------------------------------------------------
     Drawn as 64 grid cells with a Unicode man in each, rather than as SVG
     piece paths. The paths would be crisper and would cost 12 hand-authored
     shapes inlined into every copy of this page; the glyphs are one character
     each, scale with the font size, and degrade to a letterbox rather than to
     a blank square when a system has no chess font. Both sides use the solid
     glyphs (U+265A-F) and are told apart by fill and outline: the hollow
     "white" glyphs render as hairlines at this size and vanish on a light
     square. */
  .board {
    position: relative;
    display: grid; grid-template-columns: repeat(8, 1fr); grid-template-rows: repeat(8, 1fr);
    width: 100%; aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden;
    border: 1px solid var(--border); line-height: 1; user-select: none;
  }
  .board .sq { position: relative; }
  .board .light { background: var(--board-light); }
  .board .dark { background: var(--board-dark); }
  /* The move that was just played by the other side, so a puzzle opens on the
     question rather than on a still position. Yellow, like the site it is read
     beside, and distinct from the red/green this page uses for your move and
     the better one. */
  .board .sq.last::before {
    content: ""; position: absolute; inset: 0; background: var(--board-highlight);
  }
  /* The mark sits under the man, so a highlighted square never hides what is
     standing on it. */
  .board .sq.played::before, .board .sq.best::before {
    content: ""; position: absolute; inset: 0;
  }
  .board .sq.played::before { background: color-mix(in srgb, var(--mark-played) 46%, transparent); }
  .board .sq.best::before { background: color-mix(in srgb, var(--mark-best) 46%, transparent); }
  /* The men float over the squares rather than sitting in them, which is what
     lets one travel; see place() in the script. The transition here and
     STEP_MS there are the same number and have to stay that way. */
  .board .men { position: absolute; inset: 0; }
  .board .pc {
    position: absolute; left: 0; top: 0; width: 12.5%; height: 12.5%;
    display: flex; align-items: center; justify-content: center;
    transition: transform .34s ease, opacity .34s ease;
  }
  .board .pc.gone { opacity: 0; }
  /* Set while a replay jumps several plies at once, so the men arrive instead
     of racing each other across the board. */
  .board.instant .pc { transition: none; }
  /* Both sides use the solid glyphs and are told apart by fill plus outline.
     The stroke does the work the text-shadow used to do and holds its edge at
     56px, where a 2px blur just looks like a smudge. */
  .board .pc.w { color: #ffffff; -webkit-text-stroke: 1.5px #1c1a18; }
  .board .pc.b { color: #1c1a18; -webkit-text-stroke: 1px #1c1a18; }
  .board.small { max-width: 168px; }

  /* Rank and file, in the corners of the corner squares, in the colour of the
     square opposite — the only way to print on a board without a gutter. */
  .board .co { position: absolute; font: 700 11px/1 ${SANS}; pointer-events: none; }
  .board .co.r { left: 4px; top: 3px; }
  .board .co.f { right: 4px; bottom: 3px; }
  .board .light .co { color: var(--board-dark); }
  .board .dark .co { color: var(--board-light); }
  .board.small .co { display: none; }
  @media (prefers-reduced-motion: reduce) {
    .board .pc { transition: none; }
  }

  /* ---- find the move ----------------------------------------------------- */
  .train { display: grid; grid-template-columns: minmax(0, 300px) 1fr; gap: 22px; align-items: start; }
  .train .ask { color: var(--secondary); }
  .train .side { min-width: 0; }
  .train h3 { margin: 0 0 4px; font-size: 16px; font-weight: 620; }
  .deck { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .deck .count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  /* The base .btn is defined with .toggle above; these are its variants. */
  .btn:hover { color: var(--primary); }
  .btn.step { padding: 6px 12px; }
  .btn[disabled] { opacity: 0.4; cursor: default; box-shadow: var(--shadow-press-neutral); }
  .btn[disabled]:active { transform: none; }
  .answer { margin-top: 2px; }
  .answer .row { padding: 8px 0; border-top: 1px dashed var(--border); font-size: 14px; }
  .answer .row:first-child { border-top: 0; }
  .answer .key {
    font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted);
  }
  /* The two moves wear the two colours their squares are marked in. */
  .answer .youplayed .san { color: var(--mark-played); }
  .answer .better .san { color: var(--mark-best); }
  .shot { margin: 10px 0 4px; }

  /* ---- replay: the board, opened ------------------------------------------
     A button rather than a div with a click handler, so the keyboard and a
     screen reader get the same door the mouse does. */
  .peek {
    display: block; width: 100%; padding: 0; border: 0; background: none;
    font: inherit; color: inherit; cursor: zoom-in; position: relative;
    border-radius: 8px;
  }
  .peek:focus-visible { outline: 2px solid var(--series); outline-offset: 3px; }
  .peek .hint {
    position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
    font-size: 12px; white-space: nowrap; padding: 4px 10px; border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border: 1px solid var(--border); color: var(--secondary);
    opacity: 0; transition: opacity .15s; pointer-events: none;
  }
  .peek:hover .hint, .peek:focus-visible .hint { opacity: 1; }

  .modal {
    position: fixed; inset: 0; z-index: 30; display: flex;
    align-items: center; justify-content: center; padding: 16px;
    background: color-mix(in srgb, #0b0b09 62%, transparent);
  }
  .modal[hidden] { display: none; }
  .sheet {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px 18px; width: 100%; max-width: 470px;
    max-height: 94vh; overflow: auto;
  }
  .sheet .top { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .sheet .top h3 { margin: 0; font-size: 15px; font-weight: 620; }
  .sheet .x {
    margin-left: auto; font: inherit; font-size: 20px; line-height: 1; cursor: pointer;
    background: none; border: 0; color: var(--muted); padding: 0 6px;
    /* It takes the focus when the board opens, so the ring around it is seen
       every time and should not be a box drawn round a single glyph. */
    border-radius: 8px;
  }
  .sheet .x:hover { color: var(--primary); }
  .sheet .board { max-width: min(62vh, 400px); margin: 0 auto; }
  /* Which line is playing, in the colour its squares are already marked in. */
  .seg { display: flex; gap: 8px; margin-bottom: 12px; }
  /* Dark ink on both marks: white on the Blunder red is 3.4:1 and on the Best
     green 2.4:1, and these are the two brightest fills the page uses. */
  .seg .btn.on { color: var(--on-grade); }
  .seg .btn.played.on { background: var(--mark-played); }
  .seg .btn.best.on { background: var(--mark-best); }
  .bar { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .plies { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 10px; font-size: 14px; }
  .plies .ply {
    cursor: pointer; background: none; border: 0; font: inherit; padding: 2px 6px;
    border-radius: 6px; color: var(--secondary); font-weight: 600;
  }
  .plies .ply:hover { background: color-mix(in srgb, var(--series) 10%, transparent); }
  /* The move you are looking at, in the colour of the line it belongs to. */
  .plies.played .ply.at { background: color-mix(in srgb, var(--mark-played) 18%, transparent);
                          color: var(--mark-played); }
  .plies.best .ply.at { background: color-mix(in srgb, var(--mark-best) 18%, transparent);
                        color: var(--mark-best); }
  .sheet .note { margin: 10px 0 0; }

  /* ---- a fault, read as a lesson ---------------------------------------- */
  .lesson { margin: 12px 0 14px; }
  .lesson h4 {
    font-size: 12px; font-weight: 640; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--muted); margin: 14px 0 6px;
  }
  .lesson p { margin: 0 0 8px; }
  .lesson ol { margin: 0; padding-left: 20px; }
  .lesson ol li { padding: 3px 0; }
  .lesson .drill { color: var(--secondary); }
  .trendline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 10px 0 4px; }
  .trendline svg { width: 128px; height: 30px; flex: none; }
  .verdict { font-weight: 620; }
  .verdict.improving { color: var(--mark-best); }
  .verdict.worsening { color: var(--mark-played); }

  .split td.you { white-space: nowrap; }
  .empty { color: var(--secondary); padding: 28px 0; }
  @media (max-width: 720px) {
    .train { grid-template-columns: minmax(0, 1fr); }
    .train .board { max-width: 340px; }
  }
  @media (max-width: 560px) {
    body { padding: 20px 12px 64px; }
    .hide-sm { display: none; }
  }
`;

/*
 * The page's own script. Written without template literals on purpose: this
 * whole string sits inside one in the generator, and `${` in here would be
 * swallowed by it.
 */
const SCRIPT = String.raw`
const R = window.__REVIEW__;
const $ = (s, el) => (el || document).querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pct = (v) => (v == null ? '—' : v.toFixed(1) + '%');
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

/* ---- tooltip: hover enhances, the labels and tables carry the values ---- */
const tip = el('div', 'tip');
document.body.appendChild(tip);
function showTip(e, html) {
  tip.innerHTML = html;
  tip.style.opacity = '1';
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 12;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
  tip.style.left = x + 'px';
  tip.style.top = Math.max(8, e.clientY - r.height - 10) + 'px';
}
const hideTip = () => { tip.style.opacity = '0'; };
function hoverable(node, html) {
  node.addEventListener('mousemove', (e) => showTip(e, html));
  node.addEventListener('mouseleave', hideTip);
}

/* ---- horizontal bars: one measure, one hue, labels on the marks ---- */
function barChart(host, rows, opts) {
  opts = opts || {};
  const draw = () => {
    host.textContent = '';
    if (!rows.length) return;
    const w = host.clientWidth || 640;
    const longest = Math.max.apply(null, rows.map((r) => r.label.length));
    const noteW = Math.max.apply(null, rows.map((r) => String(r.note).length)) * 6.8 + 14;
    // Reserve off the longest label, not a fraction of the width: at ~7px a
    // character, 'Missing what was there' needs 150px and was being painted
    // under its own bar on a narrow screen.
    const wantW = longest * 7 + 14;

    /*
     * Two layouts, chosen by whether the side-by-side one still leaves a bar
     * worth drawing. Below that, the label goes above its bar and the bar gets
     * the full width — which is the only way a long name and a readable mark
     * fit on a phone at the same time. Squeezing both is what produces a
     * clipped label, and a clipped label is worse than a taller chart.
     */
    const stacked = w - wantW - noteW < 120;
    const rowH = stacked ? 44 : 32;
    const gap = 10;
    const labelW = stacked ? 0 : wantW;
    const h = rows.length * rowH;
    const max = Math.max.apply(null, rows.map((r) => r.value)) || 1;
    const plotW = Math.max(40, w - labelW - noteW);
    const s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, height: h });

    rows.forEach((r, i) => {
      const y = i * rowH;
      const bw = Math.max(2, (r.value / max) * plotW);
      const barY = stacked ? y + 24 : y + (rowH - gap) / 2;

      const name = svg('text', {
        x: 0, y: stacked ? y + 14 : y + rowH / 2 + 4,
        fill: css('--primary'), 'font-size': 13.5,
      });
      name.textContent = r.label;
      s.appendChild(name);

      // 4px rounded end, anchored to the baseline at labelW.
      s.appendChild(svg('rect', {
        x: labelW, y: barY, width: bw, height: gap, rx: 4, fill: css('--series'),
      }));

      const val = svg('text', {
        x: labelW + bw + 8, y: barY + gap - 1, fill: css('--secondary'),
        'font-size': 12.5, 'font-variant-numeric': 'tabular-nums',
      });
      val.textContent = r.note;
      s.appendChild(val);

      // The hit area is the whole row, not the 10px bar.
      const hit = svg('rect', { x: 0, y: y, width: w, height: rowH, fill: 'transparent' });
      hoverable(hit, r.tip || (r.label + ' — ' + r.note));
      s.appendChild(hit);
    });
    host.appendChild(s);
  };
  draw();
  addEventListener('resize', draw);
}

/* ---- accuracy over time: one series, endpoint labelled, crosshair ---- */
function lineChart(host, points) {
  const draw = () => {
    host.textContent = '';
    if (points.length < 2) {
      host.appendChild(el('p', 'note', points.length
        ? 'One game so far — the trend needs a second.' : 'No games yet.'));
      return;
    }
    const w = host.clientWidth || 640;
    const h = 190, padL = 34, padR = 46, padT = 12, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const lo = Math.max(0, Math.min.apply(null, points.map((p) => p.y)) - 6);
    const hi = Math.min(100, Math.max.apply(null, points.map((p) => p.y)) + 6);
    const X = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const Y = (v) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, height: h });

    // Recessive grid: solid hairlines, one shade off the surface.
    for (let t = 0; t <= 4; t++) {
      const v = lo + ((hi - lo) * t) / 4;
      const y = Y(v);
      s.appendChild(svg('line', {
        x1: padL, x2: padL + plotW, y1: y, y2: y, stroke: css('--grid'), 'stroke-width': 1,
      }));
      const lab = svg('text', {
        x: padL - 8, y: y + 4, fill: css('--muted'), 'font-size': 11,
        'text-anchor': 'end', 'font-variant-numeric': 'tabular-nums',
      });
      lab.textContent = Math.round(v);
      s.appendChild(lab);
    }

    const d = points.map((p, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(p.y)).join(' ');
    s.appendChild(svg('path', {
      d: d, fill: 'none', stroke: css('--series'), 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    points.forEach((p, i) => {
      s.appendChild(svg('circle', {
        cx: X(i), cy: Y(p.y), r: 4, fill: css('--series'),
        stroke: css('--surface'), 'stroke-width': 2,
      }));
    });

    // Direct-label the endpoint only — a number on every point is chaos.
    const last = points[points.length - 1];
    const endLab = svg('text', {
      x: X(points.length - 1) + 10, y: Y(last.y) + 4, fill: css('--primary'),
      'font-size': 12.5, 'font-weight': 600,
    });
    endLab.textContent = last.y.toFixed(0) + '%';
    s.appendChild(endLab);

    // One hit column per point, so the target is the band and not the dot.
    points.forEach((p, i) => {
      const bw = plotW / points.length;
      const hit = svg('rect', {
        x: X(i) - bw / 2, y: padT, width: bw, height: plotH, fill: 'transparent',
      });
      hoverable(hit, '<b>' + p.label + '</b><br>accuracy ' + p.y.toFixed(1) + '%'
        + '<br>' + p.moves + ' moves graded');
      s.appendChild(hit);
    });

    host.appendChild(s);
  };
  draw();
  addEventListener('resize', draw);
}

/* ---- a position, drawn ---------------------------------------------------
   Both sides use the solid glyphs and are told apart by fill: the hollow
   "white" men are hairlines at this size and disappear on a light square. */
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';
/* One step of a replay. Paired with the transition in .board .pc: a step that
   finished before its slide did would run the next move over the top of it. */
const STEP_MS = 340;

/* Squares are numbered as the FEN writes them: 0 is a8, 63 is h1. */
const sqIndex = (name) => (8 - +name[1]) * 8 + FILES.indexOf(name[0]);

/**
 * The men, drawn in a layer of their own rather than one per square.
 *
 * A piece parked inside its square cannot travel to another one: moving it
 * would mean removing it here and creating it there, which is a cut, not a
 * move. Absolutely positioned over the same grid, a piece is one transform
 * away from any square on the board — so the static diagrams and the replay
 * are the same renderer, and the only difference between them is whether
 * anything ever calls boardStep.
 */
function place(node, i, flipped) {
  const n = flipped ? 63 - i : i;
  node.style.transform = 'translate(' + (n & 7) * 100 + '%,' + (n >> 3) * 100 + '%)';
}

function addMan(host, p, i) {
  const node = el('span', 'pc ' + (p === p.toUpperCase() ? 'w' : 'b'),
    GLYPH[p.toLowerCase()] || p);
  place(node, i, host._flipped);
  host._layer.appendChild(node);
  return node;
}

function boardEl(fen, o) {
  o = o || {};
  const men = [];
  for (const ch of String(fen || '').split(' ')[0]) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') { for (let i = 0; i < +ch; i++) men.push(null); }
    else men.push(ch);
  }
  const host = el('div', 'board' + (o.small ? ' small' : ''));
  // A FEN that does not describe 64 squares draws nothing. A partial board
  // would look like a position and be a different one.
  if (men.length !== 64) return host;

  host._flipped = !!o.flipped;
  host._men = men;
  host._sq = new Array(64);
  host._nodes = new Array(64).fill(null);

  for (let n = 0; n < 64; n++) {
    const i = o.flipped ? 63 - n : n;
    const r = i >> 3, c = i & 7;
    const sq = el('div', 'sq ' + ((r + c) % 2 ? 'dark' : 'light'));
    /*
     * Rank down the left edge and file along the bottom, printed inside the
     * corner squares rather than in a gutter — a gutter would make the board
     * narrower than the column it sits in, and the coordinates are read while
     * looking at the position, not instead of it. The edges are the displayed
     * ones, so a flipped board still labels the side you are sitting on.
     */
    if ((n & 7) === 0) sq.appendChild(el('span', 'co r', String(8 - r)));
    if ((n >> 3) === 7) sq.appendChild(el('span', 'co f', FILES[c]));
    host._sq[i] = sq;
    host.appendChild(sq);
  }

  host._layer = el('div', 'men');
  host.appendChild(host._layer);
  for (let i = 0; i < 64; i++) if (men[i]) host._nodes[i] = addMan(host, men[i], i);

  boardMark(host, o.best, o.played);
  return host;
}

/** The two squares of a move, or of both moves, lit under the men. */
function boardMark(host, best, played) {
  if (!host._sq) return;
  for (const sq of host._sq) sq.classList.remove('played', 'best');
  const mark = (uci, cls) => {
    if (!uci || uci.length < 4) return;
    host._sq[sqIndex(uci.slice(0, 2))].classList.add(cls);
    host._sq[sqIndex(uci.slice(2, 4))].classList.add(cls);
  };
  mark(best, 'best');
  mark(played, 'played');          // second, so your move wins a shared square
}

/**
 * One move, applied to the 64 squares.
 *
 * Nothing here checks whether the move is legal, because nothing here is
 * allowed to decide that: every line the page replays was walked through a
 * real move generator in pvSteps before it was written to the review. What
 * is left are the three moves that are not simply "from A to B" — a rook that
 * travels with its king, a pawn that captures a square it does not land on,
 * and a pawn that arrives as something else.
 *
 * Returns what moved, so the layer above can animate exactly that.
 */
function applyUci(men, uci) {
  const from = sqIndex(uci.slice(0, 2));
  const to = sqIndex(uci.slice(2, 4));
  const promo = uci[4];
  const p = men[from];
  const out = { from: from, to: to, taken: null, rookFrom: null, rookTo: null, promo: null };

  if (men[to]) out.taken = to;
  // A pawn changing file onto an empty square took the pawn beside it.
  if (p && p.toLowerCase() === 'p' && (from & 7) !== (to & 7) && !men[to]) {
    out.taken = (from & ~7) + (to & 7);
  }
  if (out.taken != null) men[out.taken] = null;

  men[to] = promo ? (p === p.toUpperCase() ? promo.toUpperCase() : promo) : p;
  men[from] = null;
  if (promo) out.promo = men[to];

  // A king crossing two files is a castle, and the rook is halfway back.
  if (p && p.toLowerCase() === 'k' && Math.abs((from & 7) - (to & 7)) === 2) {
    const right = (to & 7) > (from & 7);
    out.rookFrom = (from & ~7) + (right ? 7 : 0);
    out.rookTo = (from & ~7) + (right ? 5 : 3);
    men[out.rookTo] = men[out.rookFrom];
    men[out.rookFrom] = null;
  }
  return out;
}

/** The same move, on the board the reader is looking at. */
function boardStep(host, uci) {
  if (!host._men) return;
  const ef = applyUci(host._men, uci);
  const slide = (a, b) => {
    const node = host._nodes[a];
    if (!node) return;
    host._nodes[a] = null;
    host._nodes[b] = node;
    place(node, b, host._flipped);
  };

  if (ef.taken != null) {
    const gone = host._nodes[ef.taken];
    host._nodes[ef.taken] = null;
    if (gone) {
      // Faded rather than removed on the spot: a piece that vanishes before
      // the capturer arrives looks like it moved away.
      gone.classList.add('gone');
      setTimeout(() => gone.remove(), STEP_MS);
    }
  }
  slide(ef.from, ef.to);
  if (ef.rookFrom != null) slide(ef.rookFrom, ef.rookTo);
  if (ef.promo) {
    const node = host._nodes[ef.to];
    if (node) node.textContent = GLYPH[ef.promo.toLowerCase()] || ef.promo;
  }
}

/* The men are sized from the square, which CSS cannot do by itself without
   container queries. Same redraw-on-resize contract as the charts. */
function sizeBoards() {
  for (const b of document.querySelectorAll('.board')) {
    const w = b.clientWidth;
    if (w) b.style.fontSize = Math.round((w / 8) * 0.76) + 'px';
  }
}
addEventListener('resize', sizeBoards);

/* ---- the move, played out -----------------------------------------------
 *
 * The page could already tell you that Nd4 cost 30% and that Ng5 was there,
 * and it marked both on the board — but the reason Nd4 was bad is Rxd4, which
 * was written as text and left for you to play out in your head against a
 * position you are looking at. That is the one piece of work a diagram should
 * be doing for you, so the board opens: your move and the answer to it, then
 * the move that was there and how it went on.
 */

/** The line to play for a side, and what to fall back to when it is missing. */
function lineOf(c, side) {
  const steps = side === 'played' ? c.playedLine : c.betterLine;
  if (steps && steps.length) return steps;
  /*
   * A review written before the lines were kept still has the two moves
   * themselves, and one move is worth watching. The page says as much
   * underneath rather than pretending this is the whole line.
   */
  const uci = side === 'played' ? c.uci : c.bestUci;
  const san = side === 'played' ? c.san : c.best;
  return uci ? [{ uci: uci, san: san || uci }] : [];
}

/** "21. " before White's move, "21... " before a Black move that opens a line. */
function plyLabel(fen, i) {
  const black = fen.split(' ')[1] === 'b';
  const no = +fen.split(' ')[5] || 1;
  const white = black ? i % 2 === 1 : i % 2 === 0;
  const n = no + Math.floor((i + (black ? 1 : 0)) / 2);
  if (white) return n + '. ';
  return i === 0 ? n + '... ' : '';
}

const replay = (function () {
  let host = null, sheet = null, title = null, seg = null, plies = null, note = null;
  let boardBox = null, board = null, closeBtn = null, prevBtn = null, nextBtn = null;
  let card = null, side = 'played', line = [], at = 0, timer = null, opener = null;

  const stop = () => { if (timer) clearTimeout(timer); timer = null; };

  /* Rebuilt, not rewound: a position is cheap to draw and a board walked
     backwards through captures and promotions is a second mover to get wrong. */
  function reset() {
    boardBox.textContent = '';
    board = boardEl(card.fen, { flipped: card.fen.split(' ')[1] === 'b' });
    boardBox.appendChild(board);
    at = 0;
    sizeBoards();
  }

  function goTo(n) {
    n = Math.max(0, Math.min(line.length, n));
    if (n === at + 1) { step(); return; }
    stop();
    reset();
    // Every other jump lands rather than travels: five slides at once is not an
    // animation of anything.
    board.classList.add('instant');
    for (let i = 0; i < n; i++) boardStep(board, line[i].uci);
    at = n;
    void board.offsetWidth;
    board.classList.remove('instant');
    afterStep();
  }

  function step() {
    if (at >= line.length) return;
    boardStep(board, line[at].uci);
    at++;
    afterStep();
  }

  /** The squares of the move just played, and the same move named underneath. */
  function afterStep() {
    const last = at > 0 ? line[at - 1].uci : null;
    boardMark(board, side === 'best' ? last : null, side === 'played' ? last : null);
    prevBtn.disabled = at === 0;
    nextBtn.disabled = at >= line.length;
    for (const [i, node] of [...plies.children].entries()) {
      node.classList.toggle('at', i === at - 1);
    }
  }

  function autoplay() {
    stop();
    const tick = () => {
      if (at >= line.length) { timer = null; return; }
      step();
      timer = setTimeout(tick, STEP_MS + 240);
    };
    // A beat on the starting position first: the move means nothing if you did
    // not see where it started from.
    timer = setTimeout(tick, 420);
  }

  function show(which) {
    side = which;
    line = lineOf(card, side);
    for (const b of seg.children) b.classList.toggle('on', b.dataset.side === side);

    plies.className = 'plies ' + side;
    plies.textContent = '';
    line.forEach((s, i) => {
      const b = el('button', 'ply');
      b.type = 'button';
      b.appendChild(document.createTextNode(plyLabel(card.fen, i)));
      b.appendChild(sanTip(el('span', null, s.san), s.san));
      b.addEventListener('click', () => { stop(); goTo(i + 1); });
      plies.appendChild(b);
    });

    note.textContent = line.length > 1 ? ''
      : 'Only the move itself was kept for this one — re-run  node tools/review.mjs --all'
        + '  for the line that follows it.';

    reset();
    afterStep();
    autoplay();
  }

  function build() {
    host = el('div', 'modal');
    host.hidden = true;
    sheet = el('div', 'sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Replay');
    host.appendChild(sheet);

    const top = el('div', 'top');
    title = el('h3');
    closeBtn = el('button', 'x', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', close);
    top.appendChild(title);
    top.appendChild(closeBtn);
    sheet.appendChild(top);

    seg = el('div', 'seg');
    for (const [key, text] of [['played', 'You played'], ['best', 'Better']]) {
      const b = el('button', 'btn ' + key, text);
      b.type = 'button';
      b.dataset.side = key;
      b.addEventListener('click', () => show(key));
      seg.appendChild(b);
    }
    sheet.appendChild(seg);

    boardBox = el('div');
    sheet.appendChild(boardBox);
    plies = el('div', 'plies');
    sheet.appendChild(plies);

    const bar = el('div', 'bar');
    prevBtn = el('button', 'btn step', '‹');
    nextBtn = el('button', 'btn step', '›');
    prevBtn.addEventListener('click', () => { stop(); goTo(at - 1); });
    nextBtn.addEventListener('click', () => { stop(); goTo(at + 1); });
    const again = el('button', 'btn', 'Replay');
    again.addEventListener('click', () => { reset(); afterStep(); autoplay(); });
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(again);
    sheet.appendChild(bar);

    note = el('p', 'note');
    sheet.appendChild(note);

    // The backdrop closes; the sheet is not the backdrop.
    host.addEventListener('click', (e) => { if (e.target === host) close(); });
    document.body.appendChild(host);
  }

  function open(c, from) {
    if (!host) build();
    card = c;
    opener = from || null;
    const black = c.fen.split(' ')[1] === 'b';
    title.textContent = (black ? 'Black' : 'White') + ' to play'
      + (c.fen.split(' ')[5] ? ' · move ' + c.fen.split(' ')[5] : '');
    // Nothing to show on the other side of a move the engine had no answer for.
    seg.hidden = !lineOf(c, 'best').length;
    host.hidden = false;
    document.body.style.overflow = 'hidden';
    show('played');
    closeBtn.focus();
  }

  function close() {
    if (!host || host.hidden) return;
    stop();
    host.hidden = true;
    document.body.style.overflow = '';
    hideTip();
    if (opener) opener.focus();
    opener = null;
  }

  /*
   * The deck below is listening for the same keys. It asks this first and
   * stands down while the board is open, so the arrows move through the line
   * being replayed rather than dealing a different card behind the modal.
   */
  addEventListener('keydown', (e) => {
    if (!host || host.hidden) return;
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { stop(); goTo(at + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { stop(); goTo(at - 1); e.preventDefault(); }
    else if (e.key === ' ') { reset(); afterStep(); autoplay(); e.preventDefault(); }
  });

  return { open: open, isOpen: () => !!host && !host.hidden };
}());

/** A board you can open. The hint appears on hover, not in the layout. */
function peekBoard(c, o) {
  o = o || {};
  const b = el('button', 'peek');
  b.type = 'button';
  b.setAttribute('aria-label', 'Replay this move');
  const bd = boardEl(c.fen, {
    small: o.small, flipped: c.fen.split(' ')[1] === 'b', played: c.uci, best: c.bestUci,
  });
  // Inside the board rather than the button: the button is as wide as the
  // column, and a hint centred on the column is not centred on the board.
  bd.appendChild(el('span', 'hint', 'Replay this move'));
  b.appendChild(bd);
  b.addEventListener('click', () => replay.open(c, b));
  return b;
}

/* ---- is this habit getting better: one line of chart, no axes ---- */
function sparkline(values) {
  const w = 128, h = 30, pad = 4;
  const s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h });
  if (values.length < 2) return s;
  const max = Math.max.apply(null, values) || 1;
  const X = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const Y = (v) => h - pad - (v / max) * (h - pad * 2);
  s.appendChild(svg('path', {
    d: values.map((v, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(v)).join(' '),
    fill: 'none', stroke: css('--series'), 'stroke-width': 1.5,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  // The newest game is the one the sentence beside this is about.
  s.appendChild(svg('circle', {
    cx: X(values.length - 1), cy: Y(values[values.length - 1]), r: 2.5, fill: css('--series'),
  }));
  return s;
}

/* ---- where the game turned: win probability, your side, across your moves ---- */
function evalChart(host, moves) {
  const rows = moves.filter((m) => m.winAfter != null);
  if (rows.length < 2) return false;

  const draw = () => {
    host.textContent = '';
    const w = host.clientWidth || 600;
    const h = 132, padL = 30, padR = 14, padT = 12, padB = 20;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const X = (i) => padL + (i / (rows.length - 1)) * plotW;
    const Y = (v) => padT + plotH - (v / 100) * plotH;
    const s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, height: h });

    for (const v of [0, 50, 100]) {
      s.appendChild(svg('line', {
        x1: padL, x2: padL + plotW, y1: Y(v), y2: Y(v),
        stroke: v === 50 ? css('--axis') : css('--grid'), 'stroke-width': 1,
      }));
      const lab = svg('text', {
        x: padL - 7, y: Y(v) + 4, fill: css('--muted'), 'font-size': 10.5,
        'text-anchor': 'end', 'font-variant-numeric': 'tabular-nums',
      });
      lab.textContent = v;
      s.appendChild(lab);
    }

    s.appendChild(svg('path', {
      d: rows.map((m, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(m.winAfter)).join(' '),
      fill: 'none', stroke: css('--series'), 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    /*
     * Only the moves that actually decided it are marked. A dot per move turns
     * a 40-move game into a dotted line and says nothing; the two or three
     * steepest falls are the answer to "where did this go wrong", and they are
     * the same moves the list underneath explains.
     */
    const turns = rows.map((m, i) => ({ m: m, i: i }))
      .filter((p) => (p.m.drop || 0) >= 8)
      .sort((a, b) => b.m.drop - a.m.drop).slice(0, 3);
    for (const p of turns) {
      s.appendChild(svg('circle', {
        cx: X(p.i), cy: Y(p.m.winAfter), r: 4, fill: css('--mark-played'),
        stroke: css('--surface'), 'stroke-width': 2,
      }));
      const lab = svg('text', {
        x: Math.min(X(p.i) + 7, w - padR - 30), y: Y(p.m.winAfter) - 8,
        fill: css('--primary'), 'font-size': 11.5, 'font-weight': 600,
      });
      lab.textContent = p.m.san;
      s.appendChild(lab);
    }

    rows.forEach((m, i) => {
      const bw = plotW / rows.length;
      const hit = svg('rect', {
        x: X(i) - bw / 2, y: padT, width: bw, height: plotH, fill: 'transparent',
      });
      const says = sanWords(m.san);
      hoverable(hit, '<b>' + (m.ply ? Math.ceil(m.ply / 2) + '. ' : '') + m.san + '</b>'
        + (says ? '<br>' + says : '')
        + '<br>' + m.winAfter.toFixed(0) + '% to win after it'
        + (m.drop ? '<br>cost ' + m.drop.toFixed(1) + '%' : ''));
      s.appendChild(hit);
    });

    host.appendChild(s);
  };
  draw();
  addEventListener('resize', draw);
  return true;
}

/* ---------------------------------------------------------------- page --- */
function chip(label, n) {
  const c = el('span', 'chip');
  const tint = R.gradeColors[label] || css('--muted');
  c.style.setProperty('--tint', 'color-mix(in srgb, ' + tint + ' 16%, var(--surface))');
  c.style.setProperty('--tint-dot', tint);
  const badge = el('span', 'dot');
  // The glyph is decoration: the word next to it already says the grade, and a
  // screen reader announcing "question question" helps nobody.
  badge.textContent = R.gradeGlyphs[label] || '';
  badge.setAttribute('aria-hidden', 'true');
  c.appendChild(badge);
  c.appendChild(document.createTextNode(n != null ? n + ' ' + label : label));
  return c;
}

/* ---- notation, read out on hover ----------------------------------------
   sanWords is prepended to this script from report.js. Only ever attached to
   fields that hold moves — a move, or a line of them. Never to the sentences,
   where "your pawn on f5" would be read back as a move to f5. */
function sanTip(node, san) {
  const words = sanWords(san);
  if (!words) return node;
  node.classList.add('mv');
  // The move reached here only by matching the notation, so it is a handful of
  // letters, digits and +#=x- and cannot carry markup into innerHTML.
  hoverable(node, '<b>' + san + '</b><br>' + words);
  return node;
}

/** A line of moves, each one hoverable on its own. */
function sanLine(text, cls) {
  const host = el('span', cls || 'line');
  for (const part of String(text).split(/(\s+)/)) {
    if (!part) continue;
    if (!part.trim() || !sanWords(part)) {
      host.appendChild(document.createTextNode(part));
      continue;
    }
    host.appendChild(sanTip(el('span', 'mv', part), part));
  }
  return host;
}

function moveList(moves, o) {
  o = o || {};
  const ul = el('ul', 'moves');
  let drawn = false;
  for (const m of moves) {
    const li = el('li');
    if (m.ply) li.appendChild(el('span', 'san', Math.ceil(m.ply / 2) + '. '));
    li.appendChild(sanTip(el('span', 'san', m.san), m.san));
    li.appendChild(document.createTextNode(' '));
    li.appendChild(el('span', 'drop', '−' + m.drop.toFixed(1) + '%'));
    if (m.why) {
      li.appendChild(document.createElement('br'));
      li.appendChild(el('span', 'line', m.why));
    }
    if (m.line) {
      li.appendChild(document.createElement('br'));
      li.appendChild(sanLine('line: ' + m.line));
    }
    if (m.best) {
      li.appendChild(document.createElement('br'));
      li.appendChild(sanLine('better: ' + m.best
        + (m.bestLine && m.bestLine !== m.best ? '  (' + m.bestLine + ')' : '')));
    }
    /*
     * One diagram per list, on the worst example.
     *
     * Not one per move: a fault with eight examples would be eight boards, the
     * list would stop being a list, and the reader would scroll past all of
     * them. The worst one is the one worth looking at, and the trainer above is
     * where every position can be seen in turn.
     */
    if (o.board && !drawn && m.fen) {
      drawn = true;
      const wrap = el('div', 'shot');
      // The answer is already written above it here, so the board opens from
      // the start — unlike the trainer's, which would be giving the card away.
      wrap.appendChild(peekBoard(m, { small: true }));
      li.appendChild(wrap);
    }
    ul.appendChild(li);
  }
  return ul;
}

/** A small table, since every comparison on this page has one. */
function table(host, head, rows) {
  const t = el('table', 'split');
  const tr = el('tr');
  head.forEach((h, i) => tr.appendChild(el('th', i ? 'num' : null, h)));
  const thead = el('thead');
  thead.appendChild(tr);
  t.appendChild(thead);
  const tb = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    r.forEach((v, i) => row.appendChild(el('td', i ? 'num' : 'you', v)));
    tb.appendChild(row);
  }
  t.appendChild(tb);
  host.appendChild(t);
}

/* ---- find the move ------------------------------------------------------ */

/**
 * The deck, taken across faults rather than straight down the worst list.
 *
 * Sorted purely by cost, the first ten cards are usually the same mistake ten
 * times, which trains one pattern and bores you out of the other nine. Taking
 * the worst of each fault, then the second worst of each, keeps consecutive
 * cards different — and since each fault's examples arrive already sorted, the
 * deck is still hardest-first within every kind.
 */
function buildDeck(faults, limit) {
  // A position is all a card needs. The move you played and the move that was
  // there only mark squares on it — worth having, not worth withholding the
  // card over, since the answer is written out underneath either way.
  const lists = faults.map((f) => (f.moves || [])
    .filter((m) => m.fen)
    .map((m) => ({ ...m, kind: f.kind })));
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const l of lists) {
      if (!l[i]) continue;
      out.push(l[i]);
      any = true;
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

/**
 * A position with the answer hidden.
 *
 * The face carries the board, the side to move and the move number, and
 * deliberately nothing else. The grade, the cost and the name of the fault are
 * all hints — "Blunder, hanging pieces" answers the question before you have
 * looked at the board — and a card you do not have to think about teaches
 * nothing. Everything withheld here is one click away.
 */
function trainer(host, deck) {
  let at = 0, shown = false;
  try {
    const was = +(localStorage.getItem('coach:card') || 0);
    if (was >= 0 && was < deck.length) at = was;
  } catch { /* private window, or storage refused: start at the first card */ }

  const wrap = el('div', 'train');
  const left = el('div');
  const side = el('div', 'side');
  wrap.appendChild(left);
  wrap.appendChild(side);
  host.appendChild(wrap);

  const go = (i) => {
    if (i < 0 || i >= deck.length) return;
    at = i;
    shown = false;
    try { localStorage.setItem('coach:card', String(at)); } catch { /* fine */ }
    paint();
  };

  const row = (key, node) => {
    const r = el('div', 'row' + (key ? ' ' + key.toLowerCase().replace(/[^a-z]/g, '') : ''));
    if (key) r.appendChild(el('div', 'key', key));
    r.appendChild(node);
    return r;
  };

  function paint() {
    const c = deck[at];
    const black = c.fen.split(' ')[1] === 'b';
    const no = c.fen.split(' ')[5];

    left.textContent = '';
    /*
     * Openable only once the card is revealed. Before that, a replay of the
     * answer is the answer — the same reason the grade and the name of the
     * fault are withheld up there.
     */
    left.appendChild(shown ? peekBoard(c, {}) : boardEl(c.fen, { flipped: black }));

    side.textContent = '';
    const bar = el('div', 'deck');
    const prev = el('button', 'btn step', '‹');
    const next = el('button', 'btn step', '›');
    prev.disabled = at === 0;
    next.disabled = at === deck.length - 1;
    prev.addEventListener('click', () => go(at - 1));
    next.addEventListener('click', () => go(at + 1));
    bar.appendChild(prev);
    bar.appendChild(next);
    bar.appendChild(el('span', 'count', (at + 1) + ' of ' + deck.length));
    side.appendChild(bar);
    // Said once, here, where the first move on the page is about to appear.
    side.appendChild(el('p', 'note', 'Hover any underlined move to have the notation read out.'));

    side.appendChild(el('h3', null, (black ? 'Black' : 'White') + ' to play'
      + (no ? ' · move ' + no : '')));

    if (!shown) {
      side.appendChild(el('p', 'ask',
        'You played something here that cost you. Work out what you should have played, '
        + 'then reveal.'));
      const b = el('button', 'btn', 'Reveal');
      b.addEventListener('click', () => { shown = true; paint(); });
      side.appendChild(b);
      sizeBoards();
      return;
    }

    const ans = el('div', 'answer');

    const played = el('div');
    played.appendChild(sanTip(el('span', 'san', c.san), c.san));
    played.appendChild(document.createTextNode(' '));
    played.appendChild(el('span', 'drop', '−' + c.drop.toFixed(1) + '%'));
    played.appendChild(document.createTextNode(' '));
    played.appendChild(chip(c.label));
    ans.appendChild(row('You played', played));

    if (c.why) ans.appendChild(row(null, el('div', 'line', c.why)));
    if (c.line) ans.appendChild(row('He answers', sanLine(c.line)));

    if (c.best) {
      const best = el('div');
      best.appendChild(sanTip(el('span', 'san', c.best), c.best));
      if (c.bestLine && c.bestLine !== c.best) {
        best.appendChild(document.createElement('br'));
        best.appendChild(sanLine(c.bestLine));
      }
      ans.appendChild(row('Better', best));
    }

    // Said where the board has just become openable, not in the standing note
    // above, which is read while the answer is still hidden.
    ans.appendChild(row(null, el('div', 'note',
      'Click the board to watch this played out, and the move that was there.')));

    const from = (R.faults[c.kind] || {}).title;
    ans.appendChild(row(null, el('div', 'note',
      (from ? from : 'Not classified') + (c.when ? ' · ' + c.when : ''))));

    side.appendChild(ans);
    const again = el('button', 'btn', 'Hide');
    again.addEventListener('click', () => { shown = false; paint(); });
    side.appendChild(again);
    sizeBoards();
  }

  /*
   * Arrows to move, space to reveal — the keys anyone already uses on a deck of
   * cards. Skipped when a button has focus, where the browser is already
   * turning space and enter into a click and handling it twice would toggle it
   * straight back.
   */
  addEventListener('keydown', (e) => {
    // The replay has the keyboard while it is open, and it is showing this very
    // card: dealing the next one behind it would change what you come back to.
    if (replay.isOpen()) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === ' ' || e.key === 'Enter') { shown = !shown; paint(); e.preventDefault(); }
  });

  paint();
}

/* ---- am I fixing it ----------------------------------------------------- */
function trendBlock(f) {
  const box = el('div', 'trendline');
  const vals = (f.history || []).map((h) => h.per10);
  if (vals.length >= 2) box.appendChild(sparkline(vals));

  const t = f.trend;
  if (!t || t.verdict === 'unknown') {
    box.appendChild(el('span', 'note',
      'No trend yet — ' + ((t && t.reason) || 'nothing to compare against')));
    return box;
  }
  box.appendChild(el('span', 'verdict ' + t.verdict,
    t.verdict === 'flat' ? 'about the same' : t.verdict));
  box.appendChild(el('span', 'note',
    t.now.toFixed(1) + '% per 10 moves lately, against ' + t.was.toFixed(1) + '% before'
    + ' · ' + t.games + ' games'));
  return box;
}

function render() {
  const all = R.all;
  const games = R.games;

  $('#sub').textContent = all.games
    ? all.games + (all.games === 1 ? ' game' : ' games') + ', ' + all.graded
      + ' of your moves graded · generated ' + new Date(R.generated).toLocaleString()
    : 'No games with graded moves yet.';

  if (!all.games) {
    // Clear the scaffolding rather than leaving a page of empty headings.
    $('#body').textContent = '';
    $('#body').appendChild(el('p', 'empty',
      'No reviewed games yet. Play one with the coach running, or review the '
      + 'sessions you already have with:  node tools/review.mjs --deep --all'));
    return;
  }

  /* --- the headline --- */
  const tiles = $('#tiles');
  const tile = (k, v, u) => {
    const t = el('div', 'tile');
    t.appendChild(el('div', 'k', k));
    const val = el('div', 'v' + (/^[\d.]+$/.test(v) ? '' : ' word'), v);
    if (u) val.appendChild(el('span', 'u', u));
    t.appendChild(val);
    return t;
  };
  tiles.appendChild(tile('Accuracy', all.accuracy.toFixed(1), '%'));
  tiles.appendChild(tile('Games', String(all.games)));
  tiles.appendChild(tile('Moves graded', String(all.graded)));

  /*
   * How much of what you lose goes in one move.
   *
   * The number that says which of two players you are, and they need opposite
   * advice: most of the loss in a handful of Blunders is a checking habit to
   * fix, and the same accuracy spread evenly across every move is a
   * understanding-of-the-position problem no checklist will touch.
   */
  const rows = games.flatMap((g) => g.moves || []);
  const lost = rows.reduce((a, m) => a + (m.drop || 0), 0);
  const inBlunders = rows.filter((m) => m.label === 'Blunder')
    .reduce((a, m) => a + (m.drop || 0), 0);
  if (lost > 0) {
    tiles.appendChild(tile('Lost to blunders', ((inBlunders / lost) * 100).toFixed(0), '%'));
  }

  const top = all.faults[0];
  if (top) tiles.appendChild(tile('Biggest leak', R.faults[top.kind].title));

  /*
   * A habit's cost is a sum of win-probability drops, and a sum of percentages
   * is not a percentage: often enough it reads "1976%", which is not a quantity
   * anyone can picture. The two figures that do mean something are its share of
   * everything the mistakes cost, and what it costs on average each time it
   * happens. The sum stays as the bar length, where it is a magnitude and never
   * claims to be a percentage.
   */
  const lostAll = all.faults.reduce((s, f) => s + f.cost, 0);
  const share = (f) => (lostAll ? (f.cost / lostAll) * 100 : 0);
  const each = (f) => (f.count ? f.cost / f.count : 0);

  /* --- what to work on --- */
  if (top) {
    const w = $('#work');
    const b = el('b', null, R.faults[top.kind].title + '. ');
    w.appendChild(b);
    w.appendChild(document.createTextNode(
      top.count + (top.count === 1 ? ' move' : ' moves') + ' across '
      + top.games + (top.games === 1 ? ' game' : ' games') + ' — '
      + share(top).toFixed(0) + '% of everything your mistakes have cost, about '
      + each(top).toFixed(1) + '% of win probability each time. '
      + R.faults[top.kind].work + '.'));
  }

  /* --- find the move --- */
  const host = $('#trainer');
  const deck = buildDeck(all.faults, 20);
  if (deck.length) {
    trainer(host, deck);
  } else if (all.faults.length) {
    /*
     * Games on the page, and not one position among them. That is a review
     * written before this existed, not an empty deck, and the difference is a
     * command away — so it is named rather than left as a blank panel.
     */
    host.appendChild(el('p', 'note',
      'These mistakes were reviewed before the report kept the positions they happened in. '
      + 'Run  node tools/review.mjs --deep --all  to grade the saved games again, and they '
      + 'will show up here as cards.'));
  } else {
    host.appendChild(el('p', 'note',
      'Nothing has cost you anything yet, so there is nothing to find.'));
  }

  barChart($('#faultChart'), all.faults.map((f) => ({
    label: R.faults[f.kind].title,
    value: f.cost,
    note: share(f).toFixed(0) + '%  (' + f.count + ')',
    tip: '<b>' + R.faults[f.kind].title + '</b><br>' + f.count + ' moves in '
      + f.games + ' games<br>' + share(f).toFixed(0) + '% of all you have lost'
      + '<br>about ' + each(f).toFixed(1) + '% each time',
  })));

  const faults = $('#faults');
  for (const f of all.faults) {
    const info = R.faults[f.kind] || R.faults.unknown;
    const d = el('details', 'fault');
    const s = el('summary');
    s.appendChild(el('span', 'title', info.title));
    // One pill per number: "73 ×" and "36%" and "−27.1% each" run together into
    // one grey string when they share a line.
    const meta = el('span', 'meta');
    meta.appendChild(el('span', null, f.count + ' ×'));
    meta.appendChild(el('span', null, share(f).toFixed(0) + '% of all'));
    meta.appendChild(el('span', null, '-' + each(f).toFixed(1) + '% each'));
    s.appendChild(meta);
    d.appendChild(s);

    const body = el('div', 'body');
    if (info.what) body.appendChild(el('p', 'why', info.what));
    if (info.why) body.appendChild(el('p', 'note', info.why));

    body.appendChild(trendBlock(f));
    /*
     * Twice in one game is worth its own sentence. It is the same fault by the
     * count above and a different message: the first one had already happened,
     * on this board, minutes earlier, and it happened again anyway.
     */
    if (f.repeatedGames) {
      body.appendChild(el('p', 'note', 'Twice or more in the same game, in '
        + f.repeatedGames + ' of ' + f.games + ' games.'));
    }

    const lesson = el('div', 'lesson');
    if (info.checklist && info.checklist.length) {
      lesson.appendChild(el('h4', null, 'At the board'));
      const ol = el('ol');
      for (const step of info.checklist) ol.appendChild(el('li', null, step));
      lesson.appendChild(ol);
    }
    if (info.drill) {
      lesson.appendChild(el('h4', null, 'Drill'));
      lesson.appendChild(el('p', 'drill', info.drill));
    }
    lesson.appendChild(el('h4', null, 'It happened here'));
    body.appendChild(lesson);
    body.appendChild(moveList(f.moves, { board: true }));
    d.appendChild(body);
    faults.appendChild(d);
  }

  /* --- trend --- */
  lineChart($('#trend'), games.filter((g) => g.accuracy != null).map((g) => ({
    label: g.title, y: g.accuracy, moves: g.graded,
  })));

  /* --- where it goes wrong --- */
  const order = ['opening', 'middlegame', 'endgame'];
  const inPhase = order.filter((p) => R.all.phases[p]);
  const phases = inPhase.map((p) => {
    const v = R.all.phases[p];
    return {
      label: p[0].toUpperCase() + p.slice(1),
      value: v.moves ? v.lost / v.moves : 0,
      note: (v.moves ? v.lost / v.moves : 0).toFixed(1) + '% per move',
      tip: '<b>' + p + '</b><br>' + v.moves + ' moves<br>'
        + v.lost.toFixed(0) + '% lost in total',
    };
  });
  barChart($('#phases'), phases);

  // The same three phases as accuracy, which is bounded and so comparable both
  // between them and against the figure at the top of the page. Loss per move
  // is not: one blunder in a short endgame outranks a whole sloppy middlegame.
  table($('#phaseTable'),
    ['Phase', 'Your moves', 'Accuracy', 'Lost per move'],
    inPhase.map((p) => {
      const v = R.all.phases[p];
      return [
        p[0].toUpperCase() + p.slice(1),
        String(v.moves),
        v.accMoves ? (v.acc / v.accMoves).toFixed(1) + '%' : '—',
        (v.moves ? v.lost / v.moves : 0).toFixed(1) + '%',
      ];
    }));

  /* --- the two colours --- */
  const colors = ['w', 'b'].filter((c) => R.all.byColor[c]);
  table($('#colorTable'),
    ['You were', 'Games', 'Moves', 'Accuracy', 'Lost per move'],
    colors.map((c) => {
      const v = R.all.byColor[c];
      return [
        c === 'w' ? 'White' : 'Black',
        String(v.games),
        String(v.graded),
        v.accMoves ? (v.acc / v.accMoves).toFixed(1) + '%' : '—',
        (v.graded ? v.lost / v.graded : 0).toFixed(1) + '%',
      ];
    }));
  if (colors.length < 2) {
    $('#colorTable').appendChild(el('p', 'note',
      'Only one colour so far, so there is nothing to compare it against yet.'));
  }

  /* --- games, newest first: the table view every chart here has a twin in --- */
  const tb = $('#gamesBody');
  games.forEach((g, i) => {
    const tr = el('tr', 'game');
    const when = el('td');
    when.appendChild(document.createTextNode(g.title));
    if (g.playing) {
      when.appendChild(document.createElement('br'));
      const now = el('span', 'now');
      now.appendChild(el('span', 'pip'));
      now.appendChild(document.createTextNode('on the board now'));
      when.appendChild(now);
    }
    tr.appendChild(when);
    tr.appendChild(el('td', 'hide-sm', g.color === 'w' ? 'White' : 'Black'));
    tr.appendChild(el('td', 'num', String(g.plies)));
    tr.appendChild(el('td', 'num', g.graded ? g.accuracy.toFixed(1) + '%' : '—'));
    const chips = el('td', 'hide-sm');
    const box = el('div', 'chips');
    for (const k of R.gradeOrder) if (g.labels[k]) box.appendChild(chip(k, g.labels[k]));
    chips.appendChild(box);
    tr.appendChild(chips);
    tb.appendChild(tr);

    const det = el('tr', 'detail');
    det.style.display = 'none';
    const cell = el('td');
    cell.colSpan = 5;
    if (g.source === 'live') {
      cell.appendChild(el('p', 'note',
        'From the grades computed while you played. Re-run with --deep to grade '
        + 'both sides and any move missed while the board was out of sync.'));
    }

    // Where it turned, before what went wrong: the curve is the shape of the
    // game and the list underneath names the moves that made it.
    const curve = el('div');
    if (evalChart(curve, g.moves || [])) {
      cell.appendChild(curve);
      cell.appendChild(el('p', 'note',
        'Your chance of winning after each of your moves, and the moves that changed it.'));
    }

    if (g.repeats && g.repeats.length) {
      const r = g.repeats[0];
      cell.appendChild(el('p', 'note', (R.faults[r.kind] || R.faults.unknown).title
        + ' — ' + r.count + ' times in this game alone.'));
    }

    const bad = g.moves.filter((m) => m.why || m.label === 'Blunder'
      || m.label === 'Mistake' || m.label === 'Inaccuracy');
    if (bad.length) cell.appendChild(moveList(bad, { board: true }));
    else cell.appendChild(el('p', 'note', 'Nothing went wrong in this game.'));
    det.appendChild(cell);
    tb.appendChild(det);

    tr.addEventListener('click', () => {
      det.style.display = det.style.display === 'none' ? '' : 'none';
      // The boards inside were laid out at zero width while the row was hidden.
      sizeBoards();
    });
  });

  sizeBoards();
}

/* Theme toggle: the page follows the OS until you say otherwise. */
$('#theme').addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const now = document.documentElement.getAttribute('data-theme')
    || (dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
  dispatchEvent(new Event('resize'));
});

render();
`;

/**
 * The whole page, as a string.
 *
 * @param {object} data  `{ generated, all, games }` — `all` from `reviewAll`,
 *                       `games` newest first, each a `reviewGame` result with a
 *                       `title` and `source` attached.
 */
export function renderReport(data) {
  const payload = {
    ...data,
    faults: FAULTS,
    gradeColors: Object.fromEntries(Object.values(LABELS).map((l) => [l.name, l.color])),
    gradeGlyphs: Object.fromEntries(Object.values(LABELS).map((l) => [l.name, l.glyph])),
    gradeOrder: ['Brilliant', 'Best', 'Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Blunder'],
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chess coach — what to work on</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <button class="toggle" id="theme">light / dark</button>
  <h1>What to work on</h1>
  <p class="sub" id="sub"></p>

  <div id="body">
    <div class="work" id="work"></div>

    <h2>Find the move</h2>
    <div class="card" id="trainer"></div>

    <h2>Across every game</h2>
    <div class="tiles" id="tiles"></div>

    <h2>Habits, by what they cost you</h2>
    <div class="card">
      <div id="faultChart"></div>
    </div>
    <div id="faults"></div>

    <h2>Accuracy, game by game</h2>
    <div class="card"><div id="trend"></div></div>

    <h2>Where it goes wrong</h2>
    <div class="card">
      <div id="phases"></div>
      <p class="note">Win probability lost per move, by phase.</p>
      <div id="phaseTable"></div>
    </div>

    <h2>White and Black</h2>
    <div class="card">
      <div id="colorTable"></div>
      <p class="note">A gap that holds up over a dozen games is usually the opening,
        since that is the half of the game where the two colours play different positions.</p>
    </div>

    <h2>Games</h2>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th class="hide-sm">You</th>
            <th class="num">Plies</th>
            <th class="num">Accuracy</th>
            <th class="hide-sm">Grades</th>
          </tr>
        </thead>
        <tbody id="gamesBody"></tbody>
      </table>
      <p class="note">Click a game for the moves that cost something.</p>
    </div>
  </div>
</div>
<script>window.__REVIEW__ = ${embed(payload)};</script>
<script>${sanWords}
${SCRIPT}</script>
</body>
</html>
`;
}

/** Write the page. Returns the path, so the caller can print it. */
export function writeReport(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderReport(data));
  return file;
}

/* ------------------------------------------------------------- storage ---- */

/**
 * A session's reviews, kept beside the session they came from.
 *
 * The durable record, and the reason rebuilding the page is cheap: it reads a
 * few KB of JSON per session instead of re-deriving anything. It also outlives
 * the evidence — `frames.bin.gz` is the big file in a log directory and the
 * first thing anyone deletes, and a review written here survives that.
 */
export function saveReview(dir, games) {
  try {
    writeFileSync(path.join(dir, 'review.json'),
      JSON.stringify({ version: 1, saved: new Date().toISOString(), games }, null, 1));
    return true;
  } catch { return false; /* disk, or a log dir that is gone */ }
}

export function loadReview(dir) {
  const file = path.join(dir, 'review.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data.games) ? data.games : null;
  } catch { return null; /* half-written, or from a future version */ }
}

/** A session stamp as something to read: `2026-09-24T15-13-42` -> `24 Sep, 15:13`. */
export function titleOf(session, n, games) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(session);
  const when = m
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}Z`)
      .toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : session;
  return games > 1 ? `${when} · game ${n}` : when;
}

/**
 * Rebuild the page from every review on disk.
 *
 * Wholesale rather than incremental on purpose: the cross-game ranking is the
 * whole point of the page, and it changes with every game played, so there is
 * no version of this that only touches the newest row.
 */
export function rebuild({ logDir = LOG_DIR, out = REPORT_FILE } = {}) {
  const games = [];
  if (existsSync(logDir)) {
    for (const session of readdirSync(logDir).sort()) {
      for (const g of loadReview(path.join(logDir, session)) ?? []) {
        // A game with nothing graded is a session that never got going. It has
        // no accuracy, no grades and no faults, so it would draw one empty row
        // and count towards a total it contributes nothing to.
        if (g.graded > 0) games.push(g);
      }
    }
  }
  // Newest first: the game you just played is the one you came to look at.
  games.reverse();
  writeReport(out, { generated: new Date().toISOString(), all: reviewAll(games), games });
  return { file: out, games: games.length };
}
