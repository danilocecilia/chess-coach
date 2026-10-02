/**
 * Playing your own mistakes again, until the pattern is yours.
 *
 * The review page answers "what do I keep getting wrong". It is diagnostic, and
 * the trainer deck on it is as close as it gets to practice: a position, a
 * reveal, and the reader's word that they would have found it. Nothing in this
 * project has ever made you *play* the move.
 *
 * That is the gap this file is for. A pattern you have read about is recalled;
 * a pattern you have played under a clock is recognised. So a play session
 * hands back the positions you actually lost — the same `fen`, the same side,
 * your move — and does not move on until you have found what was there. Then it
 * makes you play the consequence out, because the move is only half of it: the
 * reason `Qxe4+` was right is the three moves after it, and those are what turn
 * a solved puzzle into a habit.
 *
 * ## This is not a second coach
 *
 * Everything that judges anything here is code that already exists and is
 * already tested. `gradeMove` grades, `classify` bands, `faultOf` names the
 * fault, `audit` names the loose piece, `hint.js` answers t/w/c. The only new
 * ideas in this file are *which* positions to serve and *when* to let you move
 * on — and neither of those is a chess judgement.
 *
 * So there is deliberately no threshold here for "good enough". A move passes
 * when the grader would have called it Good or better, which means a drill can
 * never disagree with the grade the live coach would have shown you for the
 * same move. Inventing a second standard is the one thing that would make this
 * file's verdicts arguable.
 *
 * ## Nothing here is engine-dependent
 *
 * This is the pure half: the deck, the choice, the prompts, and the state
 * machine for one position. Searches are the server's, injected as results.
 * That is what lets the whole of the selection and escalation logic be tested
 * without Stockfish, the same way `review.js` is tested without a screen.
 */

import { Chess } from 'chess.js';
import { labelName } from './review.js';

/* ----------------------------------------------------------------- deck ---- */

/**
 * The faults worth drilling, and the two that are not.
 *
 * `positional` is excluded on this project's own stated grounds: `FAULTS` in
 * `review.js` calls it "the honest residue" and "the bucket to look at with an
 * engine rather than the one to train against". A drill needs a move that is
 * recognisably right, and "no material changes hands — Nd4 is a positional
 * concession" has no such move; graded as a drill it would fail you for
 * choosing the engine's third-best quiet developing move, which teaches
 * nothing and is infuriating.
 *
 * `unknown` is excluded because it is the absence of a diagnosis — a session
 * logged before grades carried positions. There is nothing in it to drill.
 */
export const DRILLABLE = [
  'missed-threat', 'missed-win', 'fork', 'allowed-mate',
  'hung', 'lost-material', 'king-safety',
];

/**
 * How much a position must have cost to be worth replaying.
 *
 * A fault that fired for 2% was correctly *classified* and is not worth a rep:
 * at that size the move you played was nearly as good as the move that was
 * there, so "find it again" is a coin toss you are being marked on. Measured on
 * the logs this was written against, `lost-material` has a median drop of 2.9
 * and `allowed-mate` 4.4 — both full of positions where the fault is real and
 * the stakes are not. 8 keeps the ones that actually hurt.
 */
export const MIN_DROP = 8;

/**
 * Not the first few moves.
 *
 * The user asked for matches already started, and a position at move 2 is not
 * one — it is an opening quiz. It is also the part of the game where "the move
 * that was there" is most often a matter of taste between playable systems.
 */
export const MIN_MOVE = 4;

const moveNumber = (fen) => Number(String(fen).split(' ')[5]) || 1;

/**
 * Every position in your history worth playing again, best evidence first.
 *
 * Takes the games as `review.json` stores them — so the caller reads the disk
 * (`loadReview`) and this stays pure. Rows missing any of `fen`, `uci` or
 * `bestUci` are dropped rather than patched: without the position there is
 * nothing to show, and without both moves there is nothing to compare.
 *
 * ## Identity is the position, not the game
 *
 * `key` is the FEN, because that is what the drill actually is. The same
 * position reached in two games is one thing to learn, and keying history by
 * game would ask you to solve it twice and report you as improving. Measured on
 * the logs here: 205 distinct FENs across 207 candidate rows, so this changes
 * almost nothing today and cannot go wrong later.
 */
