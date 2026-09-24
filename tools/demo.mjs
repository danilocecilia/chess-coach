/**
 * Dev tool: grade a few known positions end-to-end, no screen needed.
 *   node tools/demo.mjs
 * Useful for checking engine health, coach latency and explanation quality
 * without setting up a board.
 */

import { Engine } from '../src/engine.js';
import { gradeMove } from '../src/grade.js';
import { explain, shouldExplain } from '../src/coach.js';
import { formatScore } from '../src/verdict.js';
import { STOCKFISH, JEV, DEPTH } from '../src/config.js';

const CASES = [
  ['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'f3f6', 'queen takes a defended knight'],
  ['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'c4f7', 'bishop sacrifice on f7'],
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e4', 'a normal opening move'],
];

console.log(`coach model: ${JEV.coachModel}   depth: ${DEPTH}   key: ${JEV.apiKey ? 'present' : 'MISSING'}`);
const eng = await new Engine(STOCKFISH, { threads: 4 }).start();

for (const [fen, uci, note] of CASES) {
  const t0 = Date.now();
  const g = await gradeMove(eng, fen, uci, DEPTH);
  const tEngine = Date.now() - t0;

  // Mirror main.js: only interesting moves get narrated. Asking a model to
  // explain a good move invites it to invent a fault that is not there.
  const t1 = Date.now();
  const why = shouldExplain(g.label) ? await explain(g) : null;
  const tCoach = Date.now() - t1;

  console.log(`\n${g.san}  ->  ${g.label.name} ${g.label.glyph}   (${note})`);
  console.log(`   eval ${formatScore(g.scoreBefore)} -> ${formatScore(g.scoreAfter)}, cost ${g.drop.toFixed(1)}% win prob`);
  console.log(`   engine preferred: ${g.bestMove}`);
  console.log(`   coach: ${why ?? '(not narrated — nothing went wrong)'}`);
  console.log(`   timing: engine ${tEngine}ms, coach ${tCoach}ms`);
}

await eng.quit();
