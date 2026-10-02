/**
 * The page you play on.
 *
 * Built the same way `report.js` builds its page — one self-contained file, no
 * build step, no network, the script as a `String.raw` block so nothing in it
 * has to be escaped — and sharing that page's palette, because two pages of the
 * same tool whose boards are different greens reads as a bug.
 *
 * ## It knows no chess
 *
 * This is the whole design. The page sends two square names and draws whatever
 * comes back: it cannot tell a legal move from an illegal one, does not know
 * whose turn it is except by being told, and never decides anything about a
 * position. chess.js cannot come here — there is no bundler in this project —
 * and a second move generator written in page script would mean the board you
 * are looking at and the board being graded could quietly disagree. So the
 * server owns the rules and this owns the pixels.
 *
 * Legal destinations are *asked for* rather than worked out: tap a piece and the
 * squares it can reach come back from the same move generator that will judge
 * the move. One source of truth, and the dots can never lie.
 *
 * ## The board is the report's board, rebuilt
 *
 * Same approach as `boardEl`/`boardStep` there: squares in a grid, men in one
 * absolutely-positioned layer so a piece is a transform away from anywhere,
 * which is what lets a move slide instead of cut. It is a separate
 * implementation because this one has to take input — selection, dots, a
 * promotion picker — and that is most of the code; the report's board only ever
 * replays moves it has already been handed.
 */

import { INK, MARK, vars, fixedVars } from './report.js';
import { FONTS, SANS, MONO } from './fonts.js';