export function scenariosFrom(games) {
  const out = [];
  const seen = new Set();

  for (const game of games ?? []) {
    if (!(game?.graded > 0)) continue;
    for (const fault of game.faults ?? []) {
      if (!DRILLABLE.includes(fault.kind)) continue;
      for (const m of fault.moves ?? []) {
        if (!m?.fen || !m.uci || !m.bestUci) continue;
        if ((m.drop ?? 0) < MIN_DROP) continue;
        if (moveNumber(m.fen) < MIN_MOVE) continue;
        /*
         * A move that ended the game is not a mistake, whatever the grade says.
         *
         * This is here for a real row: `Qxf1#` in logs/2026-09-30T20-09-59 is
         * filed as a 100% blunder for "missing" `Rxf1#` — and both moves are
         * mate. The cause was a grader bug (UCI answers `mate 0` for a mated
         * board, which negated to `-0` and read as a loss; fixed in `classify`,
         * see the note on `mated` there). Reviews already on disk still carry the
         * old number, and re-reviewing every session is not a precondition for
         * playing, so the deck refuses the row on the board's own evidence
         * instead of trusting the stored drop.
         */
        if (m.san?.endsWith('#')) continue;
        if (seen.has(m.fen)) continue;
        seen.add(m.fen);

        out.push({
          key: m.fen,
          id: `${game.id ?? '?'}#${m.ply ?? m.san}`,
          kind: fault.kind,
          fen: m.fen,
          // The side to move in the stored position is the side you had. Checked
          // across every candidate in the logs here and true in all of them, but
          // read off the FEN rather than the game's colour so a mismatch can
          // never seat you on the wrong side of the board.
          color: String(m.fen).split(' ')[1] === 'b' ? 'b' : 'w',
          played: m.uci,
          playedSan: m.san ?? null,
          best: m.bestUci,
          bestSan: m.best ?? null,
          playedLine: m.playedLine ?? null,
          betterLine: m.betterLine ?? null,
          why: m.why ?? null,
          line: m.line ?? null,
          drop: m.drop ?? 0,
          phase: m.phase ?? null,
          game: game.id ?? null,
          when: game.title ?? null,
        });
      }
    }
  }
  return out.sort((a, b) => b.drop - a.drop);
}

/* ------------------------------------------------------------- choosing ---- */

/** A position passed this recently is held back, in days. */
export const COOLDOWN_DAYS = 2;

const DAY = 86400e3;

/**
 * How badly this position wants to be next.
 *
 * Three bands, in the order a coach would pick them, and the cost inside each
 * band as the tiebreak so the expensive mistakes come first:
 *
 *   failed last time   you owe this one — it is the whole reason for spacing
 *   never seen         new material
 *   passed before      oldest first, so a session is not the same eight forever
 *
 * A position passed inside the cooldown drops below everything, but is still
 * *selectable*: a deck that has all been passed recently must still fill a
 * session rather than hand back nothing. That is the same degrade-and-carry-on
 * contract the dashboard has for a taken port.
 */
export function priority(scenario, record, now = Date.now()) {
  const drop = scenario.drop ?? 0;
  if (!record || !record.seen) return 2000 + drop;

  const since = record.lastSeen ? (now - Date.parse(record.lastSeen)) / DAY : 999;
  if (record.lastResult === 'fail') return 3000 + drop;

  const aged = Math.min(since, 60) * 10;
  return 1000 + aged + drop * 0.1 - (since < COOLDOWN_DAYS ? 5000 : 0);
}

/**
 * How many of a session each fault gets.
 *
 * Proportional to what the fault has actually cost you across the deck, not to
 * how often it appears: `missed-threat` and `missed-win` are over half the
 * total win probability lost in the logs this was built against, and a session
 * that spent equal time on `king-safety` would be spending it on the eighth
 * most expensive thing you do.
 *
 * Largest remainder, so eight slots divide without a fault silently vanishing
 * to rounding — and any shortfall is filled from the global ranking below, so
 * the session is always the size asked for if the deck can fill it.
 */
export function allotment(deck, size) {
  const cost = new Map();
  for (const s of deck) cost.set(s.kind, (cost.get(s.kind) ?? 0) + (s.drop ?? 0));

  const total = [...cost.values()].reduce((a, b) => a + b, 0);
  if (!total) return new Map();

  const exact = [...cost.entries()].map(([kind, c]) => ({ kind, want: (c / total) * size }));
  const out = new Map(exact.map((e) => [e.kind, Math.floor(e.want)]));

  let left = size - [...out.values()].reduce((a, b) => a + b, 0);
  for (const e of exact.sort((a, b) => (b.want % 1) - (a.want % 1))) {
    if (left <= 0) break;
    out.set(e.kind, out.get(e.kind) + 1);
    left--;
  }
  return out;
}

