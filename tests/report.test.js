import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, titleOf, sanWords } from '../src/report.js';
import { reviewGame, reviewAll } from '../src/review.js';

/*
 * The page is drawn by the browser, so what can be checked here is what the
 * generator is responsible for: that the payload survives the trip into the
 * document, that nothing in it can close the script tag it sits in, and that
 * the file needs nothing off the network to render.
 */

const game = () => ({
  ...reviewGame([
    { san: 'Nd4', mover: 'b', label: 'Blunder', drop: 30, ply: 21,
      fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
      fenAfter: '4k3/8/8/8/3n4/8/8/3RK3 w - - 1 2',
      uci: 'f3d4', bestMove: 'f3g5', bestLine: ['f3g5'],
      scoreBefore: { cp: 0 }, scoreAfter: { cp: -300 },
      refutation: ['d1d4'] },
  ], { color: 'b' }),
  id: 's#1', session: 's', title: 'a game', plies: 2, source: 'live',
});

/** The same, around any one move worth drawing a board for. */
const gameOf = (g) => ({
  ...reviewGame([{
    label: 'Blunder', drop: 30, ply: 21, mover: 'w',
    scoreBefore: { cp: 0 }, scoreAfter: { cp: -300 }, ...g,
  }], { color: g.mover || 'w' }),
  id: 's#1', session: 's', title: 'a game', plies: 2, source: 'live',
});

/** A page, run, with the replay already open on its one diagram. */
function openReplay(games) {
  const page = runPage(renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games }));
  const peek = page.find('peek')[0];
  assert.ok(peek, 'the diagram is a door, not a picture');
  peek.click();
  return page;
}

function payloadOf(html) {
  const m = /window\.__REVIEW__ = (.*?);<\/script>/s.exec(html);
  assert.ok(m, 'the page carries its data inline');
  return JSON.parse(m[1]);
}

test('the page carries its games inline and needs nothing from the network', () => {
  const games = [game()];
  const html = renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games });

  const data = payloadOf(html);
  assert.equal(data.games.length, 1);
  assert.equal(data.all.faults[0].kind, 'hung');
  // Fault headings and grade colours travel with the data, so the page needs
  // no import of its own.
  assert.ok(data.faults.hung.title);
  assert.equal(data.gradeColors.Blunder, '#fa412d');

  assert.ok(!/(src|href)="https?:/.test(html), 'no external script, style or font');
});

test('a game title that could close the script tag cannot', () => {
  // The one way inlined JSON breaks a page, and the reason `embed` escapes.
  const g = { ...game(), title: '</script><script>alert(1)</script>' };
  const html = renderReport({ generated: 'x', all: reviewAll([g]), games: [g] });

  // Exactly two script tags: the payload and the page's own code.
  assert.equal((html.match(/<script>/g) ?? []).length, 2);
  assert.equal(payloadOf(html).games[0].title, '</script><script>alert(1)</script>');
});

test('an empty history still renders a page', () => {
  const html = renderReport({ generated: 'x', all: reviewAll([]), games: [] });
  assert.ok(html.includes('<!doctype html>'));
  assert.equal(payloadOf(html).games.length, 0);
});

test('a session title reads as a date, and names the game only when there are several', () => {
  assert.match(titleOf('2026-09-24T15-13-42', 1, 1), /Sep/);
  assert.doesNotMatch(titleOf('2026-09-24T15-13-42', 1, 1), /game/);
  assert.match(titleOf('2026-09-24T15-13-42', 2, 2), /game 2/);
  // A directory that is not a stamp is still a usable label.
  assert.equal(titleOf('somewhere', 1, 1), 'somewhere');
});

/* ------------------------------------------------- the page, actually run --- */

/*
 * The page is drawn by a browser, so everything above can pass while the script
 * throws on line one and the reader gets a blank document. There is no browser
 * here and there is not going to be one — this project has no dependencies and
 * a headless browser is the largest one there is — so the script is run against
 * a DOM small enough to write down.
 *
 * It is a stub, not an emulator: nothing here lays anything out, so it cannot
 * tell you the board is square or the chart fits. What it does catch is the
 * whole class of failure that actually happens when this file is edited — a
 * field that moved, a helper called before it exists, a null that is now
 * reachable — each of which blanks the page in exactly the same silent way.
 */
