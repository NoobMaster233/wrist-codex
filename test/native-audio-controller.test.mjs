import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAudioController,recordingNonce} from '../band/src/common/native-audio.mjs';
const id='01234567-89ab-cdef-0123-456789abcdef',next='fedcba98-7654-3210-fedc-ba9876543210';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(options={}) {
  let listener,nextId=0;const sent=[],states=[],subscriptions=new Map();let unsubscribed=0;
  const event={subscribe(options){const id=++nextId;subscriptions.set(id,options);if(options.eventName==='bc.capture.evt')listener=options.callback;return id;},
    unsubscribe({id}){assert.ok(subscriptions.has(id));subscriptions.delete(id);unsubscribed++;},
    publish(value){
      // Actual .043 publisher silently drops unregistered event names.
      if(![...subscriptions.values()].some(s=>s.eventName===value.eventName))return;
      sent.push(value);options.publish?.(value,emit);
    }};
  const emit=(op,session=id,extra={})=>listener({package:'dev.bandcodex.native',params:{v:2,op,n:recordingNonce(session),e:0,...extra}});
  const controller=createNativeAudioController({event,onState:state=>states.push(state),timeoutMs:options.timeoutMs??100,...options.controller});
  return {controller,sent,states,emit,raw:value=>listener(value),unsubscribed:()=>unsubscribed};
}
test('only matching native events advance capture; late recording cannot undo completion',()=>{
  const f=fixture();f.controller.control({action:'start',sessionId:id});
  assert.deepEqual(f.sent[0].options.params,{v:2,op:'start',n:recordingNonce(id)});
  f.raw(null);f.raw({package:'another.app',params:{v:2,op:'done',n:recordingNonce(id),e:0}});
  f.emit('recording',next);f.emit('recording',id,{e:17});assert.equal(f.states.length,0);
  f.emit('recording');f.controller.control({action:'stop',sessionId:id});f.emit('done');
  f.emit('done');f.emit('recording');
  assert.deepEqual(f.states.map(s=>s.phase),['recording','receiving']);
  assert.equal(f.states[1].name,'bc-audio-'+recordingNonce(id)+'.bcap');
  f.controller.destroy();assert.equal(f.unsubscribed(),2);assert.equal(f.sent.length,2);
});
test('timeout remains an error even if the stop publishes a synchronous completion',async()=>{
  const f=fixture({timeoutMs:5,publish(value,emit){if(value.options.params.op==='stop')emit('done');}});
  f.controller.control({action:'start',sessionId:id});await delay(15);
  assert.deepEqual(f.states.map(s=>s.phase),['error']);
  assert.deepEqual(f.sent.map(s=>s.options.params.op),['start','stop']);f.controller.destroy();
});
test('cancel suppresses delayed starts and obsolete events without a timeout error',async()=>{
  const f=fixture({timeoutMs:5});f.controller.control({action:'start',sessionId:id});
  f.controller.control({action:'cancel',sessionId:id});f.emit('done');f.emit('recording');
  f.controller.control({action:'start',sessionId:id});await delay(15);
  assert.equal(f.states.length,0);assert.deepEqual(f.sent.map(s=>s.options.params.op),['start','cancel']);
  f.controller.control({action:'start',sessionId:next});f.emit('recording',next);
  assert.equal(f.states[0].sessionId,next);f.controller.destroy();
  assert.equal(f.sent.at(-1).options.params.op,'stop');
});
test('an explicit status request recovers completion after lost acknowledgement',async()=>{
  const f=fixture({timeoutMs:5});f.controller.control({action:'start',sessionId:id});await delay(15);
  f.controller.control({action:'status',sessionId:id});f.emit('done');
  assert.deepEqual(f.states.map(s=>s.phase),['error','receiving']);f.controller.destroy();
  assert.throws(()=>recordingNonce('../file'),/Invalid/);
});
test('native cancellation releases capture wake once even when UI state is already terminal',()=>{
  const stopped=[],f=fixture({controller:{onQuiescent:session=>stopped.push(session)}});
  f.controller.control({action:'start',sessionId:id});f.controller.control({action:'cancel',sessionId:id});
  f.emit('cancelled');f.emit('cancelled');
  assert.deepEqual(stopped,[id]);assert.equal(f.states.length,0);f.controller.destroy();
});
