/**
 * The play session: the coach, pointed at a position instead of a screen.
 *
 * `play.js` decides which positions and when you may move on, and knows nothing
 * about engines. This is the half that searches — and it is deliberately the
 * thin half, because every judgement it makes is delegated: `gradeMove` grades,
 * `judge` decides pass or fail, `faultOf` names what you did, `audit` names the
 * loose piece, `TOPICS` answers t/w/c. What is written here is the orchestration
 * and nothing else.
 *
 * ## Why all the chess stays on this side
 *
 * The page sends two square names. It does not know the rules, cannot tell a
 * legal move from an illegal one, and never sees a FEN it is expected to
 * reason about — there is no build step in this project, so chess.js cannot go
 * to the browser, and shipping a second move generator written in page script
 * would mean the board you are looking at and the board being graded could
 * disagree. One generator, one source of truth, and the page is a renderer.
 *
 * ## No event stream
 *
 * The dashboard needs one because something *else* changes its page: a game
 * being played in another terminal. Here the page is the only actor, so every
 * action is a request that returns the whole new state — including the
 * opponent's reply, so one round trip carries your move, the grade, the coaching
 * and his answer. Less machinery, and no way for the view to drift from the
 * session.
 */

import { createServer } from 'node:http';
import { gradeMove } from './grade.js';
import { faultOf, FAULTS } from './review.js';
import { TOPICS } from './hint.js';
import { findThreat } from './threat.js';
import { pvToSan } from './grade.js';
import { openBrowser } from './dashboard.js';
import {
  Drill, PROMPTS, judge, verdictLine, record, summariseSession,
  REVEAL_AFTER, TIPS_AFTER, TIP_ORDER,
} from './play.js';
import { playPage } from './play-page.js';

const HOST = '127.0.0.1';
export const DEFAULT_PORT = Number(process.env.COACH_PLAY_PORT ?? 7272);

/**
 * How hard the opponent plays.
 *
 * Lower than the grading depth on purpose. The reply only has to be the move a
 * decent opponent would find — when you have just blundered it *is* the
 * refutation, which is the whole point — and a full-depth search between every
 * move of a drill turns a session into waiting. Grading stays at `DEPTH`,
 * because that is the number your grades have always meant.
 */
export const OPP_DEPTH = Number(process.env.COACH_PLAY_OPP_DEPTH ?? 12);

/* ---------------------------------------------------------------- session --- */

export class PlaySession {
  /**
   * @param {object} o
   * @param {import('./engine.js').Engine} o.engine
   * @param {object[]} o.scenarios  from `pickSet`
   * @param {object} [o.history]    so a position seen before is not re-explained
   */
  /**
   * @param {object} o
   * @param {function} [o.onResult] called with every result as it is banked, so
   *                                progress is on disk before the session ends.
   *                                See the note on `next`.
   */
  constructor({
    engine, scenarios, history = {}, depth = 18, threatDepth = 12,
    oppDepth = OPP_DEPTH, onResult = null,
  }) {
    this.engine = engine;
    this.scenarios = scenarios;
    this.history = history;
    this.onResult = onResult;
    this.depth = depth;
    this.threatDepth = threatDepth;
    this.oppDepth = oppDepth;

    this.at = 0;
    this.drill = null;
    this.results = [];
    this.coach = [];          // the lines beside the board, newest last
    this.lastMove = null;     // {from,to} for the page to light
    this.animate = [];        // moves the page should play out before settling
    this.reveal = null;       // {san, uci} once the move has been given away
    this.busy = false;
    /*
     * One analysis of the position you are to move from, MultiPV 2, exactly as
     * the live coach does it (see `preAnalyse` in main.js). It is not extra
     * work: `gradeMove` needs a search of this position anyway, so running it
     * while you are thinking pays for the `c` topic and halves the wait for the
     * grade. `threat` is the one thing fetched lazily, because it is a second
     * search and only `t` needs it.
     */
    this.pre = { fen: null, analysis: null, threat: null, step: {} };
  }

  get done() { return this.at >= this.scenarios.length; }
  get scenario() { return this.scenarios[this.at] ?? null; }

  /** Open the first position. */
  async begin() {
    await this.#open();
    return this;
  }

  async #open() {
    const s = this.scenario;
    if (!s) return;
    const seen = this.history[s.key]?.seen > 0;
    this.drill = new Drill(s, { first: !seen });
    this.lastMove = null;
    this.animate = [];
    this.reveal = null;
    this.coach = [];