function fakeDom() {
  const created = [];
  const node = (tag, ns) => {
    let text = '';
    const has = (c) => (' ' + n.className + ' ').includes(' ' + c + ' ');
    const n = {
      tagName: String(tag).toUpperCase(), ns, className: '', attrs: {}, children: [],
      clientWidth: 0, disabled: false, hidden: false, dataset: {}, on: {},
      style: { setProperty() {} },
      classList: {
        add(c) { if (!has(c)) n.className += ' ' + c; },
        remove(...cs) {
          n.className = (' ' + n.className + ' ').split(/\s+/)
            .filter((c) => c && !cs.includes(c)).join(' ');
        },
        contains: has,
        toggle(c, on) { if (on === false || (on === undefined && has(c))) n.classList.remove(c); else n.classList.add(c); },
      },
      appendChild(c) { n.children.push(c); c.parent = n; return c; },
      remove() {
        const at = n.parent ? n.parent.children.indexOf(n) : -1;
        if (at >= 0) n.parent.children.splice(at, 1);
      },
      // Recorded rather than dropped, so a test can press what the reader
      // presses. `focus` is a no-op here but has to exist: the replay moves the
      // focus into the dialog and back out again.
      addEventListener(type, fn) { (n.on[type] = n.on[type] || []).push(fn); },
      click() { for (const fn of n.on.click || []) fn({ target: n, preventDefault() {} }); },
      focus() {},
      setAttribute(k, v) { n.attrs[k] = v; },
      getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
    // Assigning textContent replaces the children, as it does in a browser —
    // which is how every redraw in this page clears what it drew last time.
    Object.defineProperty(n, 'textContent', {
      get: () => text,
      set(v) { text = String(v); n.children.length = 0; },
    });
    created.push(n);
    return n;
  };

  const byId = new Map();
  const document = {
    createElement: (t) => node(t),
    createElementNS: (ns, t) => node(t, ns),
    createTextNode: (d) => ({ text: String(d), children: [] }),
    // Every selector the page asks for is one of its own scaffold elements, and
    // the same one each time it asks.
    querySelector(sel) {
      if (!byId.has(sel)) byId.set(sel, node('div'));
      return byId.get(sel);
    },
    querySelectorAll: (sel) => created.filter(
      (n) => (' ' + n.className).includes(sel.replace('.', ' '))),
    body: node('body'),
    documentElement: node('html'),
  };
  return { document, created, byId };
}

/** Everything the page's script reaches for that is not `document`. */
function runPage(html) {
  const { document, created, byId } = fakeDom();
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const payload = JSON.parse(/window\.__REVIEW__ = (.*?);<\/script>/s.exec(html)[1]);
  const store = new Map();

  /*
   * The replay plays itself, one move every few hundred milliseconds. A real
   * clock here would leave timers running after the test that scheduled them
   * and make what the board shows a question of timing, so the page is handed
   * one the test winds by hand.
   */
  let seq = 0;
  const timers = new Map();
  const setTimeout_ = (fn) => { timers.set(++seq, fn); return seq; };
  const clearTimeout_ = (id) => timers.delete(id);
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };

  const run = new Function('window', 'document', 'getComputedStyle', 'addEventListener',
    'dispatchEvent', 'Event', 'matchMedia', 'localStorage', 'innerWidth',
    'setTimeout', 'clearTimeout', script);

  run(
    { __REVIEW__: payload }, document,
    () => ({ getPropertyValue: () => '#000' }),
    () => {}, () => {}, class {}, () => ({ matches: false }),
    { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    1200, setTimeout_, clearTimeout_,
  );

  // Everything the page put anywhere: each scaffold element it asked for by id,
  // plus the body, since the tooltip is parented straight onto it.
  const textOf = (n) => (!n ? '' : (n.text || '') + (n.textContent || '')
    + ' ' + (n.children || []).map(textOf).join(' '));
  // `text` is the page as it was drawn; `textNow` reads it again, for what
  // appears only after something has been pressed.
  const textNow = () => [...byId.values()].map(textOf).join(' ') + textOf(document.body);
  return {
    text: textNow(), textNow, textIn: (sel) => textOf(byId.get(sel)), created, byId, tick,
    boards: () => created.filter((n) => n.classList.contains('board')),
    find: (cls) => created.filter((n) => n.classList.contains(cls)),
  };
}

/*
 * Where a man is standing, read back off the board.
 *
 * The men are positioned over the squares rather than parented into them, so
 * the square a piece is on is the transform it carries — which makes this the
 * same arithmetic `place` does, checked from the other end.
 */
function manAt(board, name, flipped) {
  const i = (8 - Number(name[1])) * 8 + 'abcdefgh'.indexOf(name[0]);
  const n = flipped ? 63 - i : i;
  const want = 'translate(' + (n & 7) * 100 + '%,' + (n >> 3) * 100 + '%)';
  const layer = board.children.find((c) => c.classList.contains('men'));
  const pc = (layer ? layer.children : []).find(
    (p) => p.style.transform === want && !p.classList.contains('gone'));
  return pc || null;
}

/** The square drawn at a name, for the marks that are painted on the squares. */
function squareAt(board, name, flipped) {
  const i = (8 - Number(name[1])) * 8 + 'abcdefgh'.indexOf(name[0]);
  return board.children[flipped ? 63 - i : i];
}

test('the page runs against its own data without throwing', () => {
  const games = [game()];
  const page = runPage(renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games }));

  // The trainer drew a position, which is the one thing on this page that
  // cannot be checked by looking at the payload.
  const boards = page.boards();
  assert.ok(boards.length, 'a board was drawn');
  assert.equal(boards[0].children.filter((n) => n.classList.contains('sq')).length, 64,
    'a board is 64 squares');

  // A man on the board, and the two kings among them.
  const layer = boards[0].children.find((n) => n.classList.contains('men'));
  assert.ok(layer.children.map((p) => p.textContent).includes('♚'),
    'the kings are on the board');

  const card = page.textIn('#trainer');
  assert.match(card, /1 of 1/, 'the deck is counted');
  assert.match(card, /to play/, 'the card says whose move it is');
  /*
   * The face must not answer its own question. The grade, the cost and the name
   * of the fault are each enough to make the card rhetorical, and all three are
   * one click away.
   */
  assert.ok(!/Blunder|Hanging|30\.0%/.test(card), 'nothing on the face gives it away');
  assert.ok(!card.includes('Nd4'), 'least of all the move you played');
});

