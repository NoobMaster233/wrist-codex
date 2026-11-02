// Bounded protobuf primitives for the owned band's read-only installed-App list.
export function fields(bytes) {
  if(bytes.length>65536)throw new Error('Excessive protobuf input');
  let offset=0;const result=[];
  const varint=()=>{
    let value=0n;
    for(let i=0;i<10;i++) {
      if(offset>=bytes.length)throw new Error('Truncated protobuf varint');
      const byte=bytes[offset++];if(i===9&&byte>1)throw new Error('Overflow protobuf varint');
      value|=BigInt(byte&127)<<BigInt(7*i);
      if(!(byte&128))return value;
    }
    throw new Error('Overflow protobuf varint');
  };
  while(offset<bytes.length) {
    if(result.length>=256)throw new Error('Excessive protobuf fields');
    const key=varint(),wire=Number(key&7n),tag=Number(key>>3n);
    if(tag<=0||tag>0x1fffffff)throw new Error('Invalid protobuf tag');
    const item={tag,wire};
    if(wire===0)item.number=varint();
    else {
      let size;
      if(wire===2)size=Number(varint());else if(wire===1)size=8;else if(wire===5)size=4;
      else throw new Error('Unsupported protobuf wire type');
      if(!Number.isSafeInteger(size)||size<0||size>bytes.length-offset)throw new Error('Truncated protobuf field');
      item.data=bytes.subarray(offset,offset+size);offset+=size;
    }
    result.push(item);
  }
  return result;
}
export const last=(items,tag,wire)=>items.findLast(item=>item.tag===tag&&item.wire===wire);
function varint(value) {
  let n=BigInt(value);if(n<0n||n>0xffffffffffffffffn)throw new Error('Invalid protobuf integer');
  const bytes=[];do{bytes.push(Number(n&127n)|(n>127n?128:0));n>>=7n;}while(n);
  return Buffer.from(bytes);
}
export const pbNumber=(tag,value)=>Buffer.concat([varint(BigInt(tag)<<3n),varint(value)]);
export const pbBytes=(tag,value)=>Buffer.concat([varint((BigInt(tag)<<3n)|2n),varint(value.length),value]);
export const wear=(type,id,tag,payload)=>Buffer.concat([pbNumber(1,type),pbNumber(2,id),
  ...(payload===undefined?[]:[pbBytes(tag,payload)])]);
export function appListResponse(l2,{includeFingerprint=false}={}) {
  if(l2[0]!==1)return null;
  if(l2[1]===2)throw new Error('Encrypted application response; authentication required');
  if(l2[1]!==1)return null;
  const top=fields(l2.subarray(2));
  if(last(top,1,0)?.number!==20n||last(top,2,0)?.number!==0n)return null;
  if(last(top,100,2))throw new Error('Device returned an application error');
  const thirdparty=last(top,22,2);if(!thirdparty)return null;
  const list=last(fields(thirdparty.data),1,2);if(!list)return null;
  return fields(list.data).filter(item=>item.tag===1&&item.wire===2).map(item=>{
    const props=fields(item.data),name=last(props,1,2),version=last(props,3,0);
    if(!name||!version||version.number>0xffffffffn)throw new Error('Incomplete App list item');
    const packageName=name.data.toString('utf8');
    if(!/^[A-Za-z0-9_.-]{1,200}$/.test(packageName))throw new Error('Invalid App package name');
    const result={packageName,versionCode:Number(version.number)};
    if(includeFingerprint) {
      const fingerprint=last(props,2,2)?.data;
      if(!fingerprint||fingerprint.length<16||fingerprint.length>64)throw new Error('Invalid App fingerprint');
      result.fingerprint=Buffer.from(fingerprint);
    }
    return result;
  });
}
