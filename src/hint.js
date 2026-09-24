/**
 * Coaching on demand: you pick the question, not the tool.
 *
 * Three topics, each on its own key, each going deeper the more you press it:
 *
 *   t  what is he threatening?     threat.js, one shallow search, only if asked
 *   w  what is wrong with mine?    audit.js, free, no engine at all
 *   c  does this move matter?      the grader, run on the runner-up line
 *
 * The first version of this was a single ladder built around withholding the
 * engine's move. That made "what can I say that is not the move" the organising
 * question and produced directionless filler — "look at the kingside" is a
 * gesture, not advice. A coach organises around what you failed to see instead,
 * and asks about the opponent's idea long before your own. Naming the threat,
 * or naming your own loose piece, points at the problem; finding the move stays
 * your job, which is both better teaching and a cleaner line to hold.
 *
 * There is still no topic that names your move.
 */

import { classify, materialWord } from './verdict.js';
import { netMaterial } from './grade.js';
import { audit } from './audit.js';

const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/* ------------------------------------------------------------------ c ----- */

const PHRASE = {
  Blunder:    'only one move holds this',
  Mistake:    'one move here is clearly best',
  Inaccuracy: 'there is better here than the obvious move',
  Good:       'a few moves are playable here',
  Excellent:  'almost anything sensible works here',
};

/**
 * How much this move matters, in the grader's own currency.
 *
 * "How much does the choice matter" is the same question as "what would playing
 * the second-best move cost", so it is answered by running the real grader over
 * best-against-runner-up. The hint inherits classify()'s calibration exactly and
 * introduces no threshold of its own.
 */
export function missCost(chess, lines) {
  const legal = chess.moves().length;
  if (legal === 0) return null;
  if (legal === 1) return { forced: true, text: 'forced — there is only one move' };
  if (!lines || lines.length < 2) return null;

  // Both scores are the same position from the same side, so they compare
  // directly — unlike an after-the-move score, which needs its frame flipped.
  const band = classify({ before: lines[0].score, after: lines[1].score });
  return { forced: false, label: band.label, gap: band.drop, text: PHRASE[band.label.name] };
}

/** What the best line actually wins, played out to the end of the line. */
export function atStake(fen, lines, color) {
  const pv = lines?.[0]?.pv ?? [];
  if (!pv.length) return null;

  // Mate first. Counting material through a mating line reads the capture on
  // the way and misses the mate — "a pawn to be won here", for Qxf7#.
  const mate = lines[0].score?.mate;
  if (typeof mate === 'number') {
    if (mate < 0) return { mate, text: 'you are being mated — this is damage control' };
    return { mate, text: mate === 1 ? 'there is mate in one here'
      : `there is a forced mate here, in ${mate}` };
  }

  const swing = netMaterial(fen, pv, color);
  const what = materialWord(swing);
  return {
    swing,
    positional: !what,
    // Careful with the quiet case: this measures what *your best line* nets,
    // which is not a statement about whether the position is safe. "Nothing
    // hangs" read as an all-clear while the board had mate in one on it — and
    // the weaknesses topic, looking at the same position, was correctly saying
    // f7 was attacked twice and defended once.
    text: !what ? 'the best line wins no material — this one is about position'
      : swing > 0 ? `there is ${what} to be won here`
      : `there is ${what} at risk here`,
  };
}

/* ------------------------------------------------------------------ t ----- */

/** Price a threat the way it would be said out loud. */
function threatCost(t) {
  if (t.mate) return t.mate === 1 ? 'it is mate next move' : `it mates in ${t.mate}`;
  const what = materialWord(t.costsMaterial);
  if (what) return `it wins ${what}`;
  return `it costs you about ${Math.round(t.costsWinPct)}% of your winning chances`;
}

export function threatSteps(threat) {
  if (!threat) return null;                       // not fetched yet
  if (threat.check) return ['you are in check — that is the threat, deal with it'];
  if (threat.none) return ['no clear idea for him here'];
  if (!threat.serious) {
    return ['nothing immediate — this is a free move, so use it on your worst piece'];
  }

  const aimed = threat.target
    ? `it is aimed at your ${NAME[threat.target.type]} on ${threat.to}`
    : `it is quiet — he is building on ${threat.to}, not capturing`;

  return [
    threat.mate ? 'he has a mating idea here' : 'he has a real threat here',
    aimed,
    // His move, not yours. Naming what he wants to play is the whole point.
    `${threat.san} is the idea — ${threatCost(threat)}`,
  ];
}

/* ------------------------------------------------------------------ w ----- */

export function weaknessSteps(chess, color) {
  const found = audit(chess, color);
  if (!found.length) {
    return ['nothing loose, king is fine, pieces are out — go look for a plan'];
  }
  return found.map((f) => f.text);
}

/* ------------------------------------------------------------- topics ----- */

/**
 * `needsThreat` is what tells main.js it must pay for a search before this
 * topic can answer. The other two are free, so they never wait on the engine.
 */
export const TOPICS = {
  t: {
    label: 'threat',
    needsThreat: true,
    steps: (ctx) => threatSteps(ctx.threat),
  },
  w: {
    label: 'weaknesses',
    needsThreat: false,
    steps: (ctx) => weaknessSteps(ctx.chess, ctx.color),
  },
  c: {
    label: 'critical',
    needsThreat: false,
    steps: (ctx) => [
      missCost(ctx.chess, ctx.lines)?.text,
      atStake(ctx.fen, ctx.lines, ctx.color)?.text,
    ].filter(Boolean),
  },
};

export const KEYS = Object.keys(TOPICS);
