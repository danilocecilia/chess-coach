/**
 * Drives ps/overlay.ps1 by writing a small JSON state file.
 * Writes are atomic (temp file + rename) so the overlay can never read a
 * half-written state.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { formatScore, LABELS } from './verdict.js';

/**
 * The overlay's own colours, which do not turn with the report's theme.
 *
 * This panel floats over the chess site, not over the report, so it is always
 * dark whatever the page behind it is set to. They live here rather than in
 * `overlay.ps1` because the script used to re-type the hint teal as
 * `FromArgb(27, 172, 166)` — the Brilliant colour, in decimal, a third copy of
 * a value `verdict.js` already owns. Now the script is told.
 *
 * `report.js` reads these for its token block so the design system's
 * `--overlay-*` set and the real window cannot drift apart.
 */
export const OVERLAY_INK = {
  bg: '#262421',
  verdict: '#ffffff',
  eval: '#a8a6a3',
  why: '#c3c2c0',
  hint: LABELS.BRILLIANT.color,
  onGrade: '#1c1a18',
};

export class Overlay {
  constructor({ x = 40, y = 40 } = {}) {
    this.stateFile = path.join(ROOT, '.overlay-state.json');
    this.tmpFile = this.stateFile + '.tmp';
    /*
     * The same file trick in reverse, so a hint can be asked for from the
     * overlay as well as from the terminal.
     *
     * The overlay is TopMost and shown with ShowDialog, which activates it, so
     * it takes the keyboard when it appears — type `h` at that moment and the
     * terminal never sees it. Handing focus back would mean SetWindowPos
     * through P/Invoke, and runtime-compiled native interop is the one thing
     * this project is built around not needing (see README, "Why Node and not
     * Python"). Reading the key wherever focus happens to be is cheaper and has
     * no native surface at all.
     */
    this.hintFile = path.join(ROOT, '.hint-request');
    this.proc = null;
    // The window has two independent writers now — verdicts and hints — so the
    // state is retained and patched rather than replaced, or each would blank
    // whatever the other had just put on screen.
    this.state = {};
    Object.assign(this, { x, y });
  }

  start() {
    this.#write({
      label: 'Waiting for a move...', why: '', eval: '', hint: '',
      // Sent once, before the window exists, so the first paint is already in
      // the right colours rather than flashing the script's defaults.
      ink: OVERLAY_INK,
    });
    try { rmSync(this.hintFile, { force: true }); } catch { /* nothing stale, fine */ }
    const script = path.join(ROOT, 'ps', 'overlay.ps1');
    this.proc = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-StateFile', this.stateFile, '-HintFile', this.hintFile,
      '-X', String(this.x), '-Y', String(this.y),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error('[overlay]', s);
    });
    return this;
  }

  #write(patch) {
    Object.assign(this.state, patch);
    writeFileSync(this.tmpFile, JSON.stringify(this.state));
    renameSync(this.tmpFile, this.stateFile);   // atomic on NTFS
  }

  /** Show a graded move. `why` may arrive later via {@link addExplanation}. */
  show(grade, why = '') {
    this.#write({
      san: grade.san,
      label: grade.label.name,
      glyph: grade.label.glyph,
      color: grade.label.color,
      // Kept short on purpose: this line is right-aligned in a 160px column
      // beside the grade name, and the older "(-21.3% win)" phrasing wrapped
      // and clipped there. The percentage is a win-probability drop everywhere
      // in this product, so the word was never carrying much.
      eval: `${formatScore(grade.scoreBefore)} → ${formatScore(grade.scoreAfter)}`
          + ` · -${grade.drop.toFixed(1)}%`,
      why,
      hint: '',                    // the hint belonged to the move just played
    });
    this.last = grade;
  }

  /**
   * Fill in the coach sentence once it arrives, without re-rendering the rest.
   *
   * `forGrade` is what keeps a slow explanation from landing on the wrong move:
   * the coach call takes ~1.5s, and if a newer move has been shown meanwhile the
   * sentence would otherwise be attached to it and read as an assessment of a
   * move nobody made.
   *
   * It patches `why` alone rather than re-rendering through show(), which would
   * also clear the hint slot — and by the time a sentence arrives it may well be
   * your turn again and the hint a fresh one you just asked for.
   */
  addExplanation(why, forGrade = null) {
    if (!this.last || (forGrade && this.last !== forGrade)) return;
    this.#write({ why });
  }

  /** A rung of the suggestion ladder. Lives alongside the verdict, not over it. */
  hint(text) {
    this.#write({ hint: text });
  }

  /**
   * Which coaching key was pressed on the overlay window since last asked, if
   * any. Consumed on read, so a press counts once. Polled from the watch loop,
   * which already runs at 150ms — fast enough for a keypress, and it needs no
   * watcher, no extra process and no native interop.
   */
  takeKey() {
    try {
      if (!existsSync(this.hintFile)) return null;
      const key = readFileSync(this.hintFile, 'utf8').trim().toLowerCase()[0] ?? null;
      rmSync(this.hintFile, { force: true });
      return key;
    } catch {
      return null;              // racing the writer; the next press will land
    }
  }

  status(text) {
    this.#write({ label: text, why: '', eval: '', hint: '' });
  }

  quit() {
    try { this.#write({ quit: true }); } catch { /* going away anyway */ }
    setTimeout(() => {
      this.proc?.kill();
      try { rmSync(this.stateFile, { force: true }); } catch { /* ignore */ }
      try { rmSync(this.hintFile, { force: true }); } catch { /* ignore */ }
    }, 250);
  }
}