test('a fault with no stored position says which command brings it back', () => {
  // A review from before positions were kept: a fault, a cost, and no FEN.
  const games = [{
    ...reviewGame([{ san: 'Nd4', label: 'Blunder', drop: 30, mover: 'b', ply: 21 }], { color: 'b' }),
    id: 's#1', session: 's', title: 'an old game', plies: 2, source: 'live',
  }];
  const page = runPage(renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games }));

  assert.ok(!page.created.some((n) => n.className.includes('board')), 'nothing to draw');
  assert.match(page.text, /review\.mjs --deep --all/);
});

test('a page with no games at all still renders, and says so', () => {
  const page = runPage(renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll([]), games: [] }));
  assert.match(page.text, /No reviewed games yet/);
});

test('the fault write-ups reach the page', () => {
  const games = [game()];
  const page = runPage(renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games }));
  // What it is, what to do about it, and something to practise.
  assert.match(page.text, /nothing defends/i);
  assert.match(page.text, /At the board/);
  assert.match(page.text, /Drill/);
});

test('the board is drawn from the mover side, with the men on the squares they are on', () => {
  /*
   * The fixture position, in full:
   *
   *   4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1
   *
   *   black king e8, white rook d1, white king e1, black knight f3, Black to move.
   *
   * Black is to move, so the card is drawn from Black's side and e8 is at the
   * bottom. Getting this inverted is the one board bug that looks fine — a
   * legal position, the right men, mirrored — so the squares are checked by
   * name rather than by eye.
   */
  const games = [game()];
  const page = runPage(renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games }));
  const boards = page.boards();

  const face = boards[0];
  const man = (name) => manAt(face, name, true);
  assert.equal(man('e8').textContent, '♚', 'the black king is on e8');
  assert.equal(man('e1').textContent, '♚', 'and the white king on e1');
  assert.equal(man('e1').className.trim(), 'pc w', 'told apart by colour');
  assert.equal(man('f3').textContent, '♞', 'the knight is on f3');
  assert.equal(man('d1').textContent, '♜', 'the rook is on d1');
  assert.equal(man('d4'), null, 'and d4 is still empty');
  // Black at the bottom means the black king is drawn in the lower half.
  assert.ok(face.children.indexOf(squareAt(face, 'e8', true)) > 32, 'e8 is drawn near the bottom');

  // Nothing is marked before the reveal, because the marks are the answer.
  assert.ok(!face.children.some((sq) => /played|best/.test(sq.className)));

  // The diagram beside the fault list is the same position with the answer on
  // it: the move you played in one colour, the move that was there in the other.
  const shown = boards.find((b) => b.classList.contains('small'));
  assert.match(squareAt(shown, 'f3', true).className, /played/, 'the knight it came from');
  assert.match(squareAt(shown, 'd4', true).className, /played/, 'and the square it went to');
  assert.match(squareAt(shown, 'g5', true).className, /best/, 'where it should have gone');
});

