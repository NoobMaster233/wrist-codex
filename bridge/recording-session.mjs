import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const hash = data => createHash('sha256').update(data).digest('hex');
const MAX_BYTES = 8 * 1024 * 1024;

/** One explicit, bounded recording window. Only its immutable target receives a draft. */
export class RecordingSessions extends EventEmitter {
  constructor({ root, stateFile, transcribe, validateTarget, ready = async () => {}, windowMs = 600000, settleMs = 1800 }) {
    super();
    this.root = resolve(root); this.stateFile = stateFile; this.transcribe = transcribe;
    this.validateTarget = validateTarget; this.ready = ready; this.windowMs = windowMs; this.settleMs = settleMs;
    this.state = { phase: 'idle' }; this.writes = Promise.resolve(); this.preparing = false; this.closed = false;
  }

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (saved.schema !== 1) throw new Error('Unsupported recording state');
      this.state = saved;
      if (saved.phase === 'transcribing') await this.commit({ ...saved, phase: 'error', error: '转写进程已中断，请重新开始录音接收' });
      else if (saved.phase === 'armed') {
        if (saved.expiresAt <= Date.now()) await this.commit({ ...saved, phase: 'expired' });
        else { this.openWatch(); this.schedule(); }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  snapshot(threadId) {
    const s = this.state;
    if (!s.target || s.target.threadId !== threadId) return { phase: 'idle' };
    const result = { phase: s.phase, sessionId: s.id, target: s.target, expiresAt: s.expiresAt };
    if (s.error) result.error = s.error;
    if (s.phase === 'ready') { result.text = s.text; result.audio = s.audio; }
    return result;
  }

  async handle({ method, params = {} }) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(params.threadId || '')) throw new Error('录音接收需要指定对话');
    if (method === 'recording.status') return this.snapshot(params.threadId);
    if (method === 'recording.arm') return this.arm(params);
    if (method === 'recording.cancel' || method === 'recording.ack') {
      if (!params.sessionId || params.sessionId !== this.state.id || params.threadId !== this.state.target?.threadId)
        throw new Error('录音窗口已变化，请重新查询');
      if (method === 'recording.ack') {
        if (this.state.phase === 'delivered') return this.snapshot(params.threadId);
        if (this.state.phase !== 'ready') throw new Error('录音草稿尚未生成');
        await this.commit({ ...this.state, phase: 'delivered', text: undefined });
      } else {
        if (['ready', 'delivered'].includes(this.state.phase)) throw new Error('草稿已生成，请先核对或在手机清除');
        this.stopWatch(); this.controller?.abort();
        await this.commit({ ...this.state, phase: 'cancelled', text: undefined });
      }
      return this.snapshot(params.threadId);
    }
    throw new Error('不支持的录音操作');
  }

  async arm(params) {
    if (this.closed || this.preparing || ['armed', 'transcribing', 'ready'].includes(this.state.phase))
      throw new Error('已有录音接收或草稿，请先完成或取消');
    this.preparing = true;
    try {
      await this.ready();
      const target = await this.validateTarget(params);
      if (target.threadId !== params.threadId) throw new Error('录音目标校验失败');
      const baseline = {};
      for (const file of await this.files()) {
        const info = await stat(file);
        if (info.size > 0 && info.size <= MAX_BYTES) {
          baseline[relative(this.root, file)] = { size: info.size, modified: info.mtimeMs, sha256: hash(await readFile(file)) };
        }
      }
      const now = Date.now();
      await this.commit({ schema: 1, id: randomUUID(), phase: 'armed', target, startedAt: now,
        expiresAt: now + this.windowMs, baseline });
      this.openWatch(); this.schedule();
      return this.snapshot(target.threadId);
    } finally { this.preparing = false; }
  }

  async files(dir = this.root) {
    const result = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...await this.files(file));
      else if (entry.isFile() && /\.(ogg|wav)$/i.test(entry.name)) result.push(file);
      if (result.length > 2000) throw new Error('录音目录文件过多，请先整理');
    }
    return result;
  }

  openWatch() {
    this.stopWatch();
    this.watcher = watch(this.root, { recursive: true }, () => this.schedule());
    this.watcher.on('error', () => this.fail(this.state.id, '录音目录监听失败，请重新开启接收').catch(() => {}));
    const id = this.state.id;
    this.expiry = setTimeout(() => {
      if (this.state.id === id && this.state.phase === 'armed') {
        this.stopWatch(); this.commit({ ...this.state, phase: 'expired' }).catch(() => {});
      }
    }, Math.max(1, this.state.expiresAt - Date.now()));
    this.expiry.unref();
  }

  schedule() {
    if (this.closed || this.state.phase !== 'armed') return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan().catch(() => this.fail(this.state.id, '无法读取同步录音，请检查手机存储')).catch(() => {}), this.settleMs);
  }

  async scan() {
    if (this.scanning || this.state.phase !== 'armed' || this.closed) return;
    this.scanning = true;
    const session = this.state;
    try {
      const candidates = [];
      for (const file of await this.files()) {
        const info = await stat(file), previous = session.baseline[relative(this.root, file)];
        if (info.size < 1 || info.size > MAX_BYTES || info.mtimeMs < session.startedAt - 1000) continue;
        if (previous?.size === info.size && previous?.modified === info.mtimeMs) continue;
        candidates.push({ file, info });
      }
      candidates.sort((a,b) => a.info.mtimeMs - b.info.mtimeMs);
      for (const { file, info } of candidates) {
        const data = await readFile(file), after = await stat(file), digest = hash(data);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) { this.schedule(); continue; }
        if (Object.values(session.baseline).some(item => item.sha256 === digest)) continue;
        if (this.state.id !== session.id || this.state.phase !== 'armed' || this.closed) return;
        this.stopWatch();
        const controller = new AbortController(); this.controller = controller;
        await this.commit({ ...session, phase: 'transcribing', audio: { bytes: data.length, sha256: digest } });
        if (!controller.signal.aborted && this.state.id === session.id && this.state.phase === 'transcribing')
          this.runTranscription(session.id, file, digest, controller.signal).catch(() => {});
        return;
      }
    } finally { this.scanning = false; }
  }

  async runTranscription(id, file, digest, signal) {
    try {
      const result = await this.transcribe(file, { signal });
      if (this.state.id !== id || this.state.phase !== 'transcribing' || this.closed) return;
      if (result.sha256 !== digest || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 8000)
        throw new Error('转写未得到有效文字');
      await this.commit({ ...this.state, phase: 'ready', text: result.text.trim(),
        audio: { ...this.state.audio, durationMs: result.durationMs, asrMs: result.asrMs } });
    } catch (error) {
      if (!signal.aborted) await this.fail(id, error.message === '转写未得到有效文字' ? error.message : '本地转写失败，请重试录音或使用文字分享');
    }
  }

  async fail(id, message) {
    if (this.closed || this.state.id !== id || !['armed','transcribing'].includes(this.state.phase)) return;
    this.stopWatch();
    await this.commit({ ...this.state, phase: 'error', error: message });
  }

  async commit(next) {
    this.state = next;
    const serialized = JSON.stringify(next);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
      await writeFile(this.stateFile + '.tmp', serialized, { mode: 0o600 });
      await rename(this.stateFile + '.tmp', this.stateFile);
    });
    await this.writes;
    this.emit('state');
  }
  stopWatch() { this.watcher?.close(); this.watcher = null; clearTimeout(this.debounce); clearTimeout(this.expiry); }
  close() { this.closed = true; this.stopWatch(); this.controller?.abort(); }
}