/**
 * One session's worth of positions.
 *
 * Allotment decides the mix, `priority` decides which inside each fault, and
 * anything the allotment could not fill — a fault with two positions and three
 * slots — falls through to whatever is most owed overall. The result is ordered
 * hardest-first within the session so the costly ones are met while you are
 * fresh.
 *
 * @param {object[]} deck      from `scenariosFrom`
 * @param {object} [o]
 * @param {object} [o.history] `{ [fen]: record }`, as `logs/play-history.json` keeps it
 * @param {number} [o.size]
 * @param {string} [o.kind]    spend the whole session on one fault
 */
export function pickSet(deck, { history = {}, size = 8, kind = null, now = Date.now() } = {}) {
  let pool = deck ?? [];
  if (kind) pool = pool.filter((s) => s.kind === kind);
  if (!pool.length) return [];

  const rank = (a, b) => priority(b, history[b.key], now) - priority(a, history[a.key], now);
  const byKind = new Map();
  for (const s of pool) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind).push(s);
  }
  for (const list of byKind.values()) list.sort(rank);

  const want = kind ? new Map([[kind, size]]) : allotment(pool, size);
  const chosen = [];
  const taken = new Set();
  for (const [k, n] of want) {
    for (const s of (byKind.get(k) ?? []).slice(0, n)) { chosen.push(s); taken.add(s.key); }
  }

  // Short of a full session, because a fault ran out of positions. Fill from
  // whatever is most owed, regardless of kind.
  if (chosen.length < size) {
    for (const s of [...pool].sort(rank)) {
      if (chosen.length >= size) break;
      if (!taken.has(s.key)) { chosen.push(s); taken.add(s.key); }
    }
  }

  return chosen.sort((a, b) => b.drop - a.drop);
}

/* -------------------------------------------------------------- judging ---- */

/**
 * The labels that let you move on.
 *
 * Straight off `classify`'s own bands, which is the point: `Good` is "a few
 * moves are playable here" in the coach's own words, and failing a player for
 * choosing one of them would be this file inventing chess opinions it has no
 * business having.
 */
export const PASS = ['Brilliant', 'Best', 'Excellent', 'Good'];

/** Did that move hold? Takes a grade from `gradeMove`. */
export function judge(grade) {
  const label = labelName(grade);
  return { pass: PASS.includes(label), label, drop: grade?.drop ?? 0 };
}

/**
 * The grade, said out loud.
 *
 * The same sentence the live coach's move log carries, in words rather than
 * columns, and built from the grade alone — no model and no second opinion. Each
 * label gets its own reading because they mean different things to a player:
 * `Good` is permission to move on, `Excellent` is "that was free", and `Best`
 * means there was nothing better on the board.
 */
export function verdictLine(grade) {
  const label = labelName(grade);
  const drop = grade?.drop ?? 0;
  const cost = `${drop.toFixed(drop < 10 ? 1 : 0)}%`;

  if (label === 'Brilliant') return 'Brilliant — you gave something up and you were right to';
  if (label === 'Best') return 'Best — there was nothing better on the board';
  if (label === 'Excellent') return 'Excellent — that costs you nothing';
  if (label === 'Good') return `Good — playable, and it gives up ${cost}`;
  return `${label} — that costs you ${cost} of your winning chances`;
}

/* -------------------------------------------------------------- prompts ---- */

/**
 * What the coach says, per fault, and what it refuses to say.
 *
 * Hand-written and fixed, for the reason `FAULTS` in `review.js` gives for the
 * same decision: a model asked to coach produces plausible text that varies per
 * run and is accountable to nobody, and this is the part you are meant to carry
 * into a real game. It has to read the same way twice.
 *
 *   ask    the question, on a first encounter — names the *class* of mistake,
 *          never the move. Naming the class is what makes the rep teachable;
 *          naming the move is what would delete the lesson.
 *   watch  the one thing to look at, used when the first attempt has failed
 *   miss   what you have just done again, said plainly
 *   hit    what finding it achieved — the pattern, not the position
 *
 * On a repeat encounter `ask` is withheld entirely: by the second time, "this
 * is a threat you ignored" is most of the answer.
 */
