import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BlobStore } from '../bridge/blob-store.mjs';
import { crc32, encode64, decode64, uploadBlob } from '../band/src/common/bytes.mjs';
import { runFileProbe } from '../band/src/common/file-probe.mjs';
import { AstroRelay } from '../bridge/astro-server.mjs';

async function store(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'band-blob-'));
  const receiver = new BlobStore({ root, ...options }); await receiver.init();
  t.after(async () => { await receiver.close(); await rm(root, { recursive: true, force: true }); });
  return { root, receiver };
}
const id = 'test-transfer-001';
const openFrame = bytes => ({ t: 'open', id, name: 'test.bin', size: bytes.length, crc: crc32(bytes) });
const chunk = (bytes, seq = 0) => ({ t: 'chunk', id, seq, b64: encode64(bytes), crc: crc32(bytes) });

test('binary helpers preserve all byte values and agree with standard base64 and CRC vectors', () => {
  const bytes = Uint8Array.from({ length: 1027 }, (_, i) => i & 255);
  assert.equal(encode64(bytes), Buffer.from(bytes).toString('base64'));
  assert.deepEqual(decode64(encode64(bytes)), bytes);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(bytes), crc32(bytes.subarray(512), crc32(bytes.subarray(0,512))));
  for (const value of ['AB==', 'a', '@@@@', 'YWJj\n']) assert.throws(() => decode64(value));
  assert.throws(() => decode64(encode64(bytes), 1024), /limit/);
});

test('binary upload commits exact bytes and safely retries every accepted chunk', async t => {
  const { receiver, root } = await store(t);
  const bytes = Uint8Array.from({ length: 8195 }, (_, i) => (i * 73 + 19) & 255);
  const result = await uploadBlob(bytes, { id, name: 'arbitrary.data', rpc: async frame => {
    const first = await receiver.frame(frame);
    assert.deepEqual(await receiver.frame(frame), first); // Lost-ACK retry.
    return first;
  } });
  assert.equal(result.state, 'complete');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(join(root,id+'.bin')), Buffer.from(bytes));
  assert.equal(JSON.parse(await readFile(join(root,id+'.json'),'utf8')).name, 'arbitrary.data');
});

test('negotiated 1024-byte uploads preserve the short tail and duplicate acknowledgements',async t=>{
  const {receiver,root}=await store(t);
  const bytes=Uint8Array.from({length:8195},(_,i)=>(i*109+7)&255),lengths=[];
  const result=await uploadBlob(bytes,{id,name:'large-frames.bin',chunkBytes:1024,rpc:async frame=>{
    if(frame.t==='chunk')lengths.push(decode64(frame.b64).length);
    const accepted=await receiver.frame(frame);assert.deepEqual(await receiver.frame(frame),accepted);return accepted;
  }});
  assert.equal(result.chunkBytes,1024);assert.deepEqual(lengths,[1024,1024,1024,1024,1024,1024,1024,1024,3]);
  assert.deepEqual(await readFile(join(root,id+'.bin')),Buffer.from(bytes));
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
});

test('an older or lower-capacity phone negotiates 128 bytes without changing resume offsets',async t=>{
  const {receiver,root}=await store(t,{maxChunkBytes:128});
  const bytes=Uint8Array.from({length:1027},(_,i)=>i&255),lengths=[];
  const result=await uploadBlob(bytes,{id,name:'compatible.bin',chunkBytes:1024,rpc:async frame=>{
    if(frame.t==='chunk')lengths.push(decode64(frame.b64).length);
    const reply=await receiver.frame(frame);
    // An old receiver has no chunkBytes property on its open response.
    if(frame.t==='open'){const {chunkBytes,...oldReply}=reply;return oldReply;}
    return reply;
  }});
  assert.equal(result.chunkBytes,128);assert.deepEqual(lengths,[128,128,128,128,128,128,128,128,3]);
  assert.deepEqual(await readFile(join(root,id+'.bin')),Buffer.from(bytes));
});

test('negotiation cannot enlarge an unsupported request or change an existing transfer stride',async t=>{
  let calls=0;
  await assert.rejects(uploadBlob(new Uint8Array(2),{id,name:'bad.bin',chunkBytes:512,rpc:async()=>{calls++;}}),/Unsupported/);
  assert.equal(calls,0);
  for(const offered of [256,1024])await assert.rejects(uploadBlob(new Uint8Array(2),{id,name:'bad.bin',rpc:async frame=>{
    assert.equal(frame.t,'open');return {state:'receiving',next:0,chunkBytes:offered};
  }}),/negotiated/);
  const {receiver}=await store(t);const bytes=new Uint8Array(1027).fill(7);
  await assert.rejects(receiver.frame({...openFrame(bytes),chunkBytes:512}),/metadata/);
  await receiver.frame({...openFrame(bytes),chunkBytes:1024});
  await assert.rejects(receiver.frame(openFrame(bytes)),/reused/);
  await assert.rejects(receiver.frame(chunk(bytes.subarray(0,1023))),/length/);
  await assert.rejects(receiver.frame(chunk(bytes.subarray(0,1025))),/limit/);
  await receiver.frame(chunk(bytes.subarray(0,1024)));await receiver.frame(chunk(bytes.subarray(1024),1));
  assert.equal((await receiver.frame({t:'finish',id})).state,'complete');
});