const STYLE = `
${FONTS}

  :root {
    color-scheme: dark;
${fixedVars()}
${vars('dark')}
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) { color-scheme: light;
${vars('light')}
    }
  }
  :root[data-theme="light"] { color-scheme: light;
${vars('light')}
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px;
    background: var(--plane); color: var(--primary);
    font: 500 15px/22px ${SANS};
    -webkit-font-smoothing: antialiased;
  }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .wrap { max-width: 1000px; margin: 0 auto; }

  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  h1 { font-size: 20px; line-height: 26px; font-weight: 800; letter-spacing: -0.01em; margin: 0; }
  .count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .when { color: var(--muted); font-size: 13px; margin-left: auto; }

  /* Board left, coach right; one column once there is no room for two. */
  .game { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; align-items: start; }
  @media (max-width: 820px) { .game { grid-template-columns: minmax(0, 1fr); } }

  /* ---- the board ---- */
  .board {
    position: relative; display: grid; grid-template-columns: repeat(8, 1fr);
    width: 100%; aspect-ratio: 1; border-radius: var(--radius); overflow: hidden;
    border: 1px solid var(--border); user-select: none; touch-action: manipulation;
  }
  .board .sq { position: relative; }
  .board .sq.light { background: var(--board-light); }
  .board .sq.dark  { background: var(--board-dark); }
  .board .sq.from::after, .board .sq.to::after {
    content: ''; position: absolute; inset: 0; background: ${MARK.best}; opacity: 0.38;
  }
  .board .sq.played::after {
    content: ''; position: absolute; inset: 0; background: ${MARK.played}; opacity: 0.34;
  }
  .board .sq.sel::after {
    content: ''; position: absolute; inset: 0; background: ${MARK.best}; opacity: 0.5;
  }
  /* A legal destination, drawn under the men so a capture still reads. */
  .board .sq .dot {
    position: absolute; left: 50%; top: 50%; width: 30%; height: 30%;
    transform: translate(-50%, -50%); border-radius: 50%;
    background: rgba(11,11,11,0.26); pointer-events: none;
  }
  .board .sq .dot.take {
    width: 86%; height: 86%; background: none; border: 7px solid rgba(11,11,11,0.22);
  }
  .board .sq.check::after {
    content: ''; position: absolute; inset: 0; opacity: 0.55;
    background: radial-gradient(circle, ${MARK.played} 12%, transparent 72%);
  }

  .board .men { position: absolute; inset: 0; pointer-events: none; }
  .board .pc {
    position: absolute; width: 12.5%; height: 12.5%;
    display: flex; align-items: center; justify-content: center;
    transition: transform 240ms ease; will-change: transform;
    line-height: 1; cursor: pointer;
  }
  /* Both sides drawn as the solid glyph with a light outline on White, exactly
     as the report does it: the hollow "white" men are hairlines at this size. */
  .board .pc.w { color: #f7f7f3; text-shadow: 0 0 2px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.5); }
  .board .pc.b { color: #2a2a26; text-shadow: 0 0 2px rgba(255,255,255,0.35); }
  .board .pc.gone { opacity: 0; transition: opacity 200ms ease; }

  /* ---- the coach ---- */
  .panel { display: flex; flex-direction: column; gap: 12px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px 18px;
  }
  .card h2 {
    font-size: 11px; font-weight: 640; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin: 0 0 8px;
  }
  .turn { font-size: 17px; font-weight: 620; letter-spacing: -0.01em; }
  .turn.wait { color: var(--muted); font-weight: 500; }
  .fault { color: var(--secondary); font-size: 13px; margin-top: 2px; }

  .lines { display: flex; flex-direction: column; gap: 9px; }
  .line { display: flex; gap: 9px; align-items: baseline; font-size: 14px; }
  .line .bullet { flex: none; width: 15px; color: var(--muted); font-size: 12px; }
  .line.hit  .bullet { color: ${MARK.best}; }
  .line.miss .bullet, .line.fault .bullet { color: ${MARK.played}; }
  .line.hit  { color: var(--primary); }
  .line.miss { color: var(--primary); font-weight: 560; }
  .line.cost, .line.opp, .line.note { color: var(--muted); }
  .line.ask, .line.watch, .line.back { color: var(--secondary); }
  .line.hint { color: var(--primary); }
  .line.reveal { color: var(--primary); font-weight: 600; }
  .line.summary { color: var(--primary); }

  .keys { display: flex; gap: 8px; flex-wrap: wrap; }
  /* Same pressable controls as the report: a 4px edge the button drops into.
     The one green button is "go"; the rest are raised neutral. */
  .btn {
    font: 700 14px/20px ${SANS}; padding: 10px 16px; cursor: pointer; border: 0;
    background: var(--surface-raised); color: var(--secondary);
    border-radius: var(--radius-sm); box-shadow: var(--shadow-press-neutral);
  }
  .btn:hover:not(:disabled) { color: var(--primary); }
  .btn:active:not(:disabled) { transform: translateY(2px); box-shadow: none; }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .btn kbd {
    font: 700 11px/1 ${MONO}; color: var(--muted);
    background: var(--surface); border-radius: 4px; padding: 2px 5px; margin-right: 6px;
  }
  .btn.go { background: var(--brand); color: var(--on-brand); box-shadow: var(--shadow-press); }
  .btn.go kbd { color: var(--on-brand); background: rgba(255,255,255,0.25); }

  .err { color: ${MARK.played}; font-size: 13px; min-height: 18px; }
  .note { color: var(--muted); font-size: 12px; }

  /* The promotion picker: four choices over the square, nothing else clickable. */
  .promo {
    position: absolute; inset: 0; background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center; gap: 8px; z-index: 5;
  }
  .promo button {
    font-size: 30px; line-height: 1; width: 11%; aspect-ratio: 1; cursor: pointer;
    background: var(--surface); color: var(--primary);
    border: 1px solid var(--border); border-radius: 8px;
  }
`;

/*
 * The page's own script. Written without template literals, like the report's,
 * so a `${` in it cannot be swallowed by the generator's own string.
 */
