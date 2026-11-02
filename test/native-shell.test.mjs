import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeShell} from '../bridge/native-shell.mjs';
import {createNativeShellRequest} from '../band/src/common/native-shell.mjs';

const id='00000000-0000-4000-8000-000000000001';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'band-shell-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dispatched=[],reads=[],blobs=new Map();let bytes;
  const options={root,sendFile:b=>{bytes=b;return {id:'file-'+id};},
    receiveFile:(name,owner)=>{const job={id:'upload-'+reads.length,name,owner};reads.push(job);return job;},
    dispatch:command=>dispatched.push(command),readBlob:async id=>blobs.get(id)};
  const shell=new NativeShell(options);await shell.init();
  const start=async()=>{await shell.start('echo test');await shell.receivedRequest({id:'file-'+id,state:'complete',size:bytes.length,sha256:sha(bytes),metadata:{length:bytes.length}});};
  const status=({flags=0,raw=0,phase=2,pid=251,wait=251,crc=bytes.readUInt32LE(20),outputBytes=5}={})=>{
    const b=Buffer.alloc(64);b.write('BCSR0431');b.writeUInt32LE(1,8);b.writeUInt32LE(phase,12);
    b.writeInt32LE(pid,16);b.writeInt32LE(wait,20);b.writeInt32LE(raw,24);b.writeUInt32LE(6,32);
    b.writeUInt32LE(flags,36);b.writeUInt32LE(outputBytes,40);b.writeUInt32LE(crc,44);b.writeUInt32LE(3000,48);return b;
  };
  const upload=async(data,s=shell)=>{const job=reads.at(-1);blobs.set(job.id,data);await s.uploaded({id:job.id,phase:'complete',size:data.length,sha256:sha(data)});};
  return {root,shell,options,dispatched,reads,start,status,upload};
}
test('shell binds verified request, native event, receipt and exact binary output; duplicate reports never execute twice',async t=>{
  const f=await fixture(t);await f.start();
  await f.shell.receivedRequest({id:'file-'+id,state:'complete'});
  assert.equal(f.dispatched.filter(x=>x.bc_command==='nativeShellControl').length,1);
  const event={id,op:'done',r:0,f:0,b:5,e:0};await f.shell.result(event);await f.shell.result(event);
  assert.equal(f.reads.length,1);
  await f.upload(f.status());await f.upload(Buffer.from([0,255,128,65,10]));
  assert.equal(f.shell.snapshot(id).phase,'complete');assert.deepEqual(await f.shell.output(id),Buffer.from([0,255,128,65,10]));
  assert.equal(f.dispatched.at(-1).bc_command,'nativeShellRelease');
});
test('relay restart cannot resend exec, and reconciliation only reads existing files',async t=>{
  const f=await fixture(t);await f.start();const before=f.dispatched.length;
  const restarted=new NativeShell(f.options);await restarted.init();
  assert.equal(restarted.snapshot(id).phase,'unknown');assert.equal(f.dispatched.length,before);
  assert.throws(()=>restarted.requireIdle(),/未知/);
  await restarted.reconcile(id);await f.upload(f.status(),restarted);await f.upload(Buffer.from('test\n'),restarted);
  assert.equal(restarted.snapshot(id).phase,'complete');
  assert.equal(f.dispatched.filter(x=>x.bc_command==='nativeShellControl').length,1);
});
test('explicitly closing an unknown diagnostic retains uncertainty and cannot replay execution',async t=>{
  const f=await fixture(t);await f.start();
  const restarted=new NativeShell(f.options);await restarted.init();
  await assert.rejects(restarted.acknowledgeUnknown(id,''),/reason/);
  const before=f.dispatched.length;
  const state=await restarted.acknowledgeUnknown(id,'Known read-only diagnostic; retain unknown receipt without retry');
  assert.equal(state.phase,'unknown');assert.ok(state.unknownAcknowledged);assert.doesNotThrow(()=>restarted.requireIdle());
  assert.equal(f.dispatched.length,before);assert.equal(f.dispatched.filter(x=>x.bc_command==='nativeShellControl').length,1);
  const again=new NativeShell(f.options);await again.init();assert.equal(again.snapshot(id).phase,'unknown');assert.doesNotThrow(()=>again.requireIdle());
});
test('zero raw status after timeout stays timeout; losing an event can recover from a saved receipt',async t=>{
  const f=await fixture(t);await f.start();await f.shell.result({id,op:'no-event'});
  await f.upload(f.status({flags:1,raw:0,outputBytes:0}));
  assert.equal(f.shell.snapshot(id).status.outcome,'timeout');
  assert.equal(f.shell.snapshot(id).phase,'complete');assert.equal(f.reads.length,1);
  assert.equal(f.dispatched.filter(x=>x.bc_command==='nativeShellControl').length,1);
});
test('a sealed empty receipt finishes without reading output appended later by a detached task',async t=>{
  const f=await fixture(t);await f.start();
  const restarted=new NativeShell(f.options);await restarted.init();
  await restarted.reconcile(id);await f.upload(f.status({outputBytes:0}),restarted);
  assert.equal(restarted.snapshot(id).phase,'complete');
  assert.deepEqual(await restarted.output(id),Buffer.alloc(0));
  assert.equal(f.reads.length,1);assert.match(f.reads[0].name,/\.status$/);
  assert.equal(f.dispatched.filter(x=>x.bc_command==='nativeShellControl').length,1);
});
test('wrong command receipt and unconfirmed child block new executions without accepting output',async t=>{
  const f=await fixture(t);await f.start();await f.shell.result({id,op:'no-event'});
  await f.upload(f.status({crc:1}));assert.equal(f.shell.snapshot(id).phase,'unknown');assert.throws(()=>f.shell.requireIdle());
  await f.shell.reconcile(id);await f.upload(f.status({phase:1,wait:0}));assert.equal(f.shell.snapshot(id).phase,'unknown');
  assert.equal(f.reads.length,2);assert.equal(f.dispatched.filter(x=>x.bc_command==='nativeShellControl').length,1);
});
test('an unsubmitted restart is safely failed without dispatching exec',async t=>{
  const f=await fixture(t);await f.shell.start('echo test');
  const restarted=new NativeShell(f.options);await restarted.init();assert.equal(restarted.snapshot(id).phase,'failed');
  assert.equal(f.dispatched.length,0);
});
test('a lost output transfer resumes just that file from its validated receipt after restart',async t=>{
  const f=await fixture(t);await f.start();await f.shell.result({id,op:'no-event'});
  await f.upload(f.status());
  await f.shell.uploaded({id:f.reads.at(-1).id,phase:'error'});
  assert.equal(f.shell.snapshot(id).phase,'unknown');
  const restarted=new NativeShell(f.options);await restarted.init();
  const reads=f.reads.length;await restarted.reconcile(id);
  assert.equal(f.reads.length,reads+1);assert.match(f.reads.at(-1).name,/\.out$/);
  await f.upload(Buffer.from('test\n'),restarted);
  assert.equal(restarted.snapshot(id).phase,'complete');
  assert.deepEqual(await restarted.output(id),Buffer.from('test\n'));
  assert.equal(f.dispatched.filter(x=>x.bc_command==='nativeShellControl').length,1);
});
function events(retained) {
  const active=new Map(),published=[];let next=0;
  return {active,published,event:{subscribe(options){const n=++next;active.set(n,options);if(retained)options.callback(retained);return n;},
    unsubscribe({id}){active.delete(id);},publish(value){if([...active.values()].some(o=>o.eventName===value.eventName))published.push(value);}},
    emit(value){for(const o of [...active.values()])o.callback(value);}};
}
test('RPK shell uses the exact namespace/UUID and ignores unrelated or malformed native responses',async()=>{
  const f=events(),request=createNativeShellRequest({event:f.event,id});
  assert.deepEqual(f.published[0],{eventName:'bc.shell.req',options:{params:{v:1,op:'exec',id},permissions:['dev.bandcodex.remote']}});
  const params={v:1,op:'done',id,r:0,f:0,b:0,e:0};
  f.emit({package:'dev.bandcodex.native',params});f.emit({package:'dev.bandcodex.shell',params:{...params,id:'wrong'}});
  f.emit({package:'dev.bandcodex.shell',params:{...params,b:32769}});assert.equal(f.active.size,2);
  f.emit({package:'dev.bandcodex.shell',params});assert.equal((await request.done).op,'done');assert.equal(f.active.size,0);
});
test('a retained shell receipt releases its subscription without publishing an exec again',async()=>{
  const f=events({package:'dev.bandcodex.shell',params:{v:1,op:'done',id,r:0,f:128,b:0,e:0}});
  assert.equal((await createNativeShellRequest({event:f.event,id}).done).f,128);
  assert.equal(f.active.size,0);assert.equal(f.published.length,0);
});
test('invalid shell requests never subscribe or publish; cancelling releases a valid request',async()=>{
  const f=events();await assert.rejects(createNativeShellRequest({event:f.event,id:'../../bad'}).done);
  assert.equal(f.active.size,0);assert.equal(f.published.length,0);
  const request=createNativeShellRequest({event:f.event,id});const rejected=assert.rejects(request.done,/closed/);request.cancel();await rejected;
  assert.equal(f.active.size,0);assert.equal(f.published.length,1);
});
