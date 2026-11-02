import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {createNativeConnection,createBandConnection,encodeUtf8,decodeUtf8,utf8Length} from '../band/src/common/private-connection.mjs';

function harness({dropSent=false,corrupt=false,available=true}={}) {
  const files=new Map(),subscriptions=new Map(),requests=[],messages=[];let next=0,up=true,tx=0;
  const emit=params=>queueMicrotask(()=>{
    for(const sub of subscriptions.values())if(sub.eventName==='bc.link.evt')sub.callback({package:'dev.bandcodex.link',params:{v:1,...params}});
  });
  const event={subscribe:sub=>{if(!available)throw new Error('Absent');subscriptions.set(++next,sub);return next;},
    unsubscribe:({id})=>subscriptions.delete(id),publish:({options})=>{
      const p=options.params;requests.push(p);
      if(['ping','show','hide'].includes(p.op))emit({op:'state',up:up?1:0,s:'aabbccdd'});
      if(p.op==='tx'){
        tx++;messages.push(JSON.parse(decodeUtf8(files.get('internal://files/bc-link-tx-'+p.id+'.json'))));
        if(!dropSent)emit({op:'sent',id:p.id,e:0});
      }
      if(p.op==='txstatus')emit({op:'sent',id:p.id,e:0});
    }};
  const file={writeArrayBuffer:o=>setImmediate(()=>{
      assert.equal(o.buffer.byteLength,o.buffer.buffer.byteLength);const b=new Uint8Array(o.buffer.length+(corrupt?1:0));b.set(o.buffer);files.set(o.uri,b);o.success({});
    }),get:o=>setImmediate(()=>files.has(o.uri)?o.success({length:files.get(o.uri).length}):o.fail('missing',1)),
    readArrayBuffer:o=>setImmediate(()=>o.success({buffer:files.get(o.uri).slice(o.position,o.position+o.length)})),
    delete:o=>setImmediate(()=>{files.delete(o.uri);o.success({});})};
  return {event,file,files,requests,messages,emit,tx:()=>tx,setUp:value=>{up=value;emit({op:'state',up:up?1:0,s:'aabbccdd'});}};
}
const periods={probe:10,ack:15,reconcile:20,io:100};
const send=(conn,data)=>new Promise((resolve,reject)=>conn.send({data,success:resolve,fail:message=>reject(new Error(message))}));
const legacy=()=>({sendCalls:0,getReadyState:o=>o.success({status:1}),send(){this.sendCalls++;},onopen:null,onclose:null,onerror:null,onmessage:null});

test('UTF-8 matches native JSON bytes and rejects invalid encodings',()=>{
  for(const text of ['','中文 🎤 café','a\0b','\ud800','🧑‍💻'.repeat(3000)]) {
    assert.equal(utf8Length(text),Buffer.byteLength(text));assert.deepEqual(Buffer.from(encodeUtf8(text)),Buffer.from(text));
    assert.equal(decodeUtf8(encodeUtf8(text)),Buffer.from(text).toString('utf8'));
  }
  for(const bytes of [[0x80],[0xc0,0xaf],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xe2,0x82]])assert.throws(()=>decodeUtf8(Uint8Array.from(bytes)),/UTF-8/);
});
test('mailbox RPCs serialize and recover a lost sent event without republishing TX',async t=>{
  const h=harness({dropSent:true}),conn=createNativeConnection({...h,timings:periods,now:()=>123});t.after(()=>conn.destroy());
  await wait(8);await send(conn,{v:1,id:'confirm-once',method:'prompt.send',params:{text:'测试消息'}});
  assert.equal(h.tx(),1);assert.equal(h.requests.filter(x=>x.op==='txstatus').length,1);
  assert.equal(h.messages[0].id,'confirm-once');
});
test('duplicate receive notices deliver once and acknowledge the same ID again',async t=>{
  const h=harness(),conn=createNativeConnection({...h,timings:periods});t.after(()=>conn.destroy());let delivered=0;
  conn.onmessage=e=>{assert.equal(JSON.parse(e.data).result.text,'你好 🎧');delivered++;};await wait(8);
  const id='aabbccdd00000001',bytes=encodeUtf8(JSON.stringify({v:1,id:'reply',result:{text:'你好 🎧'}}));
  h.files.set('internal://files/bc-link-rx-'+id+'.json',bytes);
  h.emit({op:'rx',id,b:bytes.length});h.emit({op:'rx',id,b:bytes.length});await wait(15);
  assert.equal(delivered,1);assert.equal(h.requests.filter(p=>p.op==='rxack').length,2);
});
test('an extra file tail is rejected before a message can be transmitted',async t=>{
  const h=harness({corrupt:true}),conn=createNativeConnection({...h,timings:periods});t.after(()=>conn.destroy());await wait(8);
  await assert.rejects(send(conn,{v:1,id:'protected',method:'prompt.send'}),/file differs/);assert.equal(h.tx(),0);
});
test('native disconnect never falls back to an apparently connected official channel',async t=>{
  const h=harness(),old=legacy(),conn=createBandConnection({...h,legacy:old,timings:periods});t.after(()=>conn.destroy());await wait(8);
  await send(conn,{v:1,id:'first',method:'projects.list'});h.setUp(false);await wait(3);
  let status;conn.getReadyState({success:r=>{status=r.status;}});assert.equal(status,0);
  await assert.rejects(send(conn,{v:1,id:'second',method:'projects.list'}),/not connected/);assert.equal(old.sendCalls,0);
});
test('missing native service retains the legacy bootstrap connection',async t=>{
  const h=harness({available:false}),old=legacy(),conn=createBandConnection({...h,legacy:old,timings:periods});t.after(()=>conn.destroy());await wait(8);
  conn.send({data:{v:1,id:'bootstrap',method:'projects.list'}});assert.equal(old.sendCalls,1);
});
test('native service never instantiates the legacy interconnect, including while its phone link is down',async t=>{
  const h=harness();let instances=0;
  const conn=createBandConnection({...h,legacy:()=>{instances++;return legacy();},timings:periods});t.after(()=>conn.destroy());
  await wait(8);assert.equal(instances,0);await send(conn,{v:1,id:'native-only',method:'projects.list'});
  h.setUp(false);await wait(3);conn.getReadyState({success:()=>{}});assert.equal(instances,0);
});
