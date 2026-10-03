import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoachControl } from '../src/coach-control.js';

/*
 * A scratch directory throughout, never the real paths.
 *
 * All three files these tests write are ones a live coach reads: a stale pidfile
 * dropped under a running session, or a control file swept just as a hint was
 * asked for, would reach into a game someone is in the middle of. The whole
 * reason CoachControl takes its paths as options is so this suite can run while
 * the app is in use.
 */
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'coach-control-'));
  const control = new CoachControl({
    pidFile: path.join(dir, '.coach.pid'),
    controlFile: path.join(dir, '.hint-request'),
    stateFile: path.join(dir, '.overlay-state.json'),
  });
  return { dir, control, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A pid that is certainly gone: spawn something trivial and let it finish. */
function deadPid() {
  const done = spawnSync(process.execPath, ['-e', '']);
  assert.ok(done.pid, 'the probe process reported a pid');
  return done.pid;
}

test('no pidfile means no coach', (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  assert.deepEqual(control.status(), { coach: 'off', pid: null, since: null, log: false });
});

test('a live pid in the pidfile is an adopted coach, with no log to offer', (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  // This very process stands in for a coach: it is unquestionably alive.
  writeFileSync(control.pidFile, JSON.stringify({ pid: process.pid, started: 'then' }));

  const status = control.status();
  assert.equal(status.coach, 'adopted');
  assert.equal(status.pid, process.pid);
  assert.equal(status.since, 'then');
  // Nothing to stream: the pipes belonged to whoever spawned it.
  assert.equal(status.log, false);
});

test('a pidfile whose process is gone is swept, not reported', (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  writeFileSync(control.pidFile, JSON.stringify({ pid: deadPid(), started: 'then' }));

  assert.equal(control.status().coach, 'off');
  assert.equal(existsSync(control.pidFile), false, 'the stale file is removed on the way past');
});

test('a half-written pidfile is not a coach', (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  writeFileSync(control.pidFile, '{"pid": 2612');          // caught mid-write
  assert.equal(control.status().coach, 'off');
});

test('stopping nothing is not an error', async (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  assert.deepEqual(await control.stop(), { ok: true, was: 'off' });
});

/*
 * The cleanup asks rather than kills.
 *
 * ps/overlay.ps1 polls its state file and closes itself when it sees `quit`, so
 * a window that outlived its coach can be retired without guessing which
 * powershell.exe it was — which is how a cleanup button ends up closing
 * something someone is using.
 */
test('cleanup asks a leftover overlay to close and sweeps the stale files', (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  writeFileSync(control.stateFile, JSON.stringify({ label: 'Waiting for a move...' }));
  writeFileSync(control.pidFile, JSON.stringify({ pid: deadPid() }));
  writeFileSync(control.controlFile, 't');

  const out = control.cleanupLeftovers();
  assert.ok(out.ok);
  assert.equal(JSON.parse(readFileSync(control.stateFile, 'utf8')).quit, true);
  assert.equal(existsSync(control.pidFile), false);
  assert.equal(existsSync(control.controlFile), false);
  // It says in words what it refused to guess at.
  assert.match(out.warning, /capture\.ps1/);
  assert.match(out.warning, /stockfish/);
});

test('cleanup refuses while a coach is still running', (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  writeFileSync(control.pidFile, JSON.stringify({ pid: process.pid }));

  const out = control.cleanupLeftovers();
  assert.match(out.error, /stop it first/);
  assert.equal(existsSync(control.pidFile), true, 'and it swept nothing');
});

test('the stop request is one letter, written atomically', (t) => {
  const { control, clean } = scratch();
  t.after(clean);
  writeFileSync(control.pidFile, JSON.stringify({ pid: process.pid }));

  // `stop` on an adopted coach that never dies times out — the point here is
  // only that it asked, in the form takeKey() consumes, and left no .tmp behind.
  return control.stop({ timeoutMs: 600 }).then((out) => {
    assert.match(out.error, /did not stop/);
    assert.equal(readFileSync(control.controlFile, 'utf8'), 'q');
    assert.equal(existsSync(control.controlFile + '.tmp'), false);
  });
});
