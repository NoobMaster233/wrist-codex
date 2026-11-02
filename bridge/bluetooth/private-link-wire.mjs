import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {crc32} from '../../band/src/common/bytes.mjs';

export const PRIVATE_UUID='4aac2058-2595-47b8-b8c7-229f6d3d98de';
export const MAX_PRIVATE_PAYLOAD=32768;
export const LinkType=Object.freeze({HELLO:1,CHALLENGE:2,AUTH:3,READY:4,JSON:5,ACK:6,PING:7,PONG:8,ERROR:9,STOP:10,MANAGEMENT:11,MANAGEMENT_REPLY:12});
export function privateFrame(type,sequence,payload=Buffer.alloc(0)) {
  if(!Number.isInteger(type)||type<1||type>12||!Number.isInteger(sequence)||sequence<0||sequence>0xffffffff||
     !Buffer.isBuffer(payload)||payload.length>MAX_PRIVATE_PAYLOAD)throw new Error('Invalid private frame');
  const frame=Buffer.alloc(16+payload.length);frame.write('BCP1',0,'ascii');frame[4]=type;
  frame.writeUInt16LE(payload.length,6);frame.writeUInt32LE(sequence,8);payload.copy(frame,16);
  frame.writeUInt32LE(crc32(payload,crc32(frame.subarray(0,12))),12);return frame;
}
export class PrivateFrameDecoder {
  constructor(){this.pending=Buffer.alloc(0);}
  push(bytes) {
    if(!Buffer.isBuffer(bytes)||bytes.length>65536)throw new Error('Invalid private input chunk');
    const frames=[];let input=bytes;
    // Consume a bounded frame at a time even when one input contains many.
    while(input.length) {
      const needed=this.pending.length<16?16-this.pending.length:16+this.pending.readUInt16LE(6)-this.pending.length;
      const take=Math.min(needed,input.length);this.pending=Buffer.concat([this.pending,input.subarray(0,take)]);input=input.subarray(take);
      if(this.pending.length<16)continue;
      const header=this.pending;
      if(header.toString('ascii',0,4)!=='BCP1'||header[4]<1||header[4]>12||header[5]||header.readUInt16LE(6)>MAX_PRIVATE_PAYLOAD)
        throw new Error('Invalid private frame header');
      const length=16+header.readUInt16LE(6);if(header.length<length)continue;
      const payload=header.subarray(16);
      if(header.readUInt32LE(12)!==crc32(payload,crc32(header.subarray(0,12))))throw new Error('Private frame CRC mismatch');
      frames.push({type:header[4],sequence:header.readUInt32LE(8),payload});this.pending=Buffer.alloc(0);
    }
    return frames;
  }
}
export function privateProof(key,label,clientNonce,serverNonce) {
  if(!Buffer.isBuffer(key)||key.length!==32||!['server','client'].includes(label)||
     !Buffer.isBuffer(clientNonce)||clientNonce.length!==16||!Buffer.isBuffer(serverNonce)||serverNonce.length!==16)
    throw new Error('Invalid private authentication material');
  return createHmac('sha256',key).update('BCP1/'+label,'ascii').update(clientNonce).update(serverNonce).digest();
}
export class PrivateAuthSession {
  constructor(key,nonce=randomBytes(16)) {
    if(!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(nonce)||nonce.length!==16)throw new Error('Invalid private key');
    this.key=Buffer.from(key);this.clientNonce=Buffer.from(nonce);this.phase='new';
  }
  start(){if(this.phase!=='new')throw new Error('Private auth already started');this.phase='hello';return privateFrame(LinkType.HELLO,0,this.clientNonce);}
  challenge(packet) {
    if(this.phase!=='hello'||packet.type!==LinkType.CHALLENGE||packet.sequence||packet.payload.length!==48)throw new Error('Invalid private challenge');
    const nonce=packet.payload.subarray(0,16),proof=privateProof(this.key,'server',this.clientNonce,nonce);
    if(!timingSafeEqual(proof,packet.payload.subarray(16)))throw new Error('Private server authentication failed');
    this.serverNonce=Buffer.from(nonce);this.session=proof.readUInt32LE(0);this.phase='auth';
    return privateFrame(LinkType.AUTH,0,privateProof(this.key,'client',this.clientNonce,nonce));
  }
  ready(packet) {
    if(this.phase!=='auth'||packet.type!==LinkType.READY||packet.sequence||packet.payload.length!==12||
       packet.payload.readUInt32LE(0)!==this.session||![1,2].includes(packet.payload.readUInt32LE(4))||packet.payload.readUInt32LE(8)!==MAX_PRIVATE_PAYLOAD)
      throw new Error('Invalid private ready');
    this.phase='ready';return {session:this.session,maxPayload:MAX_PRIVATE_PAYLOAD,protocolVersion:packet.payload.readUInt32LE(4)};
  }
}