export const PROMPTS = {
  'missed-threat': {
    ask: 'something of yours is already attacked here — find it before you look at your own plan',
    watch: 'his last move changed what is attacked. Start there, not with your idea',
    miss: 'that looked away from it again — the threat was already on the board',
    hit: 'answered. That is the question to ask after every move he makes',
  },
  'missed-win': {
    ask: 'something of his is loose here, or there is a forcing line — look before you continue',
    watch: 'check every capture and every check you have, including the silly-looking ones',
    miss: 'passed it up again — it was there before you moved',
    hit: 'taken. Gifts appear right after his mistakes, which is when you are least looking',
  },
  fork: {
    ask: 'two of your pieces can be hit at once from somewhere here — find the square',
    watch: 'knight squares first, then your king and queen sharing a line or a knight-jump',
    miss: 'both pieces are still on the same two squares — he hits them together',
    hit: 'pattern broken. Two pieces safe on their own can be unsafe as a pair',
  },
  'allowed-mate': {
    ask: 'your king is in trouble here — count his checks before you do anything else',
    watch: 'list every check he has, then find where your king goes after each one',
    miss: 'the mate is still there — material stops counting once the king cannot be saved',
    hit: 'held. Checks near your king change a position faster than any material plan',
  },
  hung: {
    ask: 'one of your pieces has nothing defending it — name it before you move',
    watch: 'picture the board after your move, not as it is now. What stops being defended?',
    miss: 'still hanging — a piece is usually hung by the move that walks away from it',
    hit: 'kept. Saying your undefended pieces out loud is the cheapest habit there is',
  },
  'lost-material': {
    ask: 'there is an exchange here that does not come out the way it looks — count it',
    watch: 'count attackers and defenders cheapest first, and check each defender is really free',
    miss: 'the sequence still comes out against you — play it to the end, not to the first recapture',
    hit: 'counted. The usual culprit is a defender that was already busy',
  },
  'king-safety': {
    ask: 'your king is the problem in this position, not your pieces',
    watch: 'count his attackers near your king against your defenders — not his army against yours',
    miss: 'the king is still where it was, and that is what loses this',
    hit: 'dealt with. King safety costs nothing until it costs everything',
  },
};

/* ----------------------------------------------------------------- drill ---- */

/** Your moves after the critical one, and so the plies the engine answers. */
export const CONTINUE_MOVES = 3;

/**
 * Misses before the coach stops asking questions and starts answering them.
 *
 * Two misses is where the pointing runs out. "His last move changed what is
 * attacked" is a direction, and a third miss means the direction did not land —
 * at which point repeating it is just a tool being unhelpful in a sentence that
 * sounds helpful. So from here the coach volunteers what it actually knows.
 */
export const TIPS_AFTER = 3;

/**
 * The tips, in the order they are offered.
 *
 * These are the `t`/`w`/`c` topics, unchanged and in the order a coach would
 * reach for them: your own loose pieces first because the answer is most often
 * there and it costs no search, then his idea, then how much the choice matters.
 * Nothing new is written here — a volunteered tip is the same sentence the
 * button would have given you, which is the only way the coach can be said to
 * have one voice.
 */
export const TIP_ORDER = ['w', 't', 'c'];

/**
 * Misses before the move is given away.
 *
 * The README's rule — nothing names your move — is about live play, where a
 * named move is engine assistance and leaves the grader nothing to teach. In a
 * drill over a finished game the move is already on the review page, and a
 * position you cannot solve would otherwise be a dead end with no way out but
 * quitting. So it is revealed — but last, after every tip has been spent, and
 * never before you have moved.
 *
 * Only the rep ever gets here. The continuation has no stored best move and is
 * live play by any other name, so there the ladder ends at the last tip.
 */
export const REVEAL_AFTER = TIPS_AFTER + TIP_ORDER.length;

/**
 * One position, played.
 *
 * Holds the live board and the stage, and knows nothing about engines: the
 * server grades a move and hands the grade back in, which is what keeps every
 * transition here testable without Stockfish.
 *
 * Stages:
 *   solve     your move, on the scenario position. The rep.
 *   punished  you failed; his answer is on the board and you are about to retry
 *   continue  you found it (or were shown it) and are playing the position on
 *   done      finished, for the session to record
 *
 * ## Nodes
 *
 * Coaching escalates per *position you are asked to move at*, not per drill: a
 * rep you missed three times and a continuation ply you have taken back three
 * times are the same situation and get the same ladder. A node is identified by
 * how many plies have been played when you are on move, so walking back to one
 * finds the misses it already cost you still sitting there.
 */
