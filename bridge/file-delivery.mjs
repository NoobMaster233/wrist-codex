import { createHash, randomUUID } from 'node:crypto';
import { crc32, encode64 } from '../band/src/common/bytes.mjs';

// Phone -> our private inbox, via App or native management. Logical names are
// metadata, never filesystem paths. Both transports verify the same receipt.
export class FileDeliveries {
  constructor({ now = Date.now, maxBytes = 1024*1024 } = {}) {
    this.now=now; this.maxBytes=maxBytes; this.jobs=new Map();
  }
  expire() {
    for (const job of this.jobs.values()) if (job.state==='sending' && this.now()-job.updatedAt>60000) {
      job.state='error';job.error='文件接收超时';job.data=null;
    }
  }
  active() { this.expire();return [...this.jobs.values()].some(j=>j.state==='sending'); }
  snapshot(id) {
    this.expire();const job=this.jobs.get(id);if(!job)return null;
    return {id:job.id,name:job.name,size:job.size,crc:job.crc,sha256:job.sha256,state:job.state,
      chunkBytes:job.chunkBytes,sentBytes:job.sentBytes,...(job.uri?{uri:job.uri}:{}),
      ...(job.metadata?{metadata:job.metadata}:{}),...(job.error?{error:job.error}:{})};
  }
  start(bytes,name,chunkBytes=128) {
    if (this.active()) throw new Error('已有文件正在传输');
    if (!(bytes instanceof Uint8Array) || bytes.length>this.maxBytes) throw new Error('File exceeds limit');
    if(typeof name!=='string'||!name||name.length>80||/[\/\\\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid logical filename');
    if(![128,1024,4096].includes(chunkBytes))throw new Error('Unsupported file chunk size');
    while(this.jobs.size>=16)this.jobs.delete(this.jobs.keys().next().value);
    const id='file-'+randomUUID(),data=Buffer.from(bytes);
    const job={id,name,size:data.length,crc:crc32(data),sha256:createHash('sha256').update(data).digest('hex'),
      data,chunkBytes,updatedAt:this.now(),state:'sending',sentBytes:0};
    this.jobs.set(id,job);return this.snapshot(id);
  }
  frame({id,seq,chunkBytes=128}) {
    this.expire();const job=this.jobs.get(id);
    if(!job||job.state!=='sending')throw new Error('Unknown or expired file delivery');
    if(chunkBytes!==job.chunkBytes)throw new Error('File chunk size differs');
    if(!Number.isInteger(seq)||seq<0||seq>=Math.ceil(job.size/chunkBytes))throw new Error('Invalid file chunk index');
    const data=job.data.subarray(seq*chunkBytes,(seq+1)*chunkBytes);
    job.updatedAt=this.now();job.sentBytes=Math.max(job.sentBytes,seq*chunkBytes+data.length);
    return {seq,b64:encode64(data),crc:crc32(data)};
  }
  finish({id,size,crc,uri,error,metadata}) {
    this.expire();const job=this.jobs.get(id);if(!job)throw new Error('Unknown file delivery');
    if(job.state==='complete') {
      if(size!==job.size||crc!==job.crc||uri!==job.uri||error)throw new Error('File receipt differs');
      return this.snapshot(id);
    }
    if(job.state!=='sending')throw new Error('File delivery is no longer active');
    if(typeof error==='string') {job.state='error';job.error=error.slice(0,100);job.data=null;return this.snapshot(id);}
    if(size!==job.size||crc!==job.crc||uri!=='internal://files/bc-'+id+'.bin')throw new Error('File receipt differs');
    if(metadata?.length!==job.size)throw new Error('Saved file length is unverified or differs');
    if(metadata&&typeof metadata==='object')job.metadata={
      length:Number.isSafeInteger(metadata.length)&&metadata.length>=0?metadata.length:null,
      lengthType:['undefined','number','string','object'].includes(metadata.lengthType)?metadata.lengthType:'unknown',
      valueType:['undefined','number','string','object'].includes(metadata.valueType)?metadata.valueType:'unknown',
      keys:Array.isArray(metadata.keys)?metadata.keys.filter(k=>typeof k==='string'&&/^[A-Za-z0-9_]{1,32}$/.test(k)).slice(0,8):[],
      ...(typeof metadata.error==='string'?{error:metadata.error.slice(0,50)}:{})};
    job.state='complete';job.uri=uri;job.data=null;return this.snapshot(id);
  }
}
