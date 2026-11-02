import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchThread } from '../bridge/thread-feed.mjs';
import { createBridgeServer } from '../bridge/server.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = text => ({ messages: [{ id: 'reply', turnId: 'turn', role: 'assistant', text }], nextCursor: null, status: { type: 'idle' } });

function fixture() {
  const client = new EventEmitter();
  const calls = [];
  client.connect = async () => {};
  client.request = async (method, params) => { calls.push({ method, params }); return {}; };
  const service = { client, current: snapshot('first'), reads: 0, async handle() { this.reads++; return this.current; } };
  return { client, service, calls };
}

test('feed sends text completion events, stays idle without events, and removes listeners', async t => {
  const { client, service, calls } = fixture();
  const delivered = [], errors = [];
  const close = watchThread(service, 'thread', data => delivered.push(data), error => errors.push(error), { settleMs: 0 });
  t.after(close);
  await delay(15);
  assert.equal(calls[0].method, 'thread/resume');
  assert.deepEqual(calls[0].params, { threadId: 'thread', excludeTurns: true });
  assert.equal(delivered[0].messages[0].text, 'first');
  const reads = service.reads;
  client.emit('notification', { method: 'item/completed', params: { threadId: 'other', item: { type: 'agentMessage' } } });
  client.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { type: 'commandExecution' } } });
  await delay(30);
  assert.equal(service.reads, reads, 'no timer polls or tool-output refreshes');
  service.current = snapshot('reply arrived');
  client.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage' } } });
  await delay(15);
  assert.equal(delivered.at(-1).messages[0].text, 'reply arrived');
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread' } });
  await delay(15);
  assert.equal(delivered.length, 2, 'an unchanged snapshot is not sent twice');
  close();
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('disconnected'), 0);
  assert.deepEqual(errors, []);
});

test('completion during a snapshot read is not lost', async t => {
  const { client, service } = fixture();
  let release;
  service.handle = async function () {
    this.reads++;
    const data = this.current;
    if (this.reads === 1) await new Promise(resolve => { release = resolve; });
    return data;
  };
  const delivered = [];
  const close = watchThread(service, 'thread', data => delivered.push(data), error => { throw error; }, { settleMs: 0 });
  t.after(close);
  await delay(10);
  service.current = snapshot('final answer');
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread' } });
  release();
  await delay(10);
  assert.equal(delivered.at(-1).messages[0].text, 'final answer');
  assert.equal(service.reads, 2);
});

test('event stream requires authentication and forwards replies without another HTTP request', async t => {
  const { client, service, calls } = fixture();
  const server = createBridgeServer(service, 'test-token');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeFeeds(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/events?threadId=thread`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer test-token', Origin: 'https://example.org' } })).status, 403);
  assert.equal(calls.length, 0);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(url, { headers: { Authorization: 'Bearer test-token' }, signal: abort.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: snapshot/);
  assert.match(first, /first/);
  service.current = snapshot('pushed reply');
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread' } });
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /pushed reply/);
  await reader.cancel();
  await delay(10);
  assert.equal(client.listenerCount('notification'), 0);
});
