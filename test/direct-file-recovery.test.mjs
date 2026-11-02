import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileCommandStore} from '../bridge/bluetooth/file-command-store.mjs';
import {FileDeliveries} from '../bridge/file-delivery.mjs';

test('transport restart reoffers only an active data transfer, with no executable controls or content persisted',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'band-file-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'files.json'),files=new FileDeliveries(),receipt=files.start(new Uint8Array(8195),'data.bin',1024);
  const command={bc_command:'fileReceive',transferId:receipt.id,size:receipt.size,crc:receipt.crc,chunkBytes:1024};
  const store=new FileCommandStore(path);await store.load();await store.remember('epoch',{...command,rawAudio:'PRIVATE',command:'reboot'});
  await store.remember('epoch',{bc_command:'nativeShellControl',requestId:'do-not-store',command:'reboot'});
  const text=await readFile(path,'utf8');assert.ok(!text.includes('PRIVATE')&&!text.includes('reboot')&&!text.includes('nativeShellControl'));
  assert.equal((await stat(path)).mode&0o777,0o600);
  const next=new FileCommandStore(path);await next.load();const sent=[];
  const query=async()=>files.snapshot(receipt.id);
  assert.equal(await next.recover('epoch',{query,send:async value=>sent.push(value),force:true}),1);
  assert.deepEqual(sent,[{...command,resumable:true}]);
  await next.recover('new-epoch',{query,send:()=>assert.fail('Old relay transfer replayed'),force:true});
  assert.equal(next.items.length,0);
});

test('stalled file reoffers are bounded and progress suppresses them; failed data writes remain recoverable',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'band-file-stall-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let now=0;const path=join(dir,'files.json'),store=new FileCommandStore(path,{now:()=>now});
  const files=new FileDeliveries(),receipt=files.start(new Uint8Array(8195),'data.bin',1024);
  await store.remember('e',{bc_command:'fileReceive',transferId:receipt.id,size:receipt.size,crc:receipt.crc,chunkBytes:1024});
  const query=async()=>files.snapshot(receipt.id);let sent=0;const send=async()=>{sent++;};
  await store.recover('e',{query,send,force:true});assert.equal(sent,1);
  now=9999;await store.recover('e',{query,send});assert.equal(sent,1);
  now=10000;await store.recover('e',{query,send});assert.equal(sent,2);
  files.frame({id:receipt.id,seq:0,chunkBytes:1024});now=11000;await store.recover('e',{query,send});
  now=20000;await store.recover('e',{query,send});assert.equal(sent,2);
  now=21000;await assert.rejects(store.recover('e',{query,send:async()=>{throw new Error('lost socket');}}),/lost socket/);
  const next=new FileCommandStore(path,{now:()=>now});await next.load();
  assert.equal(await next.recover('e',{query,send,force:true}),1);assert.equal(sent,3);
  files.finish({id:receipt.id,error:'Cancelled'});
  await next.recover('e',{query,send:()=>assert.fail('Cancelled file reoffered'),force:true});assert.equal(next.items.length,0);
});