    /*
     * The class of mistake is named only the first time you meet a position. By
     * the second time, "something of yours is already attacked" is most of the
     * answer — so a repeat gets the position, the cost, and nothing else.
     */
    const p = PROMPTS[s.kind];
    this.#say('cost', `you lost ${s.drop.toFixed(0)}% of your winning chances here`);
    if (!seen && p) this.#say('ask', p.ask);
    else this.#say('ask', 'you have seen this one before — find it again');

    await this.#preAnalyse();
  }

  #say(tone, text) { if (text) this.coach.push({ tone, text }); }

  /** The search the `c` topic and the next grade both need. */
  async #preAnalyse() {
    const fen = this.drill.fen;
    /*
     * How deep you are into each topic survives a return to the same position.
     *
     * `retry` re-analyses the rep you have just missed, and a counter reset
     * there would make "pressing again goes a step deeper" false across exactly
     * the boundary where it matters: the coach's own tips would hand you the
     * first line of `w` on every miss, which is the position telling you the
     * same thing four times and calling it a ladder.
     */
    const step = this.pre.fen === fen ? this.pre.step : {};
    this.pre = { fen, analysis: null, threat: null, step };
    const analysis = await this.engine.analyse(fen, this.depth, { multipv: 2 });
    if (this.pre.fen === fen) this.pre.analysis = analysis;
  }

  /**
   * Where a piece may go, for the page to dot.
   *
   * Answered from the same move generator that will judge the move, which is the
   * reason the page asks instead of working it out: a dot the server would then
   * refuse, or a legal move with no dot on it, is the board and the session
   * disagreeing about the rules.
   *
   * Refuses while the board is not yours to touch, so a piece cannot be picked
   * up during his reply or while a failed attempt is still on screen.
   */
  legal(square) {
    if (!this.drill || !square) return { moves: [] };
    if (!this.drill.youToMove || this.drill.stage === 'punished') return { moves: [] };
    const piece = this.drill.chess.get(square);
    if (!piece || piece.color !== this.drill.you) return { moves: [] };
    return { moves: this.drill.legalFrom(square) };
  }

  /* ------------------------------------------------------------- your move -- */

  /**
   * A move from the page.
   *
   * Validated, graded, judged and answered in one call. The three stages a drill
   * can be in want different things from it, which is why the branch is here
   * rather than in `Drill`: only this side can search.
   */
  async move({ from, to, promotion }) {
    if (this.done || !this.drill) return { error: 'the session is over' };
    if (this.drill.stage === 'punished') return { error: 'play it again from the position' };
    if (!this.drill.youToMove) return { error: 'not your turn' };

    const legal = this.drill.validate({ from, to, promotion });
    if (!legal.ok) return { error: legal.reason };

    const fenBefore = this.drill.fen;
    const grade = await gradeMove(this.engine, fenBefore, legal.uci, this.depth, {
      pre: this.pre.fen === fenBefore ? { fen: fenBefore, analysis: this.pre.analysis } : null,
    });

    this.coach = [];
    this.animate = [];
    return this.drill.stage === 'solve'
      ? this.#critical(grade, legal)
      : this.#continuing(grade, legal);
  }

  /** The rep itself: the move you got wrong last time. */
  async #critical(grade, legal) {
    const out = this.drill.attempt(legal.uci, grade);
    const p = PROMPTS[this.drill.scenario.kind] ?? {};
    this.lastMove = { from: legal.from ?? legal.uci.slice(0, 2), to: legal.uci.slice(2, 4) };

    if (out.pass) {
      this.#say('hit', verdictLine(grade));
      this.#say('why', p.hit);
      await this.#answer();
      return this.state;
    }

    /*
     * Failed. The punishment goes on the board rather than into a sentence,
     * because "Qxe8 takes it" is a line you would have to play out in your head
     * against the position you are looking at — the same argument the review
     * page's replay is built on. Then the position resets and you go again.
     */
    this.#say('miss', verdictLine(grade));
    this.#say('why', p.miss);

    // Not the "— Nf6 instead" tail: naming your move is the ladder's to give.
    const fault = faultOf(grade, { nameBest: false });
    if (fault?.text) this.#say('fault', fault.text);

    // His answer, as moves the page can play out from the position.
    this.animate = [
      { uci: legal.uci, san: grade.san, by: 'you' },
      ...(grade.refutation ?? []).slice(0, 1).map((uci) => ({
        uci, san: pvToSan(grade.fenAfter, [uci], 1), by: 'opp',
      })),
    ];

    await this.#escalate({ canReveal: true });
    if (!out.reveal) this.#say('again', 'again, from the same position');
    return this.state;
  }

  /**
   * What a miss earns, by how many of them there have been.
   *
   * One ladder, used by the rep and by a continuation take-back alike, because
   * they are the same situation: a position you are being asked to move at and
   * keep getting wrong. It climbs — point, then name the loose piece, then give
   * real tips, then, on the rep only, the move itself.
   *
   * The reason it climbs rather than repeating: "his last move changed what is
   * attacked" is a direction, and a third miss is evidence the direction did not
   * land. Saying it again at that point is a tool being unhelpful in a sentence
   * that sounds helpful.
   */
  async #escalate({ canReveal = false } = {}) {
    const d = this.drill;
    const misses = d.misses;

    if (canReveal && misses >= REVEAL_AFTER) {
      this.reveal = { san: d.scenario.bestSan, uci: d.scenario.best };
      this.#say('reveal', `it was ${this.reveal.san} — play it, then we carry on`);
      return;
    }

    if (misses >= TIPS_AFTER) { await this.#tip(); return; }

    this.#say('watch', PROMPTS[d.scenario.kind]?.watch);
    // Twice wrong and the pointing has not worked, so the loose piece is named
    // outright. Taken through the `w` topic rather than from `audit` directly,
    // so this spends the topic's first line: otherwise the first real tip, one
    // miss later, would be this sentence again.
    if (misses >= 2) {
      const weak = await this.#coach('w');
      if (weak?.text) this.#say('weak', weak.text);
    }
  }

  /**
   * One real answer, volunteered.
   *
   * Drawn from the same `TOPICS` the `t`/`w`/`c` buttons use and said in their
   * words, so the coach has one voice whether you asked or not — and recorded in
   * `asked`, because help is help however it arrived. Topics are spent in
   * `TIP_ORDER` and a topic with nothing left to say is skipped rather than
   * repeated, so the ladder always moves.
   */
  async #tip() {
    for (const key of TIP_ORDER) {
      if (this.drill.told.includes(key)) continue;
      const out = await this.#coach(key);
      if (out?.stale) return false;
      this.drill.tell(key);
      if (!out) continue;
      this.drill.asked.push(key);
      this.#say('hint', out.text);
      return true;
    }
    this.#say('note', 'that is everything I have that is not the move itself');
    return false;
  }

  /** A move in the continuation, after you found it. */
  async #continuing(grade, legal) {
    this.drill.play(legal.uci);
    this.lastMove = { from: legal.uci.slice(0, 2), to: legal.uci.slice(2, 4) };
    this.#say(judge(grade).pass ? 'hit' : 'miss', verdictLine(grade));

    // Every move is commented, which is what makes this a session and not a
    // quiz — and a mistake made *after* the rep is named the same way.
    if (!judge(grade).pass) {
      // Not the "— Nf6 instead" tail: naming your move is the ladder's to give.
      const fault = faultOf(grade, { nameBest: false });
      if (fault?.text) this.#say('fault', fault.text);
      // Said here rather than left to the button, because this is the moment it
      // is wanted and the moment it is least obvious it exists.
      this.#say('back', 'take it back and find a better one');
    }

    if (this.drill.stage !== 'done') await this.#answer();
    return this.state;
  }

  /** His reply, and the pre-analysis for your next one. */
  async #answer() {
    if (this.drill.stage === 'done' || this.drill.over) return void this.#finish();

    const { bestmove } = await this.engine.analyse(this.drill.fen, this.oppDepth);
    if (!bestmove) return void this.#finish();

    const played = this.drill.play(bestmove);
    if (played.ok) {
      this.animate = [...this.animate, { uci: bestmove, san: played.san, by: 'opp' }];
      this.#say('opp', `he plays ${played.san}`);
    }

    if (this.drill.stage === 'done' || this.drill.over) return void this.#finish();
    await this.#preAnalyse();
  }

  #finish() {
    if (this.drill.stage !== 'done') this.drill.stage = 'done';
    this.#say('end', this.drill.clean
      ? 'found first time — that is the one that sticks'
      : this.drill.solved ? 'found it' : 'not this time');
  }

  /* ----------------------------------------------------------------- asking -- */

  /**
   * t / w / c, exactly as the live coach answers them.
   *
   * Pressing again goes a step deeper, and runs out rather than repeating — and
   * the fact that you asked is recorded, so the session's "found first time"
   * count stays honest. Same contract as the terminal: nothing here names your
   * move.
   */
  async hint(key) {
    const topic = TOPICS[key];
    if (!topic) return { error: 'no such topic' };
    if (!this.drill || this.drill.stage === 'punished') return { error: 'play the position first' };
    if (!this.drill.youToMove) return { error: 'not your turn' };
    if (!this.pre.analysis) return { error: 'still thinking — try again in a moment' };

    const out = await this.#coach(key);
    if (out?.stale) return this.state;
    if (!out) {
      this.#say('note', `that is all on ${topic.label} — it will not name your move`);
      return this.state;
    }
    this.drill.asked.push(key);
    this.#say('hint', out.text);
    return this.state;
  }

  /**
   * The next thing a topic has to say, or null once it has run out.
   *
   * Pulled out of `hint` so the coach can volunteer a tip through exactly the
   * same path a pressed button takes — the guards differ (a tip is given while a
   * failed attempt is still on screen) but not a word of what is said.
   */
  async #coach(key) {
    const topic = TOPICS[key];
    if (!topic || !this.pre.analysis) return null;

    if (topic.needsThreat && !this.pre.threat) {
      const fen = this.pre.fen;
      const found = await findThreat(this.engine, fen, this.pre.analysis, this.drill.you, this.threatDepth);
      if (this.pre.fen !== fen) return { stale: true };
      this.pre.threat = found;
    }

    const steps = topic.steps({
      fen: this.pre.fen, chess: this.drill.chess, lines: this.pre.analysis.lines,
      color: this.drill.you, threat: this.pre.threat,
    }) ?? [];

    const n = this.pre.step[key] ?? 0;
    if (n >= steps.length) return null;
    this.pre.step[key] = n + 1;
    return { text: steps[n] };
  }

  /* ------------------------------------------------------------ navigation -- */

  /** Back to the position after a failure. */
  async retry() {
    if (!this.drill || this.drill.stage !== 'punished') return { error: 'nothing to retry' };
    this.drill.reset({ reveal: Boolean(this.reveal) });
    this.coach = [];
    this.animate = [];
    this.lastMove = null;
    const p = PROMPTS[this.drill.scenario.kind] ?? {};
    this.#say('ask', this.reveal ? `play ${this.reveal.san}` : p.watch);
    await this.#preAnalyse();
    return this.state;
  }

  /**
   * Your last move off the board, so you can try a different one.
   *
   * The rep has `retry`, which is the same idea for the one move the drill is
   * about. This is for everything after it: a continuation played into a lost
   * position teaches nothing, and the two moves left in it teach less — the
   * line was the point, and a line you cannot correct is just a line you watch
   * happen.
   *
   * Pre-analysed before the coach speaks, because a tip at this node needs the
   * search of this node and nothing else.
   */
  async back() {
    if (!this.drill) return { error: 'nothing to take back' };
    const out = this.drill.undo();
    if (!out.ok) return { error: out.reason };

    this.coach = [];
    this.animate = [];
    const prev = this.drill.played.at(-1);
    this.lastMove = prev ? { from: prev.uci.slice(0, 2), to: prev.uci.slice(2, 4) } : null;
    this.#say('back', `${out.san} is off the board, and his answer with it`);

    await this.#preAnalyse();
    await this.#escalate();
    this.#say('again', 'find a different one');
    return this.state;
  }

  /** Give up on this one and move on, recording it as unsolved. */
  async skip() {
    if (!this.drill) return { error: 'nothing to skip' };
    this.drill.stage = 'done';
    return this.next();
  }

  /**
   * Next position, banking the one just played.
   *
   * Banked here rather than only at exit, because the ways a session actually
   * ends are not all signals: you close the tab, the terminal goes away, the
   * process is killed. Measured while building this — `kill -INT` on Windows did
   * not reach Node's handler at all, and a finished position was lost with it.
   * Spacing that silently forgets what you did is worse than no spacing, so the
   * record is written as it is earned and the exit handler is left to do nothing
   * but print.
   *
   * A failed write is never allowed to interrupt a session: the history is a
   * convenience, and the game in front of you is not.
   */
  async next() {
    if (!this.drill) return { error: 'nothing to advance' };
    this.results.push(this.drill.result());
    try { this.onResult?.(this.results); } catch { /* disk, or a path that is gone */ }
    this.at++;
    if (this.done) {
      this.coach = [];
      for (const line of summariseSession(this.results)) this.#say('summary', line.trim());
      return this.state;
    }
    await this.#open();
    return this.state;
  }

  /* ------------------------------------------------------------------ view -- */

  /** Everything the page draws, in one object. */
  get state() {
    if (this.done) {
      return {
        stage: 'session-done',
        session: { at: this.scenarios.length, total: this.scenarios.length },
        coach: this.coach,
        summary: summariseSession(this.results),
        results: this.results,
      };
    }

    const d = this.drill;
    const s = d.scenario;
    const fault = FAULTS[s.kind];
    return {
      stage: d.stage,
      session: { at: this.at + 1, total: this.scenarios.length },
      scenario: {
        kind: s.kind,
        title: fault?.title ?? s.kind,
        drop: s.drop,
        when: s.when,
        phase: s.phase,
        first: d.first,
      },
      board: {
        fen: d.fen,
        // Flipped means black at the bottom, which is what you were looking at.
        flipped: d.you === 'b',
        youToMove: d.youToMove,
        you: d.you,
        check: d.chess.isCheck(),
        over: d.over,
        lastMove: this.lastMove,
      },
      coach: this.coach,
      animate: this.animate,
      reveal: this.reveal,
      can: {
        move: d.youToMove && d.stage !== 'punished',
        hint: d.youToMove && d.stage !== 'punished' ? Object.keys(TOPICS) : [],
        retry: d.stage === 'punished',
        back: d.canUndo,
        next: d.stage === 'done',
        skip: d.stage !== 'done',
      },
      attempts: d.attempts.length,
      misses: d.misses,
      takebacks: d.takebacks,
      revealAfter: REVEAL_AFTER,
      tipsAfter: TIPS_AFTER,
    };
  }

  /** The session folded into the record the next one reads. */
  historyAfter(now = new Date()) {
    return record(this.history, this.results, now);
  }
}

