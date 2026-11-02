import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { BandService } from '../bridge/service.mjs';
import { createBridgeServer } from '../bridge/server.mjs';

class FakeCodex {
  constructor(handler) { this.calls = []; this.handler = handler; }
  async connect() {}
  async request(method, params) { this.calls.push({ method, params }); return this.handler(method, params); }
}

test('history pagination preserves emoji and excludes command output', async () => {
  const longText = '你'.repeat(899) + '🛰️' + '继续';
  const items = [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '测试消息' }] },
    { id: 'c', type: 'commandExecution', aggregatedOutput: 'private shell output' },
    { id: 'a', type: 'agentMessage', text: longText }
  ];
  const client = new FakeCodex(method => {
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', items }], nextCursor: 'older' };
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    if (method === 'thread/items/list') return { data: items.map(item => ({ item })), nextCursor: null };
    throw new Error(method);
  });
  const service = new BandService(client);
  const page = await service.handle({ method: 'messages.list', params: { threadId: 'thread' } });
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[1].truncated, true);
  const rest = await service.handle({ method: 'message.read', params: { threadId: 'thread', turnId: 'turn', itemId: 'a', offset: 900 } });
  assert.equal(page.messages[1].text + rest.text, longText);
  assert.equal(rest.nextOffset, null);
});

test('a repeated prompt sends exactly one turn and cannot change content', async () => {
  const client = new FakeCodex(method => {
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    if (method === 'thread/resume') return {};
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress' } };
    throw new Error(method);
  });
  const service = new BandService(client, { allowSend: true });
  const request = { id: 'unique-request-1', method: 'prompt.send', params: { threadId: 'thread', text: '继续' } };
  const results = await Promise.all([service.handle(request), service.handle(request)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
  await assert.rejects(service.handle({ ...request, params: { ...request.params, text: '不同的指令' } }), /reused/);
});

test('read-only mode and active conversations cannot start a turn', async () => {
  const client = new FakeCodex(() => ({ thread: { status: { type: 'active' } } }));
  const request = { id: 'unique-request-2', method: 'prompt.send', params: { threadId: 'thread', text: '继续' } };
  await assert.rejects(new BandService(client).handle(request), /读取测试/);
  await assert.rejects(new BandService(client, { allowSend: true }).handle(request), /正在处理/);
  assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
});

test('a failed initial Codex connection is retryable before any turn can start',async()=>{
  let fail=true;
  const client=new FakeCodex(method=>{
    if(method==='thread/read')return {thread:{status:{type:'idle'}}};
    if(method==='thread/resume')return {};
    if(method==='turn/start')return {turn:{id:'accepted',status:'inProgress'}};
  });
  client.connect=async()=>{if(fail)throw Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'});};
  const service=new BandService(client,{allowSend:true});
  const request={id:'connection-retry-once',method:'prompt.send',params:{threadId:'thread',text:'仅供测试'}};
  await assert.rejects(service.handle(request),e=>e.sendNotStarted===true&&e.code==='ECONNREFUSED');
  assert.equal(client.calls.length,0);fail=false;
  await service.handle(request);await service.handle(request);
  assert.equal(client.calls.filter(c=>c.method==='turn/start').length,1);
});

test('only failures before turn/start permit a retry; missing start confirmation is retained', async () => {
  let active=true, loseConfirmation=false;
  const client=new FakeCodex(method=>{
    if(method==='thread/read')return {thread:{status:{type:active?'active':'idle'}}};
    if(method==='thread/resume')return {};
    if(method==='turn/start') {if(loseConfirmation)throw new Error('start confirmation lost');return {turn:{id:'one',status:'inProgress'}};}
  });
  const service=new BandService(client,{allowSend:true});
  const request={id:'recording-send-session-one',method:'prompt.send',params:{threadId:'thread',text:'草稿'}};
  await assert.rejects(service.handle(request),e=>e.sendNotStarted===true);
  active=false;await service.handle(request);await service.handle(request);
  assert.equal(client.calls.filter(c=>c.method==='turn/start').length,1);
  loseConfirmation=true;
  const uncertain={...request,id:'recording-send-session-two'};
  await assert.rejects(service.handle(uncertain),/confirmation lost/);
  await assert.rejects(service.handle(uncertain),/confirmation lost/);
  assert.equal(client.calls.filter(c=>c.method==='turn/start').length,2);
});

test('HTTP bridge rejects unauthenticated calls, browser origins, and oversized bodies', async t => {
  let calls = 0;
  const server = createBridgeServer({ async handle() { calls++; return { projects: [] }; } }, 'test-token');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/rpc`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' };
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(32769) })).status, 413);
  const malformedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: 'http://[' }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(malformedStatus, 400, 'a malformed URL cannot terminate the bridge');
  assert.equal(calls, 0);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ id: 'test', method: 'projects.list' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'test');
  assert.equal(calls, 1);
});