test('bad checksum, changed retries, early commit, future chunks and id reuse cannot corrupt a transfer', async t => {
  const { receiver } = await store(t); const bytes = new Uint8Array(129).fill(7);
  await receiver.frame(openFrame(bytes));
  await assert.rejects(receiver.frame({ ...chunk(bytes.subarray(0,128)), crc: 1 }), /checksum/);
  await assert.rejects(receiver.frame(chunk(bytes.subarray(0,1), 1)), /out of order/);
  await assert.rejects(receiver.frame({ t: 'finish', id }), /incomplete/);
  await receiver.frame(chunk(bytes.subarray(0,128)));
  await assert.rejects(receiver.frame(chunk(new Uint8Array(128).fill(8))), /Conflicting/);
  await assert.rejects(receiver.frame({ ...openFrame(bytes), name: 'another.bin' }), /reused/);
  await receiver.frame(chunk(bytes.subarray(128),1));
  assert.equal((await receiver.frame({ t:'finish',id })).state, 'complete');
});

test('file ids, names, lengths and active transfer limits are enforced', async t => {
  const { receiver } = await store(t, { maxBytes: 1024, maxActive: 1 });
  const frame = openFrame(new Uint8Array(2));
  for (const change of [{ id:'../../escape' }, { name:'../outside' }, { size:1025 }, { crc:-1 }])
    await assert.rejects(receiver.frame({ ...frame, ...change }));
  await receiver.frame(frame);
  await assert.rejects(receiver.frame({ ...frame, id:'another-transfer' }), /active/);
  await receiver.frame({ t:'cancel', id });
  await assert.rejects(receiver.frame(chunk(new Uint8Array(2))), /closed/);
});

test('expiry closes partial files, and a completed id cannot overwrite data after receiver restart', async t => {
  let now = 0; const { receiver, root } = await store(t, { now: () => now });
  const bytes = new Uint8Array(5);
  await receiver.frame(openFrame(bytes)); now = 120001;
  await assert.rejects(receiver.frame(chunk(bytes)), /closed/);
  assert.equal(receiver.snapshot(id).state, 'expired');
  const other = 'finished-transfer';
  await uploadBlob(bytes, { id: other, name:'file.bin', rpc: f => receiver.frame(f) });
  const restarted = new BlobStore({ root }); await restarted.init();
  try { await assert.rejects(restarted.frame({ ...openFrame(bytes), id:other }), /already exists/); }
  finally { await restarted.close(); }
});

test('empty binary files commit and cancellation does not publish a partial file', async t => {
  const { receiver, root } = await store(t);
  assert.equal((await uploadBlob(new Uint8Array(0), { id, name:'empty.bin', rpc:f => receiver.frame(f) })).size, 0);
  assert.equal((await readFile(join(root,id+'.bin'))).length, 0);
  await assert.rejects(uploadBlob(new Uint8Array(256), { id:'cancel-transfer', name:'cancel.bin',
    rpc:f => receiver.frame(f), cancelled:() => true }), /cancelled/);
  await assert.rejects(readFile(join(root,'cancel-transfer.bin')), { code:'ENOENT' });
});

test('RPK probe writes and reads a private file, receives its event, and returns exact bytes through the relay', async t => {
  const { receiver } = await store(t);
  const relay = new AstroRelay({}); relay.blobs = receiver; relay.connected = true; relay.lastSeen = Date.now();
  relay.startFileProbe(4096,1024); const command = relay.events[0].data;
  const files = new Map(); let handler; let unsubscribed = false; let counter = 0;
  const file = {
    writeArrayBuffer({uri,buffer,success}) { assert.ok(uri.startsWith('internal://cache/bc-probe-')); files.set(uri,new Uint8Array(buffer)); success(); },
    readArrayBuffer({uri,success}) { success({ buffer:files.get(uri) }); },
    delete({uri,success}) { files.delete(uri); success(); }
  };
  const event = {
    subscribe({callback}) { handler = callback; return 17; },
    publish({options}) { handler({ package:'dev.bandcodex.remote', params:options.params }); },
    unsubscribe({id}) { assert.equal(id,17); unsubscribed = true; }
  };
  const result = await runFileProbe({ file, event, command, rpc: async (method,params) => {
    const response = await relay.rpc({ id:'aux-'+(++counter), method, params });
    if (response.error) throw new Error(response.error); return response.result;
  } });
  assert.equal(result.verified, true); assert.equal(result.bytes,4096); assert.equal(result.eventLoopback,true);
  assert.equal(relay.fileProbe.receivedChunkBytes,1024);
  assert.equal(result.uploadChunkBytesVerified,true);
  assert.equal(relay.fileProbe.phase,'complete'); assert.equal(files.size,0); assert.equal(unsubscribed,true);
  assert.equal([...relay.requests.values()].some(v => v.method === 'blob.frame'),false);
});

test('a timed-out probe expires without blocking a fresh probe or permitting a stale result', async t => {
  const { receiver } = await store(t); const relay = new AstroRelay({}); relay.blobs = receiver;
  relay.connected = true; relay.lastSeen = Date.now(); relay.startFileProbe(64);
  const old = relay.fileProbe.id; relay.fileProbe.startedAt -= 30001;
  relay.expireFileProbe(); assert.equal(relay.fileProbe.phase,'error');
  relay.startFileProbe(64); assert.notEqual(relay.fileProbe.id,old);
  await assert.rejects(relay.handle({ method:'capabilities.report',params:{id:old,fileReadWrite:true} }),/Unknown/);
});

test('native-only relay rejects old recorder start without calling its recording controller', async () => {
  const relay = new AstroRelay({}); relay.nativeOnly = true;
  relay.recording = { handle() { throw new Error('legacy recorder must not run'); } };
  const result = await relay.rpc({ id:'native-only-check', method:'recording.arm', params:{} });
  assert.match(result.error,/原生录音接口/); assert.equal(relay.restoreRecording(),false);
});
