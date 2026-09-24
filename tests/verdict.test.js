import test from 'node:test';
import assert from 'node:assert/strict';
import { winProb, scoreToWinProb, classify, LABELS } from '../src/verdict.js';
import { parseInfo, negate } from '../src/engine.js';

test('winProb is centred and monotonic', () => {
  assert.equal(Math.round(winProb(0)), 50);
  assert.ok(winProb(300) > winProb(100));
  assert.ok(winProb(-300) < winProb(-100));
  assert.ok(winProb(2000) > 95);
});

test('mate scores pin to the ends of the scale', () => {
  assert.equal(scoreToWinProb({ mate: 3 }), 100);
  assert.equal(scoreToWinProb({ mate: -2 }), 0);
});

test('an even swap of a big eval while winning is not a blunder', () => {
  // +900 -> +700 is a 200cp drop, but barely moves win%: still totally winning.
  const { label } = classify({ before: { cp: 900 }, after: { cp: 700 } });
  assert.notEqual(label, LABELS.BLUNDER);
});

test('the same 200cp drop in a level position is a mistake', () => {
  // ~17.8 win% swing. Costly, but recoverable — the scale should say Mistake.
  const { label, drop } = classify({ before: { cp: 20 }, after: { cp: -180 } });
  assert.equal(label, LABELS.MISTAKE);
  assert.ok(drop > 15 && drop < 25, `drop was ${drop}`);
});

test('dropping a whole piece from level is a blunder', () => {
  const { label } = classify({ before: { cp: 20 }, after: { cp: -400 } });
  assert.equal(label, LABELS.BLUNDER);
});

test('playing the engine top move grades Best', () => {
  const { label } = classify({ before: { cp: 30 }, after: { cp: 28 }, playedBest: true });
  assert.equal(label, LABELS.BEST);
});

test('a winning sacrifice grades Brilliant', () => {
  const { label } = classify({
    before: { cp: 50 }, after: { cp: 60 }, playedBest: true, sacrificed: true,
  });
  assert.equal(label, LABELS.BRILLIANT);
});

test('walking into mate is a blunder', () => {
  const { label } = classify({ before: { cp: 0 }, after: { mate: -1 } });
  assert.equal(label, LABELS.BLUNDER);
});

test('parseInfo pulls depth, score and pv', () => {
  const r = parseInfo('info depth 20 seldepth 28 score cp -34 nodes 1000 pv e2e4 e7e5 g1f3');
  assert.equal(r.depth, 20);
  assert.deepEqual(r.score, { cp: -34 });
  assert.deepEqual(r.pv, ['e2e4', 'e7e5', 'g1f3']);
});

test('negate flips both cp and mate', () => {
  assert.deepEqual(negate({ cp: 120 }), { cp: -120 });
  assert.deepEqual(negate({ mate: 4 }), { mate: -4 });
});
