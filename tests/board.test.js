/**
 * Recognition tests against a synthetic board renderer.
 *
 * We fabricate frames with a stable fake "piece set" so the matching algorithm
 * can be tested deterministically, with no screen, no real board and no timing.
 * If detection survives noise here it is the matching logic that is sound; the
 * remaining risk is purely whether real sprites are as separable as fake ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { BoardModel, fenToGrid, CODES, toBoardCoords, shadeOf, detectFlipped,
         indexOfSquare, squareName, decorated, gridOf, orientationOf,
         ORIENTATION_MARGIN } from '../src/board.js';
import { SQ_BYTES } from '../src/capture.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Deterministic pseudo-random sprite for a piece code: a colour plus a coverage
 * mask, opaque over the piece body, bare around it, with a fringe of partial
 * coverage for the anti-aliased edge. That is how a real piece set composites.
 *
 * An earlier version of this renderer added a per-code offset to the bare square
 * instead. That is exactly the assumption BoardModel used to make, so renderer
 * and model agreed with each other and no test here could see the error — while
 * on a real board it buried the detection signal completely. A fake board must
 * not share the model's assumptions, or it only ever confirms them.
 */
const sprites = new Map();
function sprite(code) {
  if (sprites.has(code)) return sprites.get(code);
  let seed = 7;
  for (const ch of code) seed = (seed * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const colour = new Float32Array(SQ_BYTES), opacity = new Float32Array(SQ_BYTES);
  for (let i = 0; i < SQ_BYTES; i++) {
    colour[i] = next() % 256;
    const m = (next() % 100) / 100;
    opacity[i] = m < 0.55 ? 1 : m < 0.75 ? (0.75 - m) / 0.2 : 0;
  }
  const s = { colour, opacity };
  sprites.set(code, s);
  return s;
}

/** Render a position into the same byte layout ps/capture.ps1 emits. */
function render(fen, { flipped = false, noise = 0 } = {}) {
  const grid = fenToGrid(fen, flipped);
  const frame = new Uint8Array(64 * SQ_BYTES);
  for (let idx = 0; idx < 64; idx++) {
    const [r, c] = toBoardCoords(idx, flipped);
    const base = shadeOf(r, c) === 'light' ? 200 : 96;
    const code = CODES[grid[idx]];
    const s = code === '.' ? null : sprite(code);
    for (let i = 0; i < SQ_BYTES; i++) {
      let v = s ? s.opacity[i] * s.colour[i] + (1 - s.opacity[i]) * base : base;
      if (noise) v += (Math.random() * 2 - 1) * noise;
      frame[idx * SQ_BYTES + i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return frame;
}

function trained(flipped = false) {
  return new BoardModel({ flipped }).learn(render(START, { flipped }), START);
}

test('learns a bare square and a piece template from the start position', () => {
  const m = trained();
  assert.ok(m.trained);
  assert.ok(Math.abs(m.empty.light[0] - 200) < 1, 'light square learned');
  assert.ok(Math.abs(m.empty.dark[0] - 96) < 1, 'dark square learned');
  // All 12 piece types appear in the start position.
  assert.equal(Object.keys(m.piece).length, 12);
});

test('an opaque piece is matched on both square colours', () => {
  /*
   * The model this replaced stored a piece as (tile - bare). For an opaque
   * sprite that quantity depends on the square it was learned on, so the two
   * instances of a piece — which stand on opposite colours — yielded templates
   * differing by the whole square contrast, and their average matched neither.
   * Only the king and queen, one instance each, escaped it.
   *
   * The self-fit is what catches it: 736 against the additive model, under 1
   * here. The margin assertion below does not discriminate on synthetic sprites
   * — they are byte-identical per piece type, so even a broken model separates
   * them cleanly — but it is the property calibrate.js keys on, and it is what
   * collapses first on a real board, so it is worth pinning too.
   */
  const m = trained();
  const r = m.detectMove(render(START), new Chess(START));
  assert.ok(r.still < 1, `self-fit should be near zero, got ${r.still.toFixed(1)}`);
  assert.ok(r.score - r.still > 6,
    `truth must beat the best rival by more than the threshold, got ${(r.score - r.still).toFixed(1)}`);
});

test('a piece seen on one square colour is predicted on the other', () => {
  /*
   * The king and queen stand on a single colour in the start position, so their
   * mask cannot be solved from two observations and is segmented out of the
   * frame instead. Not an edge case: the queen changes square colour on every
   * rank or file move, and the king does it castling.
   */
  const m = trained();                             // queen learned on d1 and d8 only
  const fen = '4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1';   // white queen on d2, the other colour
  const err = m.scoreFen(m.costTable(render(fen)), fen);
  assert.ok(err < 40, `queen on the unseen colour should still fit, got ${err.toFixed(1)}`);
});

test('recognises the start position as unchanged', () => {
  const m = trained();
  const chess = new Chess(START);
  const r = m.detectMove(render(START), chess);
  assert.ok(r.still < 1, `expected near-zero error, got ${r.still}`);
});

test('a real board\'s noise floor is not evidence of a bad region', () => {
  /*
   * The fake sprites above are byte-identical per piece type, which no real
   * board is: anti-aliasing, square boundaries that fall between pixels and
   * piece shadows make every instance differ slightly. So learning from a frame
   * and then scoring that same frame leaves a residual of a few hundred, which
   * calibration used to reject outright as "not the start position".
   *
   * The property that actually distinguishes a good region is relative, and it
   * survives a noise floor an order of magnitude above the old cutoff.
   */
  const frame = render(START, { noise: 40 });
  const m = new BoardModel().learn(frame, START);
  const r = m.detectMove(frame, new Chess(START));
  assert.ok(r.still > 40, `expected a real-world noise floor, got ${r.still}`);
  assert.ok(r.still < r.score, 'standing still must still beat every legal move');
});

test('detects a quiet move', () => {
  const m = trained();
  const chess = new Chess(START);
  const after = new Chess(START); after.move('e4');
  const r = m.detectMove(render(after.fen()), chess);
  assert.equal(r.uci, 'e2e4');
  assert.ok(r.score < r.still, 'move should explain the frame better than standing still');
});

test('detects a knight move', () => {
  const m = trained();
  const chess = new Chess(START);
  const after = new Chess(START); after.move('Nf3');
  assert.equal(m.detectMove(render(after.fen()), chess).uci, 'g1f3');
});

test('survives heavy pixel noise', () => {
  const m = trained();
  const chess = new Chess(START);
  const after = new Chess(START); after.move('d4');
  const r = m.detectMove(render(after.fen(), { noise: 25 }), chess);
  assert.equal(r.uci, 'd2d4', 'noise should not change the winner');
  assert.ok(r.margin > 0, 'should still be a clear winner');
});

test('works on a flipped board', () => {
  const m = trained(true);
  const chess = new Chess(START);
  const after = new Chess(START); after.move('e4');
  assert.equal(m.detectMove(render(after.fen(), { flipped: true }), chess).uci, 'e2e4');
});

test('detects castling, which touches four squares', () => {
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5';
  const m = new BoardModel().learn(render(fen), fen);
  const chess = new Chess(fen);
  const after = new Chess(fen); after.move('O-O');
  assert.equal(m.detectMove(render(after.fen()), chess).uci, 'e1g1');
});

test('detects board orientation from piece brightness', () => {
  // Make white pieces bright and black pieces dark, as every real board does.
  const shade = (fen, flipped) => {
    const grid = fenToGrid(fen, flipped);
    const frame = new Uint8Array(64 * SQ_BYTES);
    for (let idx = 0; idx < 64; idx++) {
      const code = CODES[grid[idx]];
      const v = code === '.' ? 150 : (code[0] === 'w' ? 235 : 40);
      frame.fill(v, idx * SQ_BYTES, (idx + 1) * SQ_BYTES);
    }
    return frame;
  };
  assert.equal(detectFlipped(shade(START, false)).flipped, false, 'white at bottom');
  assert.equal(detectFlipped(shade(START, true)).flipped, true, 'black at bottom');
});

test('a trained model survives a JSON round trip', () => {
  const m = trained();
  const back = BoardModel.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  const chess = new Chess(START);
  const after = new Chess(START); after.move('e4');
  assert.equal(back.flipped, m.flipped);
  assert.equal(back.detectMove(render(after.fen()), chess).uci, 'e2e4');
});

/**
 * Paint a flat `level` over a square, as a dialog or a modal does.
 *
 * Dark on purpose. The test is about what the detector can see, and an overlay
 * only reads as foreign when it is far from *both* square shades — a near-white
 * panel over a light square genuinely does look like an empty light square, on
 * this fake board and on a real one. That blind spot is why nothing downstream
 * is allowed to depend on occlusion being spotted; it only has to stop a few
 * squares from swamping a mean over 64.
 */
function cover(frame, idx, level = 10) {
  frame.fill(level, idx * SQ_BYTES, (idx + 1) * SQ_BYTES);
}

/*
 * Occlusion is tested at an explicit limit rather than the model's own.
 *
 * The fake sprites are uniform random noise, which is much closer to a flat
 * overlay than a real piece is: covering a square here lands ~3200 from the
 * nearest code, where a real board measured 7000-15000 against a limit of 4580.
 * Production keeps the loose limit on purpose — masking a square throws its
 * evidence away, and the squares most likely to be decorated are the two a move
 * is read from — so pinning these tests to it would mean tuning a real board's
 * safety margin to a fake board's weakness.
 */
const FAKE_LIMIT = 3000;

test('maps square names to image squares, both ways round', () => {
  // a8 is the first square of an unflipped screenshot and the last of a flipped one.
  assert.equal(indexOfSquare('a8', false), 0);
  assert.equal(indexOfSquare('h1', false), 63);
  assert.equal(indexOfSquare('a8', true), 63);
  assert.equal(indexOfSquare('e2', false), 52);
  for (const name of ['a8', 'h1', 'e4', 'd5', 'b7']) {
    for (const flipped of [false, true]) {
      const idx = indexOfSquare(name, flipped);
      const [r, c] = toBoardCoords(idx, flipped);
      assert.equal(String.fromCharCode(97 + c) + (8 - r), name, `${name} flipped=${flipped}`);
    }
  }
});

test('the last move\'s squares are excused, and a king in check with them', () => {
  const chess = new Chess(START);
  const move = chess.move('e4');
  const mask = decorated(chess, move, false);
  assert.equal(mask[indexOfSquare('e2', false)], 1);
  assert.equal(mask[indexOfSquare('e4', false)], 1);
  assert.equal(mask.reduce((s, v) => s + v, 0), 2, 'nothing else is excused');

  // Scholar's-mate position: black is in check, so black's king square is marked.
  const checked = new Chess('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2');
  checked.move('Qh4');
  const m2 = decorated(checked, { from: 'd8', to: 'h4' }, false);
  assert.equal(m2[indexOfSquare('e1', false)], 1, 'the checked king is excused');
});

test('a square under a modal is foreign; a misread square is not', () => {
  /*
   * The one measurement that separates "a dialog is sitting on the board" from
   * "we have lost the position", and it needs no hypothesis: a square we merely
   * read wrongly still looks like *some* piece, so its best code fits. A square
   * under a modal looks like none of the thirteen.
   */
  const m = trained();
  const clean = render(START);
  assert.equal(m.occluded(m.costTable(clean), FAKE_LIMIT).count, 0, 'a clean board hides nothing');

  const covered = new Uint8Array(clean);
  for (const sq of ['d4', 'e4', 'd5', 'e5']) cover(covered, indexOfSquare(sq, false));
  assert.equal(m.occluded(m.costTable(covered), FAKE_LIMIT).count, 4, 'four covered squares');

  // A board that is simply one move ahead of us must not be excused as covered.
  const ahead = new Chess(START); ahead.move('e4');
  assert.equal(m.occluded(m.costTable(render(ahead.fen())), FAKE_LIMIT).count, 0);
});

test('occluded squares are left out of the score instead of swamping it', () => {
  const m = trained();
  const chess = new Chess(START);
  const covered = new Uint8Array(render(START));
  for (const sq of ['d4', 'e4', 'd5', 'e5']) cover(covered, indexOfSquare(sq, false));

  const raw = m.scoreFen(m.costTable(covered), START, null);
  const { mask } = m.occluded(m.costTable(covered), FAKE_LIMIT);
  const masked = m.scoreFen(m.costTable(covered), START, mask);
  assert.ok(raw > 500, `four covered squares should wreck a plain mean, got ${raw.toFixed(0)}`);
  assert.ok(masked < 1, `masking them should restore the fit, got ${masked.toFixed(1)}`);

  // And the move underneath is still readable through the hole they leave.
  const after = new Chess(START); after.move('Nf3');
  const both = new Uint8Array(render(after.fen()));
  for (const sq of ['d4', 'e4', 'd5', 'e5']) cover(both, indexOfSquare(sq, false));
  const det = m.detectMove(both, chess);
  assert.equal(det.uci, 'g1f3', 'a covered corner of the board must not hide a move elsewhere');
});

test('counts squares that are outright wrong', () => {
  const m = trained();
  const after = new Chess(START); after.move('e4');
  const table = m.costTable(render(after.fen()));
  const limit = 100;

  // Against the stale position, e2 and e4 are both wrong.
  assert.equal(m.misfits(table, fenToGrid(START, false), limit), 2);
  // Against the true position, nothing is.
  assert.equal(m.misfits(table, fenToGrid(after.fen(), false), limit), 0);
});

/** Blend a square toward `level`, the way a board tints the last move. */
function tintSquare(frame, idx, level, alpha) {
  for (let i = idx * SQ_BYTES; i < (idx + 1) * SQ_BYTES; i++) {
    frame[i] = Math.round(frame[i] * (1 - alpha) + level * alpha);
  }
}

test('a tinted square still names its own piece', () => {
  /*
   * A last-move highlight is a huge perturbation in absolute terms — measured
   * at ~2400 on a real board against a wrong-square limit of 200 — so any test
   * that compares pixel distances reads a highlighted square as wrong. But a
   * tint is an affine map on intensity, so fitting one out before comparing
   * makes the answer independent of the tint's colour and strength, which is
   * what lets the same rule cover highlights, check glows and selections alike.
   */
  const m = trained();
  const chess = new Chess(START);
  for (const [name, alpha] of [['e2', 0.3], ['e2', 0.5], ['e2', 0.7],
                               ['b8', 0.5], ['e4', 0.5], ['d4', 0.6]]) {
    for (const level of [230, 40]) {
      const f = new Uint8Array(render(START));
      const idx = indexOfSquare(name, false);
      tintSquare(f, idx, level, alpha);
      const want = fenToGrid(START, false)[idx];
      assert.equal(m.tintReader(f)(idx), want,
        `${name} tinted ${level}@${alpha} should still read as ${CODES[want]}`);
    }
  }
  assert.ok(chess);
});

test('a decorated square is judged on the piece, not on the pixels', () => {
  /*
   * The guard that stops a highlight from being a loophole. Marking a square
   * as decorated must not excuse it: it only relaxes the test from "the pixels
   * are close" to "this piece is still the best of the thirteen", which a tint
   * leaves true and a wrong piece does not.
   *
   * Skipping decorated squares outright was tried and is actively harmful —
   * every wrong candidate then gets a free pass on the two squares that would
   * have refuted it, which is how a missed d4 turned into an accepted d3.
   */
  const m = trained();
  const after = new Chess(START); after.move('e4');
  // Highlighted the way a board would, so the soft path is doing real work.
  const frame = new Uint8Array(render(after.fen()));
  tintSquare(frame, indexOfSquare('e2', false), 230, 0.5);
  tintSquare(frame, indexOfSquare('e4', false), 230, 0.5);
  const table = m.costTable(frame);
  const tint = m.tintReader(frame);
  const soft = decorated(after, { from: 'e2', to: 'e4' }, false);

  // Held to the pixels, the highlight alone reads as two wrong squares.
  assert.equal(m.misfits(table, fenToGrid(after.fen(), false), 100), 2,
    'a highlight defeats a plain threshold — which is why the soft path exists');
  // Softened, the true position is recognised through it.
  assert.equal(m.misfits(table, fenToGrid(after.fen(), false), 100, { soft, tint }), 0);
  // But the stale position claims a pawn on e2 and an empty e4, and softening
  // those two squares must not make that claim pass.
  assert.equal(m.misfits(table, fenToGrid(START, false), 100, { soft, tint }), 2,
    'softening must not excuse a square that holds the wrong piece');
});

/**
 * A piece the cursor is *holding over* a square, rather than one that has landed
 * on it.
 *
 * Modelled by compositing the sprite with its own pattern rotated, which is the
 * crudest possible stand-in for a sub-square offset and enough to make the
 * point: the shape no longer lines up with the template, so no affine fit
 * repairs it. A uniformly faded piece would be the wrong model — that *is* an
 * affine map, and `bestUnderTint` is supposed to see through it.
 */
function holdPiece(frame, idx, code, { shift = SQ_BYTES >> 2, blend = 0.6 } = {}) {
  const s = sprite(code);
  const [r, c] = toBoardCoords(idx, false);
  const base = shadeOf(r, c) === 'light' ? 200 : 96;
  for (let i = 0; i < SQ_BYTES; i++) {
    const j = (i + shift) % SQ_BYTES;
    const here = s.opacity[i] * s.colour[i] + (1 - s.opacity[i]) * base;
    const there = s.opacity[j] * s.colour[j] + (1 - s.opacity[j]) * base;
    frame[idx * SQ_BYTES + i] = Math.max(0, Math.min(255,
      Math.round(here * (1 - blend) + there * blend)));
  }
}

/*
 * A limit with room for this renderer's worst *legitimate* square, which costs
 * 659 with a tint-fitted residual of 491 — a piece standing on the square colour
 * its template was predicted for rather than learned on, which is model error
 * and not a misread. Tests that used 100 were tighter than any real calibration
 * and counted that square as wrong.
 *
 * `SOFT` is the production multiple of it. The held piece below lands at 3.15x
 * the limit after the affine fit, against the 3.66x measured on the real board —
 * so the synthetic separation is the same shape as the one being guarded.
 *
 * Displacing it much further is not a harder version of this test but a
 * different one: past about 4x the square stops looking like any of the thirteen
 * codes at all, the occlusion mask takes it out of every score as foreign, and
 * what is being exercised is mid-flight animation — which `quiet` and `stable`
 * guard, not this bound. The case here is the one those cannot see: a piece
 * sitting still, plainly readable, and not where it claims to be.
 */
const HELD_LIMIT = 800;
const HELD_SOFT = HELD_LIMIT * 2;

test('a piece held over a square is not a piece that landed on it', () => {
  /*
   * The phantom move. A player picks a bishop up, holds it over g4 while they
   * think, and the board is pixel-identical for as long as they hold still —
   * `quiet` cannot tell a settled board from a settled cursor. The only thing
   * that says the piece has not landed is that it is not *aligned*, and the
   * tinted reading was blind to it: naming the piece is a comparison between
   * the thirteen codes, so a bishop straddling g4 still looks more like a
   * bishop than like anything else, and the escape waved it through.
   *
   * Measured on the session that prompted this, the held bishop cost 3.66x the
   * square limit after the affine fit where the worst *landed* square of the
   * whole game — highlight included — cost 0.59x.
   */
  const m = trained();
  const before = new Chess(START);
  for (const san of ['e4', 'e5', 'Bc4', 'Nf6', 'Qf3', 'Qe7', 'd3', 'Nc6', 'Qg3', 'd6', 'Nf3']) {
    before.move(san);
  }
  const after = new Chess(before.fen()); after.move('Bg4');

  const drag = new Uint8Array(render(after.fen()));
  holdPiece(drag, indexOfSquare('g4', false), 'bb');
  // A board marks the square a dragged piece came from, so the soft path is
  // doing real work here rather than being bypassed.
  tintSquare(drag, indexOfSquare('c8', false), 230, 0.5);

  const table = m.costTable(drag);
  const tint = m.tintReader(drag);
  const grid = fenToGrid(after.fen(), false);
  const soft = decorated(after, { from: 'c8', to: 'g4' }, false);

  assert.equal(tint(indexOfSquare('g4', false)), CODES.indexOf('bb'),
    'the held piece still names itself — which is exactly why the escape let it through');
  assert.equal(m.misfits(table, grid, HELD_LIMIT, { soft, tint }), 0,
    'unbounded, the tinted reading accepts a piece that has not landed');
  assert.equal(m.misfits(table, grid, HELD_LIMIT, { soft, tint, softLimit: HELD_SOFT }), 1,
    'bounded, the displacement refutes it');

  // And the whole point: the move stops being acceptable. MoveWatcher requires
  // the winner to explain every square, so a non-zero count is a refusal.
  const det = m.detectMove(drag, before, { squareLimit: HELD_LIMIT, softLimit: HELD_SOFT });
  assert.equal(det.uci, 'c8g4', 'it is still the best-scoring guess');
  assert.ok(det.bestMisfits > 0, 'but it no longer explains the board, so it is not accepted');

  // A move that really landed must survive the same bound, highlight and all,
  // or the fix would cost every move a frame.
  const landed = new Uint8Array(render(after.fen()));
  tintSquare(landed, indexOfSquare('c8', false), 230, 0.5);
  tintSquare(landed, indexOfSquare('g4', false), 230, 0.5);
  const real = m.detectMove(landed, before, { squareLimit: HELD_LIMIT, softLimit: HELD_SOFT });
  assert.equal(real.uci, 'c8g4');
  assert.equal(real.bestMisfits, 0, 'a landed piece under a highlight is still accepted');
});

test('replaces a move that was never played with the one that was', () => {
  /*
   * The recovery for the above, for when prevention has not worked: the truth
   * is one ply *sideways*. `tryUndo` asks whether the board went back to the
   * prior position and it did not — the bishop is on the board, just not where
   * we said. A forward search asks what follows the phantom, and the truth does
   * not follow it at all. On the real session a three-ply search eventually
   * matched all 64 squares by way of `Bb5 Be6 Bc4` and was refused, rightly,
   * for leading the field by nothing.
   */
  const m = trained();
  const game = new Chess(START);
  for (const san of ['e4', 'e5', 'Bc4', 'Nf6', 'Qf3', 'Qe7', 'd3', 'Nc6', 'Qg3', 'd6', 'Nf3']) {
    game.move(san);
  }
  const real = new Chess(game.fen()); real.move('Be6');   // what the player actually did
  game.move('Bg4');                                       // what we recorded instead

  const frame = new Uint8Array(render(real.fen()));
  tintSquare(frame, indexOfSquare('c8', false), 230, 0.5);
  tintSquare(frame, indexOfSquare('e6', false), 230, 0.5);
  const table = m.costTable(frame);
  const tint = m.tintReader(frame);

  const found = m.replaceLast(table, game,
    { squareLimit: HELD_LIMIT, tint, softLimit: HELD_SOFT });
  assert.ok(found, 'a replacement was found');
  assert.equal(found.was.san, 'Bg4', 'the move withdrawn');
  assert.equal(found.move.san, 'Be6', 'the move that really happened');
  assert.equal(found.misfits, 0, 'and it explains every square');
  assert.ok(found.margin > 6, `it must lead the field clearly, led by ${found.margin.toFixed(1)}`);
});

test('a move we recorded correctly is not replaced', () => {
  // The guard that stops this rung inventing a second fiction: if the board
  // does show the move we recorded, there is nothing sideways to find, and the
  // move we undid winning its own field is how that is detected.
  const m = trained();
  const game = new Chess(START);
  for (const san of ['e4', 'e5', 'Nf3']) game.move(san);
  game.move('Nc6');

  const frame = new Uint8Array(render(game.fen()));
  const found = m.replaceLast(m.costTable(frame), game,
    { squareLimit: HELD_LIMIT, tint: m.tintReader(frame), softLimit: HELD_SOFT });
  assert.equal(found, null, 'nothing to replace when the board agrees with us');

  // Nor is there anything to replace before a move has been made.
  assert.equal(m.replaceLast(m.costTable(render(START)), new Chess(START), {}), null);
});

test('re-syncs a board that ran two plies ahead', () => {
  /*
   * The failure that used to be terminal: one move missed — rejected mid-repaint,
   * or played while a dialog covered the board — and the tracked position is
   * behind for good, because only single plies were ever considered.
   */
  const m = trained();
  const stale = new Chess(START);
  const ahead = new Chess(START);
  ahead.move('e4'); ahead.move('c5');

  const det = m.detectMove(render(ahead.fen()), stale, { squareLimit: 100 });
  assert.ok(det.stillMisfits > 0 && det.bestMisfits > 0, 'one ply cannot explain it');

  const found = m.resync(det.table, stale, { plies: 2, mask: det.mask, squareLimit: 100 });
  assert.deepEqual(found.line.map((x) => x.san), ['e4', 'c5']);
  assert.equal(found.misfits, 0, 'the recovered line explains every square');
  assert.ok(found.margin > 6, `should lead the runner-up clearly, got ${found.margin.toFixed(1)}`);
});

test('re-sync refuses to guess when the board is not actually reachable', () => {
  // A position three plies away must not be "recovered" by a two-ply search.
  const m = trained();
  const stale = new Chess(START);
  const ahead = new Chess(START);
  ahead.move('e4'); ahead.move('c5'); ahead.move('Nf3');

  const det = m.detectMove(render(ahead.fen()), stale, { squareLimit: 100 });
  const near = m.resync(det.table, stale, { plies: 2, mask: det.mask, squareLimit: 100 });
  assert.ok(near.misfits > 0, 'a two-ply line cannot explain a three-ply board');

  const far = m.resync(det.table, stale, { plies: 3, mask: det.mask, squareLimit: 100 });
  assert.deepEqual(far.line.map((x) => x.san), ['e4', 'c5', 'Nf3']);
  assert.equal(far.misfits, 0);
});

test('reads a whole board when forward search cannot reach it', () => {
  /*
   * The last rung. Several moves went by unseen, so the truth is no longer a
   * small number of plies away and no search forward from where we think we are
   * will ever find it. This is the method the rest of the design avoids on
   * purpose — one misread square invents a position — so it earns its place by
   * refusing to answer unless every square is certain.
   */
  const m = trained();
  const g = new Chess(START);
  for (const mv of ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6']) g.move(mv);

  const read = m.readBoard(m.tintReader(render(g.fen())), { squareLimit: 100 });
  assert.ok(read, 'a clean board should be readable');
  assert.equal(read.fen.split(' ')[0], g.fen().split(' ')[0], 'placement must match exactly');
  assert.equal(read.turn, 'w', 'side to move is inferred from legality');
});

test('a board read stays readable through a highlight', () => {
  const m = trained();
  const g = new Chess(START);
  for (const mv of ['e4', 'c5', 'Nf3']) g.move(mv);
  const frame = new Uint8Array(render(g.fen()));
  tintSquare(frame, indexOfSquare('g1', false), 230, 0.5);
  tintSquare(frame, indexOfSquare('f3', false), 230, 0.5);

  const read = m.readBoard(m.tintReader(frame), { squareLimit: 100 });
  assert.ok(read, 'the last move\'s highlight must not sink the whole reading');
  assert.equal(read.fen.split(' ')[0], g.fen().split(' ')[0]);
});

test('a board turned round is recognised as such, and one flag fixes it', () => {
  /*
   * The reported failure, exactly. Calibrated with White at the bottom, then a
   * game started from the other side of the board: every frame is now rotated
   * 180 degrees from what the model expects. Nothing fits, so the recovery
   * ladder runs to the bottom — and `readBoard`, which asks only whether each
   * square is certain, is perfectly happy to read the board upside down and
   * hand back a position that never existed:
   *
   *     RNBKQB1R/PPPP1PPP/5N2/4P3/4p3/8/pppp1ppp/rnbkqbnr
   *
   * which is this game seen from the wrong end, kings and queens apparently
   * swapped. That is the FEN this test pins.
   */
  const m = trained();                          // calibrated White-at-bottom
  const g = new Chess(START);
  for (const mv of ['d4', 'd5', 'Nc3']) g.move(mv);
  const frame = render(g.fen(), { flipped: true });   // ...but the screen is not
  const table = m.costTable(frame);
  const placement = (fen) => fen.split(' ')[0];

  // As calibrated: the true position explains nothing, and the reading that
  // used to be adopted here — the FEN above — is now refused outright.
  assert.ok(m.misfits(table, fenToGrid(g.fen(), false), 100) > 0,
    'a board the other way round must not fit the position we are in');
  assert.equal(m.readBoard(m.tintReader(frame), { squareLimit: 100 }), null,
    'every square is certain and the position is still a fiction: refuse it');

  /*
   * And the fix is one flag, with no re-calibration: shade is (r+c) parity and
   * (7-r)+(7-c) shares it, so the light and dark models still apply, and `bare`
   * is indexed by image square, where the site's coordinates stay put.
   */
  m.flipped = !m.flipped;
  assert.equal(m.misfits(table, fenToGrid(g.fen(), m.flipped), 100), 0,
    'the other way round, the position we are in explains every square');
  assert.equal(placement(m.readBoard(m.tintReader(frame), { squareLimit: 100 }).fen),
    placement(g.fen()), 'and the board reads as the game that is actually on screen');

  // The cost table is per image square and per piece code, with no orientation
  // in it — which is what lets the flip be tested on a frame already in hand.
  assert.deepEqual(m.costTable(frame), table, 'the cost table must survive a flip');
});

test('a board is not turned round just because we are lost on it', () => {
  /*
   * The other direction, which matters just as much: being lost on a board that
   * is the right way round must not end in flipping it. Before the grid itself
   * was consulted, a read of a correctly-oriented board succeeded just as
   * readily upside down — so "try the flip and see if it reads" would have
   * rotated a board that was never rotated, and handed back a fiction while
   * also swapping which side it was coaching.
   */
  const m = trained();
  const g = new Chess(START);
  for (const mv of ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4']) g.move(mv);
  const frame = render(g.fen());              // right way round, but far ahead of START

  m.flipped = !m.flipped;                     // what tryFlip tries
  assert.equal(m.readBoard(m.tintReader(frame), { squareLimit: 100 }), null,
    'the wrong way round must prove nothing, so the rung puts it back');

  m.flipped = !m.flipped;                     // put it back, as tryFlip does
  assert.equal(m.readBoard(m.tintReader(frame), { squareLimit: 100 }).fen.split(' ')[0],
    g.fen().split(' ')[0], 'and the honest read still works');
});

test('orientation is read off the pieces, from any position', () => {
  const facing = (fen, flipped) => orientationOf(fenToGrid(fen, flipped));

  assert.equal(facing(START, false).flipped, false, 'white at the bottom');
  assert.equal(facing(START, true).flipped, true, 'white at the top');
  assert.ok(facing(START, false).margin > 5, 'the start position is not a close call');

  // Mid-game, where detectFlipped cannot be used at all: still decisive.
  const g = new Chess(START);
  for (const mv of ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']) g.move(mv);
  assert.equal(facing(g.fen(), false).flipped, false);
  assert.ok(facing(g.fen(), false).margin >= ORIENTATION_MARGIN, 'and worth believing');

  /*
   * A thin endgame has no sides left, and must say so rather than guess. The
   * separation on its own is no guard here: these two kings are three ranks
   * apart, which looks as decisive as an opening position and means nothing —
   * either of them could have walked up the board.
   */
  const bare = facing('8/8/4k3/8/8/3K4/8/8 w - - 0 1', false);
  assert.equal(bare.flipped, null, 'two kings do not settle which way a board faces');
  assert.ok(Math.abs(3) >= ORIENTATION_MARGIN, 'and not because they are close together');

  // Enough men, though, and a late endgame still answers.
  assert.equal(facing('8/4pppp/8/8/8/8/1PPPP3/4K1k1 w - - 0 1', false).flipped, false);
});

test('a flipped board is diagnosable from the frame already in hand', () => {
  /*
   * The rung as main.js runs it. Nothing here re-captures: the cost table, the
   * occlusion mask and the tint reader that `detectMove` already produced are
   * all indexed by image square and piece code, with no orientation in them, so
   * asking "what if the board is the other way round?" is a re-score of a frame
   * we are holding — which is what makes it cheap enough to sit in the ladder.
   */
  const m = trained();
  const chess = new Chess(START);
  for (const mv of ['d4', 'd5', 'Nc3']) chess.move(mv);
  const frame = render(chess.fen(), { flipped: true });

  const det = m.detectMove(frame, chess,
    { squareLimit: 100, excuse: decorated(chess, null, m.flipped) });
  assert.ok(det.stillMisfits > 0, 'the position we are in must not explain a rotated board');
  assert.ok(det.bestMisfits > 0, 'and no single move out of it can either');
  assert.equal(det.occluded, 0, 'a rotated board is still a board: it is wrong, not covered');

  m.flipped = !m.flipped;
  assert.equal(m.misfits(det.table, gridOf(chess, m.flipped), 100,
    { skip: det.mask, tint: det.tint, soft: decorated(chess, null, m.flipped) }), 0,
    'the other way round, the position we already believe in explains every square');
});

test('a board read refuses rather than guess', () => {
  const m = trained();
  const chess = new Chess(START);

  // Covered squares are not readable, so the answer is "no answer".
  const covered = new Uint8Array(render(START));
  for (const sq of ['d4', 'e4', 'd5']) cover(covered, indexOfSquare(sq, false));
  const { mask } = m.occluded(m.costTable(covered), FAKE_LIMIT);
  assert.equal(m.readBoard(m.tintReader(covered), { squareLimit: 100, mask }), null,
    'a panel over the board must refuse, not invent a position');

  // A board showing no black king is not a position, however clearly it reads.
  // Built square by square rather than from a FEN, because chess.js will not
  // represent one — which is the whole point of checking before asking it.
  const grid = fenToGrid(START, false);
  grid[indexOfSquare('e8', false)] = 0;
  const frame = new Uint8Array(64 * SQ_BYTES);
  for (let idx = 0; idx < 64; idx++) {
    const exp = m.predict(CODES[grid[idx]], idx);
    for (let i = 0; i < SQ_BYTES; i++) {
      frame[idx * SQ_BYTES + i] = Math.max(0, Math.min(255, Math.round(exp[i])));
    }
  }
  assert.equal(m.readBoard(m.tintReader(frame), { squareLimit: 100 }), null,
    'a board with one king is not a position to adopt');
  assert.ok(chess);
});

test('detects promotion', () => {
  const fen = '8/P6k/8/8/8/8/6K1/8 w - - 0 1';
  // Learn from the start position so every piece type has a template.
  const m = new BoardModel().learn(render(START), START);
  const chess = new Chess(fen);
  const after = new Chess(fen); after.move('a8=Q');
  assert.equal(m.detectMove(render(after.fen()), chess).uci, 'a7a8q');
});

/*
 * What the session log keeps, tested as the log will read it.
 *
 * Everything below is observation rather than decision — it changes no
 * behaviour — but it is the only evidence a desync leaves behind, so it has to
 * be right in the same way the decisions are.
 */

test('squareName is indexOfSquare backwards, both ways round', () => {
  for (const name of ['a8', 'h1', 'e4', 'd5', 'b7', 'g2']) {
    for (const flipped of [false, true]) {
      assert.equal(squareName(indexOfSquare(name, flipped), flipped), name);
    }
  }
});

test('detectMove reports the head of the ranking, not just the winner', () => {
  /*
   * Which move won says little on its own. A desync looks like the true move
   * sitting third with the field bunched together, and that is only visible
   * afterwards if the field was recorded at the time.
   */
  const m = trained();
  const chess = new Chess(START);
  const after = new Chess(START); after.move('e4');
  const det = m.detectMove(render(after.fen()), chess, { squareLimit: FAKE_LIMIT });

  assert.ok(det.top.length > 1, 'the runner-up is the whole point');
  assert.equal(det.top[0].uci, 'e2e4');
  assert.equal(det.top[0].san, 'e4');
  assert.equal(det.top[0].score, det.score);
  for (let i = 1; i < det.top.length; i++) {
    assert.ok(det.top[i].score >= det.top[i - 1].score, 'ranking must come back sorted');
  }
  assert.equal(det.top[1].score - det.top[0].score, det.margin, 'lead is the gap to the runner-up');
});

test('diagnose names the squares that refute a position, and what they show', () => {
  // The board has played e4; we still believe the start position. That is a
  // one-move desync, and it should read as one: two squares, along one move.
  const m = trained();
  const stale = new Chess(START);
  const after = new Chess(START); after.move('e4');
  const table = m.costTable(render(after.fen()));

  const wrong = m.diagnose(table, gridOf(stale, false), FAKE_LIMIT);
  assert.deepEqual(wrong.map((w) => w.sq).sort(), ['e2', 'e4']);

  const e2 = wrong.find((w) => w.sq === 'e2');
  assert.equal(e2.want, 'wp', 'we expected the pawn to still be there');
  assert.equal(e2.best, '.', 'the pixels say it left');
  assert.ok(e2.wantCost > e2.bestCost, 'the expectation must cost more than the truth');

  const e4 = wrong.find((w) => w.sq === 'e4');
  assert.equal(e4.want, '.');
  assert.equal(e4.best, 'wp');

  // And the count it reports is the count misfits reports: one judgement.
  assert.equal(wrong.length, m.misfits(table, gridOf(stale, false), FAKE_LIMIT));
});

test('diagnose marks a covered square rather than calling it wrong', () => {
  const m = trained();
  const frame = render(START);
  const idx = indexOfSquare('d5', false);
  for (let i = 0; i < SQ_BYTES; i++) frame[idx * SQ_BYTES + i] = 255;   // a modal
  const table = m.costTable(frame);
  const { mask } = m.occluded(table, FAKE_LIMIT);

  const wrong = m.diagnose(table, fenToGrid(START, false), FAKE_LIMIT, { skip: mask });
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].sq, 'd5');
  assert.ok(wrong[0].occluded, 'a covered square is not evidence of a desync');
});

test('a new game reads as the start position while the tracked game is elsewhere', () => {
  /*
   * The signature main.js probes for. Starting a second game without
   * restarting the coach puts the board back at move 1 while the tracked
   * position is deep in the last one — and no forward search can find it,
   * because it is not ahead of us, it is a different game.
   *
   * What makes it identifiable is that the screen matches the opening position
   * *exactly*: zero squares wrong, against a tracked position that is wrong
   * nearly everywhere.
   */
  const m = trained();
  const played = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6']) played.move(san);

  const table = m.costTable(render(START));      // the board has been reset
  assert.equal(m.misfits(table, fenToGrid(START, false), FAKE_LIMIT), 0,
    'the opening position explains the screen completely');
  assert.ok(m.misfits(table, gridOf(played, false), FAKE_LIMIT) > 4,
    'the game we think we are in does not');

  // And the same when the site hands you the other colour for the new game:
  // the probe asks both ways round, and exactly one of them lands on zero.
  const flipped = new BoardModel({ flipped: true }).learn(render(START, { flipped: true }), START);
  const t2 = flipped.costTable(render(START, { flipped: true }));
  assert.equal(flipped.misfits(t2, fenToGrid(START, true), FAKE_LIMIT), 0);
  assert.ok(flipped.misfits(t2, fenToGrid(START, false), FAKE_LIMIT) > 4,
    'read the other way round, the same frame must not also fit');
});

test('a decoration learned as the square itself is caught at calibration', () => {
  /*
   * The failure this guards against, reproduced: calibrate on a board with a
   * stale last-move highlight, and the tint is learned as the square's own
   * background. It fits perfectly while the highlight is there and misfits by
   * thousands under every hypothesis once it clears — so no move can ever be
   * accepted again, which is exactly what a real session did for 17 minutes.
   *
   * No fit can see this, because the model was learned from the contaminated
   * frame and therefore agrees with it. Only the square's disagreement with
   * the rest of its own shade gives it away.
   */
  const frame = render(START);
  const idx = indexOfSquare('d4', false);        // empty at the start, so a bare is learned
  for (let i = 0; i < SQ_BYTES; i++) {
    frame[idx * SQ_BYTES + i] = Math.min(255, frame[idx * SQ_BYTES + i] + 50);
  }
  const m = new BoardModel().learn(frame, START);

  // It fits its own calibration frame perfectly — which is the trap.
  assert.ok(m.scoreFen(m.costTable(frame), START) < 1,
    'the contaminated frame must still look clean to a fit');

  const odd = m.oddBackgrounds();
  assert.equal(odd.length, 1, 'exactly the tinted square should be reported');
  assert.equal(odd[0].sq, 'd4');
  assert.ok(odd[0].delta > 40, `expected a large deviation, got ${odd[0].delta}`);

  // And the damage it does once the highlight clears: the square is wrong under
  // the true position, so `explains` can never be satisfied and every move is
  // refused for a reason that has nothing to do with the move. Measured against
  // the limit a *clean* calibration of this board would have set, since that is
  // the limit the session would have been playing under had it not been learned
  // from a tinted square in the first place.
  const clean = m.costTable(render(START));
  const limit = (m.contrast * 0.12) ** 2;
  assert.ok(m.misfits(clean, fenToGrid(START, false), limit) > 0,
    'once the tint clears the square misfits against a clean board\'s limit');
});

test('a clean calibration reports nothing odd, both ways round', () => {
  for (const flipped of [false, true]) {
    const m = trained(flipped);
    assert.deepEqual(m.oddBackgrounds(), [],
      `a clean board should have no odd backgrounds (flipped=${flipped})`);
  }
});

test('a square painted for a reason we cannot predict is not a desync', () => {
  /*
   * The failure this answers: a queen the player had selected cost 1441 against
   * a limit of 206 while still being the best explanation of her own square.
   * Selections, hovers, arrows and premoves are not derivable from the tracked
   * position the way a last-move highlight is, so no `soft` mask can anticipate
   * them — and one such square is wrong under every hypothesis at once, which
   * stops moves being accepted and stops recovery finding a clean line.
   */
  const m = trained();
  const chess = new Chess(START);
  const frame = render(START);
  const idx = indexOfSquare('e2', false);              // a white pawn, "selected"
  for (let i = 0; i < SQ_BYTES; i++) {
    frame[idx * SQ_BYTES + i] = Math.min(255, frame[idx * SQ_BYTES + i] + 60);
  }
  const table = m.costTable(frame);
  const grid = fenToGrid(START, false);

  // Held to the hard threshold it is simply wrong, which is the bug.
  assert.ok(m.misfits(table, grid, FAKE_LIMIT) > 0,
    'the tinted square must fail the plain pixel test, or this proves nothing');

  // Asked whether it still looks like the piece we expect, it does.
  assert.equal(m.misfits(table, grid, FAKE_LIMIT, { tint: m.tintReader(frame) }), 0,
    'a tint over the expected piece is not evidence of a desync');

  // And the move on such a board is still detected, which is the point.
  const after = new Chess(START); after.move('d4');
  const moved = render(after.fen());
  for (let i = 0; i < SQ_BYTES; i++) {
    moved[idx * SQ_BYTES + i] = Math.min(255, moved[idx * SQ_BYTES + i] + 60);
  }
  const det = m.detectMove(moved, chess, { squareLimit: FAKE_LIMIT });
  assert.equal(det.uci, 'd2d4');
  assert.equal(det.bestMisfits, 0, 'a selected piece elsewhere must not block acceptance');
});

test('a tint does not excuse the wrong piece', () => {
  /*
   * The other half, and the one that must not regress: the second chance names
   * the expected piece, so a hypothesis that puts a piece where the pixels show
   * something else is refuted exactly as before. This is the case the README
   * records as having been accepted once — d3 claimed while the board showed
   * cxd4 — and it stays refuted even with the square tinted.
   */
  const m = trained();
  const wrong = new Chess(START); wrong.move('d3');    // we claim d3
  const real = new Chess(START); real.move('d4');      // the board played d4
  const frame = render(real.fen());
  for (const name of ['d3', 'd4']) {                   // tint both, generously
    const idx = indexOfSquare(name, false);
    for (let i = 0; i < SQ_BYTES; i++) {
      frame[idx * SQ_BYTES + i] = Math.min(255, frame[idx * SQ_BYTES + i] + 60);
    }
  }
  const table = m.costTable(frame);
  const n = m.misfits(table, gridOf(wrong, false), FAKE_LIMIT, { tint: m.tintReader(frame) });
  assert.ok(n > 0, 'a claimed pawn on an empty square must still be refuted through a tint');
});

test('a king is still a king on the square colour it was never learned on', () => {
  /*
   * The king and queen stand on one square colour each in the start position,
   * so their opacity cannot be solved from two observations and is estimated.
   * The estimate used a fixed ramp of a quarter of the board's contrast — about
   * 23 levels — while a genuinely covered pixel deviates by nearly 200, so every
   * half-covered pixel saturated at opaque and `ink` absorbed the background
   * showing through it. Invisible at home, where that background cancels; fatal
   * the moment the piece steps onto the other shade.
   *
   * Measured on the session that found it: the black king, learned on light e8,
   * cost 2116 on dark f8 against a limit of 200, and the black *queen* explained
   * him at 311. One square, wrong under every hypothesis, and a perfectly
   * tracked game was lost for nine minutes.
   */
  const m = trained();
  const fen = '5k2/8/8/8/8/8/8/4K3 w - - 0 1';      // black king on f8, a dark square
  const table = m.costTable(render(fen));
  const idx = indexOfSquare('f8', false);
  const cost = (code) => table[idx * CODES.length + CODES.indexOf(code)];

  assert.ok(cost('bk') < cost('bq'),
    `the king must explain his own square better than the queen does,`
    + ` got bk ${cost('bk').toFixed(0)} against bq ${cost('bq').toFixed(0)}`);
  assert.ok(m.misfits(table, fenToGrid(fen, false), FAKE_LIMIT) === 0,
    'and the position must read clean');
});

/**
 * Make one square read as a different piece, the way a broken template does.
 *
 * Planted on an *opponent's* piece while it is our turn, because that is the
 * shape all three real faults took — a square no candidate move can touch, so
 * every reading is wrong there in the same way. Planting on an empty square
 * instead invites a candidate that moves a piece onto it, which is a different
 * situation entirely: then the square does tell the two readings apart.
 */
function plant(m, frame, name, code) {
  const idx = indexOfSquare(name, false);
  const pred = m.predict(code, idx);
  for (let i = 0; i < SQ_BYTES; i++) {
    frame[idx * SQ_BYTES + i] = Math.max(0, Math.min(255, Math.round(pred[i])));
  }
  return idx;
}

test('a square wrong either way is discounted, so one broken square is not fatal', () => {
  /*
   * Three separate faults have each put one square permanently past the pixel
   * threshold while the position itself was tracked perfectly, and each time
   * the coach died: a move must explain the whole board, and one broken square
   * makes that unsatisfiable — no move accepted, no resync line clean, the
   * ladder climbing all the way to giving up. A square both readings agree
   * about and both get wrong cannot tell them apart, so it is left out, which
   * is the reasoning the occlusion mask already runs on.
   */
  const m = trained();
  const chess = new Chess(START);
  const after = new Chess(START); after.move('d4');
  const frame = render(after.fen());
  plant(m, frame, 'b8', 'bq');            // the enemy knight reads as a queen

  const det = m.detectMove(frame, chess, { squareLimit: FAKE_LIMIT });
  assert.equal(det.uci, 'd2d4', 'the move is still the best explanation');
  assert.equal(det.staleCount, 1, 'exactly the broken square is discounted');
  assert.equal(det.bestMisfits, 0, 'so the move explains the board and can be accepted');
});

test('a broken square does not make a still board look lost either', () => {
  // The shape all three real faults took: nothing moving, one square nothing
  // can explain, and `lost` climbing anyway until every rung had failed.
  const m = trained();
  const chess = new Chess(START);
  const frame = render(START);
  plant(m, frame, 'b8', 'bq');

  const det = m.detectMove(frame, chess, { squareLimit: FAKE_LIMIT });
  assert.equal(det.staleCount, 1);
  assert.equal(det.stillMisfits, 0, 'we are not lost over a square nothing can fix');
});

test('leniency stops at one square, so being behind stays a job for the ladder', () => {
  /*
   * The bound, which is what keeps this from becoming a licence to skip
   * squares. Two plies behind is wrong either way on two squares, past the
   * bound, so nothing is discounted and recovery works exactly as it did.
   *
   * Measured at a looser bound of three, a board four plies behind accepted
   * `e3` — a move that game really did play, but as its third ply, which lands
   * the tracked position on a line the game never followed. That is the
   * unrecoverable mistake, bought for nothing, which is why the bound is one.
   */
  const m = trained();
  const two = new Chess(START); two.move('e4'); two.move('c5');
  const four = new Chess(START);
  four.move('d4'); four.move('c5'); four.move('e3'); four.move('cxd4');

  const near = m.detectMove(render(two.fen()), new Chess(START), { squareLimit: 100 });
  assert.equal(near.staleCount, 0, 'two plies behind is being lost, not a broken square');
  assert.ok(near.bestMisfits > 0, 'so no single move may claim to explain it');

  const far = m.detectMove(render(four.fen()), new Chess(START), { squareLimit: 100 });
  assert.equal(far.staleCount, 0);
  assert.ok(far.bestMisfits > 0, 'and four plies behind must not accept a move at all');
});

test('a wrong move is refused even while a square is being discounted', () => {
  /*
   * The property the whole design is built around, restated against the new
   * leniency: a candidate is judged on the squares it *changes*, and those are
   * never shared with standing still. Here d4 is on the board and one enemy
   * square is broken, so the discount is active — and "d3" must still be
   * refused on d3, which is the case the README records as having been
   * wrongly accepted once.
   */
  const m = trained();
  const after = new Chess(START); after.move('d4');
  const frame = render(after.fen());
  plant(m, frame, 'b8', 'bq');

  const det = m.detectMove(frame, new Chess(START), { squareLimit: FAKE_LIMIT });
  assert.equal(det.staleCount, 1, 'the discount is in play');
  const d3 = det.top.find((c) => c.uci === 'd2d3');
  assert.ok(d3 && d3.misfits > 0, 'and d3 still fails on the square it claims');
});

test('a board that went backwards is explained by a position we have already been in', () => {
  /*
   * The failure this answers: a knight went to c6, sat there for ten settled
   * frames — long enough to be accepted and graded — and then went back to b8.
   * A takeback, a premove reverting, a move-confirmation dismissed; whichever
   * it was, the truth was now *behind* the tracked position, where no forward
   * search reaches it at any depth. That session was lost for fifteen minutes
   * on an ordinary game.
   *
   * The recovery needs no search at all, which is what makes it the cheapest
   * rung: the position is one we were in, exactly, so it only has to be scored.
   * Modelled here as main.js does it — undo, score, compare.
   */
  const m = trained();
  const game = new Chess(START);
  for (const san of ['e4', 'e5', 'Qf3', 'Nf6', 'Bc4', 'Qe7', 'd4', 'Nc6']) game.move(san);

  // The screen shows the knight back on b8: the position before the last move.
  const back = new Chess(START);
  for (const san of ['e4', 'e5', 'Qf3', 'Nf6', 'Bc4', 'Qe7', 'd4']) back.move(san);
  const table = m.costTable(render(back.fen()));

  const played = m.misfits(table, gridOf(game, false), FAKE_LIMIT);
  assert.ok(played > 0, 'what we believe must not explain the board, or this proves nothing');

  const undone = game.undo();
  assert.equal(undone.san, 'Nc6');
  assert.equal(m.misfits(table, gridOf(game, false), FAKE_LIMIT), 0,
    'the position one ply back explains every square');
  assert.ok(m.scoreGrid(table, gridOf(game, false)) < m.scoreGrid(table, fenToGrid(back.fen(), false)) + 1,
    'and is the same position the board is showing');
});

test('an undo is refused when the board merely moved on', () => {
  // The other direction, which must not be mistaken for a takeback: the board
  // ran ahead. Undoing then explains less, not more, and is rejected on the
  // same whole-board test every other rung is held to.
  const m = trained();
  const game = new Chess(START);
  game.move('e4'); game.move('e5');
  const ahead = new Chess(START);
  ahead.move('e4'); ahead.move('e5'); ahead.move('Nf3');

  const table = m.costTable(render(ahead.fen()));
  game.undo();
  assert.ok(m.misfits(table, gridOf(game, false), FAKE_LIMIT) > 0,
    'a board that moved on must not be explained by going back');
});
