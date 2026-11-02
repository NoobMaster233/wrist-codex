import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RecordingSessions } from '../bridge/recording-session.mjs';

const target = { threadId: 'thread-a', cwd: '/project', projectName: 'project', threadTitle: 'dialog' };
const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'band-recording-'));
  const root = join(dir, 'audio'); await mkdir(root);
  const settings = { root, stateFile: join(dir, 'private/session.json'), validateTarget: async () => target,
    settleMs: 20, windowMs: 3000, transcribe: async () => ({ text: '识别文字', sha256: sha('fresh'), durationMs: 6000 }), ...options };
  const sessions = new RecordingSessions(settings); await sessions.init();
  t.after(async () => { sessions.close(); await sessions.writes; await rm(dir, { recursive: true, force: true }); });
  return { sessions, settings, root };
}
async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('recording state transition timed out');
}
test('only new audio in an explicit window becomes a draft for its captured target', async t => {
  let calls = 0;
  const f = await fixture(t, { transcribe: async () => { calls++; return { text: '识别文字', sha256: sha('fresh') }; } });
  await writeFile(join(f.root, 'old.ogg'), 'old');
  const armed = await f.sessions.handle({ method: 'recording.arm', params: target });
  await writeFile(join(f.root, 'duplicate.ogg'), 'old');
  await f.sessions.scan(); assert.equal(calls, 0);
  assert.deepEqual(f.sessions.snapshot('thread-b'), { phase: 'idle' });
  await assert.rejects(f.sessions.arm({ ...target, threadId: 'thread-b' }), /已有录音/);
  await writeFile(join(f.root, 'new.ogg'), 'fresh');
  await until(() => f.sessions.state.phase === 'ready');
  assert.equal(calls, 1); assert.equal(f.sessions.snapshot(target.threadId).text, '识别文字');
  await assert.rejects(f.sessions.handle({ method: 'recording.ack', params: { threadId: 'thread-b', sessionId: armed.sessionId } }));
  await f.sessions.handle({ method: 'recording.ack', params: { threadId: target.threadId, sessionId: armed.sessionId } });
  assert.equal(f.sessions.state.phase, 'delivered'); assert.equal(f.sessions.snapshot(target.threadId).text, undefined);
});
test('cancellation aborts in-flight recognition and ignores a late result', async t => {
  let finish, signal;
  const f = await fixture(t, { transcribe: (file, opts) => { signal = opts.signal; return new Promise(r => { finish = r; }); } });
  const armed = await f.sessions.arm(target); await writeFile(join(f.root, 'new.ogg'), 'fresh');
  await until(() => !!finish);
  await f.sessions.handle({ method: 'recording.cancel', params: { threadId: target.threadId, sessionId: armed.sessionId } });
  assert.equal(signal.aborted, true);
  finish({ text: 'late', sha256: sha('fresh') }); await new Promise(r => setTimeout(r, 10));
  assert.equal(f.sessions.state.phase, 'cancelled'); assert.equal(f.sessions.state.text, undefined);
});
test('armed windows recover new audio after restart, while ready text remains durable', async t => {
  const f = await fixture(t); await f.sessions.arm(target); f.sessions.close();
  await writeFile(join(f.root, 'new.ogg'), 'fresh');
  const resumed = new RecordingSessions(f.settings); t.after(() => resumed.close()); await resumed.init();
  await until(() => resumed.state.phase === 'ready'); await resumed.writes; resumed.close();
  const final = new RecordingSessions(f.settings); t.after(() => final.close()); await final.init();
  assert.equal(final.snapshot(target.threadId).text, '识别文字');
});
test('expired windows stop receiving files and never invoke recognition', async t => {
  let calls = 0;
  const f = await fixture(t, { windowMs: 30, transcribe: async () => { calls++; } }); await f.sessions.arm(target);
  await until(() => f.sessions.state.phase === 'expired');
  await writeFile(join(f.root, 'late.ogg'), 'fresh'); await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 0);
});
