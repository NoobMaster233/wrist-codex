import { crc32, decode64, interruptedTransfer } from './bytes.mjs';

const call=(file,method,options)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(method+' timed out')),8000);
  const done=(error,result)=>{clearTimeout(timer);if(error)reject(error);else resolve(result);};
  try{file[method]({...options,success:result=>done(null,result),fail:(_,code)=>done(new Error(method+':'+code))});}
  catch(error){done(error);}
});

export async function receiveFile({file,command,rpc,alive=()=>true,progress=()=>{}}) {
  const {transferId:id,size,crc}=command;
  const chunkBytes=command.chunkBytes||128;
  if(!/^file-[a-f0-9-]{36}$/.test(id||'')||!Number.isInteger(size)||size<0||size>1048576||
    ![128,1024,4096].includes(chunkBytes)||!Number.isInteger(crc)||crc<0||crc>0xffffffff)throw new Error('Invalid file delivery');
  const resumable=command.resumable===true;
  const staging=(resumable?'internal://files/':'internal://cache/')+'bc-'+id+'.part',uri='internal://files/bc-'+id+'.bin';
  const check=()=>{if(!alive())throw new Error('File reception cancelled');};
  const safeRpc=async(method,params)=>{
    for(let attempt=0;;++attempt) {
      check();
      try{return await rpc(method,params);}catch(error){
        if(attempt>=2||!/Phone request timed out|Phone send failed/.test(String(error.message||error)))throw error;
        if(resumable)await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));
      }
    }
  };
  const describe=info=>({length:typeof info?.length==='number'?info.length:null,lengthType:typeof info?.length,
    keys:info&&typeof info==='object'?Object.keys(info).slice(0,8):[],valueType:typeof info});
  const checksumOf=async(path,length)=>{
    let value=0;
    for(let position=0;position<length;position+=4096) {
      check();const count=Math.min(4096,length-position),read=await call(file,'readArrayBuffer',{uri:path,position,length:count});
      const bytes=read.buffer instanceof Uint8Array?read.buffer:new Uint8Array(read.buffer);
      if(bytes.length!==count)throw new Error('File readback length differs');value=crc32(bytes,value);
    }
    return value;
  };
  let moved=false,created=false,verified=false,keepPartial=false;
  try {
    const block=new Uint8Array(4096);let used=0,offset=0,checksum=0;
    if(resumable) {
      let saved;
      try{saved=await call(file,'get',{uri});}catch(_){}
      if(saved) {
        if(saved.length===size&&await checksumOf(uri,size)===crc) {
          moved=true;verified=true;
          return await safeRpc('files.received',{id,size,crc,uri,metadata:describe(saved)});
        }
        await call(file,'delete',{uri});
      }
      let partial;
      try{partial=await call(file,'get',{uri:staging});}catch(_){}
      if(partial) {
        if(Number.isInteger(partial.length)&&partial.length>=0&&partial.length<=size&&
          (partial.length%4096===0||partial.length===size)) {
          created=true;offset=partial.length;checksum=await checksumOf(staging,offset);progress(offset,size);
        }else await call(file,'delete',{uri:staging});
      }
    }
    for(let seq=Math.ceil(offset/chunkBytes);seq*chunkBytes<size;++seq) {
      check();const part=await safeRpc('files.pull',{id,seq,chunkBytes});
      const bytes=decode64(part.b64,chunkBytes);
      if(part.seq!==seq||bytes.length!==Math.min(chunkBytes,size-seq*chunkBytes)||crc32(bytes)!==part.crc)throw new Error('File chunk differs');
      checksum=crc32(bytes,checksum);block.set(bytes,used);used+=bytes.length;
      if(used===block.length||seq*chunkBytes+bytes.length===size) {
        // .043 unwraps a typed-array view to its full backing ArrayBuffer.
        // Copy the tail so the native writer cannot append stale block bytes.
        const exact=new Uint8Array(used);exact.set(block.subarray(0,used));
        check();await call(file,'writeArrayBuffer',{uri:staging,buffer:exact,position:offset,append:offset>0});
        created=true;offset+=used;used=0;progress(offset,size);
      }
    }
    if(!size){check();await call(file,'writeText',{uri:staging,text:''});created=true;}
    if(checksum!==crc)throw new Error('File checksum differs');
    // Re-read the persisted bytes; transport CRC alone is not a disk receipt.
    let readCrc=0;
    for(let position=0;position<size;position+=4096) {
      check();const length=Math.min(4096,size-position);
      const read=await call(file,'readArrayBuffer',{uri:staging,position,length});
      const bytes=read.buffer instanceof Uint8Array?read.buffer:new Uint8Array(read.buffer);
      if(bytes.length!==length)throw new Error('File readback length differs');
      readCrc=crc32(bytes,readCrc);
    }
    if(readCrc!==crc)throw new Error('File readback checksum differs');
    check();await call(file,'move',{srcUri:staging,dstUri:uri});moved=true;
    let metadata={};
    try {
      const info=await call(file,'get',{uri});
      metadata=describe(info);
    } catch(error) {metadata={error:String(error.message||error).slice(0,50)};}
    // Both exact file length and actual bytes are required. A valid prefix
    // alone cannot prove that no extra tail was written by a native binding.
    if(metadata.length!==size)throw new Error('Committed file length differs:'+metadata.length+'/'+size);
    let finalCrc=0;
    for(let position=0;position<size;position+=4096) {
      check();const length=Math.min(4096,size-position);
      const read=await call(file,'readArrayBuffer',{uri,position,length});
      const bytes=read.buffer instanceof Uint8Array?read.buffer:new Uint8Array(read.buffer);
      if(bytes.length!==length)throw new Error('Committed file readback length differs');
      finalCrc=crc32(bytes,finalCrc);
    }
    if(finalCrc!==crc)throw new Error('Committed file readback checksum differs');
    verified=true;
    return await safeRpc('files.received',{id,size,crc:finalCrc,uri,metadata});
  } catch(error) {
    keepPartial=resumable&&interruptedTransfer(error);
    if(!keepPartial){try{await rpc('files.received',{id,error:String(error.message||error).slice(0,100)});}catch(_){}}
    throw error;
  } finally {
    // A committed file survives a lost final phone ACK, allowing reconciliation.
    if(created&&!moved&&!keepPartial){try{await call(file,'delete',{uri:staging});}catch(_) {}}
    if(moved&&!verified){try{await call(file,'delete',{uri});}catch(_) {}}
  }
}
