import test from 'node:test';
import assert from 'node:assert/strict';
import {AstroRelay} from '../bridge/relay.mjs';
import {shellSummary} from '../band/src/common/device-tools.mjs';
test('microphone authorization is bound to the live session and cannot grant twice or after expiry',async()=>{
  const relay=new AstroRelay({}),sessionId='01234567-89ab-cdef-0123-456789abcdef';
  relay.recording={state:{id:sessionId,phase:'preparing',expiresAt:Date.now()+10000}};
  const invoke=()=>relay.handle({method:'native.audio.authorize',params:{sessionId}});
  assert.equal((await invoke()).allowed,true);assert.equal((await invoke()).allowed,false);
  relay.authorizedCaptures.clear();relay.recording.state.phase='cancelled';assert.equal((await invoke()).allowed,false);
  relay.recording.state.phase='preparing';relay.recording.state.expiresAt=Date.now()-1;assert.equal((await invoke()).allowed,false);
});

test('terminal RPC keeps at-most-once command submission and refuses busy microphone',async()=>{
  const relay=new AstroRelay({}),calls=[];
  relay.recording={state:{phase:'delivered'}};
  relay.shell={start:async(...args)=>{calls.push(args);return{id:'diagnostic',phase:'sending'};}};
  const request={id:'terminal-request',method:'device.shell.start',params:{command:'uname -a'}};
  const [a,b]=await Promise.all([relay.rpc(request),relay.rpc(request)]);
  assert.deepEqual(a,b);assert.equal(calls.length,1);assert.equal(calls[0][1].timeoutMs,3000);
  relay.recording.state.phase='recording';
  const rejected=await relay.rpc({...request,id:'second-request'});assert.match(rejected.error,/录音/);assert.equal(calls.length,1);
});
test('terminal output removes control bytes, retains Unicode and requires completed native receipt',async()=>{
  const relay=new AstroRelay({});
  relay.shell={output:async id=>{assert.equal(id,'finished');return Buffer.from('\u001b\u0000状态正常\n');}};
  const result=await relay.handle({method:'device.shell.output',params:{id:'finished'}});
  assert.equal(result.text,'状态正常\n');assert.equal(result.bytes,15);
  assert.match(shellSummary({phase:'unknown'}),/不会重发/);
  assert.equal(shellSummary({phase:'complete',status:{rawStatus:256,elapsedMs:9}}),'退出 1 · 9 ms');
});
