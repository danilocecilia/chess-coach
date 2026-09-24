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

/** Where the page is written. One file, so a bookmark keeps working. */
export const REPORT_FILE = path.join(ROOT, 'reports', 'index.html');

/**
 * Chart ink, from a palette validated against both surfaces
 * (`scripts/validate_palette.js`: all checks pass, ≥3:1 on each).
 */
const INK = {
  light: { surface: '#fcfcfb', plane: '#f9f9f7', primary: '#0b0b0b', secondary: '#52514e',
    muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', series: '#2a78d6',
    border: 'rgba(11,11,11,0.10)' },
  dark: { surface: '#1a1a19', plane: '#0d0d0d', primary: '#ffffff', secondary: '#c3c2b7',
    muted: '#898781', grid: '#2c2c2a', axis: '#383835', series: '#3987e5',
    border: 'rgba(255,255,255,0.10)' },
};

/** JSON safe to sit inside a <script> tag. */
function embed(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const vars = (mode) => Object.entries(INK[mode])
  .map(([k, v]) => `    --${k}: ${v};`).join('\n');

const STYLE = `
  :root {
    color-scheme: light;
${vars('light')}
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
${vars('dark')}
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
${vars('dark')}
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 16px 96px;
    background: var(--plane);
    color: var(--primary);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 860px; margin: 0 auto; }

  h1 { font-size: 26px; font-weight: 640; letter-spacing: -0.015em; margin: 0 0 4px; }
  h2 {
    font-size: 12px; font-weight: 640; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin: 40px 0 12px;
  }
  .sub { color: var(--secondary); margin: 0 0 8px; }
  .note { color: var(--muted); font-size: 13px; }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px;
  }

  /* Stat tiles: the number is the chart. */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .tile .k { font-size: 12px; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
  .tile .v { font-size: 30px; font-weight: 620; letter-spacing: -0.02em; margin-top: 2px; }
  .tile .u { font-size: 15px; font-weight: 500; color: var(--secondary); }

  /* The headline: what to work on. */
  .work { margin-top: 10px; padding: 14px 16px; border-radius: var(--radius);
          background: color-mix(in srgb, var(--series) 9%, var(--surface));
          border: 1px solid color-mix(in srgb, var(--series) 26%, transparent); }
  .work b { font-weight: 620; }

  details.fault { border-top: 1px solid var(--border); }
  details.fault:last-of-type { border-bottom: 1px solid var(--border); }
  details.fault > summary {
    cursor: pointer; padding: 10px 2px; display: flex; align-items: baseline; gap: 10px;
    list-style: none;
  }
  details.fault > summary::-webkit-details-marker { display: none; }
  details.fault > summary::before {
    content: "›"; color: var(--muted); transition: transform .15s; display: inline-block;
  }
  details.fault[open] > summary::before { transform: rotate(90deg); }
  .fault .title { font-weight: 600; }
  .fault .meta { color: var(--muted); font-size: 13px; margin-left: auto; white-space: nowrap; }
  .fault .body { padding: 2px 0 16px 18px; }
  .fault .why { color: var(--secondary); margin-bottom: 10px; }

  ul.moves { list-style: none; margin: 0; padding: 0; }
  ul.moves li { padding: 6px 0; border-top: 1px dashed var(--border); font-size: 14px; }
  ul.moves li:first-child { border-top: 0; }
  .san { font-weight: 620; font-variant-numeric: tabular-nums; }
  .drop { color: var(--muted); font-variant-numeric: tabular-nums; }
  .line { color: var(--secondary); }

  /* Grade chips: the colour is a tint behind a word, never the word itself. */
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px;
    font-size: 12.5px; white-space: nowrap; border: 1px solid var(--tint-line);
    background: var(--tint); color: var(--primary);
  }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tint-dot); flex: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }

  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th {
    text-align: left; font-size: 12px; font-weight: 600; color: var(--muted);
    letter-spacing: 0.04em; text-transform: uppercase; padding: 0 10px 8px 0;
    border-bottom: 1px solid var(--axis);
  }
  td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
  tr.game { cursor: pointer; }
  tr.game:hover td { background: color-mix(in srgb, var(--series) 5%, transparent); }
  tr.detail td { background: color-mix(in srgb, var(--primary) 3%, transparent); }

  svg { display: block; width: 100%; height: auto; overflow: visible; }
  .tip {
    position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: var(--primary); color: var(--surface); font-size: 12.5px; line-height: 1.4;
    padding: 6px 9px; border-radius: 7px; white-space: nowrap; z-index: 20;
  }

  .toggle {
    float: right; font: inherit; font-size: 13px; cursor: pointer; color: var(--secondary);
    background: var(--surface); border: 1px solid var(--border); border-radius: 999px;
    padding: 5px 13px;
  }
  .empty { color: var(--secondary); padding: 28px 0; }
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
    const rowH = 32, gap = 10, labelW = Math.min(190, Math.max(120, w * 0.3));
    const h = rows.length * rowH;
    const max = Math.max.apply(null, rows.map((r) => r.value)) || 1;
    const plotW = Math.max(40, w - labelW - 62);
    const s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, height: h });

    rows.forEach((r, i) => {
      const y = i * rowH;
      const bw = Math.max(2, (r.value / max) * plotW);

      const name = svg('text', {
        x: 0, y: y + rowH / 2 + 4, fill: css('--primary'), 'font-size': 13.5,
      });
      name.textContent = r.label;
      s.appendChild(name);

      // 4px rounded end, anchored to the baseline at labelW.
      const bar = svg('rect', {
        x: labelW, y: y + (rowH - gap) / 2, width: bw, height: gap,
        rx: 4, fill: css('--series'),
      });
      s.appendChild(bar);

      const val = svg('text', {
        x: labelW + bw + 8, y: y + rowH / 2 + 4, fill: css('--secondary'),
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

/* ---------------------------------------------------------------- page --- */
function chip(label, n) {
  const c = el('span', 'chip');
  const tint = R.gradeColors[label] || css('--muted');
  c.style.setProperty('--tint', 'color-mix(in srgb, ' + tint + ' 15%, var(--surface))');
  c.style.setProperty('--tint-line', 'color-mix(in srgb, ' + tint + ' 34%, transparent)');
  c.style.setProperty('--tint-dot', tint);
  c.appendChild(el('span', 'dot'));
  c.appendChild(document.createTextNode(n != null ? n + ' ' + label : label));
  return c;
}

function moveList(moves) {
  const ul = el('ul', 'moves');
  for (const m of moves) {
    const li = el('li');
    li.appendChild(el('span', 'san', (m.ply ? Math.ceil(m.ply / 2) + '. ' : '') + m.san));
    li.appendChild(document.createTextNode(' '));
    li.appendChild(el('span', 'drop', '−' + m.drop.toFixed(1) + '%'));
    if (m.why) {
      li.appendChild(document.createElement('br'));
      li.appendChild(el('span', 'line', m.why));
    }
    if (m.line) {
      li.appendChild(document.createElement('br'));
      li.appendChild(el('span', 'line', 'line: ' + m.line));
    }
    ul.appendChild(li);
  }
  return ul;
}

function render() {
  const all = R.all;
  const games = R.games;

  $('#sub').textContent = all.games
    ? all.games + (all.games === 1 ? ' game' : ' games') + ', ' + all.graded
      + ' of your moves graded · generated ' + new Date(R.generated).toLocaleString()
    : 'No games with graded moves yet.';

  if (!all.games) {
    $('#body').appendChild(el('p', 'empty',
      'Play a game with the coach running, or review an old session with '
      + 'node tools/review.mjs --deep --all.'));
    return;
  }

  /* --- the headline --- */
  const tiles = $('#tiles');
  const tile = (k, v, u) => {
    const t = el('div', 'tile');
    t.appendChild(el('div', 'k', k));
    const val = el('div', 'v', v);
    if (u) val.appendChild(el('span', 'u', u));
    t.appendChild(val);
    return t;
  };
  tiles.appendChild(tile('Accuracy', all.accuracy.toFixed(1), '%'));
  tiles.appendChild(tile('Games', String(all.games)));
  tiles.appendChild(tile('Moves graded', String(all.graded)));
  const top = all.faults[0];
  if (top) tiles.appendChild(tile('Biggest leak', R.faults[top.kind].title));

  /* --- what to work on --- */
  if (top) {
    const w = $('#work');
    const b = el('b', null, R.faults[top.kind].title + '. ');
    w.appendChild(b);
    w.appendChild(document.createTextNode(
      top.count + (top.count === 1 ? ' move' : ' moves') + ' across '
      + top.games + (top.games === 1 ? ' game' : ' games') + ', costing '
      + top.cost.toFixed(0) + '% of win probability — '
      + R.faults[top.kind].work + '.'));
  }

  barChart($('#faultChart'), all.faults.map((f) => ({
    label: R.faults[f.kind].title,
    value: f.cost,
    note: f.cost.toFixed(0) + '%  (' + f.count + ')',
    tip: '<b>' + R.faults[f.kind].title + '</b><br>' + f.count + ' moves in '
      + f.games + ' games<br>' + f.cost.toFixed(1) + '% of win probability lost',
  })));

  const faults = $('#faults');
  for (const f of all.faults) {
    const d = el('details', 'fault');
    const s = el('summary');
    s.appendChild(el('span', 'title', R.faults[f.kind].title));
    s.appendChild(el('span', 'meta', f.count + ' × · ' + f.cost.toFixed(0) + '%'));
    d.appendChild(s);
    const body = el('div', 'body');
    body.appendChild(el('p', 'why', R.faults[f.kind].work));
    body.appendChild(moveList(f.moves));
    d.appendChild(body);
    faults.appendChild(d);
  }

  /* --- trend --- */
  lineChart($('#trend'), games.filter((g) => g.accuracy != null).map((g) => ({
    label: g.title, y: g.accuracy, moves: g.graded,
  })));

  /* --- where it goes wrong --- */
  const order = ['opening', 'middlegame', 'endgame'];
  const phases = order.filter((p) => R.all.phases[p]).map((p) => {
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

  /* --- games, newest first: the table view every chart here has a twin in --- */
  const tb = $('#gamesBody');
  games.forEach((g, i) => {
    const tr = el('tr', 'game');
    tr.appendChild(el('td', null, g.title));
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
    const bad = g.moves.filter((m) => m.why || m.label === 'Blunder'
      || m.label === 'Mistake' || m.label === 'Inaccuracy');
    if (bad.length) cell.appendChild(moveList(bad));
    else cell.appendChild(el('p', 'note', 'Nothing went wrong in this game.'));
    det.appendChild(cell);
    tb.appendChild(det);

    tr.addEventListener('click', () => {
      det.style.display = det.style.display === 'none' ? '' : 'none';
    });
  });
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
<script>${SCRIPT}</script>
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
      for (const g of loadReview(path.join(logDir, session)) ?? []) games.push(g);
    }
  }
  // Newest first: the game you just played is the one you came to look at.
  games.reverse();
  writeReport(out, { generated: new Date().toISOString(), all: reviewAll(games), games });
  return { file: out, games: games.length };
}
