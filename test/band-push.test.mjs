import {readWorkspaceScript} from './fixtures/workspace-script.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {pageConnectionDependencies} from './fixtures/legacy-connection.mjs';

async function fixture() {
  const script = await readWorkspaceScript('globalThis.page =');
  const sent = [], timers = new Map(), scrolls = [];
  let timerId = 0;
  const connection = { send({ data }) { sent.push(structuredClone(data)); } };
  const context = vm.createContext({ ...pageConnectionDependencies, interconnect: { instance: () => connection }, setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(script, context);
  const page = context.page;
  Object.assign(page, JSON.parse(JSON.stringify(page.private)));
  page.$nextTick = fn => fn();
  page.$element = () => ({ scrollTo(value) { scrolls.push(value.top); }, getScrollRect({ success }) { success({ height: 1000 }); } });
  page.onInit();
  const result = text => ({ messages: [{ id: 'a', turnId: 'turn', role: 'assistant', text }], nextCursor: null, status: { type: 'idle' } });
  const enter = () => {
    page.chooseThread({ id: 'thread', title: '对话' });
    const request = sent.findLast(item => item.method === 'messages.watch');
    page.receive({ v: 1, id: request.id, result: result('old') });
    page.adjustingScroll = false;
    return request;
  };
  const frames = (watchId, sequence, text) => {
    const message = { v: 1, event: 'messages.updated', threadId: 'thread', watchId, sequence, result: result(text) };
    const encoded = JSON.stringify(message);
    const parts = [];
    for (let i = 0; i < encoded.length; i += 100) parts.push(encoded.slice(i, i + 100));
    return parts.map((data, part) => ({ bc: 1, id: 'push-' + watchId + '-' + sequence, part, total: parts.length, data }));
  };
  return { page, sent, enter, frames, scrolls, timers };
}

test('band receives a fragmented push during voice input without cancelling either operation', async t => {
  const { page, sent, enter, frames } = await fixture();
  t.after(() => page.onDestroy());
  const request = enter();
  page.rpc('voice.request',{threadId:'thread'},result=>page.showDraft(result.text,result));
  const voice = sent.at(-1);
  const push = frames(request.params.watchId, 1, 'new reply');
  for (const frame of push.toReversed()) page.receive(frame);
  assert.equal(page.pending.id, voice.id);
  assert.equal(page.messages[0].text, 'old');
  page.receive({ v: 1, id: voice.id, result: { text: 'draft' } });
  assert.equal(page.view, 'draft');
  assert.equal(page.draft, 'draft');
  page.cancelDraft();
  assert.equal(page.messages[0].text, 'new reply');
  assert.equal(sent.some(item => item.method === 'messages.list'), false, 'a push does not trigger a history fetch');
});

test('reading earlier text is preserved until the user returns to the bottom', async t => {
  const { page, enter, frames } = await fixture();
  t.after(() => page.onDestroy());
  const request = enter();
  page.messageScrolled({ scrollY: 300 });
  page.messageScrolled({ scrollY: 100 });
  for (const frame of frames(request.params.watchId, 2, 'latest answer')) page.receive(frame);
  assert.equal(page.messages[0].text, 'old');
  assert.equal(page.newReplies, true);
  page.messageAtBottom();
  assert.equal(page.messages[0].text, 'latest answer');
  assert.equal(page.newReplies, false);
  for (const frame of frames(request.params.watchId, 1, 'stale answer')) page.receive(frame);
  assert.equal(page.messages[0].text, 'latest answer');
});

test('hiding the band page closes the subscription and rejects its late frames', async t => {
  const { page, sent, enter, frames } = await fixture();
  t.after(() => page.onDestroy());
  const request = enter();
  page.onHide();
  assert.equal(sent.at(-1).method, 'messages.unwatch');
  for (const frame of frames(request.params.watchId, 1, 'late reply')) page.receive(frame);
  assert.equal(page.messages[0].text, 'old');
  page.onShow();
  assert.equal(sent.at(-1).method, 'messages.watch');
  assert.notEqual(sent.at(-1).params.watchId, request.params.watchId);
});

test('a status-only update does not claim there is a new reply or move the reader', async t => {
  const { page, enter, frames, scrolls } = await fixture();
  t.after(() => page.onDestroy());
  const request = enter();
  page.messageScrolled({ scrollY: 300 });
  page.messageScrolled({ scrollY: 100 });
  const count = scrolls.length;
  for (const frame of frames(request.params.watchId, 1, 'old')) page.receive(frame);
  assert.equal(page.newReplies, false);
  assert.equal(scrolls.length, count);
});

test('returning from the system recorder checks once and opens the recorded draft without a microphone request', async t => {
  const { page, sent } = await fixture(); t.after(() => page.onDestroy());
  page.threadId = 'thread'; page.cwd = '/project'; page.view = 'recording'; page.hidden = true;
  page.onShow();
  const request = sent.at(-1); assert.equal(request.method, 'recording.status');
  page.receive({ id: request.id, result: { phase: 'ready', text: '真实录音文字', sessionId: 'recording-one' } });
  assert.equal(page.view, 'draft'); assert.equal(page.draft, '真实录音文字');
  assert.equal(sent.some(r => r.method === 'voice.request' || r.method === 'prompt.send'), false);
  assert.equal(page.pending, null);
});

test('recording-ready notification waits for the active RPC and ignores other conversations', async t => {
  const { page, sent } = await fixture(); t.after(() => page.onDestroy());
  page.chooseThread({ id: 'thread', title: '对话' }); const request = sent.at(-1);
  page.receive({ bc_command: 'recordingState', threadId: 'other', state: { phase: 'ready' } });
  assert.equal(page.recordingReadyPending, false);
  page.receive({ bc_command: 'recordingState', threadId: 'thread', state: { phase: 'ready' } });
  assert.equal(page.pending.id, request.id);
  page.receive({ id: request.id, result: { messages: [], nextCursor: null, status: { type: 'idle' } } });
  const voice = sent.at(-1); assert.equal(voice.method, 'voice.request'); assert.equal(voice.params.input, 'recording');
  page.receive({ id: voice.id, result: { text: '核对录音' } });
  assert.equal(page.view, 'draft'); assert.equal(sent.some(r => r.method === 'prompt.send'), false);
});

test('recording commands restore a recreated page and deliver a long draft without a watch or prompt', async t => {
  const { page, sent } = await fixture(); t.after(() => page.onDestroy());
  const deliver = (message, id) => {
    const encoded = JSON.stringify(message), parts = [];
    for (let i=0; i<encoded.length; i+=100) parts.push(encoded.slice(i,i+100));
    for (const part of parts.map((data,part) => ({ bc:1, id:'command-'+id, part, total:parts.length, data })).toReversed()) page.receive(part);
  };
  deliver({ bc_command:'recordingResume', sessionId:'session-one', phase:'recording',
    target:{threadId:'thread',cwd:'/project',projectName:'project',threadTitle:'对话'} },'resume');
  assert.equal(page.view,'recording'); assert.equal(page.recordingSession,'session-one');
  assert.equal(page.recordingPhase,'recording'); assert.equal(page.threadId,'thread');
  const text = '需要核对的录音文字。'.repeat(100);
  deliver({bc_command:'recordingState',threadId:'thread',state:{sessionId:'session-one',phase:'ready',text}},'ready');
  assert.equal(page.view,'draft'); assert.equal(page.draft,text);
  assert.equal(sent.some(r => r.method==='prompt.send'),false);
  assert.equal(page.pending,null,'a ready push releases the superseded status read');
  assert.equal(page.busy,false); assert.equal(page.sending,false);
});

test('a ready draft retires its status read and ignores late replies and resume commands', async t => {
  const { page, sent, timers } = await fixture(); t.after(() => page.onDestroy());
  page.threadId='thread';page.view='recording';page.recordingSession='session-one';
  page.checkRecordingStatus();const old=page.pending, oldTimeout=timers.get(old.timer);
  page.receive({bc_command:'recordingState',threadId:'thread',state:{phase:'ready',sessionId:'session-one',text:'核对后发送'}});
  assert.equal(page.view,'draft');assert.equal(page.busy,false);assert.equal(page.sending,false);
  page.sendDraft();const send=page.pending;
  assert.equal(send.method,'prompt.send');assert.equal(page.sending,true);
  oldTimeout();
  page.receive({id:old.id,result:{phase:'receiving'}});
  page.receive({bc_command:'recordingResume',sessionId:'session-one',phase:'receiving',target:{threadId:'thread',cwd:'/project'}});
  assert.equal(page.pending,send);assert.equal(page.view,'draft');assert.equal(page.recordingPhase,'ready');
  page.sendDraft();assert.equal(sent.filter(r=>r.method==='prompt.send').length,1);
});

test('paused send timers expire on show and confirmation retries keep the same request id', async t => {
  const { page, sent } = await fixture();t.after(()=>page.onDestroy());
  page.threadId='thread';page.recordingSession='session-one';page.recordingPhase='ready';page.showDraft('草稿',{sessionId:'session-one',phase:'ready'});
  page.sendDraft();const first=sent.findLast(r=>r.method==='prompt.send');
  page.pending.deadline=Date.now()-1;page.onShow();
  assert.equal(page.busy,false);assert.equal(page.sending,false);assert.equal(page.sendUncertain,true);assert.equal(page.draft,'草稿');
  page.sendDraft();const retry=sent.findLast(r=>r.method==='prompt.send');assert.equal(retry.id,first.id);
  page.receive({id:retry.id,result:{threadId:'thread',turnId:'accepted'}});
  assert.equal(page.view,'messages');assert.equal(page.draft,'');assert.equal(page.sendUncertain,false);
  page.receive({bc_command:'recordingState',threadId:'thread',state:{sessionId:'session-one',phase:'ready',text:'草稿'}});
  assert.equal(page.view,'messages','late ready notifications cannot resurrect a sent draft');
});

test('a known rejection preserves the draft and unlocks send without claiming it was submitted', async t => {
  const { page } = await fixture();t.after(()=>page.onDestroy());
  page.threadId='thread';page.showDraft('稍后发送');page.sendDraft();
  page.receive({id:page.pending.id,error:'这段对话正在处理任务，请等待完成后再发送',retryable:true});
  assert.equal(page.view,'draft');assert.equal(page.draft,'稍后发送');
  assert.equal(page.busy,false);assert.equal(page.sending,false);assert.equal(page.sendUncertain,false);
});

const savedRecording = () => ({pending:true,phase:'ready',sessionId:'saved-one',text:'之前的录音',
  target:{threadId:'original-thread',cwd:'/original',projectName:'original',threadTitle:'原对话'}});

test('starting with an existing draft opens management without starting or replacing a recording', async t => {
  const {page,sent}=await fixture();t.after(()=>page.onDestroy());
  page.threadId='current-thread';page.cwd='/current';page.view='input';page.armRecording();
  assert.equal(page.pending.method,'recording.pending');
  page.receive({id:page.pending.id,result:savedRecording()});
  assert.equal(page.view,'recording-manager');assert.equal(page.threadId,'current-thread');
  assert.equal(sent.some(x=>x.method==='recording.arm'||x.method==='recording.discard'),false);
  page.reviewPendingRecording();
  assert.equal(page.view,'draft');assert.equal(page.threadId,'original-thread');assert.equal(page.draft,'之前的录音');
  page.cancelDraft();assert.equal(page.pending.method,'recording.discard');
  assert.equal(page.pending && sent.findLast(x=>x.method==='recording.discard').params.sessionId,'saved-one');
});

test('global manager discards only the selected session and keeps the currently selected conversation', async t => {
  const {page,sent}=await fixture();t.after(()=>page.onDestroy());
  page.threadId='current-thread';page.cwd='/current';page.openRecordingManager(savedRecording());
  page.discardPendingRecording();const request=sent.findLast(x=>x.method==='recording.discard');
  assert.equal(request.params.threadId,'original-thread');assert.equal(request.params.sessionId,'saved-one');
  page.receive({id:request.id,result:{phase:'cancelled',sessionId:'saved-one'}});
  assert.equal(page.pendingRecording,null);assert.equal(page.view,'input');assert.equal(page.threadId,'current-thread');
  page.armRecording();page.receive({id:page.pending.id,result:{pending:false,phase:'idle'}});
  assert.equal(sent.findLast(x=>x.method==='recording.arm').params.threadId,'current-thread');
});

test('back from a native draft preserves it, while a manual continue does not discard or reuse its send id', async t => {
  const {page,sent}=await fixture();t.after(()=>page.onDestroy());
  page.openRecordingManager(savedRecording());page.reviewPendingRecording();page.goBack();
  assert.equal(page.view,'input');assert.equal(sent.some(x=>x.method==='recording.discard'),false);
  page.receive({id:page.pending.id,result:savedRecording()});
  page.prepareContinue();page.sendDraft();const request=sent.findLast(x=>x.method==='prompt.send');
  assert.ok(request.id.startsWith('send-'));assert.equal(request.params.text,'继续');
});

test('the shipping page excludes legacy native recording and report probes', async t => {
  const {page,sent}=await fixture();t.after(()=>page.onDestroy());
  assert.equal(page.probeRecord,undefined);assert.equal(page.readDeviceProbe,undefined);
  page.receive({bc_command:'probeDevice'});page.receive({bc_command:'probeRecord'});
  assert.equal(sent.length,0);
  const manifest=JSON.parse(await readFile(new URL('../band/src/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.features.map(x=>x.name).sort(),['system.brightness','system.event','system.file','system.interconnect']);
});
