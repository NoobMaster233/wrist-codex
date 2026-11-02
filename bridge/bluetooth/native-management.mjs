// Native files use the same transfer engines as the RPK. Business journals,
// receipts, CRCs, SHA256 and resume IDs remain owned by the existing relay.
import {setTimeout as delay} from 'node:timers/promises';
import {receiveFile} from '../../band/src/common/file-receive.mjs';
import {sendOwnFile} from '../../band/src/common/file-upload.mjs';
import {decodeShellStatus} from '../shell-protocol.mjs';

export const ManagementOp=Object.freeze({STAT:1,READ:2,WRITE:3,MOVE:4,DELETE:5,EXEC:6,CAPS:7});
const ownName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
const integer=(n,max)=>Number.isInteger(n)&&n>=0&&n<=max;
const uriName=uri=>{
  const match=/^internal:\/\/(?:files|cache)\/([^/]+)$/.exec(uri||'');
  if(!match||!ownName(match[1]))throw new Error('Invalid native private file URI');return match[1];
};
export function managementRequest(op,{name='',target='',offset=0,length=0,append=false,data=Buffer.alloc(0)}={}) {
  if(!Object.values(ManagementOp).includes(op)||!integer(offset,1048576)||!integer(length,4096)||
    typeof append!=='boolean'||!Buffer.isBuffer(data)||
    (op===ManagementOp.CAPS?(name!==''||target!==''):!ownName(name))||
    (op===ManagementOp.MOVE?!ownName(target):target!=='')||
    (op===ManagementOp.WRITE?(data.length!==length||length>1048576-offset):data.length!==0)||
    (op!==ManagementOp.WRITE&&append)||(![ManagementOp.READ,ManagementOp.WRITE].includes(op)&&(offset||length)))
    throw new Error('Invalid native management request');
  const a=Buffer.from(name,'ascii'),b=Buffer.from(target,'ascii'),header=Buffer.alloc(16);
  header.write('BCM1');header[4]=op;header[5]=append?1:0;header[6]=a.length;header[7]=b.length;
  header.writeUInt32LE(offset,8);header.writeUInt32LE(length,12);
  return Buffer.concat([header,a,b,data]);
}
export function managementResponse(bytes,op) {
  if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>4108||bytes.toString('ascii',0,4)!=='BCR1'||
    bytes[4]!==op||bytes[5]||bytes[6]||bytes[7])throw new Error('Invalid native management response');
  const status=bytes.readInt32LE(8),data=bytes.subarray(12);
  if(status){
    if(status<1||status>4095||data.length)throw new Error('Invalid native management error');
    const error=new Error('Native management operation '+op+' failed ('+status+')');error.nativeStatus=status;throw error;
  }
  if([ManagementOp.STAT,ManagementOp.WRITE,ManagementOp.EXEC,ManagementOp.CAPS].includes(op)?data.length!==4:
     [ManagementOp.MOVE,ManagementOp.DELETE].includes(op)?data.length!==0:false)
    throw new Error('Native management result length differs');
  return data;
}
export function createNativeFileAPI(transport) {
  let chain=Promise.resolve();
  const request=(op,params)=>{
    const payload=managementRequest(op,params);
    const result=chain.then(async()=>managementResponse(await transport.management(payload),op));
    chain=result.catch(()=>{});return result;
  };
  const invoke=(options,task)=>{
    Promise.resolve().then(task).then(value=>options.success?.(value),error=>options.fail?.(error,error.nativeStatus??-1));
  };
  const write=options=>invoke(options,async()=>{
    const data=options.buffer===undefined?Buffer.from(options.text||'','utf8'):Buffer.from(new Uint8Array(options.buffer));
    const result=await request(ManagementOp.WRITE,{name:uriName(options.uri),offset:options.position||0,
      append:options.append===true,length:data.length,data});
    return {length:result.readUInt32LE(0)};
  });
  return {
    get:options=>invoke(options,async()=>({length:(await request(ManagementOp.STAT,{name:uriName(options.uri)})).readUInt32LE(0)})),
    readArrayBuffer:options=>invoke(options,async()=>{
      const data=await request(ManagementOp.READ,{name:uriName(options.uri),offset:options.position||0,length:options.length});
      if(data.length!==options.length)throw new Error('Native file read length differs');
      return {buffer:Uint8Array.from(data).buffer};
    }),
    writeArrayBuffer:write,writeText:write,
    move:options=>invoke(options,async()=>{await request(ManagementOp.MOVE,{name:uriName(options.srcUri),target:uriName(options.dstUri)});return {};}),
    delete:options=>invoke(options,async()=>{await request(ManagementOp.DELETE,{name:uriName(options.uri)});return {};}),
    execute:async id=>(await request(ManagementOp.EXEC,{name:id})).readUInt32LE(0),
    status:async name=>{
      const n=(await request(ManagementOp.STAT,{name})).readUInt32LE(0);
      if(n!==64)throw new Error('Native shell status is incomplete');
      return decodeShellStatus(await request(ManagementOp.READ,{name,length:n}));
    }
  };
}
export function createNativeManagement({transport,rpc,onOperation=()=>{},now=Date.now,sleep=delay}) {
  const file=createNativeFileAPI(transport),alive=()=>!transport.failure;
  const interrupted=()=>new Error('Phone send failed: native management connection closed');
  const call=async(method,params)=>{
    // A connection loss retains the original transfer, even when a shared
    // engine attempts its normal failure/cancel receipt during unwinding.
    if(!alive())throw interrupted();
    return rpc(method,params);
  };
  return {async handle(command) {
    if(!['fileReceive','fileUpload','nativeShellControl'].includes(command.bc_command))return false;
    onOperation(command.bc_command);
    try{
      if(command.bc_command==='fileReceive')await receiveFile({file,command,rpc:call,alive});
      else if(command.bc_command==='fileUpload')await sendOwnFile({file,command,rpc:call,alive});
      else{
        const id=command.requestId;
        if(!Number.isSafeInteger(command.expiresAt)||now()>=command.expiresAt){await call('native.shell.report',{id,notStarted:true});return true;}
        try{
          await file.execute(id);
          const until=now()+Math.min(12000,(command.timeoutMs||3000)+2000);
          while(now()<until){
            try{const state=await file.status('bc-shell-'+id+'.status');if(!['pending'].includes(state.outcome))break;}
            catch(error){if(!alive())throw error;if(error.nativeStatus!==2&&error.message!=='Native shell status is incomplete')throw error;}
            await sleep(100);
          }
        }catch(error){if(!alive())throw error;}
        // The saved native receipt is authoritative, including an unknown
        // event delivery. This path never republishes an EXEC request.
        await call('native.shell.report',{id,op:'no-event'});
      }
      return true;
    }catch(error){if(!alive())throw interrupted();throw error;}
  }};
}
