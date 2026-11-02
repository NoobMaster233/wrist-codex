import test from 'node:test';
import assert from 'node:assert/strict';
import {PrivateFrameDecoder,PrivateAuthSession,LinkType,privateFrame,privateProof} from '../bridge/bluetooth/private-link-wire.mjs';

test('private wire decodes boundaries and multiple frames, rejects corrupt bytes',()=>{
  const payload=Buffer.alloc(32768);for(let i=0;i<payload.length;i++)payload[i]=i*37+11;
  const whole=privateFrame(LinkType.JSON,0xffffffff,payload);
  for(const step of [1,7,16,990,4096]) {
    const decoder=new PrivateFrameDecoder(),packets=[];
    for(let at=0;at<whole.length;at+=step)packets.push(...decoder.push(whole.subarray(at,at+step)));
    assert.equal(packets.length,1);assert.deepEqual(packets[0].payload,payload);assert.equal(packets[0].sequence,0xffffffff);
  }
  assert.equal(new PrivateFrameDecoder().push(Buffer.concat([privateFrame(LinkType.ACK,1),privateFrame(LinkType.ACK,2)])).length,2);
  const corrupt=Buffer.from(whole);corrupt[100]^=1;assert.throws(()=>new PrivateFrameDecoder().push(corrupt),/CRC/);
  const oversized=Buffer.from(whole.subarray(0,16));oversized.writeUInt16LE(32769,6);assert.throws(()=>new PrivateFrameDecoder().push(oversized),/header/);
});
test('private mutual authentication checks the server proof, session and state',()=>{
  const key=Buffer.alloc(32,0x42),clientNonce=Buffer.alloc(16,0x17),serverNonce=Buffer.alloc(16,0x29);
  const auth=new PrivateAuthSession(key,clientNonce);assert.equal(new PrivateFrameDecoder().push(auth.start())[0].type,LinkType.HELLO);
  const server=privateProof(key,'server',clientNonce,serverNonce),challenge={type:LinkType.CHALLENGE,sequence:0,payload:Buffer.concat([serverNonce,server])};
  const response=new PrivateFrameDecoder().push(auth.challenge(challenge))[0];
  assert.deepEqual(response.payload,privateProof(key,'client',clientNonce,serverNonce));
  const ready=Buffer.alloc(12);ready.writeUInt32LE(server.readUInt32LE(0),0);ready.writeUInt32LE(1,4);ready.writeUInt32LE(32768,8);
  assert.equal(auth.ready({type:LinkType.READY,sequence:0,payload:ready}).maxPayload,32768);
  assert.throws(()=>auth.start(),/already/);
  const wrong=new PrivateAuthSession(Buffer.alloc(32),clientNonce);wrong.start();assert.throws(()=>wrong.challenge(challenge),/authentication/);
});
test('native management requires an authenticated version-two READY and keeps old peers compatible',()=>{
 const key=Buffer.alloc(32,2),nonce=Buffer.alloc(16,3),serverNonce=Buffer.alloc(16,4);
 const auth=new PrivateAuthSession(key,nonce);auth.start();
 const proof=privateProof(key,'server',nonce,serverNonce);
 auth.challenge({type:LinkType.CHALLENGE,sequence:0,payload:Buffer.concat([serverNonce,proof])});
 const ready=Buffer.alloc(12);ready.writeUInt32LE(proof.readUInt32LE(0));ready.writeUInt32LE(2,4);ready.writeUInt32LE(32768,8);
 assert.equal(auth.ready({type:LinkType.READY,sequence:0,payload:ready}).protocolVersion,2);
 const frame=privateFrame(LinkType.MANAGEMENT,7,Buffer.from('BCM1'));
 assert.equal(new PrivateFrameDecoder().push(frame)[0].type,11);
 assert.throws(()=>privateFrame(13,1),/Invalid/);
});
