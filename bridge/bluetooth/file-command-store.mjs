import {readFile,open,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;

// Persist data-transfer metadata only. No executable controls, message text,
// file contents, tokens or microphone-start requests can enter this store.
function metadata(command) {
  if(!command||!['fileReceive','fileUpload'].includes(command.bc_command))return null;
  const receive=command.bc_command==='fileReceive';
  if(!new RegExp('^'+(receive?'file-':'upload-')+uuid+'$').test(command.transferId||'')||
    !(receive?[128,1024,4096]:[128,1024]).includes(command.chunkBytes))throw new Error('Invalid resumable file identity');
  const value={bc_command:command.bc_command,transferId:command.transferId,chunkBytes:command.chunkBytes,resumable:true};
  if(receive) {
    if(!integer(command.size,1048576)||!integer(command.crc,0xffffffff))throw new Error('Invalid resumable file size/checksum');
    Object.assign(value,{size:command.size,crc:command.crc});
  } else {
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(command.name||''))throw new Error('Invalid resumable private filename');
    value.name=command.name;
    if(command.purpose!==undefined) {
      if(!['audio','shell'].includes(command.purpose)||!new RegExp('^'+uuid+'$').test(command.sessionId||''))
        throw new Error('Invalid file purpose');
      Object.assign(value,{purpose:command.purpose,sessionId:command.sessionId});
    }
  }
  return value;
}

export class FileCommandStore {
  constructor(path,{now=Date.now}={}) {this.path=path;this.now=now;this.items=[];this.progress=new Map();}
  async load() {
    let value;
    try{value=JSON.parse(await readFile(this.path,'utf8'));}
    catch(error){if(error.code==='ENOENT')return;throw new Error('Cannot read saved file transfers');}
    if(value?.version!==1||!Array.isArray(value.items)||value.items.length>16)throw new Error('Invalid saved file transfers');
    for(const item of value.items) {
      if(typeof item.epoch!=='string'||!item.epoch.length||item.epoch.length>100||
        !Number.isSafeInteger(item.createdAt)||!integer(item.reoffers,64)||!metadata(item.command))
        throw new Error('Invalid saved file transfer');
      item.command=metadata(item.command);
    }
    this.items=value.items;
  }
  async save() {
    const folder=dirname(this.path);await mkdir(folder,{recursive:true,mode:0o700});
    const temporary=this.path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify({version:1,items:this.items})+'\n');await file.sync();}
    finally{await file.close();}
    await rename(temporary,this.path);
    const dir=await open(folder,'r');try{await dir.sync();}finally{await dir.close();}
  }
  async remember(epoch,command) {
    const value=metadata(command);if(!value)return command;
    if(typeof epoch!=='string'||!epoch.length||epoch.length>100)throw new Error('Invalid file transfer epoch');
    this.items=this.items.filter(item=>item.epoch===epoch&&this.now()-item.createdAt<600000);
    const old=this.items.find(item=>item.command.transferId===value.transferId);
    if(old&&JSON.stringify(old.command)!==JSON.stringify(value))throw new Error('File transfer identity was reused');
    if(!old) {
      if(this.items.length>=16)throw new Error('Too many saved file transfers');
      this.items.push({epoch,command:value,createdAt:this.now(),reoffers:0});await this.save();
    }
    this.progress.set(value.transferId,{bytes:0,at:this.now()});return value;
  }
  async recover(epoch,{query,send,force=false}) {
    let sent=0,changed=false;
    for(const item of [...this.items]) {
      const command=item.command,id=command.transferId,receive=command.bc_command==='fileReceive';
      const discard=()=>{this.items=this.items.filter(value=>value!==item);this.progress.delete(id);changed=true;};
      if(item.epoch!==epoch||this.now()-item.createdAt>=600000){discard();continue;}
      let status;
      try{status=await query((receive?'/files/status?id=':'/files/receive/status?id=')+id);}
      catch(error){if(error.status===404){discard();continue;}throw error;}
      if(receive?status.state!=='sending':status.phase!=='pending'){discard();continue;}
      if(status.id!==id||status.chunkBytes!==command.chunkBytes||
        (receive?(status.size!==command.size||status.crc!==command.crc):status.name!==command.name))
        throw new Error('Saved file transfer differs from its active receipt');
      const bytes=receive?status.sentBytes:status.received?.bytes||0,last=this.progress.get(id);
      if(!force&&(!last||bytes!==last.bytes)){this.progress.set(id,{bytes,at:this.now()});continue;}
      if(!force&&this.now()-last.at<10000)continue;
      if(item.reoffers>=64)throw new Error('File resume limit reached; inspect the saved transfer');
      item.reoffers++;await this.save();
      await send(command);sent++;this.progress.set(id,{bytes,at:this.now()});
    }
    if(changed)await this.save();return sent;
  }
}
