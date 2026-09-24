/**
 * The static half of coaching: what is wrong with your position, no engine.
 *
 * Every assertion here is a fact about the board rather than a judgement of it,
 * which is the whole reason this module exists — it is the part a model would
 * otherwise be asked to guess at, and would get wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { audit, loosePieces, kingSafety, development } from '../src/audit.js';

const at = (fen) => new Chess(fen);

test('an undefended piece under attack is named exactly', () => {
  // Black pawn on d6 hits the knight on e5; nothing defends it.
  const found = loosePieces(at('4k3/8/3p4/4N3/8/8/8/4K3 w - - 0 1'), 'w');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'hanging');
  assert.equal(found[0].square, 'e5');
  assert.match(found[0].text, /knight on e5/);
});

test('being attacked by something cheaper is its own problem', () => {
  // Rook on e5 is defended by the rook on e2, but a pawn attacks it.
  const found = loosePieces(at('4k3/8/3p4/4R3/8/8/4R3/4K3 w - - 0 1'), 'w');
  assert.equal(found[0].kind, 'cheaper');
  assert.match(found[0].text, /rook on e5/);
});

test('a defended piece nobody outnumbers is not a finding', () => {
  assert.equal(loosePieces(at('4k3/8/8/4R3/8/8/4R3/4K3 w - - 0 1'), 'w').length, 0);
});

test('the opening is left alone', () => {
  /*
   * "Your king is still in the centre" and "four of your pieces have not moved"
   * are both true on move one and useless there. Filling an answer with things
   * that are technically true is precisely what made the first version of these
   * hints worthless, so silence is the correct output here.
   */
  const start = at('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(audit(start, 'w'), []);
});

test('an uncastled king is raised once the pieces are out', () => {
  const developed = at('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5');
  const found = kingSafety(developed, 'w');
  assert.equal(found.length, 1);
  assert.match(found[0].text, /castle/);
});

test('a king that can no longer castle is the more serious version', () => {
  const stuck = at('r3k2r/pppq1ppp/2npbn2/4p3/4P3/2NPBN2/PPPQ1PPP/R3K2R b - - 0 12');
  const [found] = kingSafety(stuck, 'w');
  assert.match(found.text, /can no longer castle/);
  // It must outrank the version you can still fix by castling.
  const fixable = kingSafety(
    at('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5'), 'w');
  assert.ok(found.severity > fixable[0].severity);
});

test('sleeping pieces are only mentioned once it is late enough to matter', () => {
  const fen = (moveNo) => `rnbqkbnr/pp3ppp/8/2pp4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 ${moveNo}`;
  assert.deepEqual(development(at(fen(3)), 'w'), []);
  const late = development(at(fen(9)), 'w');
  assert.equal(late.length, 1);
  assert.match(late[0].text, /have not moved/);
});

test('findings come back worst first', () => {
  // A hanging queen and an uncastled king in the same position.
  const found = audit(at('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPPQPPP/R1B1K2R b KQkq - 8 6'), 'w');
  const severities = found.map((f) => f.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => b - a));
});