const SCRIPT = String.raw`
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';
const STEP_MS = 240;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const $ = (s) => document.querySelector(s);
/* Squares numbered as a FEN writes them: 0 is a8, 63 is h1. */
const sqIndex = (name) => (8 - +name[1]) * 8 + FILES.indexOf(name[0]);
const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));

let S = null;          /* the last state the server sent */
let sel = null;        /* the square you have picked up */
let dots = [];         /* its legal destinations */
let pending = false;   /* a request is out; the board is read-only */

/* ---- talking to the session ---------------------------------------------- */

async function call(action, body) {
  if (pending) return;
  pending = true;
  setBusy(true);
  try {
    const res = await fetch('/api/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const next = await res.json();
    if (res.status === 409) return;          /* still thinking; keep what we have */
    apply(next);
  } catch (e) {
    $('#err').textContent = 'lost the session — is the coach still running?';
  } finally {
    pending = false;
    setBusy(false);
  }
}

function setBusy(on) {
  document.body.style.cursor = on ? 'progress' : '';
  for (const b of document.querySelectorAll('.btn')) b.disabled = on || b.dataset.off === '1';
}

/*
 * A new state, and the moves that got us there.
 *
 * The server sends "animate" when something happened that is worth watching —
 * your move and the capture that answers it. Those are played on the board we
 * are already looking at, then the authoritative FEN is drawn underneath. Doing
 * it the other way round would show the position after the punishment before the
 * punishment.
 */
function apply(next) {
  const steps = (next.animate || []).slice();
  S = next;
  sel = null; dots = [];

  if (!steps.length || !S.board) return void render();

  /* Draw the position these steps start from, then walk them. */
  render({ skipBoard: false });
  let i = 0;
  const walk = () => {
    if (i >= steps.length) return void render();
    step(steps[i++].uci);
    setTimeout(walk, STEP_MS + 40);
  };
  walk();
}

/* ---- the board ----------------------------------------------------------- */

let men = [];          /* 64 entries, piece letter or null */
let nodes = [];        /* 64 entries, the element standing on that square */
let flipped = false;

function place(node, i) {
  const n = flipped ? 63 - i : i;
  node.style.transform = 'translate(' + (n & 7) * 100 + '%,' + (n >> 3) * 100 + '%)';
}

function readFen(fen) {
  const out = [];
  for (const ch of String(fen || '').split(' ')[0]) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') { for (let i = 0; i < +ch; i++) out.push(null); }
    else out.push(ch);
  }
  return out.length === 64 ? out : null;
}

function drawBoard(board) {
  const host = $('#board');
  host.textContent = '';
  const read = readFen(board.fen);
  if (!read) return;
  men = read;
  nodes = new Array(64).fill(null);
  flipped = !!board.flipped;

  const squares = new Array(64);
  for (let n = 0; n < 64; n++) {
    const i = flipped ? 63 - n : n;
    const r = i >> 3, c = i & 7;
    const sq = el('div', 'sq ' + ((r + c) % 2 ? 'dark' : 'light'));
    sq.dataset.sq = sqName(i);
    squares[i] = sq;
    host.appendChild(sq);
  }
  host._sq = squares;

  const layer = el('div', 'men');
  host.appendChild(layer);
  host._layer = layer;
  for (let i = 0; i < 64; i++) if (men[i]) nodes[i] = addMan(men[i], i);

  mark(board);
  sizeBoard();
}

function addMan(p, i) {
  const node = el('span', 'pc ' + (p === p.toUpperCase() ? 'w' : 'b'), GLYPH[p.toLowerCase()] || p);
  place(node, i);
  $('#board')._layer.appendChild(node);
  return node;
}

/* The last move, the selection, its dots, and a king in check. */
function mark(board) {
  const host = $('#board');
  if (!host._sq) return;
  for (const sq of host._sq) {
    sq.className = sq.className.replace(/ (from|to|sel|played|check)/g, '');
    const d = sq.querySelector('.dot');
    if (d) d.remove();
  }
  if (board && board.lastMove) {
    host._sq[sqIndex(board.lastMove.from)].className += ' from';
    host._sq[sqIndex(board.lastMove.to)].className += ' to';
  }
  if (board && board.check) {
    const king = men.findIndex((p) => p === (board.youToMove
      ? (board.you === 'w' ? 'K' : 'k') : (board.you === 'w' ? 'k' : 'K')));
    if (king >= 0) host._sq[king].className += ' check';
  }
  if (sel != null) {
    host._sq[sqIndex(sel)].className += ' sel';
    for (const d of dots) {
      const sq = host._sq[sqIndex(d.to)];
      sq.appendChild(el('div', 'dot' + (men[sqIndex(d.to)] ? ' take' : '')));
    }
  }
}

/*
 * One move, on the board already drawn. The three that are not simply A to B —
 * a rook travelling with its king, a pawn taking a square it does not land on,
 * a pawn arriving as something else — are handled here because the page is
 * handed UCI, which does not mention any of them.
 */
function step(uci) {
  const from = sqIndex(uci.slice(0, 2));
  const to = sqIndex(uci.slice(2, 4));
  const promo = uci[4];
  const p = men[from];
  if (!p) return;

  let taken = men[to] ? to : null;
  if (p.toLowerCase() === 'p' && (from & 7) !== (to & 7) && !men[to]) {
    taken = (from & ~7) + (to & 7);          /* en passant */
  }
  if (taken != null) {
    men[taken] = null;
    const gone = nodes[taken];
    nodes[taken] = null;
    if (gone) { gone.classList.add('gone'); setTimeout(() => gone.remove(), STEP_MS); }
  }

  men[to] = promo ? (p === p.toUpperCase() ? promo.toUpperCase() : promo) : p;
  men[from] = null;
  const slide = (a, b) => {
    const node = nodes[a];
    if (!node) return;
    nodes[a] = null; nodes[b] = node;
    place(node, b);
  };
  slide(from, to);

  if (p.toLowerCase() === 'k' && Math.abs((from & 7) - (to & 7)) === 2) {
    const right = (to & 7) > (from & 7);
    const rf = (from & ~7) + (right ? 7 : 0);
    const rt = (from & ~7) + (right ? 5 : 3);
    men[rt] = men[rf]; men[rf] = null;
    slide(rf, rt);
  }
  if (promo && nodes[to]) nodes[to].textContent = GLYPH[promo.toLowerCase()] || promo;
}

/* The men are sized off the square, which CSS cannot do alone here. */
function sizeBoard() {
  const b = $('#board');
  const w = b.clientWidth;
  if (w) b.style.fontSize = Math.round((w / 8) * 0.78) + 'px';
}
addEventListener('resize', sizeBoard);

/* ---- picking a move ------------------------------------------------------ */

async function tap(square) {
  if (pending || !S || !S.can || !S.can.move) return;

  if (sel && dots.some((d) => d.to === square)) {
    const promo = dots.find((d) => d.to === square && d.promotion);
    const from = sel;
    sel = null; dots = [];
    if (promo) return void askPromotion(from, square);
    return void call('move', { from: from, to: square });
  }

  /* Picking up: ask the server what this piece can do. Never worked out here. */
  const own = men[sqIndex(square)];
  if (!own) { sel = null; dots = []; return void mark(S.board); }
  sel = square;
  const res = await fetch('/api/legal?square=' + square);
  const out = await res.json();
  dots = out.moves || [];
  if (!dots.length) sel = null;
  mark(S.board);
}

function askPromotion(from, to) {
  const host = $('#board');
  const box = el('div', 'promo');
  const black = S.board.you === 'b';
  for (const p of ['q', 'r', 'b', 'n']) {
    const b = el('button', null, GLYPH[p]);
    b.style.color = black ? '#2a2a26' : '#f7f7f3';
    b.onclick = () => { box.remove(); call('move', { from: from, to: to, promotion: p }); };
    box.appendChild(b);
  }
  host.appendChild(box);
}

/* ---- the panel ---------------------------------------------------------- */

function render(o) {
  o = o || {};
  const err = $('#err');
  err.textContent = S.error || '';

  if (S.stage === 'session-done') return void renderEnd();

  $('#count').textContent = 'position ' + S.session.at + ' of ' + S.session.total;
  $('#when').textContent = S.scenario.when ? 'from ' + S.scenario.when : '';

  if (!o.skipBoard) drawBoard(S.board); else mark(S.board);

  const turn = $('#turn');
  if (S.stage === 'punished') { turn.textContent = 'not that one'; turn.className = 'turn'; }
  else if (S.stage === 'done') { turn.textContent = 'done with this one'; turn.className = 'turn wait'; }
  else if (S.board.youToMove) { turn.textContent = 'your move'; turn.className = 'turn'; }
  else { turn.textContent = 'his move'; turn.className = 'turn wait'; }

  /* The fault is named only while it is already on the table. Before your first
     attempt on a fresh position, naming it here would answer the question. */
  $('#fault').textContent = (S.scenario.first && S.attempts === 0) ? '' : S.scenario.title;

  const lines = $('#lines');
  lines.textContent = '';
  for (const c of S.coach) {
    const row = el('div', 'line ' + c.tone);
    row.appendChild(el('span', 'bullet', bulletFor(c.tone)));
    row.appendChild(el('span', 'text', c.text));
    lines.appendChild(row);
  }

  buttons();
}

function bulletFor(tone) {
  if (tone === 'hit') return '✓';
  if (tone === 'miss' || tone === 'fault') return '×';
  if (tone === 'opp') return '→';
  if (tone === 'back') return '↩';
  if (tone === 'hint' || tone === 'reveal') return '··';
  return '·';
}

function buttons() {
  const bar = $('#keys');
  bar.textContent = '';
  const go = ['next', 'retry', 'back'];
  const add = (key, label, action, on) => {
    const b = el('button', 'btn' + (go.includes(action) ? ' go' : ''));
    if (key) b.appendChild(el('kbd', null, key));
    b.appendChild(document.createTextNode(label));
    b.disabled = !on;
    b.dataset.off = on ? '0' : '1';
    b.onclick = () => (action === 'hint' ? call('hint', { topic: key }) : call(action));
    bar.appendChild(b);
  };

  const canAsk = (S.can.hint || []).length > 0;
  add('t', 'threat', 'hint', canAsk);
  add('w', 'weaknesses', 'hint', canAsk);
  add('c', 'how critical', 'hint', canAsk);
  if (S.can.retry) add('r', 'try again', 'retry', true);
  if (S.can.back) add('b', 'take it back', 'back', true);
  if (S.can.next) add('n', 'next position', 'next', true);
  if (S.can.skip && !S.can.retry) add('s', 'skip', 'skip', true);
}

function renderEnd() {
  $('#count').textContent = 'session over';
  $('#when').textContent = '';
  $('#board').textContent = '';
  $('#turn').textContent = 'that is the session';
  $('#turn').className = 'turn';
  $('#fault').textContent = '';
  const lines = $('#lines');
  lines.textContent = '';
  for (const t of S.summary || []) {
    const row = el('div', 'line summary');
    row.appendChild(el('span', 'bullet', '·'));
    row.appendChild(el('span', 'text', t));
    lines.appendChild(row);
  }
  $('#keys').textContent = '';
  $('#hintnote').textContent = 'close the tab, or Ctrl+C in the terminal.';
}

/* ---- keys --------------------------------------------------------------- */

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || !S) return;
  const k = e.key.toLowerCase();
  if ('twc'.includes(k) && (S.can.hint || []).length) { e.preventDefault(); call('hint', { topic: k }); }
  else if (k === 'r' && S.can.retry) { e.preventDefault(); call('retry'); }
  else if (k === 'b' && S.can.back) { e.preventDefault(); call('back'); }
  else if ((k === 'n' || k === ' ') && S.can.next) { e.preventDefault(); call('next'); }
  else if (k === 's' && S.can.skip && !S.can.retry) { e.preventDefault(); call('skip'); }
  else if (k === 'escape') { sel = null; dots = []; mark(S.board); }
});

$('#board').addEventListener('click', (e) => {
  const sq = e.target.closest ? e.target.closest('.sq') : null;
  if (sq && sq.dataset.sq) return void tap(sq.dataset.sq);
  /* A man is in a layer above the squares, so a click on a piece lands here. */
  const r = $('#board').getBoundingClientRect();
  const c = Math.floor(((e.clientX - r.left) / r.width) * 8);
  const row = Math.floor(((e.clientY - r.top) / r.height) * 8);
  if (c < 0 || c > 7 || row < 0 || row > 7) return;
  const n = row * 8 + c;
  tap(sqName(flipped ? 63 - n : n));
});

fetch('/api/state').then((r) => r.json()).then(apply);
`;

/** The whole page, as one string. */
export function playPage() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chess-coach — play</title>
<style>${STYLE}</style>
<body>
<div class="wrap">
  <header>
    <h1>play</h1>
    <span class="count" id="count"></span>
    <span class="when" id="when"></span>
  </header>
  <div class="game">
    <div class="board" id="board"></div>
    <div class="panel">
      <div class="card">
        <div class="turn" id="turn"></div>
        <div class="fault" id="fault"></div>
      </div>
      <div class="card">
        <h2>coach</h2>
        <div class="lines" id="lines"></div>
      </div>
      <div class="card">
        <h2>ask</h2>
        <div class="keys" id="keys"></div>
        <div class="err" id="err"></div>
        <div class="note" id="hintnote">nothing here will name your move.</div>
      </div>
    </div>
  </div>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
