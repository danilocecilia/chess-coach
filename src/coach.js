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

