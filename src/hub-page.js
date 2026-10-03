/**
 * The page you start things from.
 *
 * Built the way `play-page.js` and `report.js` build theirs — one self-contained
 * file, no build step, nothing fetched off the network, the script as a
 * `String.raw` block so nothing in it has to be escaped — and sharing their
 * palette, because three pages of the same tool in three different greens reads
 * as a bug.
 *
 * ## What it is for
 *
 * Everything here used to be a command typed in a terminal, and that is the only
 * thing being replaced: this page starts, watches and stops the same processes
 * with the same arguments, and knows nothing the CLI does not. `npm start` and
 * `npm run play` keep working exactly as before, and a coach started from a
 * terminal shows up here as adopted — the hub is a front door, not an owner.
 *
 * ## Why the log is a pre and not a console
 *
 * The coach already says useful things on stdout, in a shape someone tuned for
 * reading. Re-rendering those lines into structured rows would mean a second
 * opinion about what a verdict looks like, and the two would drift. So the log
 * is the coach's own words, monospaced, newest at the bottom.
 */

import { vars, fixedVars } from './report.js';
import { FONTS, SANS, MONO } from './fonts.js';
import { DRILLABLE } from './play.js';
import { FAULTS } from './review.js';

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
    margin: 0; padding: 32px 16px 64px;
    background: var(--plane); color: var(--primary);
    font: 500 15px/22px ${SANS};
    -webkit-font-smoothing: antialiased;
  }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  .wrap { max-width: 760px; margin: 0 auto; }

  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  h1 { font-size: 26px; line-height: 32px; margin: 0; letter-spacing: -0.01em; }
  .where { color: var(--muted); font: 500 13px/20px ${MONO}; }
  .lede { color: var(--secondary); margin: 0 0 28px; }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px; margin-bottom: 16px;
  }
  .card h2 {
    font-size: 17px; line-height: 24px; margin: 0 0 2px;
    display: flex; align-items: center; gap: 9px;
  }
  .card p { color: var(--secondary); margin: 0 0 16px; font-size: 14px; line-height: 21px; }
  .card p:last-child { margin-bottom: 0; }

  .dot {
    width: 9px; height: 9px; flex: none;
    border-radius: var(--radius-pill); background: var(--axis);
  }
  .dot[data-on="owned"] { background: var(--brand); }
  .dot[data-on="adopted"] { background: var(--series); }

  .state { color: var(--muted); font-weight: 500; font-size: 13px; margin-left: auto; }

  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .row + .row { margin-top: 12px; }

  button {
    font: 600 14px/20px ${SANS}; color: var(--on-brand); background: var(--brand);
    border: 0; border-radius: var(--radius-sm); padding: 9px 16px; cursor: pointer;
    box-shadow: var(--shadow-press);
  }
  button:active { transform: translateY(2px); box-shadow: none; }
  button.quiet {
    background: var(--surface-raised); color: var(--primary);
    box-shadow: var(--shadow-press-neutral);
  }
  button[disabled] { opacity: 0.45; cursor: default; box-shadow: none; transform: none; }

  label {
    color: var(--secondary); font-size: 13px;
    display: inline-flex; align-items: center; gap: 7px;
  }
  input[type="text"], input[type="number"], select {
    font: 500 13px/20px ${MONO}; color: var(--primary); background: var(--plane);
    border: 1px solid var(--axis); border-radius: var(--radius-sm); padding: 7px 9px;
  }
  input[type="text"] { flex: 1 1 260px; min-width: 0; }
  input[type="number"] { width: 68px; }

  a { color: var(--brand-ink); }

  pre#log {
    margin: 14px 0 0; padding: 12px 14px; max-height: 260px; overflow: auto;
    background: var(--plane); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font: 500 12px/19px ${MONO}; color: var(--secondary);
    white-space: pre-wrap; word-break: break-word;
  }

  #msg {
    margin-top: 16px; padding: 11px 14px; border-radius: var(--radius-sm);
    background: var(--surface-raised); color: var(--primary); font-size: 14px;
  }
  #msg:empty { display: none; }
`;

/*
 * The page's own script. Written without template literals, like the report's
 * and the play page's, so a dollar-brace in it cannot be swallowed by the
 * generator's own string — and with no backtick anywhere, which would truncate
 * this block into something that is still valid HTML and a broken page.
 */
const SCRIPT = String.raw`
const $ = (s) => document.querySelector(s);
const POLL_MS = 2000;

let S = null;

function setMsg(text) { $('#msg').textContent = text || ''; }

