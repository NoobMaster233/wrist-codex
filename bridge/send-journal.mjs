import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const digest=value=>createHash('sha256').update(value).digest('hex');

/** Store intent before turn/start. Unknown outcomes stay blocked after restart. */
export class SendJournal {
  constructor({root, limit=256}={}) {
    this.root=root;this.limit=limit;this.entries=new Map();
  }
  path(id) { return join(this.root,digest(id)+'.json'); }
  async read(id) {
    if (!this.root) return null;
    try {
      const record=JSON.parse(await readFile(this.path(id),'utf8'));
      if (record.schema!==1 || record.id!==id || !['starting','confirmed'].includes(record.phase))
        throw new Error('发送记录无效，请在手机核对对话');
      if (!/^[a-f0-9]{64}$/.test(record.signature) || (record.phase==='confirmed' &&
          (typeof record.result?.threadId!=='string' || typeof record.result?.turnId!=='string')))
        throw new Error('发送记录不完整，请在手机核对对话');
      return record;
    } catch(error) { if (error.code==='ENOENT') return null;throw error; }
  }
  async write(record) {
    if (!this.root) return;
    await mkdir(this.root,{recursive:true,mode:0o700});
    const path=this.path(record.id),temporary=path+'.'+randomUUID()+'.tmp';
    try {
      const file=await open(temporary,'wx',0o600);
      try { await file.writeFile(JSON.stringify(record));await file.sync(); }
      finally { await file.close(); }
      await rename(temporary,path);
    } finally { await rm(temporary,{force:true}); }
  }
  run(id, payload, prepare, submit) {
    const signature=digest(JSON.stringify(payload)),previous=this.entries.get(id);
    if (previous) {
      if (previous.signature!==signature) return Promise.reject(new Error('Request id reused with different content'));
      return previous.promise;
    }
    while (this.entries.size>=this.limit) {
      const oldest=[...this.entries].find(([,value])=>value.settled && (this.root || value.safeToRetry));
      if (!oldest) return Promise.reject(new Error('发送记录繁忙，请稍后重试'));
      this.entries.delete(oldest[0]);
    }
    const entry={signature,settled:false};
    // Defer work until the in-flight entry exists, including concurrent retries.
    entry.promise=Promise.resolve().then(async()=>{
      const prior=await this.read(id);
      if (prior) {
        if (prior.signature!==signature) throw new Error('Request id reused with different content');
        if (prior.phase==='confirmed') return prior.result;
        throw new Error('上次发送结果尚未确认，请在手机核对对话，避免重复发送');
      }
      try {
        await prepare();
        await this.write({schema:1,id,signature,phase:'starting',at:Date.now()});
      } catch(error) {error.sendNotStarted=true;entry.safeToRetry=true;throw error;}
      const result=await submit();
      await this.write({schema:1,id,signature,phase:'confirmed',at:Date.now(),result});
      return result;
    });
    this.entries.set(id,entry);
    entry.promise.then(()=>{entry.settled=true;},()=>{
      entry.settled=true;
      if (entry.safeToRetry) this.entries.delete(id);
    });
    return entry.promise;
  }
}
