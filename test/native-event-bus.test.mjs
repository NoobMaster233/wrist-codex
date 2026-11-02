import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEventBus} from '../band/src/common/native-event-bus.mjs';
function harness(){
  let now=0,id=0;const timers=new Map(),calls=[],subs=[];
  const bus=createNativeEventBus({publish:o=>calls.push({name:o.eventName,op:o.options.params.op,at:now}),subscribe:o=>{subs.push(o);return subs.length;},unsubscribe:()=>{}},
    {schedule:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},cancel:id=>timers.delete(id)});
  const advance=end=>{for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;timers.delete(next[0]);now=next[1].at;next[1].fn();}now=end;};
  const reply=(name,params)=>{for(const s of subs)if(s.eventName===name)s.callback({params});};
  const send=(eventName,op,id='a')=>bus.publish({eventName,options:{params:{op,id}}});
  return{bus,calls,advance,reply,send};
}
test('Shell transaction keeps transport ACK behind the native completion, preventing event coalescing',()=>{
  const h=harness();h.bus.subscribe({eventName:'bc.shell.evt',callback:()=>{}});
  h.send('bc.shell.req','exec');h.send('bc.link.req','rxack');h.advance(100);
  assert.deepEqual(h.calls,[{name:'bc.shell.req',op:'exec',at:0}]);
  h.reply('bc.shell.evt',{op:'done',id:'other'});h.advance(200);assert.equal(h.calls.length,1);
  h.reply('bc.shell.evt',{op:'done',id:'a'});h.advance(279);assert.equal(h.calls.length,1);
  h.advance(280);assert.equal(h.calls[1].op,'rxack');h.bus.close();
});
test('queued TX is not completion; sent receipt releases the next transaction without retransmission',()=>{
  const h=harness();h.bus.subscribe({eventName:'bc.link.evt',callback:()=>{}});
  h.send('bc.link.req','tx');h.send('bc.capture.req','start');h.advance(0);
  h.reply('bc.link.evt',{op:'queued',id:'a'});h.advance(500);assert.equal(h.calls.length,1);
  h.reply('bc.link.evt',{op:'sent',id:'a'});h.advance(580);assert.equal(h.calls.length,2);
  assert.equal(h.calls.filter(c=>c.op==='tx').length,1);h.bus.close();
});
test('lost native response releases the bus after a bound and never republishes exec',()=>{
  const h=harness();h.send('bc.shell.req','exec');h.send('bc.link.req','rxack');h.advance(11080);
  assert.deepEqual(h.calls.map(c=>c.op),['exec','rxack']);h.bus.close();
});
