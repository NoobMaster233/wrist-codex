import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneFrames,readAppPacket,basicInfo} from '../bridge/bluetooth/app-protocol.mjs';
import {pbBytes,wear} from '../bridge/bluetooth/protobuf.mjs';
import {DirectBand} from '../bridge/bluetooth/direct-band.mjs';
import {frame,FrameDecoder} from '../bridge/bluetooth/l1.mjs';

const app={packageName:'dev.bandcodex.remote',fingerprint:Buffer.alloc(32,7)};
test('phone fragments meet the actual RPK UTF-16 and UTF-8 bounds and reassemble escaped Unicode exactly',()=>{
  const content='汉字😀\\"\n\0'.repeat(400),message={id:'response-one',result:{content}};
  const chunks=phoneFrames(message).map(text=>{
    assert.ok(Buffer.byteLength(text)<=450);const part=JSON.parse(text);assert.ok(part.data.length<=200);return part;
  });
  assert.ok(chunks.length>1&&chunks.length<=512);
  assert.deepEqual(JSON.parse(chunks.map(part=>part.data).join('')),message);
  chunks.forEach((chunk,i)=>{assert.equal(chunk.part,i);assert.equal(chunk.total,chunks.length);});
  assert.match(JSON.parse(phoneFrames({bc_command:'test',data:content})[0]).id,/^command-/);
  assert.equal(JSON.parse(phoneFrames({event:'messages.updated',watchId:'w',sequence:1,data:content})[0]).id,'push-w-1');
  assert.throws(()=>phoneFrames({data:content}),/ID/);
});
test('App packet reader accepts the installed fingerprint and rejects other apps or mismatched identities',()=>{
  const content=JSON.stringify({id:'one',method:'projects.list',params:{}});
  const message=identity=>Buffer.concat([Buffer.from([1,1]),wear(20,9,22,pbBytes(9,Buffer.concat([
    pbBytes(1,identity),pbBytes(2,Buffer.from(content))])))]);
  assert.equal(readAppPacket(message(basicInfo(app)),app).data.method,'projects.list');
  assert.equal(readAppPacket(message(basicInfo({...app,fingerprint:Buffer.alloc(32,8)})),app),null);
  const other=Buffer.concat([pbBytes(1,Buffer.from('other.app')),pbBytes(2,app.fingerprint)]);
  assert.equal(readAppPacket(message(other),app),null);
  assert.throws(()=>basicInfo({...app,packageName:'other.app'}),/owned/);
});
test('direct transport acknowledges duplicates without delivering data twice, and serializes transmit sequence',async()=>{
  const band=new DirectBand('/unused');band.auth={decode:x=>x};const acks=[],packets=[];
  band.raw=bytes=>acks.push(new FrameDecoder().push(bytes)[0]);band.on('packet',packet=>packets.push(packet));
  band.accept(frame(3,0,Buffer.from([1,1])));band.accept(frame(3,0,Buffer.from([1,1])));
  assert.equal(packets.length,1);assert.deepEqual(acks.map(item=>item.seq),[0,0]);
  assert.throws(()=>band.accept(frame(3,2,Buffer.from([1,1]))),/sequence/);
  const sent=[];
  band.raw=bytes=>{const item=new FrameDecoder().push(bytes)[0];sent.push(item.seq);queueMicrotask(()=>band.emit('ack',item.seq));};
  await Promise.all([band.sendL2(Buffer.from([1])),band.sendL2(Buffer.from([2]))]);assert.deepEqual(sent,[0,1]);
  assert.equal(band.waiters.size,0);
});
test('failed direct write rejects pending waits and never retries the packet',async()=>{
  const band=new DirectBand('/unused');let writes=0;
  band.raw=()=>{writes++;throw new Error('fixture write failed');};
  await assert.rejects(band.sendL2(Buffer.from([1])),/write failed/);
  assert.equal(writes,1);assert.equal(band.waiters.size,0);
});
test('negotiated batch accepts only cumulative final ACK, including sequence wrap, without retransmission',async()=>{
  const band=new DirectBand('/unused');band.maxFlight=4;band.txSequence=254;
  const sent=[];band.raw=bytes=>{
    const item=new FrameDecoder().push(bytes)[0];sent.push(item.seq);
    if(item.seq===1)queueMicrotask(()=>band.emit('ack',1));
  };
  await band.sendL2Batch([1,2,3,4].map(n=>Buffer.from([n])));
  assert.deepEqual(sent,[254,255,0,1]);assert.equal(band.txSequence,2);assert.equal(band.waiters.size,0);
  await assert.rejects(band.sendL2Batch(Array(5).fill(Buffer.alloc(0))),/window/);
  assert.equal(sent.length,4);
});
