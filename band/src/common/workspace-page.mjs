import { createBandConnection, utf8Length } from './private-connection.mjs';
import { createNativeEventBus } from './native-event-bus.mjs';
import { runFileProbe } from './file-probe.mjs';
import { createNativeEventProbe } from './native-event-probe.mjs';
import { receiveFile } from './file-receive.mjs';
import { sendOwnFile } from './file-upload.mjs';
import { readNativeLoaderReport } from './native-loader-report.mjs';
import { createNativeAudioController } from './native-audio.mjs';
import { createNativeShellRequest } from './native-shell.mjs';
import { shellPresets, shellSummary } from './device-tools.mjs';

export default function createWorkspace({interconnect,file,loadEvent=()=>null,loadBrightness=()=>null}) {
return {
  private: {
    appVersion: '0.4.3', clockLabel: '', dateLabel: '', recordingSeconds: '00',
    view: 'home', title: '腕上 Codex', status: '正在检测手机连接', statusTone: 'neutral', busy: false,
    sending: false, sendUncertain: false,
    projects: [], threads: [], messages: [], cwd: '', projectName: '', threadId: '', threadTitle: '',
    threadCursor: null, messageCursor: null, draft: '', readingText: '', readingNext: null,
    readingOffset: 0, readingPage: 1, readingRole: '', viewingLatest: true, newReplies: false,
    recordingPhase: 'idle', recordingSession: '', recordingHelp: '', pendingRecording: null,
    shellPresets: shellPresets, shellResult: '', shellStateLabel: '选择一条命令', shellJob: '', shellRunning: false,
    shellCommandLabel: '', greeting: '夜深了，灵感还在。'
  },
  onInit() {
    this.instanceId=Date.now()+'-'+Math.floor(Math.random()*65536).toString(16);
    let nativeEvent;
    try { nativeEvent = loadEvent(); } catch (_) {}
    const eventTrace=[];
    this.nativeEventBus = nativeEvent ? createNativeEventBus(nativeEvent,{onTrace:entry=>{
      if(entry.name==='bc.link.req'&&!['timeout','publish-failed'].includes(entry.phase))return;
      eventTrace.push(entry);if(eventTrace.length>48)eventTrace.shift();
      try{file.writeText({uri:'internal://files/bc-native-events-v1.json',text:JSON.stringify({v:1,instanceId:this.instanceId,entries:eventTrace}),fail:()=>{}});}catch{}
    }}) : null;
    this.conn = createBandConnection({ event:this.nativeEventBus, file, legacy:()=>interconnect.instance() });
    this.pending = null;
    this.auxRequests = {}; this.destroyed = false; this.fileProbeRunning = false; this.fileProbeEpoch = 0;
    this.sendAttempt = null;
    this.recordingDraft = null;
    this.nativeAudio = null; this.recordingRevision = 0; this.activeFileUploadId = ''; this.activeFileReceiveId = ''; this.cancelledAudioSessions = [];
    this.nativeShellSession='';this.nativeShellRequest=null;this.nativeShellAttempts={};
    this.completedRecordingSession = '';
    this.nativeCaptureSession='';this.nativeCaptureUntil=0;this.recordingStartedAt=0;this.nativeAudioStartAttempts={};
    this.counter = 0;
    this.watchId = ''; this.pushSequence = 0; this.pushFrames = {}; this.deferredSnapshot = null; this.liveMessageSignature = '';
    this.followingLatest = true; this.lastScrollY = 0; this.hidden = false;
    this.recordingReadyPending = false;
    this.conn.onopen = () => {
      this.setStatus('手机通信已连接', 'ready'); this.reportDiagnostic('快应用通信已建立 · '+this.appVersion); this.reportLifecycle('ready');
      if (this.view === 'messages' && !this.pending && !this.hidden) this.startWatching();
    };
    this.conn.onclose = () => { this.setStatus('手机通道已断开，请启动手机连接服务', 'error'); };
    this.conn.onerror = error => { this.setStatus('连接错误：' + (error.code || error.data), 'error'); };
    this.conn.onmessage = event => { this.receive(event.data); };
    this.startClock();
  },
  onDestroy() {
    this.destroyed = true;
    clearTimeout(this.recordingClockTimer);clearTimeout(this.nativeCaptureTimer);this.nativeCaptureSession='';
    clearTimeout(this.clockTimer);
    if (this.nativeAudio) this.nativeAudio.destroy();
    if(this.nativeShellRequest)this.nativeShellRequest.cancel();
    clearTimeout(this.nativeShellDeadline);
    if (this.nativeEventProbe) this.nativeEventProbe.cancel();
    Object.keys(this.auxRequests).forEach(id => {
      const request = this.auxRequests[id]; clearTimeout(request.timer); request.reject(new Error('App closed'));
    });
    this.auxRequests = {};
    this.keepRecordingAwake(false);
    this.stopWatching();
    clearTimeout(this.scrollTimer);
    if (this.pending) clearTimeout(this.pending.timer);
    this.conn.onmessage = null;
    this.conn.onopen = null;
    this.conn.onclose = null;
    this.conn.onerror = null;
    this.conn.destroy();
  },
  onReady() { this.checkConnection(); },
  onShow() {
    this.hidden = false;
    this.conn.show();
    this.startClock();
    if(this.recordingPhase==='recording')this.startRecordingClock();
    if(this.nativeCaptureSession&&Date.now()>=this.nativeCaptureUntil)this.releaseNativeCapture(this.nativeCaptureSession);
    if(this.nativeShellSession&&Date.now()>=this.nativeShellDeadlineAt)this.releaseNativeShell({requestId:this.nativeShellSession});
    else if(this.nativeShellSession)this.keepRecordingAwake(true);
    // Vela can pause timers while this page is hidden.
    if (this.pending && Date.now() >= this.pending.deadline) this.expireRpc(this.pending.id);
    if (this.view === 'draft' && this.draft) this.releaseDraftRead();
    this.reportLifecycle('show');
    if (this.view === 'messages' && !this.watchId && !this.pending && this.threadId) this.startWatching();
    else if (this.view === 'recording' && !this.pending && this.threadId) this.checkRecordingStatus();
    else if (this.view === 'terminal' && this.shellJob) this.auxiliaryRpc('device.shell.status',{id:this.shellJob}).then(state=>this.updateShellState(state)).catch(()=>{});
  },
  onHide() { this.conn.hide(); this.reportLifecycle('hide'); this.hidden = true; clearTimeout(this.clockTimer);clearTimeout(this.recordingClockTimer); this.keepRecordingAwake(false); this.stopWatching(); },
  startRecordingClock() {
    clearTimeout(this.recordingClockTimer);
    if(this.destroyed||this.hidden||this.recordingPhase!=='recording')return;
    if(!this.recordingStartedAt)this.recordingStartedAt=Date.now();
    const seconds=Math.max(0,Math.min(24,Math.floor((Date.now()-this.recordingStartedAt)/1000)));
    this.recordingSeconds=seconds<10?'0'+seconds:''+seconds;
    this.recordingClockTimer=setTimeout(()=>this.startRecordingClock(),1000);
  },
  holdNativeCapture(sessionId) {
    this.nativeCaptureSession=sessionId;this.nativeCaptureUntil=Date.now()+45000;
    clearTimeout(this.nativeCaptureTimer);this.keepRecordingAwake(true);
    this.nativeCaptureTimer=setTimeout(()=>this.releaseNativeCapture(sessionId),45000);
  },
  releaseNativeCapture(sessionId) {
    if(this.nativeCaptureSession!==sessionId)return;
    this.nativeCaptureSession='';this.nativeCaptureUntil=0;clearTimeout(this.nativeCaptureTimer);
    this.keepRecordingAwake(!!this.fileReceptionRunning||!!this.nativeShellSession||!this.hidden&&['preparing','recording','receiving','transcribing'].includes(this.recordingPhase));
  },
  startClock() {
    clearTimeout(this.clockTimer);
    if(this.hidden||this.destroyed)return;
    const now=new Date(),pad=n=>n<10?'0'+n:''+n;
    this.clockLabel=pad(now.getHours())+':'+pad(now.getMinutes());
    this.dateLabel=(now.getMonth()+1)+'月'+now.getDate()+'日';
    this.greeting=now.getHours()<6?'夜深了，灵感还在。':now.getHours()<12?'早安，接着想。':now.getHours()<18?'把想法，向前一步。':'今晚，继续好想法。';
    this.clockTimer=setTimeout(()=>this.startClock(),60000-now.getSeconds()*1000-now.getMilliseconds());
  },
  reportLifecycle(phase) {
    try { this.conn.send({ data: { v: 1, id: 'lifecycle-' + Date.now(), method: 'app.lifecycle', params: { phase: phase, view: this.view, sessionId: this.recordingSession, recordingPhase: this.recordingPhase,instanceId:this.instanceId } } }); } catch (error) {}
  },
  setStatus(text, tone = 'neutral') { this.status = text; this.statusTone = tone; },
  checkConnection() {
    if (this.pending) return;
    this.conn.getReadyState({
      success: result => {
        this.setStatus(result.status === 1 ? '手机通道已连接' : '手机通道未连接，请启动手机连接服务', result.status === 1 ? 'ready' : 'error');
        if (result.status === 1) { this.reportDiagnostic('手环已检测到手机通信连接'); }
      },
      fail: (error, code) => { this.setStatus('检测失败：' + code, 'error'); }
    });
  },
  clearRpc(id) {
    if (!this.pending || this.pending.id !== id) return;
    if(this.pending.method==='device.shell.start')this.shellRunning=false;
    clearTimeout(this.pending.timer); this.pending = null; this.busy = false; this.sending = false;
  },
  expireRpc(id) {
    if (!this.pending || this.pending.id !== id) return;
    const method = this.pending.method;
    this.clearRpc(id);
    if (method === 'prompt.send') this.sendUncertain = true;
    if (method === 'messages.watch' && this.deferredSnapshot) { this.showMessages(this.deferredSnapshot); return; }
    this.setStatus(method === 'prompt.send' ? '尚未收到确认，点核实发送' : '手机超时，请重试连接', 'error');
  },
  releaseDraftRead() {
    // A ready draft supersedes these recorder replies. Never retire a send.
    if (this.pending && ['recording.status', 'voice.request', 'recording.arm', 'recording.stop'].indexOf(this.pending.method) >= 0) this.clearRpc(this.pending.id);
    if (!this.pending && !this.sendUncertain) this.setStatus('文字已就绪，请核对后发送', 'ready');
  },
  rpc(method, params, done, requestId) {
    if (this.pending && Date.now() >= this.pending.deadline) this.expireRpc(this.pending.id);
    if (this.pending) return;
    const id = requestId || Date.now() + '-' + (++this.counter);
    const timeout = 25000;
    const timer = setTimeout(() => {
      if (this.pending && this.pending.timer === timer) this.expireRpc(id);
    }, timeout);
    this.pending = { id: id, method: method, timer: timer, deadline: Date.now() + timeout, done: done, parts: [], total: 0 };
    this.busy = true; this.sending = method === 'prompt.send';
    this.setStatus(method === 'voice.request' ? '正在读取录音文字…' : method === 'prompt.send' ? '正在发送给 Codex…' : '正在读取，请稍候…', 'working');
    this.conn.send({
      data: { v: 1, id: id, method: method, params: params || {} },
      fail: (error, code) => {
        if (this.pending && this.pending.id === id) {
          this.clearRpc(id);
          if (method === 'prompt.send') this.sendUncertain = true;
          this.setStatus('发送失败：' + code + ' ' + String(error || ''), 'error');
        }
      }
    });
  },
  auxiliaryRpc(method, params) {
    return new Promise((resolve, reject) => {
      if (this.destroyed) { reject(new Error('App closed')); return; }
      const id = 'aux-' + Date.now() + '-' + (++this.counter);
      const finish = (error, result) => {
        const pending = this.auxRequests[id]; if (!pending) return;
        delete this.auxRequests[id]; clearTimeout(pending.timer);
        if (error) reject(new Error(String(error))); else resolve(result);
      };
      const timer = setTimeout(() => finish('Phone request timed out'), 12000);
      this.auxRequests[id] = { id, timer, finish, reject, parts: [], total: 0 };
      this.conn.send({ data: { v: 1, id, method, params }, fail: (_, code) => finish('Phone send failed:' + code) });
    });
  },
  capabilityProbe(command) {
    if (this.fileReceptionRunning || this.fileProbeRunning || this.nativeEventProbe || this.destroyed) return;
    this.fileProbeRunning = true; this.setStatus('正在检查文件与事件通道…', 'working');
    this.keepRecordingAwake(true);
    const epoch = ++this.fileProbeEpoch;
    let probeTimer;
    let systemEvent;
    try { systemEvent = this.nativeEventBus; } catch (_) {}
    const probe = this.auxiliaryRpc('capabilities.progress', { id:command.probeId, stage:'received' }).then(() =>
      runFileProbe({ file, event: systemEvent, command, alive: () => !this.destroyed && this.fileProbeEpoch === epoch,
        rpc: (method, params) => this.auxiliaryRpc(method, params) }));
    const deadline = new Promise((_, reject) => {
      probeTimer = setTimeout(() => { ++this.fileProbeEpoch; reject(new Error('通道检查超时')); }, 22000);
    });
    Promise.race([probe, deadline]).then(result => {
      if (!this.destroyed) this.setStatus(result.verified ? '文件往返校验通过' : '文件校验未通过', result.verified ? 'ready' : 'error');
    }).catch(error => {
      if (!this.destroyed) this.setStatus('通道检查失败：' + String(error.message || error), 'error');
      this.auxiliaryRpc('capabilities.report', { id:command.probeId, error:String(error.message || error).slice(0,100) }).catch(() => {});
    }).then(() => {
      clearTimeout(probeTimer); this.fileProbeRunning = false; this.keepRecordingAwake(false);
      if (this.fileProbeEpoch === epoch) ++this.fileProbeEpoch;
    });
  },
  nativeCapabilityProbe(command) {
    if (this.destroyed || this.fileReceptionRunning || this.fileProbeRunning || this.nativeEventProbe) return;
    this.setStatus('原生事件检测：等待模块回报', 'working'); this.keepRecordingAwake(true);
    let systemEvent;
    try { systemEvent = this.nativeEventBus; } catch (_) {}
    const probe = createNativeEventProbe({ event:systemEvent, nonce:command.nonce, receiveOnly:command.receiveOnly === true,
      onArmed: () => this.auxiliaryRpc('native.capabilities.progress', {id:command.probeId, stage:'armed'}) });
    this.nativeEventProbe = probe;
    probe.done.then(result => {
      if (!this.destroyed) this.setStatus(result.nativeRx ? '原生双向事件已验证' : '已收到原生模块事件，录音尚未接入', 'ready');
      return this.auxiliaryRpc('native.capabilities.report', {id:command.probeId, ...result});
    }).catch(error => {
      if (!this.destroyed) this.setStatus('原生检测：'+String(error.message || error), 'error');
      return this.auxiliaryRpc('native.capabilities.report', {id:command.probeId, error:String(error.message || error).slice(0,100)}).catch(() => {});
    }).then(() => { this.nativeEventProbe = null; this.keepRecordingAwake(false); });
  },
  receiveFileCommand(command) {
    if (this.destroyed) return;
    if(this.fileReceptionRunning&&this.activeFileReceiveId===command.transferId)return;
    if(this.deferFileCommand(command,()=>this.receiveFileCommand(command)))return;
    if (this.fileReceptionRunning || this.fileProbeRunning || this.nativeEventProbe) {
      this.auxiliaryRpc('files.received',{id:command.transferId,error:'手环已有任务，请结束后重试'}).catch(()=>{});return;
    }
    this.activeFileReceiveId=command.transferId;this.fileReceptionRunning = true;this.keepRecordingAwake(true);this.setStatus('正在接收文件…','working');
    receiveFile({file,command,alive:()=>!this.destroyed,
      rpc:(method,params)=>this.auxiliaryRpc(method,params),
      progress:(bytes,size)=>this.setStatus('正在保存文件 '+Math.round(bytes/Math.max(1,size)*100)+'%','working')
    }).then(()=>{if(!this.destroyed)this.setStatus('文件已校验并保存','ready');})
      .catch(error=>{if(!this.destroyed)this.setStatus('文件接收失败：'+String(error.message||error),'error');})
      .then(()=>{this.activeFileReceiveId='';this.fileReceptionRunning=false;this.keepRecordingAwake(!!this.nativeShellSession);});
  },
  deferFileCommand(command,retry) {
    if(!this.fileReceptionRunning)return false;
    command.localWaits=(command.localWaits||0)+1;
    if(command.localWaits>60)return false;
    setTimeout(retry,50);return true;
  },
  uploadFileCommand(command) {
    if(this.destroyed)return;
    if(this.fileReceptionRunning&&this.activeFileUploadId===command.transferId)return;
    // The next readback can reach us before the previous upload's RPC ACK.
    // Wait for that local file handler to finish; this never retries exec.
    if(this.deferFileCommand(command,()=>this.uploadFileCommand(command)))return;
    if(this.fileReceptionRunning&&this.activeFileUploadId===command.transferId)return;
    if(this.fileReceptionRunning||this.fileProbeRunning||this.nativeEventProbe){
      this.auxiliaryRpc('files.uploaded',{id:command.transferId,error:'手环已有文件任务，请结束后重试'}).catch(()=>{});return;
    }
    const audio=command.purpose==='audio';
    const alive=()=>!this.destroyed&&(!audio||this.cancelledAudioSessions.indexOf(command.sessionId)<0);
    this.activeFileUploadId=command.transferId;this.fileReceptionRunning=true;this.keepRecordingAwake(true);this.setStatus(audio?'正在回传录音…':'正在回传文件…','working');
    sendOwnFile({file,command,alive,rpc:(method,params)=>this.auxiliaryRpc(method,params),
      progress:(bytes,size)=>this.setStatus((audio?'正在回传录音 ':'正在回传文件 ')+Math.round(bytes/Math.max(1,size)*100)+'%','working')
    }).then(()=>{if(!this.destroyed&&!audio)this.setStatus('文件回传并校验完成','ready');})
      .catch(error=>{if(alive())this.setStatus('文件回传失败：'+String(error.message||error),'error');})
      .then(()=>{this.activeFileUploadId='';this.fileReceptionRunning=false;
        if(this.nativeCaptureSession&&command.name==='bc-audio-'+this.nativeCaptureSession.replace(/-/g,'')+'.bcap')this.releaseNativeCapture(this.nativeCaptureSession);
        this.keepRecordingAwake(!!this.nativeShellSession||(!this.hidden&&['preparing','recording','receiving','transcribing'].indexOf(this.recordingPhase)>=0));});
  },
  nativeShellCommand(command) {
    if(this.destroyed||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(command.requestId||''))return;
    const id=command.requestId;
    if(this.nativeShellAttempts[id])return;
    if(!Number.isSafeInteger(command.expiresAt)||Date.now()>=command.expiresAt){
      this.auxiliaryRpc('native.shell.report',{id,notStarted:true}).catch(()=>{});return;
    }
    if(this.deferFileCommand(command,()=>this.nativeShellCommand(command)))return;
    if(this.nativeShellSession||this.fileReceptionRunning||this.fileProbeRunning||this.nativeEventProbe||
       ['preparing','recording','receiving','transcribing'].includes(this.recordingPhase)){
      this.auxiliaryRpc('native.shell.report',{id,notStarted:true}).catch(()=>{});return;
    }
    this.nativeShellAttempts[id]=true;
    const keys=Object.keys(this.nativeShellAttempts);if(keys.length>32)delete this.nativeShellAttempts[keys[0]];
    this.nativeShellSession=id;this.keepRecordingAwake(true);this.setStatus('正在执行手环命令…','working');
    clearTimeout(this.nativeShellDeadline);
    this.nativeShellDeadlineAt=Date.now()+240000;
    this.nativeShellDeadline=setTimeout(()=>this.releaseNativeShell({requestId:id}),240000);
    try{
      this.nativeShellRequest=createNativeShellRequest({event:this.nativeEventBus,id,timeoutMs:command.timeoutMs});
      this.nativeShellRequest.done.then(result=>{
        if(!this.destroyed)return this.auxiliaryRpc('native.shell.report',result);
      }).catch(()=>{});
    }catch(error){this.auxiliaryRpc('native.shell.report',{id,op:'no-event'}).catch(()=>{});}
  },
  releaseNativeShell(command) {
    if(command.state)this.updateShellState(command.state);
    if(command.requestId!==this.nativeShellSession)return;
    this.nativeShellSession='';clearTimeout(this.nativeShellDeadline);
    if(this.nativeShellRequest)this.nativeShellRequest.cancel();this.nativeShellRequest=null;
    this.keepRecordingAwake(!!this.fileReceptionRunning);if(!this.destroyed)this.setStatus('手环命令任务已结束','ready');
  },
  nativeAudioCommand(command) {
    if(command.action!=='start'){this.performNativeAudioCommand(command);return;}
    if(this.destroyed||command.sessionId===this.completedRecordingSession||this.nativeAudioStartAttempts[command.sessionId]||this.cancelledAudioSessions.includes(command.sessionId))return;
    this.nativeAudioStartAttempts[command.sessionId]=true;
    const keys=Object.keys(this.nativeAudioStartAttempts);if(keys.length>32)delete this.nativeAudioStartAttempts[keys[0]];
    const requestedAt=Date.now();this.holdNativeCapture(command.sessionId);
    this.auxiliaryRpc('native.audio.authorize',{sessionId:command.sessionId}).then(result=>{
      if(this.destroyed||this.cancelledAudioSessions.includes(command.sessionId)){this.releaseNativeCapture(command.sessionId);return;}
      if(!result.allowed||Date.now()-requestedAt>=Math.min(5000,result.leaseMs||0))throw new Error('录音请求已过期，请重新开始');
      this.performNativeAudioCommand(command);
    }).catch(error=>{
      this.releaseNativeCapture(command.sessionId);
      this.auxiliaryRpc('native.audio.state',{sessionId:command.sessionId,phase:'error',error:String(error.message||error).slice(0,100)}).catch(()=>{});
    });
  },
  performNativeAudioCommand(command) {
    if(this.destroyed||(command.sessionId===this.completedRecordingSession&&['start','status'].indexOf(command.action)>=0))return;
    if(command.action==='cancel'){
      if(this.cancelledAudioSessions.indexOf(command.sessionId)<0)this.cancelledAudioSessions.push(command.sessionId);
      if(this.cancelledAudioSessions.length>16)this.cancelledAudioSessions.shift();
      if(command.sessionId===this.recordingSession){this.recordingPhase='cancelled';this.keepRecordingAwake(false);}
    }
    try{
      if(command.action==='start'&&(this.nativeShellSession||this.fileReceptionRunning||this.fileProbeRunning||this.nativeEventProbe))throw new Error('手环还有命令、文件或检测任务，请稍后录音');
      if(!this.nativeAudio){
        const event=this.nativeEventBus;
        this.nativeAudio=createNativeAudioController({event,
          onQuiescent:session=>this.releaseNativeCapture(session),
          onState:state=>{
            if(['error','cancelled'].includes(state.phase))this.releaseNativeCapture(state.sessionId);
            return this.auxiliaryRpc('native.audio.state',state);
          },onError:()=>{}});
      }
      if(command.action==='start')this.holdNativeCapture(command.sessionId);
      this.nativeAudio.control(command);
    }catch(error){
      this.releaseNativeCapture(command.sessionId);
      this.auxiliaryRpc('native.audio.state',{sessionId:command.sessionId,phase:'error',error:String(error.message||error).slice(0,100)}).catch(()=>{});
    }
  },
  nativeLoaderReport(command) {
    if (this.destroyed) return;
    readNativeLoaderReport(file).then(reports => this.auxiliaryRpc('native.loader.report',{id:command.reportId,reports}))
      .catch(()=>{});
  },
  decodePhoneMessage(raw) {
    let message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    if (message.bc === 1 || message.bc === 2) {
      const wide = message.bc === 2;
      if (typeof message.data !== 'string' || message.data.length > (wide ? 4096 : 201) || !Number.isInteger(message.total) || message.total < 1 || message.total > (wide ? 32 : 512) || !Number.isInteger(message.part) || message.part < 0 || message.part >= message.total) return null;
      let pending = this.auxRequests[message.id] || this.pending;
      const push = this.watchId && typeof message.id === 'string' && message.id.indexOf('push-' + this.watchId + '-') === 0;
      const command = typeof message.id === 'string' && message.id.indexOf('command-') === 0;
      if (push || command) {
        const keys = Object.keys(this.pushFrames);
        keys.forEach(key => { if (Date.now() - this.pushFrames[key].created > 60000) delete this.pushFrames[key]; });
        if (!this.pushFrames[message.id]) {
          if (Object.keys(this.pushFrames).length >= 3) delete this.pushFrames[Object.keys(this.pushFrames)[0]];
          this.pushFrames[message.id] = { parts: [], total: 0, created: Date.now() };
        }
        pending = this.pushFrames[message.id];
      } else if (!pending || message.id !== pending.id) return null;
      if (pending.total && pending.total !== message.total) return null;
      pending.total = message.total;
      if (typeof pending.parts[message.part] === 'string' && pending.parts[message.part] !== message.data) return null;
      const priorBytes = typeof pending.parts[message.part] === 'string' ? utf8Length(pending.parts[message.part]) : 0;
      const nextBytes = (pending.bytes || 0) - priorBytes + utf8Length(message.data);
      if (nextBytes > 65536) { pending.parts = []; pending.total = 0; pending.bytes = 0; return null; }
      pending.bytes = nextBytes;
      pending.parts[message.part] = message.data;
      for (let i = 0; i < pending.total; i++) { if (typeof pending.parts[i] !== 'string') return null; }
      message = JSON.parse(pending.parts.join(''));
      if (push || command) {
        Object.keys(this.pushFrames).forEach(key => { if (this.pushFrames[key] === pending) delete this.pushFrames[key]; });
      }
    }
    return message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  },
  receiveCommand(message) {
    if (this.receiveRecordingCommand(message)) return true;
    const handlers = {
      capabilityProbe: 'capabilityProbe', nativeEventProbe: 'nativeCapabilityProbe',
      nativeLoaderReport: 'nativeLoaderReport', fileUpload: 'uploadFileCommand',
      nativeShellControl:'nativeShellCommand',nativeShellRelease:'releaseNativeShell',
      fileReceive: 'receiveFileCommand', probeProjects: 'loadProjects',
      recordingManager: 'showRecordingManager'
    };
    if (typeof handlers[message.bc_command] === 'string') { this[handlers[message.bc_command]](message); return true; }
    if (message.bc_command === 'connectionReady') {
      if (!this.pending) this.setStatus('手机通信已连接', 'ready');
      this.reportLifecycle(this.hidden ? 'hide' : 'show'); return true;
    }
    if (message.bc_command === 'probeConversation' && message.thread && message.project && !this.pending) {
      this.cwd = message.project.path; this.projectName = message.project.name;
      this.chooseThread(message.thread); return true;
    }
    return false;
  },
  receive(raw) {
    try {
      const message = this.decodePhoneMessage(raw);
      if (!message || this.receiveCommand(message)) return;
      if (message && this.auxRequests[message.id]) { this.auxRequests[message.id].finish(message.error, message.result); return; }
      if (message.event) { this.receiveLive(message); return; }
      if ((!this.pending || message.id !== this.pending.id) && message.watchId === this.watchId && message.threadId === this.threadId && message.result && this.pushSequence === 0) {
        if (this.view === 'messages' && this.followingLatest && !this.pending) this.showMessages(message.result);
        else { this.deferredSnapshot = message.result; this.newReplies = true; }
        return;
      }
      if (!this.pending || message.id !== this.pending.id) return;
      const pending = this.pending;
      this.clearRpc(pending.id);
      if (message.error) {
        if (message.recordingPending) { this.openRecordingManager(message.recordingPending); return; }
        if (pending.method === 'prompt.send') this.sendUncertain = message.retryable !== true;
        this.setStatus(String(message.error), 'error'); return;
      }
      this.setStatus('已同步', 'ready');
      pending.done(message.result);
      this.maybeLoadRecordingDraft();
      this.positionPage();
    } catch (error) { this.setStatus('手机数据无法解析，请重试', 'error'); }
  },
  receiveRecordingCommand(message) {
    if (!message) return false;
    if(message.bc_command==='nativeAudioControl'){this.nativeAudioCommand(message);return true;}
    if (message.bc_command === 'ping') {
      this.reportDiagnostic('快应用通信已建立 · '+this.appVersion);
      this.reportLifecycle(this.hidden ? 'hide' : 'show'); return true;
    }
    if (message.bc_command === 'recordingResume' && message.target && typeof message.target.threadId === 'string') {
      if (message.sessionId === this.completedRecordingSession) return true;
      if ((this.pending && this.pending.method === 'prompt.send') ||
          (message.sessionId === this.recordingSession && this.view === 'draft')) {
        this.reportLifecycle(this.hidden ? 'hide' : 'show'); return true;
      }
      if (this.pending) this.clearRpc(this.pending.id);
      this.cwd = message.target.cwd; this.projectName = message.target.projectName;
      this.threadId = message.target.threadId; this.threadTitle = message.target.threadTitle;
      this.recordingSession = message.sessionId; this.view = 'recording'; this.title = '手环录音';
      this.applyRecordingState(message.state || { phase: message.phase, sessionId: message.sessionId });
      this.reportLifecycle(this.hidden ? 'hide' : 'show');
      if (this.view !== 'draft') this.checkRecordingStatus();
      return true;
    }
    if (message.bc_command === 'recordingState') {
      if (this.pendingRecording && this.pendingRecording.sessionId === message.state.sessionId) {
        this.pendingRecording = ['preparing','recording','receiving','transcribing','ready'].indexOf(message.state.phase) >= 0 ? { pending: true, ...message.state } : null;
      }
      if (message.threadId === this.threadId && !this.hidden && this.view !== 'recording-manager' &&
          (this.view !== 'input'||this.pending?.method==='recording.arm'||message.state.sessionId===this.recordingSession))this.applyRecordingState(message.state);
      return true;
    }
    return false;
  },
  loadProjects() {
    this.rpc('projects.list', {}, result => {
      this.projects = result.projects; this.view = 'projects'; this.title = '选择项目';
      this.stopWatching();
      if (!this.projects.length) this.setStatus('暂时没有项目');
      this.reportDiagnostic('项目列表已显示：' + this.projects.length + ' 个项目');
    });
  },
  decorateThreads(threads) {
    return threads.map(thread => {
      let label = '点击继续对话';
      if (thread.status && thread.status.type === 'active') label = 'Codex 正在处理';
      else if (thread.updatedAt) {
        const timestamp = thread.updatedAt > 100000000000 ? thread.updatedAt : thread.updatedAt * 1000;
        const date = new Date(timestamp);
        label = (date.getMonth() + 1) + '月' + date.getDate() + '日更新';
      }
      return Object.assign({}, thread, { label: label });
    });
  },
  chooseProject(project) {
    this.rpc('threads.list', { cwd: project.path }, result => {
      if (this.cwd !== project.path) { this.threadId = ''; this.threadTitle = ''; this.messages = []; }
      this.cwd = project.path; this.projectName = project.name;
      this.threads = this.decorateThreads(result.threads); this.threadCursor = result.nextCursor; this.view = 'threads'; this.title = project.name;
    });
  },
  moreThreads() {
    this.rpc('threads.list', { cwd: this.cwd, cursor: this.threadCursor }, result => {
      this.threads = this.decorateThreads(result.threads); this.threadCursor = result.nextCursor;
    });
  },
  chooseThread(thread) {
    if (this.pending) return;
    if (this.threadId !== thread.id) {
      this.recordingPhase = 'idle'; this.recordingSession = ''; this.recordingReadyPending = false;
      this.recordingDraft = null; this.draft = ''; this.sendAttempt = null; this.sendUncertain = false;
    }
    this.threadId = thread.id; this.threadTitle = thread.title;
    this.messages = []; this.messageCursor = null;
    this.startWatching();
  },
  startWatching(preserveView = false) {
    if (this.pending || this.hidden || !this.threadId) return;
    this.stopWatching();
    this.watchId = 'watch-' + Date.now() + '-' + (++this.counter);
    const watchId = this.watchId;
    if (!preserveView) { this.view = 'messages'; this.title = this.threadTitle || '对话'; }
    this.followingLatest = true; this.viewingLatest = true;
    this.rpc('messages.watch', { threadId: this.threadId, watchId: watchId }, result => {
      if (watchId !== this.watchId) return;
      if (preserveView) { this.messages = result.messages; this.messageCursor = result.nextCursor; }
      else this.showMessages(result);
      this.reportDiagnostic('自动推送已接通：' + this.messages.length + ' 条消息');
    });
  },
  stopWatching() {
    const watchId = this.watchId;
    this.watchId = ''; this.pushFrames = {}; this.pushSequence = 0; this.deferredSnapshot = null; this.newReplies = false; this.liveMessageSignature = '';
    if (this.pending && this.pending.method === 'messages.watch') {
      clearTimeout(this.pending.timer); this.pending = null; this.busy = false;
    }
    if (!watchId) return;
    try { this.conn.send({ data: { v: 1, id: 'unwatch-' + Date.now(), method: 'messages.unwatch', params: { watchId: watchId } } }); } catch (error) {}
  },
  receiveLive(message) {
    if (!this.watchId || message.watchId !== this.watchId || message.threadId !== this.threadId || !Number.isInteger(message.sequence) || message.sequence <= this.pushSequence) return;
    this.pushSequence = message.sequence;
    if (message.event === 'messages.connection') {
      if (this.view === 'messages' && !this.pending) this.setStatus(message.message || '自动更新正在重连', 'working');
      return;
    }
    if (message.event !== 'messages.updated' || !message.result || !Array.isArray(message.result.messages)) return;
    const signature = JSON.stringify(message.result.messages);
    if (signature === this.liveMessageSignature) {
      if (this.deferredSnapshot) this.deferredSnapshot = message.result;
      else if (this.view === 'messages' && this.viewingLatest && !this.pending) this.conversationStatus(message.result);
      return;
    }
    this.liveMessageSignature = signature;
    if (this.view === 'messages' && this.viewingLatest && this.followingLatest && !this.pending) {
      this.showMessages(message.result);
      this.reportDiagnostic('新回复已自动显示：' + this.messages.length + ' 条消息');
    } else {
      this.deferredSnapshot = message.result; this.newReplies = true;
      if (this.view === 'messages' && !this.pending) this.setStatus('有新回复，点下方查看', 'ready');
    }
  },
  showMessages(result, latest = true) {
    this.adjustingScroll = true;
    this.messages = result.messages; this.messageCursor = result.nextCursor; this.view = 'messages'; this.title = this.threadTitle || '对话';
    this.viewingLatest = latest;
    this.followingLatest = latest;
    if (latest) { this.newReplies = false; this.deferredSnapshot = null; this.liveMessageSignature = JSON.stringify(result.messages); }
    this.conversationStatus(result);
    this.positionMessages(latest);
  },
  conversationStatus(result) {
    this.setStatus(result.status && result.status.type === 'active' ? 'Codex 正在处理，回复自动送达' : '已同步 · 自动推送已连接', result.status && result.status.type === 'active' ? 'working' : 'ready');
  },
  positionMessages(latest = true) {
    this.adjustingScroll = true;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => { this.adjustingScroll = false; }, 700);
    this.$nextTick(() => {
      if (this.view !== 'messages') return;
      const scroll = this.$element('messageScroll');
      if (!scroll) return;
      if (!latest) { scroll.scrollTo({ top: 0, behavior: 'instant' }); return; }
      scroll.getScrollRect({
        success: rect => {
          if (this.view !== 'messages') return;
          scroll.scrollTo({ top: rect.height, behavior: 'instant' });
        }
      });
    });
  },
  positionPage() {
    this.$nextTick(() => {
      if (this.view === 'messages') return;
      const scroll = this.$element('pageScroll');
      if (scroll) scroll.scrollTo({ top: 0, behavior: 'instant' });
    });
  },
  messageScrolled(event) {
    const y = Number(event.scrollY);
    if (!Number.isFinite(y)) return;
    if (!this.adjustingScroll && y < this.lastScrollY - 8) this.followingLatest = false;
    this.lastScrollY = y;
  },
  messageAtBottom() {
    if (this.adjustingScroll || !this.viewingLatest) return;
    this.followingLatest = true;
    if (this.deferredSnapshot && !this.pending) this.showMessages(this.deferredSnapshot);
  },
  refreshMessages() {
    if (this.pending) return;
    if (this.deferredSnapshot && this.watchId) this.showMessages(this.deferredSnapshot);
    else this.startWatching();
  },
  resumeThread() { if (!this.pending) this.refreshMessages(); },
  olderMessages() { this.rpc('messages.list', { threadId: this.threadId, cursor: this.messageCursor }, result => this.showMessages(result, false)); },
  readMessage(message) {
    if (this.pending) return;
    this.readingMessage = message; this.readingRole = message.role === 'user' ? '我' : 'Codex';
    this.loadMessagePage(0);
  },
  loadMessagePage(offset) {
    this.rpc('message.read', { threadId: this.threadId, turnId: this.readingMessage.turnId, itemId: this.readingMessage.id, offset: offset }, result => {
      this.readingText = result.text; this.readingNext = result.nextOffset;
      this.readingOffset = offset; this.readingPage = Math.floor(offset / 900) + 1;
      this.view = 'reading'; this.title = '阅读消息';
    });
  },
  nextMessagePage() { if (this.readingNext !== null) this.loadMessagePage(this.readingNext); },
  previousMessagePage() { if (this.readingOffset > 0) this.loadMessagePage(Math.max(0, this.readingOffset - 900)); },
  showDraft(text, source) {
    if (!text || (this.pending && this.pending.method === 'prompt.send')) return;
    if (this.sendAttempt && (this.sendAttempt.text !== text || this.sendAttempt.threadId !== this.threadId)) {
      this.sendAttempt = null; this.sendUncertain = false;
    }
    this.recordingReadyPending = false; this.draft = text; this.view = 'draft'; this.title = '确认发送';
    this.recordingDraft = source && source.sessionId ? { sessionId: source.sessionId, threadId: this.threadId, text: text } : null;
    this.releaseDraftRead();
    this.reportDiagnostic('文字草稿已显示，等待用户确认发送');
    this.reportLifecycle(this.hidden ? 'hide' : 'show');
  },
  showInput() {
    if (this.pending) return;
    this.view = 'input'; this.title = '输入方式'; this.positionPage();
    this.rpc('recording.pending', {}, result => { this.pendingRecording = result.pending ? result : null; });
  },
  openRecordingManager(result) {
    this.pendingRecording = result.pending ? result : null;
    this.view = 'recording-manager'; this.title = '录音与草稿';
    this.setStatus(result.pending ? '查看或取消后，可继续录音' : '没有待处理录音', 'ready');
    this.reportDiagnostic('录音与草稿已显示：' + (result.pending ? 1 : 0));
    this.reportLifecycle(this.hidden ? 'hide' : 'show'); this.positionPage();
  },
  showRecordingManager() {
    this.rpc('recording.pending', {}, result => this.openRecordingManager(result));
  },
  reviewPendingRecording() {
    const item = this.pendingRecording;
    if (this.pending || !item || !item.pending || !item.target) return;
    this.stopWatching(); this.cwd = item.target.cwd; this.projectName = item.target.projectName;
    this.threadId = item.target.threadId; this.threadTitle = item.target.threadTitle;
    this.view = 'recording'; this.title = '手环录音'; this.applyRecordingState(item);
    this.reportLifecycle(this.hidden ? 'hide' : 'show'); this.positionPage();
  },
  discardPendingRecording() {
    const item = this.pendingRecording;
    if (this.pending || !item || !item.pending || !item.target) return;
    if (this.sendUncertain && this.recordingDraft && this.recordingDraft.sessionId === item.sessionId) {
      this.setStatus('发送结果待确认，请查看草稿核实', 'error'); return;
    }
    this.rpc(item.phase === 'ready' ? 'recording.discard' : 'recording.cancel',
      { threadId: item.target.threadId, sessionId: item.sessionId }, () => {
        this.completedRecordingSession = item.sessionId;
        this.pendingRecording = null;
        if (this.recordingSession === item.sessionId) { this.recordingPhase = 'cancelled'; this.recordingSession = ''; this.recordingDraft = null; this.draft = ''; this.sendAttempt = null; }
        this.view = 'input'; this.title = '输入方式'; this.setStatus('已取消，现在可以开始新录音', 'ready'); this.positionPage();
      });
  },
  readRecordingDraft() {
    this.rpc('voice.request', { input: 'recording', threadId: this.threadId }, result => this.showDraft(result.text, result));
  },
  armRecording() {
    this.rpc('recording.pending', {}, result => {
      this.pendingRecording = result.pending ? result : null;
      if (result.pending) this.openRecordingManager(result);
      else this.startRecording();
    });
  },
  startRecording() {
    this.rpc('recording.arm', { threadId: this.threadId, cwd: this.cwd, threadTitle: this.threadTitle }, result => {
      this.view = 'recording'; this.title = '手环录音'; this.applyRecordingState(result);
    });
  },
  finishRecording() {
    this.rpc('recording.stop', { threadId: this.threadId, sessionId: this.recordingSession }, result => this.applyRecordingState(result));
  },
  applyRecordingState(result) {
    if (!result || !result.phase) return;
    if(Number.isInteger(result.revision)){
      if(result.revision<this.recordingRevision)return;
      this.recordingRevision=result.revision;
    }
    if (result.sessionId && result.sessionId === this.completedRecordingSession && result.phase !== 'delivered') return;
    const previousPhase=this.recordingPhase;this.recordingPhase = result.phase;
    if(result.phase==='recording'){
      if(previousPhase!=='recording'){this.recordingStartedAt=Date.now();this.recordingSeconds='00';}
      this.startRecordingClock();
    }else clearTimeout(this.recordingClockTimer);
    if (result.sessionId) this.recordingSession = result.sessionId;
    if(!['preparing','recording','receiving'].includes(result.phase)&&this.nativeCaptureSession===this.recordingSession)
      this.releaseNativeCapture(this.recordingSession);
    this.keepRecordingAwake(!this.hidden&&['preparing','recording','receiving','transcribing'].indexOf(result.phase)>=0);
    if (result.phase === 'ready') {
      if (this.view === 'draft') return;
      if (result.text) this.showDraft(result.text, result);
      else { this.recordingReadyPending = true; this.maybeLoadRecordingDraft(); }
    } else if (result.phase === 'preparing') {
      this.recordingHelp = '正在打开手环麦克风，准备好后直接在这里说话。';
      if (this.view === 'recording') this.setStatus('正在准备录音…', 'working');
    } else if (result.phase === 'recording') {
      this.recordingHelp = '请对着手环说话。说完点“结束并转文字”，24 秒后会自动结束。';
      if (this.view === 'recording') this.setStatus('正在录音 · 点结束转文字', 'ready');
    } else if (result.phase === 'receiving') {
      this.recordingHelp = '录音已结束，正在安全传到手机。';
      if (this.view === 'recording') this.setStatus('正在接收录音…', 'working');
    } else if (result.phase === 'transcribing') {
      this.recordingHelp = '录音已传到手机，正在转成文字。完成后会自动显示，核对后再发送。';
      if (this.view === 'recording') this.setStatus('正在转成文字…', 'working');
    } else if (this.view === 'recording') {
      this.recordingHelp = result.error || (result.phase === 'expired' ? '接收窗口已过期，请返回输入菜单重新开始。' : result.phase === 'cancelled' ? '本次接收已取消，录音文件仍保留。' : '没有待接收的录音，可返回输入菜单开始接收。');
      this.setStatus(this.recordingHelp, result.phase === 'error' ? 'error' : 'neutral');
    }
  },
  maybeLoadRecordingDraft() {
    if (!this.recordingReadyPending || this.pending || this.hidden || !this.threadId || this.view === 'draft') return;
    if (this.view !== 'messages' && this.view !== 'recording' && this.view !== 'input') return;
    this.recordingReadyPending = false; this.readRecordingDraft();
  },
  checkRecordingStatus() {
    this.rpc('recording.status', { threadId: this.threadId }, result => {
      this.applyRecordingState(result);
      if(result.sessionId&&['preparing','recording','receiving'].indexOf(result.phase)>=0)
        this.nativeAudioCommand({action:'status',sessionId:result.sessionId});
    });
  },
  cancelRecording() {
    this.rpc('recording.cancel', { threadId: this.threadId, sessionId: this.recordingSession }, result => this.applyRecordingState(result));
  },
  prepareContinue() { if (!this.pending) this.showDraft('继续'); },
  cancelDraft() {
    if (this.pending) return;
    if (this.sendUncertain) { this.setStatus('请先点核实发送，确认发送结果', 'error'); return; }
    if (this.recordingDraft) {
      const sessionId = this.recordingDraft.sessionId;
      this.rpc('recording.discard', { threadId: this.recordingDraft.threadId, sessionId: this.recordingDraft.sessionId }, () => {
        this.completedRecordingSession = sessionId;
        this.recordingPhase = 'cancelled'; this.pendingRecording = null; this.recordingDraft = null; this.draft = ''; this.sendAttempt = null; this.backToLatest();
      });
    } else { this.draft = ''; this.backToLatest(); }
  },
  sendDraft() {
    this.releaseDraftRead();
    if (this.pending || !this.draft || !this.draft.trim()) return;
    const nativeDraft = this.recordingDraft && this.recordingDraft.threadId === this.threadId && this.recordingDraft.text === this.draft ? this.recordingDraft : null;
    if (!this.sendAttempt || this.sendAttempt.text !== this.draft || this.sendAttempt.threadId !== this.threadId) {
      this.sendAttempt = { id: nativeDraft ? 'recording-send-' + nativeDraft.sessionId : 'send-' + Date.now() + '-' + (++this.counter),
        text: this.draft, threadId: this.threadId };
    }
    this.rpc('prompt.send', { threadId: this.threadId, text: this.draft }, result => {
      if (nativeDraft) this.completedRecordingSession = nativeDraft.sessionId;
      this.recordingDraft = null; this.pendingRecording = null;
      this.sendAttempt = null; this.sendUncertain = false;
      this.draft = ''; this.view = 'messages'; this.title = this.threadTitle; this.setStatus('已发送，回复会自动送达', 'ready');
      if (this.deferredSnapshot) this.showMessages(this.deferredSnapshot);
      else if (!this.watchId) this.startWatching();
      this.positionMessages();
    }, this.sendAttempt.id);
  },
  showTools() { if (!this.pending) { this.stopWatching(); this.view = 'tools'; this.title = '控制中心'; this.positionPage(); } },
  showTerminal() {
    if(this.pending)return;
    this.view='terminal';this.title='手环终端';this.positionPage();
    if(this.shellJob)this.auxiliaryRpc('device.shell.status',{id:this.shellJob}).then(state=>this.updateShellState(state)).catch(()=>{});
  },
  runShellPreset(preset) {
    if(this.pending||this.shellRunning||!shellPresets.some(item=>item.command===preset.command))return;
    this.shellCommandLabel=preset.command;this.shellResult='';this.shellRunning=true;this.shellStateLabel='正在准备命令';
    this.rpc('device.shell.start',{command:preset.command},state=>{
      this.shellJob=state.id;this.updateShellState(state);
    });
  },
  updateShellState(state) {
    if(!state||state.id!==this.shellJob)return;
    this.shellStateLabel=shellSummary(state);this.shellRunning=!['complete','failed','unknown'].includes(state.phase);
    if(state.phase==='complete')this.auxiliaryRpc('device.shell.output',{id:state.id}).then(result=>{
      if(this.shellJob===state.id)this.shellResult=(result.text||'命令已完成，没有文字输出。')+(result.truncated?'\n…更多内容可在手机查看。':'');
    }).catch(()=>{this.shellResult='输出尚未读到，返回后可再次查看。';});
  },
  showActions() { if (!this.pending) { this.view = 'actions'; this.title = '对话操作'; } },
  backToLatest() {
    if (this.pending) return;
    if (this.deferredSnapshot) { this.showMessages(this.deferredSnapshot); return; }
    if (!this.watchId) { this.startWatching(); return; }
    this.view = 'messages'; this.title = this.threadTitle; this.positionMessages();
  },
  switchThread() { if (!this.pending) { this.stopWatching(); this.view = 'threads'; this.title = this.projectName; } },
  goBack() {
    if (this.pending) return;
    if (this.view === 'recording' && ['preparing', 'recording', 'receiving', 'transcribing'].indexOf(this.recordingPhase) >= 0) { this.cancelRecording(); return; }
    if(this.view==='terminal'){this.showTools();return;}
    if (this.view === 'recording-manager' || this.view === 'draft') this.showInput();
    else if (this.view === 'reading' || this.view === 'actions' || this.view === 'input' || this.view === 'recording') this.backToLatest();
    else if (this.view === 'messages') this.switchThread();
    else if (this.view === 'threads') { this.view = 'projects'; this.title = '选择项目'; }
    else { this.view = 'home'; this.title = '腕上 Codex'; }
  },
  keepRecordingAwake(keep) {
    try {
      const nativeBrightness = loadBrightness();
      const brightness = nativeBrightness && (nativeBrightness.default || nativeBrightness);
      const held=!this.destroyed&&!!this.nativeCaptureSession&&Date.now()<this.nativeCaptureUntil;
      if (brightness && typeof brightness.setKeepScreenOn === 'function') brightness.setKeepScreenOn({ keepScreenOn: !!keep||held });
    } catch (error) {}
  },
  reportDiagnostic(text) {
    this.conn.send({ data: { v: 1, id: 'diagnostic-' + Date.now(), method: 'diagnostics.report', params: { text: text } } });
  }
};
}
