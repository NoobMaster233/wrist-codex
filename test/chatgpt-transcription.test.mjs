import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transcribeChatGPTAudio, TRANSCRIPTION_ENDPOINT } from '../bridge/chatgpt-transcription.mjs';

async function credentials(t) {
  const dir = await mkdtemp(join(tmpdir(), 'band-asr-auth-test-'));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-token-only', account_id: 'fixture-account-only' } }));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const audio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfixture-audio')]);
test('completed audio uses a fixed destination, prevents redirects and keeps credentials out of multipart audio', async t => {
  const authDir = await credentials(t); let calls = 0;
  const result = await transcribeChatGPTAudio(audio, { authDir, fetchImpl: async (url, request) => {
    calls++; assert.equal(url, TRANSCRIPTION_ENDPOINT); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture-token-only');
    assert.deepEqual([...request.body.keys()].sort(), ['file', 'language']);
    assert.equal(request.body.get('file').name, 'recording.wav');
    assert.deepEqual(Buffer.from(await request.body.get('file').arrayBuffer()), audio);
    return new Response(JSON.stringify({ text: '  测试文字  ' }), { status: 200 });
  } });
  assert.equal(result.text, '测试文字'); assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('fixture-token-only'), false);
});
test('authentication failure preserves a safe error, ignores sensitive bodies and does not retry', async t => {
  const authDir = await credentials(t); let calls = 0;
  await assert.rejects(transcribeChatGPTAudio(audio, { authDir, fetchImpl: async () => {
    calls++; return new Response('secret raw error fixture-token-only', { status: 401 });
  } }), error => error.code === 'AUTH_REQUIRED' && error.status === 401 && !error.message.includes('fixture-token-only'));
  assert.equal(calls, 1);
});
test('invalid audio and already-cancelled input cannot cause an upload', async t => {
  const authDir = await credentials(t); let calls = 0;
  const options = { authDir, fetchImpl: async () => { calls++; } };
  await assert.rejects(transcribeChatGPTAudio(Buffer.from('not an audio container'), options), error => error.code === 'UNSUPPORTED_AUDIO');
  await assert.rejects(transcribeChatGPTAudio(audio, { ...options, signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});
test('an HTML response cannot be displayed as a transcript or leak into errors', async t => {
  const authDir = await credentials(t);
  await assert.rejects(transcribeChatGPTAudio(audio, { authDir, fetchImpl: async () => new Response('<html>private challenge content</html>') }),
    error => error.code === 'INVALID_RESPONSE' && !error.message.includes('private'));
});
