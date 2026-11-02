import test from 'node:test';
import assert from 'node:assert/strict';
import { FileDeliveries } from '../bridge/file-delivery.mjs';
import { receiveFile } from '../band/src/common/file-receive.mjs';
import { crc32 } from '../band/src/common/bytes.mjs';

function memoryFile({corruptRead=false,metadataLength,nativeBackingBuffer=true}={}) {
  const data=new Map();
  return {data,file:{
    writeArrayBuffer({uri,buffer,append,success}) {
      if(nativeBackingBuffer)buffer=new Uint8Array(buffer.buffer);
      const prior=append?data.get(uri)||new Uint8Array():new Uint8Array();
      const next=new Uint8Array(prior.length+buffer.length);next.set(prior);next.set(buffer,prior.length);data.set(uri,next);success({});
    },
    writeText({uri,text,success}) {data.set(uri,new TextEncoder().encode(text));success({});},
    readArrayBuffer({uri,position,length,success}) {
      const buffer=data.get(uri).slice(position,position+length);
      if((corruptRead===true||(corruptRead==='committed'&&uri.startsWith('internal://files/')))&&buffer.length)buffer[0]^=1;
      success({buffer});
    },
    move({srcUri,dstUri,success}) {assert.ok(data.has(srcUri));data.set(dstUri,data.get(srcUri));data.delete(srcUri);success(dstUri);},
    get({uri,success}) {success({uri,length:metadataLength??data.get(uri).length,type:'file'});},
    delete({uri,success}) {data.delete(uri);success({});}
  }};
}

for(const chunkBytes of [128,1024,4096])test('binary file readback and lost-ACK retry with chunk bytes '+chunkBytes,async()=>{
  const store=new FileDeliveries(),bytes=Uint8Array.from({length:8195},(_,i)=>(i*109+7)&255);
  const meta=store.start(bytes,'任意数据.dat',chunkBytes),fs=memoryFile();let lost=true;
  const result=await receiveFile({file:fs.file,command:{transferId:meta.id,size:meta.size,crc:meta.crc,chunkBytes},rpc:async(method,p)=>{
    if(method==='files.pull')return store.frame(p);
    const result=store.finish(p);
    if(lost&&result.state==='complete'){lost=false;throw new Error('Phone request timed out');}
    return result;
  }});
  assert.equal(result.state,'complete');assert.equal(result.name,'任意数据.dat');
  assert.equal(fs.data.size,1);assert.deepEqual([...fs.data.values()][0],bytes);
  assert.equal(result.crc,crc32(bytes));assert.equal(store.jobs.get(meta.id).data,null);
});

test('matching prefix bytes cannot hide an excess file tail',async()=>{
  const store=new FileDeliveries(),bytes=new Uint8Array([0,255,12]),meta=store.start(bytes,'metadata.dat');
  const fs=memoryFile({metadataLength:4096});
  await assert.rejects(receiveFile({file:fs.file,command:{transferId:meta.id,size:meta.size,crc:meta.crc},
    rpc:async(method,p)=>method==='files.pull'?store.frame(p):store.finish(p)}),/file length differs/);
  assert.equal(store.snapshot(meta.id).state,'error');assert.equal(fs.data.size,0);
});

for(const corruptRead of [true,'committed'])test('corrupt persisted bytes cannot be confirmed: '+corruptRead,async()=>{
  const store=new FileDeliveries(),meta=store.start(new Uint8Array([0,255,1]),'payload.bin'),fs=memoryFile({corruptRead});
  await assert.rejects(receiveFile({file:fs.file,command:{transferId:meta.id,size:meta.size,crc:meta.crc},
    rpc:async(method,p)=>method==='files.pull'?store.frame(p):store.finish(p)}),/readback checksum/);
  assert.equal(fs.data.size,0);assert.equal(store.snapshot(meta.id).state,'error');
});

test('empty files commit, and cancellation before writing leaves no staged file',async()=>{
  const store=new FileDeliveries(),meta=store.start(new Uint8Array(),'empty.txt'),fs=memoryFile();
  const result=await receiveFile({file:fs.file,command:{transferId:meta.id,size:0,crc:0},rpc:async(_,p)=>store.finish(p)});
  assert.equal(result.state,'complete');assert.equal(fs.data.get(result.uri).length,0);
  const next=store.start(new Uint8Array([1,2]),'next.dat');
  await assert.rejects(receiveFile({file:fs.file,command:{transferId:next.id,size:2,crc:next.crc},alive:()=>false,
    rpc:async(method,p)=>method==='files.pull'?store.frame(p):store.finish(p)}),/cancelled/);
  assert.equal(fs.data.size,1);assert.equal(store.snapshot(next.id).state,'error');
});