/* --------------------------------------------------------------- replay --- */

/*
 * The board, played out.
 *
 * Every line here was walked through a real move generator before it was
 * written to the review, so what these cover is the other half: that the page
 * moves the right man to the right square, and that the three moves which are
 * not simply "from A to B" are not quietly drawn as if they were.
 */

test('the replay plays your move, and then the answer to it', () => {
  const page = openReplay([game()]);
  const board = page.boards().at(-1);
  const man = (name) => manAt(board, name, true);   // Black to move, Black at the bottom

  // It opens on the position, not on the move: a move you did not see start
  // from anywhere is not a move you can learn anything from.
  assert.equal(man('f3').textContent, '♞', 'the knight is still on f3');
  assert.equal(man('d4'), null);

  page.tick();
  assert.equal(man('d4').textContent, '♞', 'your move: the knight goes to d4');
  assert.equal(man('f3'), null, 'and is no longer where it came from');
  assert.match(squareAt(board, 'd4', true).className, /played/, 'lit as the move you played');

  page.tick();
  assert.equal(man('d4').textContent, '♜', 'the answer: the rook takes it');
  assert.equal(man('d1'), null);
});

test('the other side of the toggle replays the move that was there', () => {
  const page = openReplay([game()]);
  // The squares wear these classes too, so it is the button that is wanted.
  const better = page.find('best').find((n) => n.tagName === 'BUTTON');
  assert.ok(better, 'the better line can be asked for');

  better.click();
  const board = page.boards().at(-1);
  assert.equal(manAt(board, 'f3', true).textContent, '♞', 'back to the position as it was');

  page.tick();
  assert.equal(manAt(board, 'g5', true).textContent, '♞', 'the knight goes to g5 instead');
  assert.match(squareAt(board, 'g5', true).className, /best/, 'in the other colour');
});

test('a king that castles takes its rook with it', () => {
  const page = openReplay([gameOf({
    san: 'Rb1', uci: 'a1b1',
    fenBefore: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    refutation: ['e8g8'], bestMove: 'e1g1', bestLine: ['e1g1'],
  })]);
  const board = page.boards().at(-1);
  const man = (name) => manAt(board, name, false);

  page.tick();
  page.tick();
  assert.equal(man('g8').textContent, '♚', 'the king crossed two files');
  assert.equal(man('f8').textContent, '♜', 'and the rook came round with it');
  assert.equal(man('h8'), null, 'leaving the corner');
});

test('a pawn taken en passant is taken off the square it is actually on', () => {
  const page = openReplay([gameOf({
    san: 'exd6', uci: 'e5d6',
    fenBefore: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2',
    refutation: ['e8d8'], bestMove: 'e1e2', bestLine: ['e1e2'],
  })]);
  const board = page.boards().at(-1);

  page.tick();
  assert.equal(manAt(board, 'd6', false).textContent, '♟', 'the pawn lands on d6');
  // The captured pawn never stood on the square that captured it.
  assert.equal(manAt(board, 'd5', false), null, 'and the pawn on d5 is gone');
});

test('a pawn that promotes arrives as what it promoted to', () => {
  const page = openReplay([gameOf({
    san: 'a8=Q', uci: 'a7a8q',
    fenBefore: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
    refutation: ['e8f7'], bestMove: 'e1e2', bestLine: ['e1e2'],
  })]);
  const board = page.boards().at(-1);

  page.tick();
  const queen = manAt(board, 'a8', false);
  assert.equal(queen.textContent, '♛', 'a queen, not the pawn that walked there');
  assert.match(queen.className, /\bw\b/, 'and still White');
  assert.equal(manAt(board, 'a7', false), null);
});

