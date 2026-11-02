import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';
import {CodexClient} from '../bridge/codex-client.mjs';
import {BandService} from '../bridge/service.mjs';

async function setup(t,{loseStart=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'bc-ws-')),socketPath=join(dir,'codex.sock');
  const server=createServer(),ws=new WebSocketServer({server}),calls=[];
  await new Promise(resolve=>server.listen(socketPath,resolve));
  ws.on('connection',socket=>{
    socket.on('error',()=>{});
    socket.on('message',bytes=>{
      const request=JSON.parse(bytes.toString());if(request.id===undefined)return;
      calls.push(request);let result;
      if(request.method==='initialize')result={};
      else if(request.method==='thread/read')result={thread:{status:{type:'idle'}}};
      else if(request.method==='thread/resume')result={thread:{id:'test-thread',turns:request.params.excludeTurns?[]:[{text:'x'.repeat(8192)}]}};
      else if(request.method==='turn/start'){
        if(loseStart){socket.terminate();return;}
        result={turn:{id:'synthetic-turn',status:'inProgress'}};
      }else throw new Error('Unexpected synthetic method');
      socket.send(JSON.stringify({id:request.id,result}));
    });
  });
  // A small test limit reproduces the same WS length guard without allocating
  // a real multi-megabyte transcript or touching the live Codex daemon.
  const client=new CodexClient({socketPath,maxPayload:4096,timeout:1500});
  t.after(async()=>{
    client.close();for(const socket of ws.clients)socket.terminate();
    await new Promise(resolve=>ws.close(resolve));await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  return {client,calls};
}
test('full-history resume reproduces a bounded WebSocket close and records only transport metadata',async t=>{
  const {client}=await setup(t);await client.connect();
  await assert.rejects(client.request('thread/resume',{threadId:'test-thread'}),/connection closed/);
  const state=client.snapshot();assert.equal(state.connected,false);
  assert.equal(state.lastDisconnect.transportErrorCode,'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
  assert.deepEqual(state.lastDisconnect.pendingMethods,['thread/resume']);
});
test('confirmed send resumes metadata only and submits one synthetic turn across duplicate requests',async t=>{
  const {client,calls}=await setup(t),service=new BandService(client,{allowSend:true});
  const request={id:'synthetic-request-once',method:'prompt.send',params:{threadId:'test-thread',text:'synthetic test'}};
  const [a,b]=await Promise.all([service.handle(request),service.handle(request)]);assert.deepEqual(a,b);
  assert.equal(calls.find(c=>c.method==='thread/resume').params.excludeTurns,true);
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1);assert.equal(client.snapshot().connected,true);
});
test('a lost turn/start confirmation stays ambiguous and is not submitted twice after reconnecting',async t=>{
  const {client,calls}=await setup(t,{loseStart:true}),service=new BandService(client,{allowSend:true});
  const request={id:'synthetic-ambiguous-once',method:'prompt.send',params:{threadId:'test-thread',text:'synthetic test'}};
  await assert.rejects(service.handle(request),e=>!e.sendNotStarted&&/connection closed/.test(e.message));
  await assert.rejects(service.handle(request),e=>!e.sendNotStarted&&/connection closed/.test(e.message));
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
});