async function post(action, body) {
  setMsg('');
  try {
    const res = await fetch('/hub/api/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const out = await res.json();
    if (out && out.error) setMsg(out.error);
    await refresh();
    return out;
  } catch (e) {
    setMsg('could not reach the hub: ' + e.message);
    return null;
  }
}

/* ---- what is running ----------------------------------------------------- */

async function refresh() {
  try {
    const res = await fetch('/hub/api/status');
    S = await res.json();
  } catch (e) {
    S = null;
  }
  draw();
}

function draw() {
  if (!S) {
    $('#state').textContent = 'the hub is not answering';
    return;
  }
  const coach = S.coach || {};
  const on = coach.coach || 'off';
  const busy = (S.tool && S.tool.running) || null;

  $('#dot').setAttribute('data-on', on);
  $('#state').textContent = on === 'owned' ? 'running, pid ' + coach.pid
    : on === 'adopted' ? 'running outside the hub, pid ' + coach.pid
    : 'not running';

  $('#start').disabled = on !== 'off' || !!busy;
  $('#stop').disabled = on === 'off';
  $('#all').disabled = on !== 'off';
  $('#fen').disabled = on !== 'off';

  /* An adopted coach has no pipe, so there is nothing to stream. Say that,
     rather than leaving an empty box that looks broken. */
  $('#adopted').hidden = on !== 'adopted';

  const playing = !!(S.play && S.play.running);
  $('#playState').textContent = playing
    ? (S.play.positions || 0) + ' positions in this session'
    : 'no session';
  $('#playStart').disabled = playing || !!busy;
  $('#playStop').disabled = !playing;
  $('#playOpen').hidden = !playing;

  $('#calibrate').disabled = on !== 'off' || !!busy;
  $('#clean').disabled = on !== 'off' || !!busy;
  $('#busy').textContent = busy ? busy + ' is running' : '';
}

/* ---- the coach's own words ----------------------------------------------- */

function listen() {
  const stream = new EventSource('/hub/api/log');
  stream.onmessage = (e) => {
    const pre = $('#log');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent += JSON.parse(e.data) + '\n';
    /* Only follow the tail if they had not scrolled up to read something. */
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
}

/* ---- wiring -------------------------------------------------------------- */

$('#start').addEventListener('click', () => post('coach-start', {
  all: $('#all').checked,
  fen: $('#fen').value.trim() || null,
}));
$('#stop').addEventListener('click', () => {
  setMsg('stopping — it writes the game and the review on the way out');
  post('coach-stop');
});
$('#playStart').addEventListener('click', () => post('play-start', {
  size: Number($('#size').value) || 8,
  kind: $('#kind').value || null,
}));
$('#playStop').addEventListener('click', () => post('play-stop'));
$('#calibrate').addEventListener('click', () => post('calibrate', { auto: $('#auto').checked }));
$('#clean').addEventListener('click', () => post('cleanup'));

listen();
refresh();
setInterval(refresh, POLL_MS);
`;

/** The whole page, as one string. */
export function hubPage({ port = null } = {}) {
  const kinds = DRILLABLE
    .map((k) => `          <option value="${k}">${FAULTS[k]?.title ?? k}</option>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chess-coach</title>
<style>${STYLE}</style>
<body>
<div class="wrap">
  <header>
    <h1>chess-coach</h1>
    <span class="where">127.0.0.1${port ? ':' + port : ''}</span>
  </header>
  <p class="lede">Everything on one origin, so none of it needs a terminal.</p>

  <div class="card">
    <h2><span class="dot" id="dot" data-on="off"></span> Coach <span class="state" id="state"></span></h2>
    <p>Watches the board on screen and grades your moves while you play.</p>
    <div class="row">
      <button id="start">Start</button>
      <button id="stop" class="quiet">Stop</button>
      <label><input type="checkbox" id="all"> grade both sides</label>
    </div>
    <div class="row">
      <input type="text" id="fen" placeholder="start from a FEN instead of the opening (optional)">
    </div>
    <p id="adopted" hidden>This coach was started outside the hub, so there is no
      live log to show here. Stopping it still works.</p>
    <pre id="log"></pre>
  </div>

  <div class="card">
    <h2>Practise <span class="state" id="playState"></span></h2>
    <p>Play the positions you have already lost. <a href="/review">Open the review</a>
      to see what they have in common.</p>
    <div class="row">
      <button id="playStart">Start a drill</button>
      <button id="playStop" class="quiet">Stop</button>
      <a id="playOpen" href="/play" hidden>open the board</a>
    </div>
    <div class="row">
      <label>positions <input type="number" id="size" value="8" min="1" max="40"></label>
      <label>habit
        <select id="kind">
          <option value="">all of them</option>
${kinds}
        </select>
      </label>
    </div>
  </div>

  <div class="card">
    <h2>Setup <span class="state" id="busy"></span></h2>
    <p>Calibration teaches it your board. Do it once, with the pieces in the
      starting position — and not while a coach is running, because it rewrites
      the very files that coach has loaded.</p>
    <div class="row">
      <button id="calibrate" class="quiet">Calibrate</button>
      <label><input type="checkbox" id="auto" checked> find the board itself</label>
      <button id="clean" class="quiet">Clean up leftovers</button>
    </div>
  </div>

  <div id="msg"></div>
</div>
<script>${SCRIPT}</script>
</body>
`;
}
