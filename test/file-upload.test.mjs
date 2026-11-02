import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BlobStore} from '../bridge/blob-store.mjs';
import {AstroRelay} from '../bridge/astro-server.mjs';
import {sendOwnFile,ownFileName} from '../band/src/common/file-upload.mjs';

async function setup(t,bytes,{mutate=false,badRead=false}={}){
  const root=await mkdtemp(join(tmpdir(),'band-existing-file-'));
  const blobs=new BlobStore({root});await blobs.init();
  t.after(async()=>{await blobs.close();await rm(root,{recursive:true,force:true});});
  const relay=new AstroRelay({});relay.blobs=blobs;relay.connected=true;relay.lastSeen=Date.now();
  const job=relay.startFileUpload('existing.bin');const command=relay.events[0].data;const reads=[];
  let read=0;
  const file={get(o){assert.equal(o.uri,'internal://files/existing.bin');o.success({length:bytes.length});},
    readArrayBuffer(o){reads.push([o.position,o.length]);
      const data=bytes.slice(o.position,o.position+o.length);++read;
      if(mutate&&read>Math.ceil(bytes.length/4096)&&data.length)data[0]^=1;
      o.success({buffer:badRead?data.subarray(0,data.length-1):data});
    }};
  const rpc=(method,params)=>relay.handle({method,params});
  return {root,blobs,relay,job,command,file,rpc,reads};
}
test('existing file uses bounded two-pass reads and commits the exact short tail',async t=>{
  const bytes=Uint8Array.from({length:16387},(_,i)=>i*17&255);
  const s=await setup(t,bytes);const done=await sendOwnFile(s);
  assert.equal(done.phase,'complete');assert.equal(done.size,bytes.length);
  assert.deepEqual(await readFile(join(s.root,s.job.id+'.bin')),Buffer.from(bytes));
  assert.ok(s.reads.every(([,length])=>length<=4096));assert.equal(s.reads.at(-1)[1],3);
  assert.equal(done.received.chunkBytes,1024);
});
test('changed bytes between file passes cannot produce a successful receipt',async t=>{
  const s=await setup(t,new Uint8Array(8195).fill(42),{mutate:true});
  await assert.rejects(sendOwnFile(s),/checksum/);
  assert.equal(s.relay.fileUploadStatus(s.job.id).phase,'error');
  assert.equal(s.blobs.snapshot(s.job.id).state,'error');
});
test('zero-size files work, truncated reads fail and cancellation leaves no success',async t=>{
  const s=await setup(t,new Uint8Array(0));assert.equal((await sendOwnFile(s)).phase,'complete');
  const short=await setup(t,new Uint8Array(1),{badRead:true});
  await assert.rejects(sendOwnFile(short),/length/);assert.equal(short.relay.fileUpload.phase,'error');
  const cancel=await setup(t,new Uint8Array(8195));let running=true;
  await assert.rejects(sendOwnFile({...cancel,alive:()=>running,progress:()=>{running=false;}}),/cancelled/);
  assert.equal(cancel.relay.fileUpload.phase,'error');
});
test('private namespace, length limits and task exclusion apply before file access',async t=>{
  for(const name of ['../file','/data/secret','a/b','a\\b','.','..','a'.repeat(81),''])assert.throws(()=>ownFileName(name));
  const s=await setup(t,new Uint8Array(1));
  for(const start of [()=>s.relay.startFileUpload('second.bin'),()=>s.relay.startFileProbe(),()=>s.relay.startFileDelivery(new Uint8Array(1),'x'),()=>s.relay.startNativeProbe()])assert.throws(start);
  await assert.rejects(sendOwnFile({...s,file:{get(o){o.success({length:1048577});}}}),/limit/);
  assert.equal(s.relay.fileUpload.phase,'error');
});

test('a new RPK page resumes phone-side blocks after a resumable file upload is interrupted',async t=>{
  const bytes=Uint8Array.from({length:16387},(_,i)=>(i*31+(i>>8))&255),s=await setup(t,bytes);
  s.command={...s.command,resumable:true};let alive=true;
  await assert.rejects(sendOwnFile({...s,alive:()=>alive,progress:count=>{if(count>=4096)alive=false;}}),/cancelled/);
  assert.equal(s.blobs.snapshot(s.job.id).state,'receiving');assert.equal(s.blobs.snapshot(s.job.id).next,4);
  assert.equal(s.relay.fileUploadStatus(s.job.id).phase,'pending');
  const sequences=[],rpc=async(method,p)=>{
    if(method==='blob.frame'&&p.t==='chunk')sequences.push(p.seq);return s.rpc(method,p);
  };
  const result=await sendOwnFile({...s,rpc});assert.equal(result.phase,'complete');assert.equal(sequences[0],4);
  assert.deepEqual(await readFile(join(s.root,s.job.id+'.bin')),Buffer.from(bytes));
});
