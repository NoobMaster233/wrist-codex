// Standard vendor RPK/watchface installation, over an authenticated DirectBand.
// Does not load native modules, write firmware partitions, or bind a device.
import {createHash} from 'node:crypto';
import {crc32} from '../../band/src/common/bytes.mjs';
import {fields,last,pbBytes,pbNumber,wear} from './protobuf.mjs';

const text=value=>Buffer.from(value,'utf8');
function body(packet,type,id,tag) {
  if(packet[0]!==1||packet[1]!==1)return null;
  const top=fields(packet.subarray(2));
  if(last(top,1,0)?.number!==BigInt(type)||last(top,2,0)?.number!==BigInt(id))return null;
  const error=last(top,100,0);if(error&&error.number!==0n)throw new Error('Device error code '+error.number);
  const data=last(top,tag,2);if(!data)throw new Error('Missing installation response payload');
  return fields(data.data);
}
export function installPrepare(kind,id,version,size) {
  if(!['rpk','watchface'].includes(kind)||!Number.isInteger(size)||size<1||size>16*1024*1024)
    throw new Error('Invalid install kind or size');
  if(kind==='rpk') {
    if(!/^[A-Za-z][A-Za-z0-9_.-]{1,199}$/.test(id)||!Number.isInteger(version)||version<1||version>0xffffffff)
      throw new Error('Invalid RPK metadata');
    return wear(20,1,22,pbBytes(2,Buffer.concat([pbBytes(1,text(id)),pbNumber(2,version),pbNumber(3,size)])));
  }
  if(!/^\d{1,12}$/.test(id))throw new Error('Invalid watchface ID');
  return wear(4,4,6,pbBytes(6,Buffer.concat([pbBytes(1,text(id)),pbNumber(2,size),pbNumber(3,65536)])));
}
export function installPrepareResponse(packet,kind,expectedId) {
  const props=body(packet,kind==='rpk'?20:4,kind==='rpk'?1:4,kind==='rpk'?22:6);
  if(!props)return null;
  let status;
  if(kind==='rpk') {
    const reply=last(props,3,2);if(!reply)throw new Error('Missing RPK prepare status');
    status=last(fields(reply.data),1,0)?.number;
  } else {
    status=last(props,5,0)?.number;
    const reply=last(props,9,2);
    if(reply) {
      const values=fields(reply.data),identity=last(values,1,2)?.data.toString('utf8');
      if(expectedId!==undefined&&identity!==expectedId)throw new Error('Watchface prepare ID differs');
      status=last(values,2,0)?.number;
    }
  }
  if(status===undefined)throw new Error('Missing device prepare status');
  if(status!==0n)throw new Error('Installation preparation rejected with status '+status);
  return true;
}
export function massPrepare(data,type) {
  if(![16,64].includes(type))throw new Error('Only watchface/RPK MASS types are supported');
  const md5=createHash('md5').update(data).digest();
  const request=Buffer.concat([pbNumber(1,type),pbBytes(2,md5),pbNumber(3,data.length)]);
  return {md5,packet:wear(22,0,24,pbBytes(1,request))};
}
export function cancelMassTransfer(data,type) {
  if(![16,64].includes(type)||!Buffer.isBuffer(data)||data.length<1||data.length>16*1024*1024)
    throw new Error('Only a known watchface/RPK data transfer may be cancelled');
  const id=createHash('md5').update(data).digest();
  return wear(22,1,24,pbBytes(3,Buffer.concat([pbNumber(1,2),pbNumber(2,type),pbBytes(3,id)])));
}
export function massPrepareResponse(packet,expectedMd5,{expectedResumeBytes=0}={}) {
  if(!Number.isInteger(expectedResumeBytes)||expectedResumeBytes<0||expectedResumeBytes>16*1024*1024)
    throw new Error('Invalid expected MASS resume offset');
  const props=body(packet,22,0,24);if(!props)return null;
  const response=last(props,2,2);if(!response)throw new Error('Missing MASS prepare response');
  const reply=fields(response.data),md5=last(reply,1,2)?.data,status=last(reply,2,0)?.number;
  if(!md5?.equals(expectedMd5))throw new Error('MASS response belongs to another file');
  if(status!==0n)throw new Error('MASS preparation rejected with status '+String(status));
  const mode=last(reply,3,0)?.number??0n,retained=last(reply,4,0)?.number??0n,length=last(reply,5,0)?.number;
  if(mode!==0n)throw new Error('Unrequested MASS compression mode');
  if(length===undefined||length<7n||length>64512n)throw new Error('Invalid MASS slice length');
  if(retained!==BigInt(expectedResumeBytes)) {
    const error=new Error('Device retained transfer state; inspect the previous request before resuming');
    error.transferState={reportedLength:retained.toString(),sliceLength:Number(length),dataId:md5.toString('hex')};
    throw error;
  }
  return Number(length);
}
export function massFrames(data,type,sliceLength,resumeBytes=0) {
  if(![16,64].includes(type)||!Number.isInteger(sliceLength)||sliceLength<7||sliceLength>64512||
    !Number.isInteger(resumeBytes)||resumeBytes<0||resumeBytes>=data.length)
    throw new Error('Invalid MASS framing parameters');
  const remaining=data.subarray(resumeBytes);
  const header=Buffer.alloc(22);header[1]=type;createHash('md5').update(data).digest().copy(header,2);header.writeUInt32LE(remaining.length,18);
  const content=Buffer.concat([header,remaining]),checksum=Buffer.alloc(4);checksum.writeUInt32LE(crc32(content));
  const inner=Buffer.concat([content,checksum]),capacity=sliceLength-6,count=Math.ceil(inner.length/capacity);
  if(count>65535)throw new Error('MASS transfer has too many slices');
  const packets=[];
  for(let part=1;part<=count;part++) {
    const head=Buffer.alloc(6);head[0]=2;head[1]=1;head.writeUInt16LE(count,2);head.writeUInt16LE(part,4);
    packets.push(Buffer.concat([head,inner.subarray((part-1)*capacity,part*capacity)]));
  }
  return packets;
}
export function installResult(packet,kind,id) {
  const props=body(packet,kind==='rpk'?20:4,kind==='rpk'?2:5,kind==='rpk'?22:6);if(!props)return null;
  const value=last(props,kind==='rpk'?4:7,2);if(!value)throw new Error('Missing install result');
  const result=fields(value.data);
  if(kind==='watchface') {
    const identity=last(result,1,2)?.data.toString('utf8'),code=last(result,2,0)?.number;
    if(identity!==id)throw new Error('Watchface result ID differs');
    if(code!==2n&&code!==3n)throw new Error('Watchface install failed with code '+String(code));
    return {kind,id,code:Number(code)};
  }
  const code=last(result,1,0)?.number,metadata=last(result,3,2);
  const item=metadata?fields(metadata.data):null;
  const identity=last(result,2,2)?.data.toString('utf8')||last(item||[],1,2)?.data.toString('utf8');
  if(identity!==id)throw new Error('RPK result package differs');
  if(code!==0n)throw new Error('RPK install failed with code '+String(code));
  return {kind,id,code:0,...(item?{versionCode:Number(last(item,3,0)?.number??-1n)}:{})};
}
export async function installResource(band,{kind,id,version,data,progress=()=>{},stage=()=>{},resumeBytes=0}) {
  if(!Number.isInteger(resumeBytes)||resumeBytes<0||resumeBytes>=data.length)throw new Error('Invalid install resume offset');
  const type=kind==='rpk'?64:16;
  await stage({name:'vendor-prepare-request'});
  await band.requestL2(band.auth.encode(installPrepare(kind,id,version,data.length)),packet=>installPrepareResponse(packet,kind,id));
  await stage({name:'vendor-prepare-confirmed'});
  const prepared=massPrepare(data,type);
  await stage({name:'mass-prepare-request'});
  const sliceLength=await band.requestL2(band.auth.encode(prepared.packet),packet=>massPrepareResponse(packet,prepared.md5,{expectedResumeBytes:resumeBytes}));
  // The negotiated L1 message window is suitable for small RPC packets. It
  // does not establish a byte budget for 12 KiB MASS slices: this firmware
  // retained exactly three slices before EOF when those were sent in batches.
  // Await each slice receipt before sending the next large payload.
  const installFlight=1;
  await stage({name:'mass-ready',sliceLength,resumeBytes,installFlight,negotiatedWindow:band.maxFlight});
  const packets=massFrames(data,type,sliceLength,resumeBytes);
  // Register before the final transfer packet can trigger a fast result.
  const final=band.wait('packet',packet=>installResult(packet,kind,id),120000);final.catch(()=>{});
  for(let start=0;start<packets.length;start+=installFlight) {
    await band.sendL2Batch(packets.slice(start,start+installFlight));
    await progress({sentSlices:Math.min(start+installFlight,packets.length),totalSlices:packets.length,sliceLength,resumeBytes});
  }
  return await final;
}
export function watchfaceListResponse(packet) {
  const props=body(packet,4,0,6);if(!props)return null;
  const list=last(props,1,2);if(!list)throw new Error('Missing watchface list');
  return fields(list.data).filter(item=>item.tag===1&&item.wire===2).map(item=>{
    const values=fields(item.data),id=last(values,1,2)?.data.toString('utf8'),current=last(values,3,0)?.number;
    if(!/^\d{1,12}$/.test(id||'')||(current!==0n&&current!==1n))throw new Error('Invalid watchface list item');
    return {id,current:current===1n};
  });
}
export function watchfaceSelectedResponse(packet) {
  const props=body(packet,4,1,6);if(!props)return null;
  if(last(props,4,0)?.number!==1n)throw new Error('Watchface selection rejected');
  return true;
}
