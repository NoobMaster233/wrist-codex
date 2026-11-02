// Normal Xiaomi authentication using one existing owned pairing token.
// No binding, fallback key, key guessing, or logging of protocol secrets.
import {createHmac,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {fields,last,pbBytes,pbNumber,wear} from './protobuf.mjs';

const hmac=(key,...parts)=>{
  const mac=createHmac('sha256',key);for(const part of parts)mac.update(part);return mac.digest();
};
export function deriveKeys(token,phoneNonce,deviceNonce) {
  if(token.length!==16||phoneNonce.length!==16||deviceNonce.length!==16)throw new Error('Invalid auth input length');
  const key=hmac(Buffer.concat([phoneNonce,deviceNonce]),token),blocks=[];let previous=Buffer.alloc(0);
  for(let i=1;i<=2;i++) {
    previous=hmac(key,previous,Buffer.from('miwear-auth'),Buffer.from([i]));blocks.push(previous);
  }
  const bytes=Buffer.concat(blocks);
  return {decKey:bytes.subarray(0,16),encKey:bytes.subarray(16,32),decNonce:bytes.subarray(32,36),encNonce:bytes.subarray(36,40)};
}
function account(l2,id) {
  if(l2[0]!==1||l2[1]!==1)return null;
  const top=fields(l2.subarray(2));
  if(last(top,1,0)?.number!==1n||last(top,2,0)?.number!==BigInt(id))return null;
  const value=last(top,3,2);if(!value)throw new Error('Missing account response');
  const props=fields(value.data),error=last(props,3,0);
  if(error&&error.number!==0n)throw new Error('Device rejected auth with code '+error.number);
  return props;
}
const plainAccount=(id,tag,payload)=>Buffer.concat([Buffer.from([1,1]),wear(1,id,3,pbBytes(tag,payload))]);
export class AuthSession {
  constructor(token,phoneNonce=randomBytes(16),deviceType=0) {
    if(token.length!==16||phoneNonce.length!==16)throw new Error('Invalid owned token or nonce');
    if(![0,1].includes(deviceType))throw new Error('Unsupported companion device type');
    this.deviceType=deviceType;this.token=Buffer.from(token);this.phoneNonce=Buffer.from(phoneNonce);this.authenticated=false;
  }
  start() {return plainAccount(26,30,pbBytes(1,this.phoneNonce));}
  challenge(l2) {
    const props=account(l2,26);if(!props)return null;
    const verify=last(props,31,2);if(!verify)throw new Error('Missing device challenge');
    const values=fields(verify.data),nonce=last(values,1,2)?.data,sign=last(values,2,2)?.data;
    if(nonce?.length!==16||sign?.length!==32)throw new Error('Invalid device challenge length');
    const keys=deriveKeys(this.token,this.phoneNonce,nonce);
    if(!timingSafeEqual(sign,hmac(keys.decKey,nonce,this.phoneNonce)))
      throw new Error('Owned token does not match device challenge');
    this.keys=keys;this.deviceHmacVerified=true;
    const deviceInfo=Buffer.concat([pbNumber(1,this.deviceType),pbBytes(3,Buffer.from('BandCodex')),pbNumber(4,0xffffffff)]);
    const ccmNonce=Buffer.concat([keys.encNonce,Buffer.alloc(8)]);
    const cipher=createCipheriv('aes-128-ccm',keys.encKey,ccmNonce,{authTagLength:4});
    cipher.setAAD(Buffer.alloc(0),{plaintextLength:deviceInfo.length});
    const encrypted=Buffer.concat([cipher.update(deviceInfo),cipher.final(),cipher.getAuthTag()]);
    return plainAccount(27,32,Buffer.concat([pbBytes(1,hmac(keys.encKey,this.phoneNonce,nonce)),pbBytes(2,encrypted)]));
  }
  confirm(l2) {
    const props=account(l2,27);if(!props)return false;
    if(!this.deviceHmacVerified)throw new Error('Auth confirmation before verified challenge');
    const confirmed=last(props,33,2);
    if(!confirmed||last(fields(confirmed.data),1,0)?.number!==1n)throw new Error('Device rejected authentication confirmation');
    this.authenticated=true;this.token.fill(0);return true;
  }
  encode(pb) {
    if(!this.authenticated)throw new Error('Authentication not confirmed');
    const cipher=createCipheriv('aes-128-ctr',this.keys.encKey,this.keys.encKey);
    return Buffer.concat([Buffer.from([1,2]),cipher.update(pb),cipher.final()]);
  }
  decode(l2) {
    if(l2[0]!==1||l2[1]!==2)return l2;
    if(!this.keys)throw new Error('Encrypted response before device verification');
    const decipher=createDecipheriv('aes-128-ctr',this.keys.decKey,this.keys.decKey);
    return Buffer.concat([Buffer.from([1,1]),decipher.update(l2.subarray(2)),decipher.final()]);
  }
}
