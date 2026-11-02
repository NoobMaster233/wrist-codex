import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeLoaderReport } from '../band/src/common/native-loader-report.mjs';
import { createNativeEventProbe } from '../band/src/common/native-event-probe.mjs';
import { AstroRelay } from '../bridge/astro-server.mjs';

test('loader diagnostics read only fixed bounded regular files and reject binary or oversize content',async()=>{
  const contents={'report.txt':'submitted\n','rc.txt':'0\n','log.txt':'\x00','fw.txt':'x'.repeat(2049)},read=[];
  const file={
    get({uri,success}) { assert.match(uri,/^internal:\/\/files\/bc-native-load-043-(report|rc|log|fw)\.txt$/);success({length:contents[uri.split('-043-')[1]].length}); },
    readArrayBuffer({uri,success}) { read.push(uri);success({buffer:Uint8Array.from(contents[uri.split('-043-')[1]],c=>c.charCodeAt(0))}); }
  };
  const result=await readNativeLoaderReport(file);
  assert.equal(result['rc.txt'].text,'0\n');assert.match(result['log.txt'].error,/Non-text/);
  assert.match(result['fw.txt'].error,/length/);assert.equal(read.length,3);
  const relay=new AstroRelay({});relay.connected=true;relay.lastSeen=Date.now();
  const {id}=relay.requestNativeLoaderReport();
  await assert.rejects(relay.handle({method:'native.loader.report',params:{id,reports:{'report.txt':{text:'a'.repeat(2049)}}}}),/Invalid/);
  await relay.handle({method:'native.loader.report',params:{id,reports:result}});
  assert.deepEqual(relay.nativeLoaderReport.reports,result);
});

test('receive-only probe does not overwrite a retained native event with a ping',async()=>{
  let response,published=0;
  const probe=createNativeEventProbe({nonce:'0'.repeat(32),receiveOnly:true,event:{
    subscribe({eventName,callback}) { if(eventName==='bc.capture.evt')response=callback;return eventName==='bc.capture.evt'?2:1; },
    unsubscribe(){},publish(){published++;}
  }});
  response({package:'dev.bandcodex.native',params:{v:1,op:'ready',rx:false,audio:false}});
  assert.equal((await probe.done).nativeTx,true);assert.equal(published,0);
});

test('a live phone plugin cannot leave an unanswered band diagnostic pending forever',async()=>{
  const relay=new AstroRelay({});relay.connected=true;relay.lastSeen=Date.now();
  const {id}=relay.requestNativeLoaderReport();relay.nativeLoaderReport.startedAt-=30001;
  relay.poll(0);
  assert.equal(relay.nativeLoaderReport.phase,'error');assert.equal(relay.events.length,0);
  await assert.rejects(relay.handle({method:'native.loader.report',params:{id,reports:{}}}),/Unknown/);
});