test('a review with no lines kept still opens, on the move itself', () => {
  // Everything an older review.json holds: the two moves, and no line either
  // side of them. The board still opens, and the page says why it is short.
  const games = [gameOf({
    san: 'Nd4', mover: 'b', uci: 'f3d4',
    fenBefore: '4k3/8/8/8/8/5n2/8/3RK3 b - - 0 1',
    bestMove: 'f3g5',
  })];
  for (const m of games[0].moves) { delete m.playedLine; delete m.betterLine; }

  const page = openReplay(games);
  const board = page.boards().at(-1);
  page.tick();
  assert.equal(manAt(board, 'd4', true).textContent, '♞', 'the move you played, at least');
  assert.match(page.textNow(), /review\.mjs --all/, 'and what brings the rest of it back');
});

/* ------------------------------------------------------------- notation --- */

/*
 * Read structurally, so it works on the moves inside a line the engine returned
 * as well as on the one you played. The cases below are the whole grammar:
 * everything else on a board is one of these.
 */
test('a move in notation reads out in words', () => {
  const cases = [
    ['e4', 'pawn to e4'],
    ['Nf3', 'knight to f3'],
    ['Nxf8', 'knight takes on f8'],
    ['Qxe4+', 'queen takes on e4, with check'],
    ['Qh7#', 'queen to h7, checkmate'],
    ['exd5', 'the pawn on the e-file takes on d5'],
    ['Nbd2', 'the knight on the b-file to d2'],
    ['R1e2', 'the rook on rank 1 to e2'],
    ['Qh4e1', 'the queen on h4 to e1'],
    ['e8=Q', 'pawn to e8, promoting to a queen'],
    ['exd8=N+', 'the pawn on the e-file takes on d8, promoting to a knight, with check'],
    ['O-O', 'castles kingside'],
    ['O-O-O+', 'castles queenside, with check'],
    ['Kd2', 'king to d2'],
    // chess.js does not emit annotations, but a PGN read from elsewhere can.
    ['Nf3!?', 'knight to f3'],
  ];
  for (const [san, words] of cases) assert.equal(sanWords(san), words, san);
});

test('anything that is not a move reads as nothing', () => {
  for (const s of ['your', 'pawn', '', null, undefined, 'e9', 'Zf3', 'line:', '30.0%', 'd4d5']) {
    assert.equal(sanWords(s), null, JSON.stringify(s));
  }
});

test('a bare square is a pawn move, which is why prose is never handed to the decoder', () => {
  /*
   * `f5` is a real move and has to read as one inside a line. It is also how
   * every sentence on this page refers to a square — "your pawn on f5 is not
   * defended well enough" — where the same reading would be nonsense.
   *
   * The decoder cannot tell those apart and does not try. What keeps it right
   * is where it is attached: the move, the refutation and the engine's line,
   * never the explanation. So the guarantee is tested on the page rather than
   * on the function.
   */
  assert.equal(sanWords('f5'), 'pawn to f5');

  const games = [{
    ...reviewGame([{
      san: 'Bb2', mover: 'w', label: 'Blunder', drop: 30, ply: 20,
      fenBefore: '4k3/8/8/5p2/8/8/1B6/4K2R w K - 0 1',
      fenAfter: '4k3/8/8/5p2/8/8/1B6/4K2R b K - 1 1',
      uci: 'b2b2', refutation: [],
    }], { color: 'w' }),
    id: 's#1', title: 'a game', plies: 2, source: 'live',
  }];
  const page = runPage(renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games }));
  for (const n of page.created.filter((x) => x.className.includes('mv'))) {
    assert.ok(sanWords(n.textContent), 'only moves are marked: ' + n.textContent);
  }
});

test('the page carries the decoder with it, and hangs it on the moves', () => {
  const games = [game()];
  const html = renderReport({ generated: '2026-09-24T00:00:00Z', all: reviewAll(games), games });
  // Shipped as source rather than written twice.
  assert.ok(html.includes('function sanWords'), 'the decoder travels with the page');

  const page = runPage(html);
  const marked = page.created.filter((n) => n.className.includes('mv'));
  assert.ok(marked.length, 'moves are marked as readable');
  assert.ok(marked.some((n) => n.textContent === 'Nd4'), 'including the move you played');
  // The sentence beside it is not, since it is prose with squares in it.
  assert.ok(!marked.some((n) => /had nothing defending/.test(n.textContent)));
});
