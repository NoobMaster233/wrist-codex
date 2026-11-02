import test from 'node:test';
import assert from 'node:assert/strict';
import {crc16Arc,frame,startRequest,FrameDecoder,receiveWindow} from '../bridge/bluetooth/l1.mjs';
import {fields,appListResponse} from '../bridge/bluetooth/protobuf.mjs';

test('L1 CRC reference vector and every stream split preserve frames; invalid CRC and lengths fail',()=>{
  assert.equal(crc16Arc(Buffer.from('123456789')),0xbb3d);
  const packet=frame(3,255,Buffer.from([1,1,8,20,16,0]));
  for(let i=0;i<=packet.length;i++) {
    const decoder=new FrameDecoder();
    const decoded=[...decoder.push(packet.subarray(0,i)),...decoder.push(packet.subarray(i))];
    assert.equal(decoded.length,1);assert.equal(decoded[0].seq,255);assert.deepEqual(decoded[0].payload,packet.subarray(8));
  }
  const two=new FrameDecoder().push(Buffer.concat([packet,packet]));assert.equal(two.length,2);
  const corrupt=Buffer.from(packet);corrupt[8]^=1;
  assert.throws(()=>new FrameDecoder().push(corrupt),/CRC/);
  const oversized=Buffer.from(packet);oversized.writeUInt16LE(65535,4);
  assert.throws(()=>new FrameDecoder().push(oversized),/header/);
  const start=new FrameDecoder().push(startRequest())[0];
  assert.equal(start.type,2);assert.equal(start.payload.toString('hex'),'0101030001000002020000fc03020020000402001027');
});
test('application parser distinguishes empty list, wrong response, encryption and malformed protobuf',()=>{
  const response=Buffer.from([1,1,8,20,16,0,178,1,2,10,0]);
  assert.deepEqual(appListResponse(response),[]);
  assert.equal(appListResponse(Buffer.from([1,1,8,4,16,0])),null);
  assert.throws(()=>appListResponse(Buffer.from([1,2,0])),/authentication/);
  for(const invalid of [[0],[8,128],[10,4,1],[9,0]])assert.throws(()=>fields(Buffer.from(invalid)));
  assert.throws(()=>fields(Buffer.from([8,...Array(10).fill(255)])),/Overflow/);
});
test('optional SPP prefix resynchronization is bounded and never conceals corruption after SAR startup',()=>{
  const packet=startRequest(),prefix=Buffer.from('badcfe00c00300000100ef','hex');
  for(let cut=0;cut<=prefix.length+packet.length;cut++) {
    const bytes=Buffer.concat([prefix,packet]),decoder=new FrameDecoder({preambleLimit:64});
    const result=[...decoder.push(bytes.subarray(0,cut)),...decoder.push(bytes.subarray(cut))];
    assert.equal(result.length,1);assert.equal(decoder.prefixBytesSkipped,prefix.length);
  }
  assert.throws(()=>new FrameDecoder().push(Buffer.concat([prefix,packet])),/magic/);
  assert.throws(()=>new FrameDecoder({preambleLimit:64}).push(Buffer.concat([Buffer.alloc(65),packet])),/magic/);
  const decoder=new FrameDecoder({preambleLimit:64});decoder.push(packet);
  assert.throws(()=>decoder.push(Buffer.concat([prefix,packet])),/magic/);
});
test('startup negotiation bounds batch size and rejects malformed configurations',()=>{
  assert.equal(receiveWindow(Buffer.from([2])),1);
  assert.equal(receiveWindow(Buffer.from([2,3,2,0,32,0])),8);
  assert.equal(receiveWindow(Buffer.from([2,3,2,0,4,0])),4);
  for(const bytes of [[1],[2,3],[2,3,2,0,0,0],[2,3,3,0,4,0]])
    assert.throws(()=>receiveWindow(Buffer.from(bytes)));
});
