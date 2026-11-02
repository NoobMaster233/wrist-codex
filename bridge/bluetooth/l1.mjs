// SAR v2 wire layout from the pinned Astro Core primary source. No auth policy.
export function crc16Arc(bytes) {
  let crc=0;
  for(const value of bytes) {
    crc^=value;
    for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xa001:0);
  }
  return crc;
}
export function frame(type,seq,payload=Buffer.alloc(0)) {
  if(![0,1,2,3,19].includes(type)||!Number.isInteger(seq)||seq<0||seq>255||payload.length>64512)
    throw new Error('Invalid L1 packet');
  const result=Buffer.alloc(8+payload.length);
  result.writeUInt16LE(0xa5a5);result[2]=type;result[3]=seq;
  result.writeUInt16LE(payload.length,4);result.writeUInt16LE(crc16Arc(payload),6);payload.copy(result,8);
  return result;
}
export function startRequest() {
  return frame(2,0,Buffer.from([1,1,3,0,1,0,0,2,2,0,0,252,3,2,0,32,0,4,2,0,16,39]));
}
export function receiveWindow(payload) {
  if(payload[0]!==2)throw new Error('Not an L1 startup response');
  let window=1,offset=1;
  while(offset<payload.length) {
    if(payload.length-offset<3)throw new Error('Truncated L1 config');
    const key=payload[offset],length=payload.readUInt16LE(offset+1);offset+=3;
    if(length>payload.length-offset)throw new Error('Truncated L1 config value');
    if(key===3) {
      if(length!==2||payload.readUInt16LE(offset)===0)throw new Error('Invalid L1 receive window');
      window=Math.min(8,payload.readUInt16LE(offset));
    }
    offset+=length;
  }
  return window;
}
export class FrameDecoder {
  pending=Buffer.alloc(0);
  prefixBytesSkipped=0;
  started=false;
  constructor({preambleLimit=0}={}) {
    if(!Number.isInteger(preambleLimit)||preambleLimit<0||preambleLimit>64)throw new Error('Invalid L1 preamble limit');
    this.preambleLimit=preambleLimit;
  }
  push(chunk) {
    if(this.pending.length+chunk.length>130000)throw new Error('Excessive L1 input');
    const bytes=Buffer.concat([this.pending,chunk]),result=[];let offset=0;
    while(bytes.length-offset>=8) {
      if(bytes.readUInt16LE(offset)!==0xa5a5) {
        // Astro Core scans past the SPP sideband preamble. Permit only an
        // explicit bounded prefix before the first valid SAR frame.
        if(this.started||++this.prefixBytesSkipped>this.preambleLimit)throw new Error('Invalid L1 magic');
        offset++;continue;
      }
      const type=bytes[offset+2],seq=bytes[offset+3],length=bytes.readUInt16LE(offset+4);
      if((type&0xe0)||!([0,1,2,3].includes(type&15))||length>64512)throw new Error('Invalid L1 header');
      if(bytes.length-offset<8+length)break;
      const payload=Buffer.from(bytes.subarray(offset+8,offset+8+length));
      if(crc16Arc(payload)!==bytes.readUInt16LE(offset+6))throw new Error('Invalid L1 CRC');
      this.started=true;result.push({type:type&15,frx:!!(type&16),seq,payload});offset+=8+length;
    }
    this.pending=Buffer.from(bytes.subarray(offset));return result;
  }
}