/* ----------------------------------------------------------------- server --- */

export class PlayServer {
  constructor({ session, port = DEFAULT_PORT, open = true } = {}) {
    this.session = session;
    this.port = port;
    this.wantOpen = open;
    this.server = null;
    this.url = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      // Unlike the dashboard, a port we cannot have is fatal: the dashboard is a
      // convenience beside a game that is happening anyway, and this *is* the game.
      this.server.on('error', reject);
      this.server.listen(this.port, HOST, () => {
        this.port = this.server.address()?.port ?? this.port;
        this.url = `http://${HOST}:${this.port}/`;
        if (this.wantOpen) openBrowser(this.url);
        resolve(this.url);
      });
    });
  }

  /**
   * Answer one request.
   *
   * `mounted` overrides the dispatch path for a server that owns more than this
   * session: `src/hub.js` serves the page at `/play` but leaves `/api/*` at the
   * root, because the three fetches in `src/play-page.js` are root-relative and
   * a `<base href>` does not rewrite those — moving the API would mean editing
   * the client, which is the one thing a shared origin should not cost.
   *
   * Only the dispatch key is overridden. `url` stays the real request, because
   * the `legal` branch below reads `url.searchParams`.
   */
  async handle(req, res, mounted = null) {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const path = mounted ?? url.pathname;

    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(playPage());
    }

    if (!path.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return void res.end('not found');
    }

    const action = path.slice(5);

    /*
     * Reads do not take the lock.
     *
     * `state` and `legal` only look at the position, and both are wanted exactly
     * when a search might be running: picking a piece up while the engine is
     * still answering the last move must not be refused, or the board feels
     * stuck. Neither awaits anything, so there is no window for the session to
     * change underneath them.
     */
    if (action === 'state') return void json(res, 200, this.session.state);
    if (action === 'legal') {
      return void json(res, 200, this.session.legal(url.searchParams.get('square')));
    }

    /*
     * Everything else is one at a time. The engine serialises its own queue, but
     * two moves arriving together would interleave the *session's* state — a
     * double click grading one move onto the board the other left behind.
     */
    if (this.session.busy) return void json(res, 409, { error: 'still thinking' });
    this.session.busy = true;
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      json(res, 200, await this.#act(action, body));
    } catch (e) {
      json(res, 500, { error: e.message });
    } finally {
      this.session.busy = false;
    }
  }

  async #act(action, body) {
    const s = this.session;
    switch (action) {
      case 'move':   return withState(s, await s.move(body));
      case 'hint':   return withState(s, await s.hint(body.topic));
      case 'retry':  return withState(s, await s.retry());
      case 'back':   return withState(s, await s.back());
      case 'skip':   return withState(s, await s.skip());
      case 'next':   return withState(s, await s.next());
      default:       return { error: `unknown action ${action}` };
    }
  }

  stop() {
    this.server?.close();
    this.server = null;
  }
}

/**
 * An error is an answer, not a replacement for the state.
 *
 * A rejected move ("not a legal move") must still leave the page with a board to
 * draw, or a mis-click would blank the session.
 */
const withState = (session, out) => (out?.error ? { ...session.state, error: out.error } : out);

export function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** A small JSON body, with a cap: this listens on loopback but still parses input. */
export function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad JSON')); }
    });
    req.on('error', reject);
  });
}
