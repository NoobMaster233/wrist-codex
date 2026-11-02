import {crc32,uploadSource,interruptedTransfer} from './bytes.mjs';

export function ownFileName(name) {
  if(typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name))throw new Error('Invalid private file name');
  return name;
}
const call=(file,method,options)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(method+' timed out')),8000);
  const done=(error,result)=>{clearTimeout(timer);if(error)reject(error);else resolve(result);};
  try{file[method]({...options,success:result=>done(null,result),fail:(_,code)=>done(new Error(method+':'+code))});}
  catch(error){done(error);}
});

/** Read only our app's private files. Two passes bound RAM and detect changes. */
export async function sendOwnFile({file,command,rpc,alive=()=>true,progress=()=>{}}) {
  const {transferId:id,name,chunkBytes=1024}=command;
  if(!/^upload-[a-f0-9-]{36}$/.test(id||'')||![128,1024].includes(chunkBytes))throw new Error('Invalid file upload');
  const uri='internal://files/'+ownFileName(name);
  const check=()=>{if(!alive())throw new Error('File upload cancelled');};
  const metadata=async()=>{check();const info=await call(file,'get',{uri});check();
    if(!Number.isInteger(info.length)||info.length<0||info.length>1048576)throw new Error('Private file exceeds limit');return info;};
  const read=async(position,length)=>{check();const result=await call(file,'readArrayBuffer',{uri,position,length});check();
    const bytes=result.buffer instanceof Uint8Array?result.buffer:new Uint8Array(result.buffer);
    if(bytes.length!==length)throw new Error('Private file read length differs');return bytes;};
  const safeRpc=async(method,params)=>{
    for(let attempt=0;;++attempt){check();try{return await rpc(method,params);}catch(error){
      if(attempt>=2||!/Phone request timed out|Phone send failed/.test(String(error.message||error)))throw error;
      if(command.resumable)await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));
    }}
  };
  try {
    const before=await metadata();let checksum=0;
    for(let offset=0;offset<before.length;offset+=4096)checksum=crc32(await read(offset,Math.min(4096,before.length-offset)),checksum);
    const result=await uploadSource({id,name,size:before.length,checksum,chunkBytes,readChunk:read,
      rpc:frame=>safeRpc('blob.frame',frame),cancelled:()=>!alive(),progress,resumable:command.resumable===true});
    const after=await metadata();
    if(after.length!==before.length||(before.lastModifiedTime!==undefined&&after.lastModifiedTime!==before.lastModifiedTime))
      throw new Error('Private file changed during upload');
    return await safeRpc('files.uploaded',{id,size:before.length,crc:checksum});
  } catch(error) {
    if(!command.resumable||!interruptedTransfer(error)){
      try{await rpc('files.uploaded',{id,error:String(error.message||error).slice(0,100)});}catch(_){}
    }
    throw error;
  }
}