export class Drill {
  /**
   * @param {object} scenario  from `scenariosFrom`
   * @param {object} [o]
   * @param {boolean} [o.first] is this the first time you have seen it? Decides
   *                            whether the fault class is named up front.
   */
  constructor(scenario, { first = true } = {}) {
    this.scenario = scenario;
    this.first = first;
    this.chess = new Chess(scenario.fen);
    this.you = scenario.color;
    this.stage = 'solve';
    this.attempts = [];          // every move you tried at the critical position
    this.revealed = false;
    this.asked = [];             // t/w/c you pressed, as the live coach records them
    this.played = [];            // the continuation, both sides, as { uci, san, by }
    this.left = CONTINUE_MOVES;  // your moves remaining in the continuation
    this.takebacks = 0;          // moves of yours you took off the board
    this.nodes = new Map();      // ply index -> { misses, told }, see the note above
  }

  get fen() { return this.chess.fen(); }
  get youToMove() { return this.chess.turn() === this.you; }
  get over() { return this.chess.isGameOver(); }
  get solved() { return this.attempts.some((a) => a.pass); }
  /**
   * Found with no wrong attempt, no hint and nothing taken back.
   *
   * A take-back counts for the same reason asking `w` does: it is help, it is
   * the kind you only want after the move is already on the board, and a
   * session that reported "found first time" for a position you unwound twice
   * would be a record of nothing.
   */
  get clean() {
    return this.solved && this.attempts.length === 1 && !this.asked.length && !this.takebacks;
  }

  /* ---- the node you are standing on ---- */

