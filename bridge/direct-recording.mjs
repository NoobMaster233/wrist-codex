import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const live = phase => ['preparing', 'recording', 'receiving', 'transcribing'].includes(phase);
const digest = data => createHash('sha256').update(data).digest('hex');

/** Explicit band recording, immutable conversation, durable draft, no model sends. */
export class DirectRecording extends EventEmitter {
  constructor({ stateFile, audioRoot, validateTarget, transcribe, command, ready, timeoutMs = 120000 }) {
    super(); Object.assign(this, { stateFile, audioRoot, validateTarget, transcribe, command, ready, timeoutMs });
    this.state = { schema: 1, phase: 'idle' }; this.writes = Promise.resolve(); this.revision=0;
  }
  async init() {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (this.state.schema !== 1) throw new Error('Unknown direct recording state');
      this.revision=Number.isSafeInteger(this.state.revision)?this.state.revision:0;
      if (live(this.state.phase)) {
        this.command({ action: 'cancel', sessionId: this.state.id });
        await this.commit({ ...this.state, phase: 'error', error: '手机录音服务已重启，请重新录音' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot(threadId) {
    const s = this.state;
    if (!s.target || s.target.threadId !== threadId) return { phase: 'idle' };
    return { phase: s.phase, sessionId: s.id, target: s.target, revision:s.revision||0,
      ...(s.phase === 'ready' ? { text: s.text } : {}), ...(s.error ? { error: s.error } : {}) };
  }
  async handle({ method, params = {} }) {
    if (method === 'recording.pending') {
      const s = this.state;
      return s.target && (live(s.phase) || s.phase === 'ready') ?
        { pending: true, ...this.snapshot(s.target.threadId) } : { pending: false, phase: 'idle' };
    }
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(params.threadId || '')) throw new Error('请选择对话');
    if (method === 'recording.status') return this.snapshot(params.threadId);
    if (method === 'recording.arm') {
      if (this.closed || this.preparing || live(this.state.phase) || this.state.phase === 'ready') {
        const error = new Error('有待处理录音，请打开“录音与草稿”查看或取消');
        if (this.state.target && (live(this.state.phase) || this.state.phase === 'ready'))
          error.recordingPending = { pending: true, ...this.snapshot(this.state.target.threadId) };
        throw error;
      }
      this.preparing = true;
      try {
        await this.ready();
        const target = await this.validateTarget(params);
        if (target.threadId !== params.threadId || target.cwd !== params.cwd) throw new Error('项目和对话不匹配');
        const id = randomUUID(), expiresAt = Date.now() + this.timeoutMs;
        await this.commit({ schema: 1, id, phase: 'preparing', target, expiresAt });
        this.command({ action: 'start', sessionId: id, target, expiresAt });
        this.deadline = setTimeout(() => this.cancel(id, 'error', '录音或传输超时，请重新录音').catch(() => {}), this.timeoutMs);
        this.deadline.unref();
        return this.snapshot(params.threadId);
      } finally { this.preparing = false; }
    }
    const s = this.state;
    if (params.sessionId !== s.id || params.threadId !== s.target?.threadId) throw new Error('录音会话已变化，请重新查询');
    if (method === 'recording.stop') {
      if (['preparing', 'recording', 'receiving'].includes(s.phase)) this.command({ action: 'stop', sessionId: s.id });
    } else if (method === 'recording.cancel') {
      if (s.phase === 'ready') throw new Error('文字已经生成，请在核对页取消草稿');
      await this.cancel(s.id);
    } else if (method === 'recording.discard' || method === 'recording.ack') {
      if (!['ready', 'delivered', 'cancelled'].includes(s.phase)) throw new Error('草稿尚未生成');
      await this.commit({ ...s, phase: method === 'recording.ack' ? 'delivered' : 'cancelled', text: undefined });
    } else throw new Error('不支持的录音操作');
    return this.snapshot(params.threadId);
  }
  async cancel(id, phase = 'cancelled', error) {
    if (this.closed || id !== this.state.id || !live(this.state.phase)) return;
    this.controller?.abort(); clearTimeout(this.deadline);
    this.command({ action: 'cancel', sessionId: id });
    await this.commit({ ...this.state, phase, text: undefined, ...(error ? { error } : {}) });
  }
  async telemetry({ sessionId, phase, error }) {
    const s = this.state;
    if (this.closed || sessionId !== s.id || !live(s.phase) || s.phase === 'transcribing') return;
    if (phase === 'error') return this.cancel(s.id, 'error', String(error || '手环录音失败').slice(0, 180));
    const rank = { preparing: 0, recording: 1, receiving: 2 };
    if (!(phase in rank) || rank[phase] < rank[s.phase]) return;
    await this.commit({ ...s, phase });
  }
  async ingest(id, data) {
    const s = this.state, sha256 = digest(data);
    if (id !== s.id || this.closed) throw new Error('录音会话不匹配');
    if (s.audio?.sha256 === sha256 && ['transcribing', 'ready', 'delivered'].includes(s.phase)) return;
    if (!['recording', 'receiving'].includes(s.phase)) throw new Error('当前不接收音频');
    const ogg=data.length>=64&&data.toString('ascii',0,4)==='OggS'&&data.subarray(0,128).includes(Buffer.from('OpusHead'));
    // Our native decoder emits canonical 16 kHz mono PCM WAV. Validate every
    // header field and the exact payload length before claiming/transcribing.
    const wav=data.length>=44&&data.toString('ascii',0,4)==='RIFF'&&data.readUInt32LE(4)===data.length-8&&
      data.toString('ascii',8,16)==='WAVEfmt '&&data.readUInt32LE(16)===16&&data.readUInt16LE(20)===1&&
      data.readUInt16LE(22)===1&&data.readUInt32LE(24)===16000&&data.readUInt32LE(28)===32000&&
      data.readUInt16LE(32)===2&&data.readUInt16LE(34)===16&&data.toString('ascii',36,40)==='data'&&
      data.readUInt32LE(40)===data.length-44&&(data.length-44)%2===0&&data.length>=3244&&data.length<=800044;
    if(data.length>1024*1024||(!ogg&&!wav))throw new Error('录音文件格式或长度无效');
    // Claim synchronously before awaiting disk I/O, so concurrent retries cannot transcribe twice.
    const controller = new AbortController(); this.controller = controller;
    const next = { ...s, phase: 'transcribing', audio: { bytes: data.length, sha256 } };
    this.state = next;
    const path = join(this.audioRoot, id + (wav?'.wav':'.ogg'));
    try {
      await mkdir(this.audioRoot, { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
      if (controller.signal.aborted) return;
      await this.commit(next);
      this.runTranscription(id, path, sha256, controller.signal).catch(() => {});
    } catch (error) {
      if (!controller.signal.aborted) await this.cancel(id, 'error', '保存录音失败，请重新录音');
      throw error;
    }
  }
  async runTranscription(id, path, sha256, signal) {
    try {
      const result = await this.transcribe(path, { signal });
      if (signal.aborted || this.closed || this.state.id !== id || this.state.phase !== 'transcribing') return;
      if (result.sha256 !== sha256 || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 8000)
        throw new Error('invalid transcript');
      clearTimeout(this.deadline);
      await this.commit({ ...this.state, phase: 'ready', text: result.text.trim(),
        audio: { ...this.state.audio, durationMs: result.durationMs, asrMs: result.asrMs } });
    } catch(error) {
      if(!signal.aborted)await this.cancel(id,'error',typeof error?.publicMessage==='string'?
        error.publicMessage.slice(0,180):'转写未获得有效文字，请重新录音');
    }
  }
  async commit(next) {
    next={...next,revision:++this.revision};this.state = next;
    const data = JSON.stringify(next);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      await writeFile(this.stateFile + '.tmp', data, { mode: 0o600 });
      await rename(this.stateFile + '.tmp', this.stateFile);
    });
    await this.writes; this.emit('state', this.snapshot(next.target?.threadId));
  }
  close() { this.closed = true; clearTimeout(this.deadline); this.controller?.abort(); }
}
