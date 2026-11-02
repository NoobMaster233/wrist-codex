import {createHash} from 'node:crypto';
import {fields,last,pbBytes,pbNumber,wear} from './protobuf.mjs';

const packageName='dev.bandcodex.remote';
export function basicInfo(app) {
  if(app.packageName!==packageName||!Buffer.isBuffer(app.fingerprint)||app.fingerprint.length<16||app.fingerprint.length>64)
    throw new Error('Expected installed owned App identity');
  return Buffer.concat([pbBytes(1,Buffer.from(packageName)),pbBytes(2,app.fingerprint)]);
}
export const launchApp=app=>wear(20,4,22,pbBytes(6,Buffer.concat([
  pbBytes(1,basicInfo(app)),pbBytes(2,Buffer.from('hap://app/dev.bandcodex.remote/pages/index'))])));
export const connectedStatus=app=>wear(20,7,22,pbBytes(8,Buffer.concat([pbBytes(1,basicInfo(app)),pbNumber(2,1)])));
export function phoneMessage(app,text) {
  if(Buffer.byteLength(text)>450)throw new Error('Phone message exceeds band frame bound');
  return wear(20,8,22,pbBytes(9,Buffer.concat([pbBytes(1,basicInfo(app)),pbBytes(2,Buffer.from(text))])));
}
export function readAppPacket(l2,app) {
  if(!app||l2[0]!==1||l2[1]!==1)return null;
  const top=fields(l2.subarray(2));if(last(top,1,0)?.number!==20n)return null;
  const body=last(top,22,2);if(!body)return null;
  const props=fields(body.data),id=last(top,2,0)?.number;
  let basic,content;
  if(id===6n)basic=last(props,5,2)?.data;
  else if(id===9n) {
    const message=last(props,9,2);if(!message)return null;
    const values=fields(message.data);basic=last(values,1,2)?.data;content=last(values,2,2)?.data;
  } else return null;
  if(!basic)return null;
  const identity=fields(basic),name=last(identity,1,2)?.data,fingerprint=last(identity,2,2)?.data;
  if(name?.toString('utf8')!==packageName||!fingerprint?.equals(app.fingerprint))return null;
  if(id===6n)return {kind:'status'};
  if(!content||content.length>32768)throw new Error('Invalid band App message length');
  return {kind:'message',data:JSON.parse(content.toString('utf8'))};
}
export function phoneFrames(message) {
  const text=JSON.stringify(message);if(Buffer.byteLength(text)>65536)throw new Error('Excessive phone JSON');
  if(Buffer.byteLength(text)<=450)return [text];
  let id=message.id;
  if(message.event)id=`push-${message.watchId}-${message.sequence}`;
  if(!id&&message.bc_command)id='command-'+createHash('sha256').update(text).digest('hex').slice(0,16);
  if(typeof id!=='string'||!id.length||id.length>100)throw new Error('Large phone message has no bounded ID');
  const pieces=[];let part='';
  const fits=value=>value.length<=200&&Buffer.byteLength(JSON.stringify({bc:1,id,part:511,total:512,data:value}))<=450;
  for(const character of text) {
    if(!fits(part+character)){if(!part)throw new Error('Phone character cannot fit');pieces.push(part);part='';}
    part+=character;
  }
  if(part)pieces.push(part);if(pieces.length>512)throw new Error('Excessive phone fragments');
  return pieces.map((data,part)=>JSON.stringify({bc:1,id,part,total:pieces.length,data}));
}

// Private transport has a larger native mailbox than vendor interconnect.
// Keep the same fragment identities, with a separate bounded format version.
export function privatePhoneFrames(message) {
  const text=JSON.stringify(message);if(Buffer.byteLength(text)>65536)throw new Error('Excessive private JSON');
  if(Buffer.byteLength(text)<=32768)return [text];
  let id=message.id;
  if(message.event)id=`push-${message.watchId}-${message.sequence}`;
  if(!id&&message.bc_command)id='command-'+createHash('sha256').update(text).digest('hex').slice(0,16);
  if(typeof id!=='string'||!id.length||id.length>100)throw new Error('Large private message has no bounded ID');
  const parts=[];let part='',bytes=0;
  for(const character of text){
    const n=Buffer.byteLength(character);
    if(bytes+n>4096){parts.push(part);part='';bytes=0;}
    part+=character;bytes+=n;
  }
  if(part)parts.push(part);if(parts.length>32)throw new Error('Excessive private fragments');
  return parts.map((data,part)=>JSON.stringify({bc:2,id,part,total:parts.length,data}));
}
