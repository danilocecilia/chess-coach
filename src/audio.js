/**
 * Voice coaching — natural speech via Microsoft Edge TTS.
 *
 * Speaks hints, verdicts and explanations out loud while you play, using the
 * same neural voices as Edge's "Read Aloud" feature. Free, no API key, no
 * native binary — just a WebSocket to Microsoft's public TTS endpoint.
 *
 * Audio never blocks the game. Generation and playback run in the background,
 * failures are swallowed (the verdict is already on screen), and a blunder
 * interrupts whatever the coach was mid-sentence on.
 *
 *   COACH_AUDIO=0                     disable voice entirely
 *   COACH_VOICE=en-US-AvaNeural       pick a voice (any Edge neural voice)
 *   COACH_VOICE=pt-BR-FranciscaNeural Portuguese
 *   COACH_RATE=+15%                   speaking rate
 *
 * Requires `node-edge-tts` (`npm install node-edge-tts`). Without it, voice
 * coaching is silently disabled and everything else works as before.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const DEFAULT_VOICE = 'en-US-AvaNeural';
const DEFAULT_RATE  = '+10%';

/**
 * Blunder interrupts everything; a hint waits its turn. Equal priority also
 * interrupts, because the newer sentence is the one that matters — a second
 * press of `t` has moved on to the next step of the same topic.
 */
const PRIORITY = { low: 0, hint: 1, verdict: 2, blunder: 3 };

/**
 * MP3 is the default output and the one `node-edge-tts` actually supports.
 * Played back by ps/play.ps1 via WPF MediaPlayer (PresentationCore), which is
 * present on every Windows 10/11 install and plays MP3 natively.
 */
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

export class Audio {
  /**
   * @param {object} [opts]
   * @param {string} [opts.voice]    Edge neural voice name
   * @param {string} [opts.rate]     speaking rate, e.g. '+15%' or '-10%'
   * @param {boolean} [opts.enabled] false to disable entirely
   */
  constructor({ voice, rate, enabled = true } = {}) {
    this.voice   = voice ?? process.env.COACH_VOICE ?? DEFAULT_VOICE;
    this.rate    = rate  ?? process.env.COACH_RATE  ?? DEFAULT_RATE;
    this.enabled = enabled && process.env.COACH_AUDIO !== '0';
    this.muted   = false;

    /** The process playing audio right now, if any. */
    this._playing = null;
    /** Monotonic counter to discard stale generations. */
    this._seq = 0;
    /** Lazily loaded; `null` means unavailable (package not installed). */
    this._TTS = undefined;

    this._dir = path.join(ROOT, '.audio');
    this._playScript = path.join(ROOT, 'ps', 'play.ps1');

    if (this.enabled) {
      // Clean up anything a previous crash left behind.
      try { rmSync(this._dir, { recursive: true, force: true }); } catch { /* ignore */ }
      mkdirSync(this._dir, { recursive: true });
    }
  }

  /**
   * Speak a sentence. Returns immediately — generation and playback happen
   * in the background, and a failure is logged but never thrown.
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {'low'|'hint'|'verdict'|'blunder'} [opts.priority='hint']
   */
  speak(text, { priority = 'hint' } = {}) {
    if (!this.enabled || this.muted || !text) return;
    const p = PRIORITY[priority] ?? PRIORITY.hint;

    // Higher-or-equal priority interrupts what is playing.
    if (this._playing) {
      if (p >= this._playing.priority) this._kill();
      else return;                     // lower priority — drop it
    }

    const seq = ++this._seq;
    this._generate(text, seq, p)
      .catch((e) => {
        if (e.name !== 'AbortError') console.error('[audio]', e.message);
      });
  }

  // ----------------------------------------------------------------- private

  /**
   * Load `node-edge-tts` on first use. Returns the class, or null if the
   * package is not installed — which disables voice for the rest of the
   * session without breaking anything.
   */
  async _loadTTS() {
    if (this._TTS !== undefined) return this._TTS;
    try {
      const mod = await import('node-edge-tts');
      this._TTS = mod.EdgeTTS;
    } catch {
      this._TTS = null;
      this.enabled = false;
      console.log('[audio] voice coaching needs node-edge-tts — run:  npm install node-edge-tts');
    }
    return this._TTS;
  }

  async _generate(text, seq, priority) {
    const TTS = await this._loadTTS();
    if (!TTS) return;

    const file = path.join(this._dir, `say-${seq}.mp3`);
    const tts = new TTS({
      voice: this.voice,
      rate: this.rate,
      outputFormat: OUTPUT_FORMAT,
    });
    await tts.ttsPromise(text, file);

    // A newer speak() may have landed while we were generating.
    if (seq !== this._seq || this.muted) {
      try { rmSync(file, { force: true }); } catch { /* ignore */ }
      return;
    }

    this._play(file, priority);
  }

  _play(file, priority) {
    const proc = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this._playScript,
      '-AudioPath', file,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    proc.stderr?.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error('[audio]', s);
    });

    this._playing = { proc, priority, file };

    proc.on('exit', () => {
      if (this._playing?.proc === proc) this._playing = null;
      try { rmSync(file, { force: true }); } catch { /* ignore */ }
    });
  }

  _kill() {
    if (!this._playing) return;
    const { proc, file } = this._playing;
    this._playing = null;
    try { proc.kill(); } catch { /* ignore */ }
    // Give the process a moment to release the file handle before deleting.
    setTimeout(() => {
      try { rmSync(file, { force: true }); } catch { /* ignore */ }
    }, 200);
  }

  // ----------------------------------------------------------------- public

  /** Toggle mute on/off. Returns the new mute state. */
  toggleMute() {
    this.muted = !this.muted;
    if (this.muted) this._kill();
    return this.muted;
  }

  /** Tear down on exit. */
  stop() {
    this._kill();
    this._seq = Infinity;              // reject anything still generating
    // Best-effort cleanup of the temp directory.
    try {
      for (const f of readdirSync(this._dir)) {
        rmSync(path.join(this._dir, f), { force: true });
      }
    } catch { /* ignore */ }
  }
}