  #node(at = this.played.length) {
    if (!this.nodes.has(at)) this.nodes.set(at, { misses: 0, told: [] });
    return this.nodes.get(at);
  }

  /** How many times you have got this position wrong. */
  get misses() { return this.#node().misses; }
  /** Which topics the coach has already volunteered here. */
  get told() { return this.#node().told; }

  missed() { return ++this.#node().misses; }
  tell(key) { this.#node().told.push(key); return key; }

  /** Legal destinations from a square, for the page to dot. */
  legalFrom(square) {
    return this.chess.moves({ square, verbose: true }).map((m) => ({
      to: m.to, promotion: Boolean(m.promotion), san: m.san,
    }));
  }

  /**
   * Is this a legal move, and what is it called?
   *
   * Legality lives here rather than in the page because chess.js cannot go to
   * the browser — there is no build step in this project — and because one move
   * generator is the only way the board you see and the board being graded
   * cannot drift apart.
   */
  validate({ from, to, promotion }) {
    const m = this.chess.moves({ verbose: true }).find((x) => x.from === from && x.to === to
      && (!x.promotion || x.promotion === (promotion ?? 'q')));
    if (!m) return { ok: false, reason: 'not a legal move' };
    return { ok: true, uci: m.from + m.to + (m.promotion ?? ''), san: m.san, needsPromotion: Boolean(m.promotion) };
  }

  /**
   * Your move at the critical position, with the grade for it.
   *
   * Returns what the session should do next. A failed attempt does not advance
   * the board — the punishment is shown and then the position is reset, because
   * the rep is this position and playing on from a lost one trains nothing.
   */
  attempt(uci, grade) {
    const verdict = judge(grade);
    this.attempts.push({ uci, san: grade?.san ?? uci, ...verdict });

    if (verdict.pass) {
      this.chess.move(this.#move(uci));
      this.played.push({ uci, san: grade?.san ?? uci, by: 'you' });
      this.left--;
      this.stage = this.#exhausted() ? 'done' : 'continue';
      return { pass: true, stage: this.stage };
    }

    this.stage = 'punished';
    const misses = this.missed();
    return {
      pass: false,
      stage: this.stage,
      attempt: this.attempts.length,
      misses,
      // The refutation is the server's to supply from the grade; what this
      // decides is whether the next reset comes with the move attached.
      reveal: misses >= REVEAL_AFTER,
    };
  }

  /** Back to the position, for another go. */
  reset({ reveal = false } = {}) {
    this.chess = new Chess(this.scenario.fen);
    this.revealed = this.revealed || reveal;
    this.stage = 'solve';
    this.played = [];
    this.left = CONTINUE_MOVES;
    return this;
  }

  /** A move in the continuation — yours once solved, or his reply. */
  play(uci) {
    const m = this.#move(uci);
    if (!m) return { ok: false, reason: 'not a legal move' };
    const by = this.chess.turn() === this.you ? 'you' : 'opp';
    this.chess.move(m);
    this.played.push({ uci, san: m.san, by });
    if (by === 'you') this.left--;
    if (this.#exhausted()) this.stage = 'done';
    return { ok: true, san: m.san, by };
  }

  /**
   * Can that one come back?
   *
   * Everything after the rep move can. The rep move itself cannot: `played[0]`
   * is the move the whole position exists to make you find, and taking it off
   * would be un-solving the drill rather than retrying a continuation — the
   * stage for that is `punished`, and it has `reset`.
   */
  get canUndo() {
    return this.stage !== 'punished' && this.played.findLastIndex((p) => p.by === 'you') > 0;
  }

  /**
   * Your last move, and his answer to it, off the board.
   *
   * Unwound through chess.js's own `undo` rather than a stored FEN, so the
   * position you come back to is the position you left, castling rights, en
   * passant square, clocks and all — a FEN snapshot would be a second source of
   * truth for the board and is exactly the kind of thing that drifts.
   *
   * Counts as a miss at the node you return to, which is what makes the coach
   * escalate for someone unwinding the same ply over and over.
   */
  undo() {
    const i = this.played.findLastIndex((p) => p.by === 'you');
    if (i < 0) return { ok: false, reason: 'nothing to take back' };
    if (i === 0) return { ok: false, reason: 'that one is the position — find it again' };

    // Your move and anything he answered with — one `undo` each, newest first.
    const undone = this.played.splice(i);
    for (let n = 0; n < undone.length; n++) this.chess.undo();
    const [mine] = undone;

    this.left++;
    this.takebacks++;
    // A take-back can rescue a drill that just ran out of moves, so the stage is
    // recomputed rather than assumed: `done` is only done while it stays done.
    this.stage = this.#exhausted() ? 'done' : 'continue';
    this.missed();
    return { ok: true, san: mine.san, uci: mine.uci, stage: this.stage };
  }

  #move(uci) {
    return this.chess.moves({ verbose: true })
      .find((m) => m.from + m.to + (m.promotion ?? '') === uci) ?? null;
  }

  #exhausted() {
    return this.over || this.left <= 0;
  }

  /** What the drill is worth to the history file. */
  result() {
    return {
      key: this.scenario.key,
      kind: this.scenario.kind,
      pass: this.solved,
      clean: this.clean,
      attempts: this.attempts.length,
      asked: [...new Set(this.asked)],
      revealed: this.revealed,
      takebacks: this.takebacks,
      drop: this.scenario.drop,
    };
  }
}

/* ------------------------------------------------------------- history ---- */

/**
 * Fold one session's results into the record the next session reads.
 *
 * Pure, and it takes `now` — a history file is the one thing here that has to
 * be reproducible in a test, and `Date.now()` buried inside would make the
 * spacing untestable.
 */
export function record(history, results, now = new Date()) {
  const out = { ...(history ?? {}) };
  for (const r of results ?? []) {
    const was = out[r.key] ?? { seen: 0, passed: 0, failed: 0, clean: 0 };
    out[r.key] = {
      ...was,
      kind: r.kind,
      seen: was.seen + 1,
      passed: was.passed + (r.pass ? 1 : 0),
      failed: was.failed + (r.pass ? 0 : 1),
      clean: was.clean + (r.clean ? 1 : 0),
      lastSeen: now.toISOString(),
      // What the next session's `priority` reads. A position solved only after
      // being shown the move has not been solved for spacing purposes: it is
      // still owed, so it comes back at the top.
      lastResult: r.clean ? 'clean' : r.pass && !r.revealed ? 'pass' : 'fail',
    };
  }
  return out;
}

/**
 * The session, as a few lines of terminal.
 *
 * Same shape and same job as `summarise` in `review.js`: short enough to
 * survive being glanced at on the way out, and saying the one thing worth
 * knowing — whether the patterns are going in.
 */
export function summariseSession(results) {
  const out = [];
  if (!results?.length) return ['  nothing played'];

  const clean = results.filter((r) => r.clean).length;
  const passed = results.filter((r) => r.pass).length;
  out.push(`  ${results.length} positions, ${clean} found first time, ${passed} found in the end`);

  const byKind = new Map();
  for (const r of results) {
    const at = byKind.get(r.kind) ?? { kind: r.kind, n: 0, clean: 0 };
    at.n++;
    at.clean += r.clean ? 1 : 0;
    byKind.set(r.kind, at);
  }
  const worst = [...byKind.values()]
    .filter((k) => k.clean < k.n)
    .sort((a, b) => (a.clean / a.n) - (b.clean / b.n))[0];
  if (worst) {
    out.push(`  still costing you: ${worst.kind} — ${worst.clean} of ${worst.n} first time`);
  }
  return out;
}
