import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const TRANSCRIPTION_ENDPOINT = 'https://chatgpt.com/backend-api/transcribe';
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export class TranscriptionError extends Error {
  constructor(code, message, status) {
    super(message); this.name = 'TranscriptionError'; this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const failures = {
  400: ['INVALID_AUDIO', '转写服务未接受这段录音'],
  401: ['AUTH_REQUIRED', 'Codex 登录已失效，请在手机重新登录'],
  403: ['ACCESS_DENIED', '当前网络或账号未能访问转写服务'],
  415: ['UNSUPPORTED_AUDIO', '转写服务未接受此音频格式'],
  429: ['RATE_LIMITED', '转写请求已达限制，请稍后再试']
};

/** Receives completed audio only. It never opens a microphone or sends a Codex turn. */
export async function transcribeChatGPTAudio(bytes, {
  language = 'zh', signal, authDir = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  fetchImpl = globalThis.fetch, timeoutMs = 40000
} = {}) {
  if (signal?.aborted) throw new TranscriptionError('CANCELLED', '转写已取消');
  const audio = Buffer.from(bytes);
  if (audio.length < 12 || audio.length > MAX_AUDIO_BYTES)
    throw new TranscriptionError('AUDIO_SIZE_LIMIT', '录音为空或超过 8 MB');
  let extension, mime;
  if (audio.subarray(0, 4).toString() === 'RIFF' && audio.subarray(8, 12).toString() === 'WAVE') {
    extension = '.wav'; mime = 'audio/wav';
  } else if (audio.subarray(0, 4).toString() === 'OggS') {
    extension = '.ogg'; mime = 'audio/ogg';
  } else throw new TranscriptionError('UNSUPPORTED_AUDIO', '当前手环转写模块接收 WAV 或 Ogg 录音');
  if (typeof language !== 'string' || !/^(?:auto|[a-z]{2,3}(?:-[a-zA-Z]{2,8})?)$/.test(language))
    throw new TranscriptionError('INVALID_LANGUAGE', '转写语言参数无效');

  let token, accountId;
  try {
    const auth = JSON.parse(await readFile(join(authDir, 'auth.json'), 'utf8'));
    token = auth.tokens?.access_token; accountId = auth.tokens?.account_id;
  } catch { throw new TranscriptionError('AUTH_REQUIRED', '未读到 Codex 登录，请在手机登录后重试'); }
  if (typeof token !== 'string' || !token.trim())
    throw new TranscriptionError('AUTH_REQUIRED', '需要 Codex 的 ChatGPT 登录凭据');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), 'recording' + extension);
  if (language !== 'auto') form.append('language', language);
  const headers = { Authorization: `Bearer ${token}`, originator: 'Codex Desktop',
    'User-Agent': `Codex Desktop/0.1.0 (${process.platform}; ${process.arch})` };
  if (typeof accountId === 'string' && accountId.trim()) headers['ChatGPT-Account-Id'] = accountId;
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const started = Date.now();
  try {
    const response = await fetchImpl(TRANSCRIPTION_ENDPOINT, {
      method: 'POST', headers, body: form, redirect: 'error', signal: requestSignal
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const [code, message] = failures[response.status] || ['SERVICE_ERROR', '转写服务暂时不可用'];
      throw new TranscriptionError(code, message, response.status);
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 128 * 1024) throw new TranscriptionError('INVALID_RESPONSE', '转写响应过大');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new TranscriptionError('INVALID_RESPONSE', '转写服务未返回有效文字'); }
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (!text || text.length > 8000) throw new TranscriptionError('NO_TRANSCRIPT', '未识别到有效文字，请重新录音');
    return { text, engine: 'chatgpt-file-transcription',
      sha256: createHash('sha256').update(audio).digest('hex'), asrMs: Date.now() - started };
  } catch (error) {
    if (signal?.aborted) throw new TranscriptionError('CANCELLED', '转写已取消');
    if (timeout.aborted) throw new TranscriptionError('TIMEOUT', '转写超时，请重试');
    if (error instanceof TranscriptionError) throw error;
    // Never expose fetch error bodies, request headers, auth contents or internal causes.
    throw new TranscriptionError('NETWORK_ERROR', '无法连接转写服务，请检查手机网络');
  }
}

export async function transcribeChatGPTFile(path, options) {
  if ((await stat(path)).size > MAX_AUDIO_BYTES)
    throw new TranscriptionError('AUDIO_SIZE_LIMIT', '录音超过 8 MB');
  return transcribeChatGPTAudio(await readFile(path), options);
}
