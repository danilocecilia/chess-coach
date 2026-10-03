/**
 * The explanation layer — this is the only place a language model is used.
 *
 * It is deliberately downstream of the verdict. Stockfish has already decided
 * what the move was worth; the model's whole job is to put that into a sentence.
 * Every number in the prompt comes from the engine, and the model is told to
 * explain the given line rather than assess the position itself, because models
 * are poor at calculating chess and good at describing a line they are handed.
 */

import { JEV } from './config.js';
import { formatScore, materialWord } from './verdict.js';
import { pvToSan } from './grade.js';

/** Describe a material swing the way a player would say it out loud. */
function materialPhrase(swing) {
  const what = materialWord(swing);
  if (!what) return null;
  return swing < 0 ? `you end up down ${what}` : `you come out ahead ${what}`;
}

/**
 * Note the FEN is deliberately absent.
 *
 * Handing a model a FEN invites it to "read the position", which it cannot
 * reliably do — benchmarking produced invented skewers, invented pins and
 * captures of the player's own pieces. Everything here is instead a concrete
 * fact already computed by the engine, so the model only has to put a supplied
 * line into words.
 */
function buildPrompt(g) {
  const bestSan = g.bestMove ? pvToSan(g.fenBefore, [g.bestMove], 1) : null;
  const betterLine = pvToSan(g.fenBefore, g.bestLine ?? []);
  const punish = pvToSan(g.fenAfter, g.refutation ?? []);
  const mat = materialPhrase(g.materialSwing);
  const side = g.mover === 'w' ? 'White' : 'Black';

  return [
    `You are ${side}. You played ${g.san}.`,
    `Engine verdict: ${g.label.name}, costing ${g.drop.toFixed(1)}% win probability`,
    `(evaluation ${formatScore(g.scoreBefore)} -> ${formatScore(g.scoreAfter)}).`,
    punish ? `\nThe opponent punishes it with: ${punish}` : '',
    mat ? `\nAfter that line, ${mat}.` : '',
    bestSan ? `\nYou should have played ${bestSan}${betterLine ? `, with the line ${betterLine}` : ''}.` : '',
  ].filter(Boolean).join(' ');
}

const SYSTEM = [
  'You are a chess coach giving instant feedback on one move.',
  'Base your sentence ONLY on the lines and facts provided. Do not analyse the position yourself,',
  'do not invent tactics, and never mention a piece or square that does not appear in the given lines.',
  'The engine verdict is authoritative: never dispute it.',
  'Reply with ONE sentence of at most 25 words explaining the consequence, addressed to "you".',
  'No preamble, no quotation marks, no markdown.',
].join(' ');

/**
 * Only the interesting moves are worth a call. Grading Best/Excellent/Good
 * needs no narration, and skipping them keeps the overlay instant and the
 * spend near zero over a full game.
 */
export function shouldExplain(label) {
  return ['Inaccuracy', 'Mistake', 'Blunder', 'Brilliant'].includes(label.name);
}

/**
 * One call to Jev.
 *
 * The coaching topics in hint.js deliberately do not come through here. Their
 * sentences are already concrete — "your knight on e4 is hanging, nothing is
 * defending it" — and a model could only reword them, at the cost of a network
 * round trip and the risk of blurring a fact into a vaguer version of itself.
 * The first attempt did route them through a model, and generic phrasing was
 * exactly what made those hints useless.
 *
 * Returns null on any failure: the overlay must never block or break because
 * the network hiccuped, since the verdict itself is already known.
 */
