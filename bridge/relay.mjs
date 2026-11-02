import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { watchThread } from './thread-feed.mjs';
import { FileDeliveries } from './file-delivery.mjs';
import { crc32, encode64 } from '../band/src/common/bytes.mjs';
import { ownFileName } from '../band/src/common/file-upload.mjs';
import { RequestCache } from './request-cache.mjs';

// Coordinates the existing band protocol; no HTTP or process lifecycle here.
export class AstroRelay {
  constructor(service) {
    this.service = service; this.events = []; this.sequence = 0; this.lastSeen = 0;
    this.requests = new RequestCache(); this.connected = false;
    this.epoch = randomUUID();
    this.fileDeliveries = new FileDeliveries();
  }
  nativeRecordingCommand(data) {
    if(data.action==='cancel'){
      this.events=this.events.filter(e=>!(e.data?.bc_command==='nativeAudioControl'&&e.data.sessionId===data.sessionId));
      const job=this.fileUpload;
      if(job?.nativeSessionId===data.sessionId&&job.phase==='pending'){
        job.phase='error';job.error='录音已取消';
        this.events=this.events.filter(e=>e.data?.transferId!==job.id);
        this.blobs.frame({t:'cancel',id:job.id}).catch(()=>{});
      }
    }
    this.enqueue('band',{bc_command:'nativeAudioControl',...data});
  }
  startNativeAudioCheck() {
    this.shell?.requireIdle();
    this.requireNativeRecoveryIdle();
    if(!this.nativeOnly||!this.decodeNativeAudio)throw new Error('Native audio is not enabled');
    if(!this.connected||Date.now()-this.lastSeen>15000)throw new Error('请先连接手环');
    if(this.nativeAudioCheck?.phase==='pending'||['preparing','recording','receiving','transcribing','ready'].includes(this.recording.state.phase)||
      this.fileUpload?.phase==='pending'||this.fileProbe?.phase==='pending'||this.nativeProbe?.phase==='pending'||this.fileDeliveries.active())
      throw new Error('请先完成当前录音或文件任务');
    const check=this.nativeAudioCheck={id:randomUUID(),phase:'pending',stage:'queued',startedAt:Date.now()};
    // This diagnostic never enters DirectRecording, ASR or prompt.send. The
    // cancellation deadline also invalidates a start delayed in the BLE queue.
    this.nativeAudioCheckDeadline=setTimeout(()=>this.finishNativeAudioCheck('error','录音自检超时'),30000);
    this.nativeAudioCheckDeadline.unref?.();
    try{this.nativeRecordingCommand({action:'start',sessionId:check.id,expiresAt:check.startedAt+25000});}
    catch(error){this.finishNativeAudioCheck('error','录音自检无法启动');throw error;}
    return {...check};
  }
  requireNativeRecoveryIdle() {
    this.expireNativeRecovery();
    if(this.nativeRecovery?.phase==='pending')throw new Error('正在恢复录音服务，请稍候');
  }
  expireNativeRecovery() {
    const job=this.nativeRecovery;
    if(job?.phase==='pending'&&Date.now()>=job.expiresAt){
      job.phase='error';job.message='录音服务恢复回执超时，请检查手环状态';
      this.events=this.events.filter(e=>e.kind!=='maintenance'||e.data.id!==job.id);
    }
  }
  startNativeRecovery() {
    this.shell?.requireIdle();
    this.requireNativeRecoveryIdle();
    if(!this.nativeOnly||!this.connected||Date.now()-this.lastSeen>15000)throw new Error('请先连接手环并启用原生录音模式');
    if(this.nativeAudioCheck?.phase==='pending'||['preparing','recording','receiving','transcribing','ready'].includes(this.recording.state.phase)||
      this.fileUpload?.phase==='pending'||this.fileProbe?.phase==='pending'||this.nativeProbe?.phase==='pending'||this.fileDeliveries.active())
      throw new Error('请先完成当前录音或文件任务');
    const job={id:randomUUID(),phase:'pending',startedAt:Date.now(),expiresAt:Date.now()+90000};
    this.enqueue('maintenance',{id:job.id,action:'native-audio-recover',expiresAt:job.expiresAt});
    this.nativeRecovery=job;return {...job};
  }
  finishNativeAudioCheck(phase,error) {
    const check=this.nativeAudioCheck;
    if(check?.phase!=='pending')return;
    clearTimeout(this.nativeAudioCheckDeadline);clearTimeout(this.nativeAudioCheckStop);
    check.phase=phase;check.finishedAt=Date.now();
    if(error)check.error=error;
    if(phase!=='complete')this.nativeRecordingCommand({action:'cancel',sessionId:check.id});
  }
  nativeAudioCheckState(params) {
    const check=this.nativeAudioCheck;
    if(!check||params.sessionId!==check.id)return null;
    if(check.phase!=='pending')return {accepted:false};
    if(params.phase==='recording'){
      if(check.stage==='queued'){
        check.stage='recording';check.recordingAt=Date.now();
        clearTimeout(this.nativeAudioCheckDeadline);
        this.nativeAudioCheckDeadline=setTimeout(()=>this.finishNativeAudioCheck('error','录音结束回执超时'),12000);
        this.nativeAudioCheckDeadline.unref?.();
        this.nativeAudioCheckStop=setTimeout(()=>{
          if(check.phase!=='pending')return;
          check.stage='stopping';this.nativeRecordingCommand({action:'stop',sessionId:check.id});
        },1000);
        this.nativeAudioCheckStop.unref?.();
      }
    }else if(params.phase==='receiving'){
      const name='bc-audio-'+check.id.replace(/-/g,'')+'.bcap';
      if(params.name!==name)throw new Error('Native diagnostic file differs');
      check.name=name;this.finishNativeAudioCheck('complete');
    }else if(params.phase==='cancelled'||params.phase==='error')this.finishNativeAudioCheck('error','手环录音自检失败');
    else throw new Error('Unknown native diagnostic state');
    return {accepted:true};
  }
  enqueue(kind, data) {
    if (kind === 'band' && data.event === 'messages.updated')
      this.events = this.events.filter(e => !(e.kind === 'band' && e.data.event === data.event && e.data.watchId === data.watchId));
    if (kind === 'band' && ['recordingState','recordingResume'].includes(data.bc_command))
      this.events = this.events.filter(e => !(e.kind === 'band' && e.data.bc_command === data.bc_command));
    if (this.events.length >= 128) throw new Error('手机事件队列已满，请重新连接');
    this.events.push({ id: ++this.sequence, kind, data });
  }
  poll(cursor, epoch = this.epoch) {
    this.expireFileUpload();
    this.expireFileProbe();
    this.expireNativeProbe();
    this.expireNativeLoaderReport();
    this.events = this.events.filter(e => e.data?.bc_command !== 'fileReceive' ||
      this.fileDeliveries.snapshot(e.data.transferId)?.state === 'sending');
    this.events=this.events.filter(e=>e.data?.bc_command!=='nativeShellControl'||
      (this.shell?.snapshot(e.data.requestId)?.phase==='executing'&&Date.now()<e.data.expiresAt));
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor');
    const reset = epoch !== this.epoch;
    if (reset) cursor = 0;
    if (cursor > this.sequence) throw new Error('Invalid cursor');
    this.lastSeen = Date.now(); this.connected = true; this.events = this.events.filter(e => e.id > cursor);
    // This is phone-to-loopback scheduling; the band stays event driven. Idle
    // WASM callbacks previously consumed enough background CPU for Android to
    // kill AstroBox. Keep capture/file deadlines fast and drain queued events.
    const transferring = !!this.shell?.list().some(j=>!['complete','failed','unknown'].includes(j.phase)) || ['preparing','recording','receiving','transcribing'].includes(this.recording?.state.phase) ||
      [this.fileUpload,this.fileProbe,this.nativeProbe,this.nativeLoaderReport,this.nativeAudioCheck,this.nativeRecovery]
        .some(job => job?.phase === 'pending') || this.fileDeliveries.active();
    const pollAfterMs = this.events.length ? 250 : transferring ? 750 : this.watchId ? 1500 : 4000;
    return { epoch: this.epoch, reset, event: this.events[0] || null, pollAfterMs };
  }
  async rpc(request) {
    if (typeof request.id !== 'string' || request.id.length > 100 || typeof request.method !== 'string') throw new Error('Invalid request');
    this.lastBandRpcAt = Date.now();
    // File frames have their own bounded sequence/duplicate handling. Keeping
    // every chunk in the prompt RPC cache would exhaust it after a large file.
    if (request.method === 'blob.frame' || request.method === 'files.pull') {
      try { return { v: 1, id: request.id, result: await this.handle(request) }; }
      catch (error) { return { v: 1, id: request.id, error: error.message }; }
    }
    const signature = JSON.stringify(request);
    const prior = this.requests.get(request.id);
    if (prior) {
      if (prior.signature !== signature) throw new Error('Request id reused');
      return prior.promise;
    }
    const entry = { signature, method: request.method, startedAt: Date.now(), settled: false };
    this.requests.reserve(request.id,entry);
    const promise = this.handle(request).then(result => ({ v: 1, id: request.id, result }),
      error => ({ v: 1, id: request.id, error: error.message, ...(error.sendNotStarted ? { retryable: true } : {}),
        ...(error.recordingPending ? { recordingPending: error.recordingPending } : {}) }));
    entry.promise = promise;
    promise.then(response => {
      entry.settled = true; entry.failed = !!response.error;
      if (response.retryable) this.requests.delete(request.id);
    });
    return promise;
  }
  async handle({ id, method, params = {} }) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid parameters');
    if(method==='native.audio.authorize'){
      const session=params.sessionId;
      if(!/^[a-f0-9-]{36}$/.test(session||''))throw new Error('Invalid recording session');
      const check=this.nativeAudioCheck,s=this.recording?.state;
      const until=check?.id===session&&check.phase==='pending'&&check.stage==='queued'?check.startedAt+25000:
        s?.id===session&&s.phase==='preparing'?s.expiresAt:0;
      this.authorizedCaptures||=new Set();
      if(until<=Date.now()||this.authorizedCaptures.has(session))return {allowed:false,leaseMs:0};
      this.authorizedCaptures.add(session);
      if(this.authorizedCaptures.size>32)this.authorizedCaptures.delete(this.authorizedCaptures.values().next().value);
      return {allowed:true,leaseMs:Math.min(5000,until-Date.now())};
    }
    if(method==='device.shell.start'){
      if(!this.shell)throw new Error('手环终端尚未启用');
      if(['preparing','recording','receiving','transcribing'].includes(this.recording?.state.phase)||this.fileDeliveries.active()||this.fileUpload?.phase==='pending')
        throw new Error('请先完成当前录音或文件任务');
      return this.shell.start(params.command,{timeoutMs:3000,outputLimit:8192});
    }
    if(method==='device.shell.status'){
      const state=this.shell?.snapshot(params.id);if(!state)throw new Error('没有找到这条命令');return state;
    }
    if(method==='device.shell.output'){
      if(!this.shell)throw new Error('手环终端尚未启用');
      const bytes=await this.shell.output(params.id);
      const text=Array.from(bytes.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,''));
      return {text:text.slice(0,6000).join(''),bytes:bytes.length,truncated:text.length>6000};
    }
    if (method === 'blob.frame') {
      if (!this.blobs) throw new Error('File receiver is not enabled');
      this.expireFileUpload();
      if(params.id===this.fileUpload?.id&&this.fileUpload.phase==='pending')this.fileUpload.updatedAt=Date.now();
      return this.blobs.frame(params);
    }
    if (method === 'files.uploaded') {
      this.expireFileUpload();
      const job=this.fileUpload;
      if(!job||params.id!==job.id)throw new Error('Unknown file upload');
      if(job.phase!=='pending')return this.fileUploadStatus(job.id);
      const received=this.blobs?.snapshot(job.id);
      if(typeof params.error==='string'){
        job.phase='error';job.error=params.error.slice(0,100);
        await this.blobs?.frame({t:'cancel',id:job.id}).catch(()=>{});
      }
      else if(received?.state==='complete'&&received.size===params.size&&received.crc===params.crc){
        job.phase='complete';job.size=received.size;job.sha256=received.sha256;job.crc=received.crc;
      }else throw new Error('File upload receipt differs');
      if(job.nativeSessionId){
        if(job.phase==='error')await this.recording.cancel(job.nativeSessionId,'error',job.error);
        else if(this.recording.state.id===job.nativeSessionId&&this.recording.state.phase==='receiving'){
          try{
            const audio=await this.decodeNativeAudio(job);
            if(this.recording.state.id===job.nativeSessionId&&this.recording.state.phase==='receiving')
              await this.recording.ingest(job.nativeSessionId,audio);
          }catch{
            await this.recording.cancel(job.nativeSessionId,'error','录音解码失败或声音太短，请重新录音');
          }
        }
      }
      const receipt=this.fileUploadStatus(job.id);
      await this.shell?.uploaded(receipt);
      return receipt;
    }
    if(method==='native.audio.state'){
      if(!this.nativeOnly||!this.decodeNativeAudio)throw new Error('Native audio is not enabled');
      const diagnostic=this.nativeAudioCheckState(params);
      if(diagnostic)return diagnostic;
      const s=this.recording.state;
      if(params.sessionId!==s.id||!['preparing','recording','receiving'].includes(s.phase))return {accepted:false};
      if(params.phase==='receiving'){
        const name='bc-audio-'+s.id.replace(/-/g,'')+'.bcap';
        if(params.name!==name)throw new Error('Native recording file differs');
        if(this.fileUpload?.nativeSessionId===s.id){
          const job=this.fileUpload;
          if(job.phase==='pending'&&!this.events.some(e=>e.data?.transferId===job.id)){
            job.updatedAt=Date.now();
            this.enqueue('band',{bc_command:'fileUpload',transferId:job.id,name:job.name,chunkBytes:job.chunkBytes,purpose:'audio',sessionId:s.id});
          }
          return {accepted:true};
        }
        await this.recording.telemetry({sessionId:s.id,phase:'receiving'});
        try{this.startFileUpload(name,1024,s.id);}
        catch{await this.recording.cancel(s.id,'error','录音已保存，但蓝牙文件通道未就绪，请重新录音');}
      }else if(params.phase==='recording'||params.phase==='error')await this.recording.telemetry(params);
      else if(params.phase==='cancelled')await this.recording.cancel(s.id);
      else throw new Error('Unknown native recording state');
      return {accepted:true};
    }
    if (method === 'files.pull') return this.fileDeliveries.frame(params);
    if (method === 'files.received') {
      const receipt=this.fileDeliveries.finish(params);
      await this.shell?.receivedRequest(receipt);return receipt;
    }
    if (method === 'native.shell.report') {
      if(!this.shell)throw new Error('Native shell is unavailable');
      return this.shell.result(params);
    }
    if (method === 'native.loader.report') {
      this.expireNativeLoaderReport();
      if (!this.nativeLoaderReport || params.id!==this.nativeLoaderReport.id || this.nativeLoaderReport.phase!=='pending')
        throw new Error('Unknown native loader report');
      if (!params.reports || typeof params.reports!=='object' || Array.isArray(params.reports)) throw new Error('Invalid loader report');
      const reports={};
      for (const name of ['report.txt','rc.txt','log.txt','fw.txt']) {
        const value=params.reports[name];
        if (!value || typeof value!=='object') throw new Error('Missing report field');
        if (typeof value.text==='string' && value.text.length<=2048 && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(value.text)) reports[name]={text:value.text};
        else if (typeof value.error==='string' && value.error.length<=100) reports[name]={error:value.error};
        else throw new Error('Invalid report field');
      }
      this.nativeLoaderReport={...this.nativeLoaderReport,phase:'complete',reports};
      return {accepted:true};
    }
    if (method === 'capabilities.report') {
      if (!this.fileProbe || params.id !== this.fileProbe.id || this.fileProbe.phase !== 'pending') throw new Error('Unknown capability probe');
      const received = this.blobs?.snapshot(params.id);
      const verified = params.fileReadWrite === true && received?.state === 'complete' &&
        received.size === this.fileProbe.size && received.sha256 === this.fileProbe.expectedSha256;
      this.fileProbe = { ...this.fileProbe, phase: verified ? 'complete' : 'error', fileReadWrite: verified,
        eventLoopback: params.event?.received === true, receivedBytes: received?.bytes || 0,
        receivedChunkBytes: received?.chunkBytes,
        uploadChunkBytesVerified: received?.chunkBytes === this.fileProbe.uploadChunkBytes,
        ...(typeof params.error === 'string' ? { error: params.error.slice(0,100) } : {}) };
      return { verified, bytes: received?.bytes || 0, eventLoopback: this.fileProbe.eventLoopback,
        receivedChunkBytes:received?.chunkBytes, uploadChunkBytesVerified:this.fileProbe.uploadChunkBytesVerified };
    }
    if (method === 'capabilities.progress') {
      if (!this.fileProbe || params.id !== this.fileProbe.id || this.fileProbe.phase !== 'pending') throw new Error('Unknown capability probe');
      if (!['received','writing','reading','events','uploading'].includes(params.stage)) throw new Error('Unknown probe stage');
      this.fileProbe.stage = params.stage; this.fileProbe.updatedAt = Date.now();
      return { accepted: true };
    }
    if (method === 'native.capabilities.progress' || method === 'native.capabilities.report') {
      this.expireNativeProbe();
      const probe = this.nativeProbe;
      if (!probe || probe.id !== params.id || probe.phase !== 'pending') throw new Error('Unknown native event probe');
      if (method === 'native.capabilities.progress') {
        if (params.stage !== 'armed') throw new Error('Unknown native probe stage');
        probe.stage = 'armed'; return { accepted:true };
      }
      probe.nativeTx = params.nativeTx === true;
      probe.nativeRx = probe.nativeTx && params.nativeRx === true;
      probe.phase = probe.nativeRx ? 'complete' : probe.nativeTx ? 'partial' : 'error';
      if (typeof params.error === 'string') probe.error = params.error.slice(0,100);
      return { verified:probe.nativeRx, nativeTx:probe.nativeTx, nativeRx:probe.nativeRx, nativeCapture:false };
    }
    if (method === 'recording.arm' && this.nativeOnly && !this.decodeNativeAudio)
      throw new Error('原生录音接口尚在接入，当前不会启动系统录音机');
    if(method==='recording.arm'&&this.nativeAudioCheck?.phase==='pending')throw new Error('录音自检进行中，请稍候');
    if(method==='recording.arm')this.requireNativeRecoveryIdle();
    if (method.startsWith('recording.')) return this.recording.handle({ method, params });
    if (method === 'voice.request') {
      const state = this.recording.snapshot(params.threadId);
      if (state.phase !== 'ready') throw new Error('当前对话还没有录音文字，请点手环录音');
      return { text: state.text, sessionId: state.sessionId, target: state.target };
    }
    if (method === 'messages.unwatch') {
      if (params.watchId === this.watchId) this.unwatch();
      return { stopped: true };
    }
    if (method === 'messages.watch') {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(params.watchId || '')) throw new Error('Invalid watch id');
      this.service.requireThread(params);
      this.unwatch(); this.watchId = params.watchId; this.threadId = params.threadId; this.pushSequence = 0;
      const initial = await this.service.handle({ method: 'messages.list', params });
      const watchId = this.watchId, threadId = this.threadId;
      let previous = JSON.stringify(initial);
      this.stopWatch = watchThread(this.service, threadId, result => {
        if (this.watchId !== watchId || JSON.stringify(result) === previous) return;
        previous = JSON.stringify(result);
        this.enqueue('band', { v: 1, event: 'messages.updated', watchId, threadId, sequence: ++this.pushSequence, result });
      }, () => {
        if (this.watchId === watchId) this.enqueue('band', { v: 1, event: 'messages.connection', watchId, threadId,
          sequence: ++this.pushSequence, message: '连接已中断，请返回对话重连' });
      });
      return initial;
    }
    const result = await this.service.handle({ id, method, params });
    const draft = this.recording.snapshot(params.threadId);
    if (method === 'prompt.send' && draft.phase === 'ready' && draft.text === params.text)
      await this.recording.handle({ method: 'recording.ack', params: { threadId: params.threadId, sessionId: draft.sessionId } });
    return result;
  }
  unwatch() {
    const old = this.watchId; this.stopWatch?.(); this.stopWatch = null; this.watchId = null;
    this.events = this.events.filter(e => !(e.kind === 'band' && e.data.watchId === old));
  }
  restoreRecording() {
    if (this.nativeOnly&&!this.decodeNativeAudio) return false;
    const s = this.recording.state;
    if (!s.target || !['preparing','recording','receiving','transcribing','ready'].includes(s.phase)) return false;
    this.enqueue('band', { bc_command: 'recordingResume', sessionId: s.id, target: s.target,
      phase: s.phase, state: this.recording.snapshot(s.target.threadId) });
    return true;
  }
  expireFileProbe() {
    if (this.fileProbe?.phase === 'pending' && Date.now() - this.fileProbe.startedAt >= 30000) {
      this.fileProbe.phase = 'error'; this.fileProbe.error = '通道检查超时，可重新检查';
      this.events = this.events.filter(e => e.data?.probeId !== this.fileProbe.id);
      this.blobs?.frame({ t:'cancel', id:this.fileProbe.id }).catch(() => {});
    }
  }
  expireFileUpload() {
    const job=this.fileUpload;
    if(job?.phase==='pending'&&Date.now()-job.updatedAt>=120000){
      job.phase='error';job.error='手环文件回传超时';
      this.events=this.events.filter(e=>e.data?.transferId!==job.id);
      this.blobs?.frame({t:'cancel',id:job.id}).catch(()=>{});
      if(job.nativeSessionId)this.recording.cancel(job.nativeSessionId,'error',job.error).catch(()=>{});
    }
  }
  fileUploadStatus(id) {
    this.expireFileUpload();
    if(this.fileUpload?.id!==id)return null;
    return {...this.fileUpload,received:this.blobs?.snapshot(id)||null};
  }
  startFileUpload(name,chunkBytes=1024,nativeSessionId,shellOwner) {
    this.shell?.requireIdle(shellOwner);
    this.requireNativeRecoveryIdle();
    ownFileName(name);this.expireFileUpload();this.expireFileProbe();this.expireNativeProbe();
    if(this.nativeAudioCheck?.phase==='pending')throw new Error('录音自检进行中，请稍候');
    if(![128,1024].includes(chunkBytes))throw new Error('Invalid upload chunk size');
    if(!this.blobs)throw new Error('File receiver is not enabled');
    if(!this.connected||Date.now()-this.lastSeen>15000)throw new Error('请先连接手环');
    if(nativeSessionId&&(!/^[0-9a-f-]{36}$/.test(nativeSessionId)||nativeSessionId!==this.recording?.state.id))throw new Error('Native recording session differs');
    if(!nativeSessionId&&this.nativeOnly&&['preparing','recording','receiving'].includes(this.recording?.state.phase))throw new Error('请先完成当前录音');
    if(this.fileUpload?.phase==='pending'||this.fileProbe?.phase==='pending'||this.nativeProbe?.phase==='pending'||this.fileDeliveries.active())
      throw new Error('A file task is already running');
    const job={id:'upload-'+randomUUID(),name,chunkBytes,phase:'pending',startedAt:Date.now(),updatedAt:Date.now(),...(nativeSessionId?{nativeSessionId}:{})};
    this.enqueue('band',{bc_command:'fileUpload',transferId:job.id,name,chunkBytes,
      ...(nativeSessionId?{purpose:'audio',sessionId:nativeSessionId}:{}),...(shellOwner?{purpose:'shell',sessionId:shellOwner}:{})});this.fileUpload=job;
    return this.fileUploadStatus(job.id);
  }
  startFileProbe(size = 1024, uploadChunkBytes = 128) {
    this.shell?.requireIdle();
    this.requireNativeRecoveryIdle();
    if(this.nativeAudioCheck?.phase==='pending')throw new Error('录音自检进行中，请稍候');
    if(this.nativeOnly&&['preparing','recording','receiving'].includes(this.recording?.state.phase))throw new Error('请先完成当前录音');
    this.expireFileUpload();
    if(this.fileUpload?.phase==='pending')throw new Error('File upload already running');
    this.expireFileProbe();
    this.expireNativeProbe();
    if (!this.blobs) throw new Error('File receiver is not enabled');
    if (!this.connected || Date.now() - this.lastSeen > 15000) throw new Error('请先连接手环');
    if (this.fileProbe?.phase === 'pending') throw new Error('Capability probe already running');
    if (this.nativeProbe?.phase === 'pending') throw new Error('Native event probe already running');
    if (this.fileDeliveries.active()) throw new Error('File delivery already running');
    if (!Number.isInteger(size) || size < 32 || size > 4096) throw new Error('Invalid probe length');
    if (![128,1024].includes(uploadChunkBytes)) throw new Error('Invalid upload chunk size');
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 73 + 19) & 255);
    this.fileProbe = { id: 'probe-' + randomUUID(), phase: 'pending', size: bytes.length, uploadChunkBytes,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'), startedAt: Date.now() };
    this.enqueue('band', { bc_command: 'capabilityProbe', probeId: this.fileProbe.id,
      size: bytes.length, crc: crc32(bytes), b64: encode64(bytes), uploadChunkBytes });
    return { id: this.fileProbe.id, size: bytes.length };
  }
  expireNativeProbe() {
    if (this.nativeProbe?.phase === 'pending' && Date.now() - this.nativeProbe.startedAt >= 125000) {
      this.nativeProbe.phase = 'error'; this.nativeProbe.error = '原生事件检测超时';
      this.events = this.events.filter(e => e.data?.probeId !== this.nativeProbe.id);
    }
  }
  startNativeProbe(receiveOnly = false) {
    this.shell?.requireIdle();
    this.requireNativeRecoveryIdle();
    if(this.nativeAudioCheck?.phase==='pending')throw new Error('录音自检进行中，请稍候');
    if(this.nativeOnly&&['preparing','recording','receiving'].includes(this.recording?.state.phase))throw new Error('请先完成当前录音');
    this.expireFileUpload();
    if(this.fileUpload?.phase==='pending')throw new Error('File upload already running');
    this.expireNativeProbe(); this.expireFileProbe();
    if (!this.connected || Date.now()-this.lastSeen > 15000) throw new Error('请先连接手环');
    if (this.nativeProbe?.phase === 'pending' || this.fileProbe?.phase === 'pending') throw new Error('A capability probe is already running');
    if (this.fileDeliveries.active()) throw new Error('File delivery already running');
    this.nativeProbe = {id:'native-'+randomUUID(), phase:'pending', stage:'queued', startedAt:Date.now(),
      nativeTx:false, nativeRx:false, nativeCapture:false};
    this.enqueue('band', {bc_command:'nativeEventProbe', probeId:this.nativeProbe.id, nonce:randomBytes(16).toString('hex'),receiveOnly:receiveOnly===true});
    return {id:this.nativeProbe.id};
  }
  requestNativeLoaderReport() {
    this.expireNativeLoaderReport();
    if (!this.connected || Date.now()-this.lastSeen>15000) throw new Error('请先连接手环');
    if (this.nativeLoaderReport?.phase==='pending' && Date.now()-this.nativeLoaderReport.startedAt<30000)
      throw new Error('Loader report already requested');
    this.nativeLoaderReport={id:'loader-'+randomUUID(),phase:'pending',startedAt:Date.now()};
    this.enqueue('band',{bc_command:'nativeLoaderReport',reportId:this.nativeLoaderReport.id});
    return {id:this.nativeLoaderReport.id};
  }
  expireNativeLoaderReport() {
    const report=this.nativeLoaderReport;
    if (report?.phase==='pending' && Date.now()-report.startedAt>=30000) {
      report.phase='error';report.error='手环诊断回执超时，手机插件在线不能证明手环已响应';
      this.events=this.events.filter(e=>e.data?.reportId!==report.id);
    }
  }
  startFileDelivery(bytes, name, chunkBytes=128) {
    this.shell?.requireIdle();
    this.requireNativeRecoveryIdle();
    if(this.nativeAudioCheck?.phase==='pending')throw new Error('录音自检进行中，请稍候');
    if(this.nativeOnly&&['preparing','recording','receiving'].includes(this.recording?.state.phase))throw new Error('请先完成当前录音');
    this.expireFileUpload();
    if(this.fileUpload?.phase==='pending')throw new Error('File upload already running');
    this.expireNativeProbe();this.expireFileProbe();
    if (!this.connected || Date.now()-this.lastSeen>15000) throw new Error('请先连接手环');
    if (this.nativeProbe?.phase==='pending'||this.fileProbe?.phase==='pending') throw new Error('A capability probe is already running');
    const transfer=this.fileDeliveries.start(bytes,name,chunkBytes);
    try { this.enqueue('band',{bc_command:'fileReceive',transferId:transfer.id,size:transfer.size,crc:transfer.crc,chunkBytes}); }
    catch (error) { this.fileDeliveries.finish({id:transfer.id,error:error.message}); throw error; }
    return transfer;
  }
  close() {
    clearTimeout(this.nativeAudioCheckDeadline);clearTimeout(this.nativeAudioCheckStop);
    this.unwatch();this.recording?.close();this.blobs?.close().catch(()=>{});
  }
}