test('delivery bounds, names, receipt paths, replays and inactivity expiry are enforced',()=>{
  let now=0;const store=new FileDeliveries({now:()=>now,maxBytes:256});
  assert.throws(()=>store.start(new Uint8Array(257),'large.bin'),/limit/);
  for(const name of ['../system','a/b','a\\b','\0'])assert.throws(()=>store.start(new Uint8Array([1]),name),/filename/);
  const meta=store.start(new Uint8Array([1,2,3]),'ok.bin');
  assert.throws(()=>store.start(new Uint8Array(),'busy'),/正在/);
  assert.deepEqual(store.frame({id:meta.id,seq:0}),store.frame({id:meta.id,seq:0}));
  assert.throws(()=>store.finish({id:meta.id,size:3,crc:meta.crc,uri:'internal://files/other'}),/differs/);
  now=60001;assert.equal(store.snapshot(meta.id).state,'error');assert.equal(store.jobs.get(meta.id).data,null);
  assert.throws(()=>store.frame({id:meta.id,seq:0}),/expired/);
});

test('a new RPK page resumes persisted blocks under the same transfer and verifies the whole file',async()=>{
  const store=new FileDeliveries(),bytes=Uint8Array.from({length:16387},(_,i)=>(i*17+(i>>8))&255);
  const meta=store.start(bytes,'resume.bin',1024),fs=memoryFile();let alive=true;
  const command={transferId:meta.id,size:meta.size,crc:meta.crc,chunkBytes:1024,resumable:true};
  const rpc=async(method,p)=>method==='files.pull'?store.frame(p):store.finish(p);
  await assert.rejects(receiveFile({file:fs.file,command,rpc,alive:()=>alive,progress:count=>{if(count>=8192)alive=false;}}),/cancelled/);
  assert.equal(store.snapshot(meta.id).state,'sending');
  assert.equal(fs.data.get('internal://files/bc-'+meta.id+'.part').length,8192);
  const sequences=[];
  const result=await receiveFile({file:fs.file,command,rpc:async(method,p)=>{
    if(method==='files.pull')sequences.push(p.seq);return rpc(method,p);
  }});
  assert.equal(sequences[0],8);assert.equal(result.state,'complete');assert.equal(fs.data.size,1);
  assert.deepEqual(fs.data.get(result.uri),bytes);
});

test('a persisted final file with lost receipt survives a new page without another download',async()=>{
  const store=new FileDeliveries(),bytes=new Uint8Array([1,2,3]),meta=store.start(bytes,'final.bin',1024),fs=memoryFile();
  const command={transferId:meta.id,size:meta.size,crc:meta.crc,chunkBytes:1024,resumable:true};
  await assert.rejects(receiveFile({file:fs.file,command,rpc:async(method,p)=>{
    if(method==='files.pull')return store.frame(p);store.finish(p);throw new Error('App closed');
  }}),/App closed/);
  const result=await receiveFile({file:fs.file,command,rpc:async(method,p)=>{
    assert.equal(method,'files.received');return store.finish(p);
  }});
  assert.equal(result.state,'complete');assert.deepEqual(fs.data.get(result.uri),bytes);
});

test('corrupted persisted partial data cannot become a confirmed resumed file',async()=>{
  const store=new FileDeliveries(),bytes=new Uint8Array(8195).fill(23),meta=store.start(bytes,'corrupt-resume.bin',1024),fs=memoryFile();
  const command={transferId:meta.id,size:meta.size,crc:meta.crc,chunkBytes:1024,resumable:true};let alive=true;
  const rpc=async(method,p)=>method==='files.pull'?store.frame(p):store.finish(p);
  await assert.rejects(receiveFile({file:fs.file,command,rpc,alive:()=>alive,progress:()=>{alive=false;}}),/cancelled/);
  fs.data.get('internal://files/bc-'+meta.id+'.part')[0]^=1;
  await assert.rejects(receiveFile({file:fs.file,command,rpc}),/checksum differs/);
  assert.equal(store.snapshot(meta.id).state,'error');assert.equal(fs.data.size,0);
});