async function ask(system, user, { timeoutMs = 12000, signal } = {}) {
  if (!JEV.apiKey) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ac.abort(), { once: true });

  try {
    const res = await fetch(`${JEV.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Authorization': `Bearer ${JEV.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'chess-coach',
      },
      body: JSON.stringify({
        model: JEV.coachModel,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!res.ok) {
      console.error('[coach]', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json = await res.json();
    let text = json.choices?.[0]?.message?.content?.trim();
    // Some models wrap the sentence in quotes despite being told not to.
    text = text?.replace(/^["'“‘]|["'”’]$/g, '').trim();
    return text || null;
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[coach]', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Narrate a graded move. */
export function explain(grade, opts = {}) {
  return ask(SYSTEM, buildPrompt(grade), opts);
}

/* ------------------------------------------------------ across games ------ */

/**
 * The second call, and the only other one: what your record says about you.
 *
 * ## Why this one is worth a model and the hint sentences are not
 *
 * The rule above — the model narrates, it never judges — is what decides it.
 * `audit.js` and `hint.js` hand you a fact about the board in front of you, and
 * a model could only make it vaguer. The page's "what to work on" paragraph is
 * the opposite case: the facts are all computed, there are a lot of them, and
 * what is missing is a sentence that puts them together. Today that paragraph is
 * a title, four numbers and a fixed string from FAULTS — which means every
 * player with the same worst habit reads exactly the same sentence, while the
 * page already knows that yours is improving, happens mostly in the endgame, and
 * happens twice as often with Black.
 *
 * ## The same discipline, for the same reason
 *
 * No FEN, no move, no position — the inputs are aggregates the page itself
 * computed, and the model's whole job is to say which of them are the story.
 * It is told not to do arithmetic for the same reason it is not shown a board:
 * the numbers on the page are measurements, and a model that recomputes them
 * will eventually print one that disagrees with the chart beside it.
 *
 * ## Why it is not called from the page builder
 *
 * `rebuild()` runs on the grading queue after every move you play, and it must
 * keep working with the network off — the report is a file you double-click.
 * So this is called when a game ends, the sentence is cached to disk, and the
 * page builder only ever reads it. A failure leaves the composed paragraph
 * exactly as it is today.
 */
/*
 * ## Why the phase and colour figures are not in here
 *
 * They were, and benchmarking against a real 57-game record is what took them
 * out. The page's phase split and colour split are over *every* mistake
 * together; the trend is per habit. Nothing in the data joins the two — and in
 * four runs the model joined them three times anyway: "positional drift is
 * worsening, especially in the middlegame", which the record does not say and
 * cannot say. One run also closed on "increasing risk in your decision-making
 * under pressure", which is not a measurement of anything.
 *
 * Instructions not to do it did not stop it, and that is the useful finding: a
 * fact that can be mis-joined eventually will be. The fix is not a firmer rule,
 * it is not handing over the two numbers that do not belong to each other — the
 * same move as dropping the FEN from `explain`. Everything left below is about
 * one habit and is true of that habit alone.
 *
 * A per-habit phase split would be a real fact and is welcome here if it is ever
 * computed. It cannot be derived from `f.moves`: that is the worst eight by
 * cost, so counting phases in it would describe the sample, not the habit.
 */
const HABITS_SYSTEM = [
  'You are a chess coach summarising what a player keeps doing wrong, from their own record.',
  'Every number you need is given, worked out. Every percentage or proportion you write must',
  'appear word for word in the facts — never work out a share, a fraction or a ratio yourself,',
  'and do not restate every figure.',
  'Never mention a habit that is not in the facts, and never mention where on the board,',
  'in which phase, or with which colour something happened — you have not been told.',
  'The facts say nothing about which games you won or lost, so never refer to either.',
  'Do not speculate about causes, mindset or pressure, do not give chess advice,',
  'and do not name any move. Stop once you have stated what the facts show.',
  'Reply with at most 3 sentences, 50 words total, addressed to "you".',
  'No preamble, no headings, no markdown, no bullet points.',
].join(' ');

/**
 * One fault, as the lines the prompt is built from.
 *
 * Every proportion is worked out here rather than left to be derived. Told only
 * "79 moves in 34 games" against a headline of 57, the model wrote "over a third
 * of your games" — 34 of 57 is nearly two thirds — and, on another run, invented
 * "your losing games", a category this record does not have. It computes when
 * there is something to compute, accurately or not, so there is nothing left to.
 */
function habitLines(f, title, lostAll, games) {
  const share = lostAll ? Math.round((f.cost / lostAll) * 100) : 0;
  const each = f.count ? (f.cost / f.count).toFixed(1) : '0';
  const inGames = games ? ` (${Math.round((f.games / games) * 100)}% of your games)` : '';
  const out = [`- ${title}: ${f.count} moves, in ${f.games} of your ${games} games${inGames},`
    + ` ${share}% of everything your mistakes cost, about ${each}% win probability each time.`];

  // Only a decided trend is worth a line. `unknown` carries a reason rather
  // than a direction ("only 2 games with this so far"), and handing that to a
  // model invites it to report the absence of evidence as a finding.
  if (f.trend && f.trend.verdict !== 'unknown') out.push(`  trend: ${f.trend.verdict}`);
  if (f.repeatedGames > 1) out.push(`  happened twice or more in ${f.repeatedGames} of those games`);
  return out.join('\n');
}

/**
 * @param {object} all        from `reviewAll`
 * @param {object} titles     fault kind -> its FAULTS title, so this file needs
 *                            no opinion about what a fault is called
 */
export function summariseHabits(all, titles, opts = {}) {
  if (!all?.games || !all.faults?.length) return null;

  const lostAll = all.faults.reduce((s, f) => s + f.cost, 0);
  const top = all.faults.slice(0, 3);

  const facts = [
    `${all.games} games, ${all.graded} of your moves graded`
      + (all.accuracy == null ? '' : `, accuracy ${all.accuracy.toFixed(1)}%`),
    '',
    'Your habits, worst first. Every figure on a line belongs to that habit alone:',
    ...top.map((f) => habitLines(f, titles[f.kind] ?? f.kind, lostAll, all.games)),
  ].join('\n');

  return ask(HABITS_SYSTEM, facts, opts);
}

