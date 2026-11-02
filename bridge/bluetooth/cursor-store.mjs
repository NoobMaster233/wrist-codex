import {readFile,open,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

// Claim an event before radio transmission. A restarted transport cannot
// replay a command whose delivery became uncertain. Device results still
// come from the existing recording/file/native Shell journals.
export class CursorStore {
  constructor(path){this.path=path;}
  async load() {
    let value;
    try{value=JSON.parse(await readFile(this.path,'utf8'));}
    catch(error){if(error.code==='ENOENT')return null;throw new Error('Cannot read saved transport cursor');}
    if(!value||typeof value.epoch!=='string'||!value.epoch.length||value.epoch.length>100||
      !['band','maintenance'].includes(value.kind)||!Number.isSafeInteger(value.cursor)||value.cursor<0)
      throw new Error('Invalid saved transport cursor; inspect before reconnecting');
    return value;
  }
  async claim(epoch,cursor,kind) {
    if(typeof epoch!=='string'||!epoch.length||epoch.length>100||!['band','maintenance'].includes(kind)||!Number.isSafeInteger(cursor)||cursor<0)
      throw new Error('Invalid transport cursor');
    const folder=dirname(this.path);await mkdir(folder,{recursive:true,mode:0o700});
    const temporary=this.path+'.'+randomUUID()+'.tmp';
    const file=await open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify({epoch,cursor,kind,claimedAt:Date.now()})+'\n');await file.sync();}
    finally{await file.close();}
    await rename(temporary,this.path);
    const dir=await open(folder,'r');try{await dir.sync();}finally{await dir.close();}
  }
}
