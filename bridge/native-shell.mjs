import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeShellRequest, decodeShellStatus, SHELL_FLAGS } from './shell-protocol.mjs';

const uuid = id => typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const terminal = job => ['complete','failed','unknown'].includes(job.phase);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// One executor request at a time. A saved intent never automatically becomes a
// second execution, including after a relay restart or a lost native event.
export class NativeShell {
  constructor({root, sendFile, receiveFile, dispatch, readBlob, now=Date.now}) {
    Object.assign(this,{root,sendFile,receiveFile,dispatch,readBlob,now});
    this.jobs=new Map();this.chain=Promise.resolve();
  }
  serial(fn) {
    const result=this.chain.catch(()=>{}).then(fn);this.chain=result;return result;
  }
  async init() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    for(const name of await readdir(this.root)) {
      if(!name.endsWith('.json') || !uuid(name.slice(0,-5)))continue;
      const bytes=await readFile(join(this.root,name));if(bytes.length>16384)throw new Error('Oversized shell journal');
      const job=JSON.parse(bytes);
      if(job.id!==name.slice(0,-5)||!uuid(job.id))throw new Error('Invalid shell journal identity');
      this.jobs.set(job.id,job);
      if(!terminal(job)) {
        job.phase=job.dispatched?'unknown':'failed';
        job.error=job.dispatched?'桥接重启，执行结果待核实；未重发命令':'桥接重启，命令尚未提交';
        job.finishedAt=this.now();await this.save(job);
      }
    }
  }
  blocking() { return [...this.jobs.values()].find(job=>!terminal(job)||(job.phase==='unknown'&&!job.unknownAcknowledged)); }
  requireIdle(owner) {
    const job=this.blocking();if(job && owner!==job.id)throw new Error(job.phase==='unknown'?'上次命令结果未知，请先只读核实':'手环命令任务进行中');
  }
  snapshot(id) {
    const j=this.jobs.get(id);if(!j)return null;
    const {requestSha,requestSize,requestCrc,timeoutMs,outputLimit,event,...publicJob}=j;
    return {...publicJob,timeoutMs,outputLimit};
  }
  list() { return [...this.jobs.values()].sort((a,b)=>a.startedAt-b.startedAt).slice(-16).map(job=>this.snapshot(job.id)); }
  async save(job) {
    const path=join(this.root,job.id+'.json'),part=path+'.tmp';
    await writeFile(part,JSON.stringify(job)+'\n',{mode:0o600});await rename(part,path);
  }
  async start(command,options={}) {
    return this.serial(async()=>{
      this.requireIdle();
      const bytes=encodeShellRequest(command,options);
      const receipt=this.sendFile(bytes,'shell-request.bin');
      const id=receipt.id.slice(5);if(!uuid(id))throw new Error('Invalid shell transfer identity');
      const job={id,phase:'sending',startedAt:this.now(),deadline:this.now()+120000,dispatched:false,
        requestSha:digest(bytes),requestSize:bytes.length,requestCrc:bytes.readUInt32LE(20),
        timeoutMs:bytes.readUInt32LE(12),outputLimit:bytes.readUInt32LE(24)};
      this.jobs.set(id,job);await this.save(job);return this.snapshot(id);
    });
  }
  async receivedRequest(receipt) {
    return this.serial(async()=>{
      const job=this.jobs.get(receipt.id?.slice(5));if(!job||job.phase!=='sending')return;
      if(receipt.state!=='complete')return this.finish(job,'failed',receipt.error||'命令文件传输失败');
      if(receipt.sha256!==job.requestSha||receipt.size!==job.requestSize||receipt.metadata?.length!==job.requestSize)
        return this.finish(job,'failed','命令文件回执不一致');
      // Persist before queueing an exec event. Restart never replays this event.
      job.dispatched=true;job.phase='executing';job.deadline=this.now()+120000;await this.save(job);
      try { this.dispatch({bc_command:'nativeShellControl',requestId:job.id,timeoutMs:job.timeoutMs,expiresAt:job.deadline}); }
      catch(error){await this.finish(job,'unknown','命令下发结果未知');}
    });
  }
  async result(params) {
    return this.serial(async()=>{
      const job=this.jobs.get(params.id);if(!job)throw new Error('Unknown shell request');
      if(job.phase!=='executing')return {accepted:false};
      if(params.notStarted===true)return this.finish(job,'failed','手环正忙，命令未提交');
      if(!['done','unknown','no-event'].includes(params.op))throw new Error('Invalid shell event operation');
      if(params.op!=='no-event' && (!Number.isInteger(params.r)||params.r < -2147483648||params.r>2147483647||
         !Number.isInteger(params.f)||params.f<0||params.f>255||!Number.isInteger(params.b)||params.b<0||params.b>32768||
         !Number.isInteger(params.e)||params.e < -2147483648||params.e>2147483647))throw new Error('Invalid shell event fields');
      job.event={op:params.op,r:params.r,f:params.f,b:params.b,e:params.e};
      return this.fetchStatus(job);
    });
  }
  async fetchStatus(job) {
    job.phase='receiving-status';job.deadline=this.now()+120000;
    await this.save(job);
    try {job.uploadId=this.receiveFile('bc-shell-'+job.id+'.status',job.id).id;await this.save(job);}
    catch(error){await this.finish(job,'unknown','无法读取手环执行回执');}
    return {accepted:true};
  }
  async reconcile(id) {
    return this.serial(async()=>{
      const job=this.jobs.get(id);if(!job||job.phase!=='unknown')throw new Error('Only an unknown result can be reconciled');
      // Read files only. No publish, dispatch or execution retry.
      const other=[...this.jobs.values()].some(j=>j.id!==id&&!terminal(j));
      if(other)throw new Error('Another shell task is active');
      // A previously validated terminal receipt remains authoritative across a
      // failed output transfer. Read only that missing file; fetching status
      // again would recreate the same final-ACK handoff on older band Apps.
      const s=job.status;
      if(s && ['completed','timeout','output-limit'].includes(s.outcome) && s.outputBytes>0 &&
         s.commandCrc===job.requestCrc && s.timeoutMs===job.timeoutMs && s.outputBytes<=job.outputLimit) {
        await this.fetchOutput(job);
      } else {job.event={op:'no-event'};await this.fetchStatus(job);}
      return this.snapshot(id);
    });
  }
  async acknowledgeUnknown(id,reason) {
    return this.serial(async()=>{
      const job=this.jobs.get(id);
      if(!job||job.phase!=='unknown')throw new Error('Only an unknown result can be closed');
      if(typeof reason!=='string'||reason.trim().length<8||reason.length>240)throw new Error('Provide a specific reason for retaining an unknown result');
      // Keep the unknown result and every receipt. This is an explicit
      // release of the phone queue, never success or an execution retry.
      job.unknownAcknowledged={at:this.now(),reason:reason.trim()};await this.save(job);
      return this.snapshot(id);
    });
  }
  async fetchOutput(job) {
    job.phase='receiving-output';job.deadline=this.now()+120000;await this.save(job);
    try {job.uploadId=this.receiveFile('bc-shell-'+job.id+'.out',job.id).id;await this.save(job);}
    catch(error){await this.finish(job,'unknown','无法读取手环命令输出');}
  }
  async uploaded(receipt) {
    return this.serial(async()=>{
      const job=[...this.jobs.values()].find(j=>j.uploadId===receipt.id&&!terminal(j));if(!job)return;
      if(receipt.phase!=='complete')return this.finish(job,'unknown','执行结果文件回传失败');
      let bytes;
      try {
        bytes=await this.readBlob(receipt.id);
        if(bytes.length!==receipt.size||digest(bytes)!==receipt.sha256)throw new Error('Blob digest differs');
        if(job.phase==='receiving-status') {
          const status=decodeShellStatus(bytes);
          if(status.commandCrc!==job.requestCrc||status.timeoutMs!==job.timeoutMs||status.outputBytes>job.outputLimit)
            throw new Error('Command receipt identity differs');
          job.status=status;
          if(status.outcome==='unknown'||status.outcome==='pending')return this.finish(job,'unknown','手环尚未确认任务回收');
          const e=job.event;
          if(e?.op==='done' && (e.r!==status.rawStatus||(e.f&~SHELL_FLAGS.duplicate)!==status.flags||e.b!==status.outputBytes||e.e!==status.error))
            throw new Error('Event and saved receipt differ');
          if(status.outcome==='spawn-failed')return this.finish(job,'complete');
          // This is the native receipt's snapshot at direct-child reaping.
          // A detached task can inherit stdout and append after that snapshot.
          // An authoritative empty result needs no mutable output-file read.
          if(status.outputBytes===0){job.outputBytes=0;return this.finish(job,'complete');}
          await this.fetchOutput(job);
        } else if(job.phase==='receiving-output') {
          if(bytes.length!==job.status.outputBytes)throw new Error('Command output length differs');
          await writeFile(join(this.root,job.id+'.out'),bytes,{mode:0o600,flag:'wx'});
          job.outputSha256=digest(bytes);job.outputBytes=bytes.length;await this.finish(job,'complete');
        }
      }catch(error){await this.finish(job,'unknown','执行回执或输出校验失败');}
    });
  }
  async output(id) {
    const job=this.jobs.get(id);if(!job||job.phase!=='complete')throw new Error('Shell output is not complete');
    if(!job.outputSha256)return Buffer.alloc(0);
    const bytes=await readFile(join(this.root,id+'.out'));
    if(bytes.length!==job.outputBytes||digest(bytes)!==job.outputSha256)throw new Error('Saved shell output differs');
    return bytes;
  }
  async finish(job,phase,error) {
    job.phase=phase;job.finishedAt=this.now();if(error)job.error=error;else delete job.error;
    await this.save(job);
    try{this.dispatch({bc_command:'nativeShellRelease',requestId:job.id,state:this.snapshot(job.id)});}catch(_){}
    return {accepted:true};
  }
  expire() {
    return this.serial(async()=>{
      for(const job of this.jobs.values())if(!terminal(job)&&this.now()>=job.deadline)
        await this.finish(job,job.dispatched?'unknown':'failed',job.dispatched?'命令结果超时，未重发命令':'命令文件传输超时，未执行');
    });
  }
}
