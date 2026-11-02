import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeEventProbe } from '../band/src/common/native-event-probe.mjs';
import { AstroRelay } from '../bridge/astro-server.mjs';

function fixture(options = {}) {
  let id = 0;
  const subscriptions = new Map(), published = [];
  const event = {
    subscribe(value) { subscriptions.set(++id,value); return id; },
    unsubscribe({id}) { subscriptions.delete(id); },
    publish(value) { published.push(value); }
  };
  const probe = createNativeEventProbe({event,nonce:'0123456789abcdef0123456789abcdef', ...options});
  return {probe,published,subscriptions,emit: data => {
    for (const s of [...subscriptions.values()]) if (s.eventName === 'bc.capture.evt') s.callback(data);
  }};
}

test('native diagnostic publishes once and distinguishes transmit-only from capture', async () => {
  let armed = false;
  const {probe,published,subscriptions,emit} = fixture({onArmed:()=>{armed=true;}});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(armed,true); assert.equal(published.length,1);
  assert.deepEqual(published[0].options.params,{v:1,op:'ping',n:'0123456789abcdef0123456789abcdef'});
  emit({package:'another.app',params:{v:1,op:'ready',rx:false,audio:false}});
  assert.equal(subscriptions.size,2);
  emit({package:'dev.bandcodex.native',params:{v:1,op:'ready',rx:false,audio:false}});
  assert.deepEqual(await probe.done,{nativeTx:true,nativeRx:false,nativeCapture:false});
  assert.equal(subscriptions.size,0);
});

test('only the matching nonce proves a native return path; cancel and timeout release listeners', async () => {
  const first=fixture();
  first.emit({package:'dev.bandcodex.native',params:{v:1,op:'pong',n:'wrong'}});
  assert.equal(first.subscriptions.size,2);
  first.emit({package:'dev.bandcodex.native',params:{v:1,op:'pong',n:'0123456789abcdef0123456789abcdef'}});
  assert.equal((await first.probe.done).nativeRx,true); assert.equal(first.subscriptions.size,0);
  const second=fixture(); const cancelled=assert.rejects(second.probe.done,/cancelled/);
  second.probe.cancel(); await cancelled; assert.equal(second.subscriptions.size,0);
  const third=fixture({timeoutMs:5}); await assert.rejects(third.probe.done,/超时/);
  assert.equal(third.subscriptions.size,0);
});

test('native relay reports partial capability without advertising recording or executing a loader', async () => {
  const relay=new AstroRelay({}); relay.connected=true;relay.lastSeen=Date.now();
  const {id}=relay.startNativeProbe();
  assert.equal(relay.events.length,1);assert.equal(relay.events[0].data.bc_command,'nativeEventProbe');
  await relay.handle({method:'native.capabilities.progress',params:{id,stage:'armed'}});
  const result=await relay.handle({method:'native.capabilities.report',params:{id,nativeTx:true,nativeRx:false,nativeCapture:true}});
  assert.deepEqual(result,{verified:false,nativeTx:true,nativeRx:false,nativeCapture:false});
  assert.equal(relay.nativeProbe.phase,'partial');
  const next=relay.startNativeProbe();relay.nativeProbe.startedAt-=125001;relay.expireNativeProbe();
  await assert.rejects(relay.handle({method:'native.capabilities.report',params:{id:next.id,nativeTx:true}}),/Unknown/);
});

test('a retained event delivered during subscription releases both ids and never republishes',async()=>{
  let id=0,published=0;const active=new Map();
  const event={subscribe(value){const current=++id;active.set(current,value);
    if(value.eventName==='bc.capture.evt')value.callback({package:'dev.bandcodex.native',params:{v:1,op:'ready',rx:false,audio:false}});
    return current;
  },unsubscribe({id}){active.delete(id);},publish(){published++;}};
  const probe=createNativeEventProbe({event,nonce:'0'.repeat(32),receiveOnly:true,timeoutMs:5});
  assert.equal((await probe.done).nativeTx,true);assert.equal(active.size,0);assert.equal(published,0);
});
