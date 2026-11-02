import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { CodexClient } from './codex-client.mjs';
import { BandService } from './service.mjs';
import { watchThread } from './thread-feed.mjs';
import { RecordingSessions } from './recording-session.mjs';

export function createBridgeServer(service, token) {
  const feeds = new Set();
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin) return reply(403, { error: 'Browser origins are not accepted' });
    if (req.method === 'GET' && req.url === '/health') return reply(200, { service: 'band-codex', version: '0.1.9' });
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { return reply(400, { error: 'Invalid request URL' }); }
    const events = req.method === 'GET' && url.pathname === '/events';
    if (!events && (req.method !== 'POST' || req.url !== '/rpc')) return reply(404, { error: 'Not found' });
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'Unauthorized' });
    if (events) {
      const threadId = url.searchParams.get('threadId');
      if (!threadId || !/^[a-zA-Z0-9_-]{1,200}$/.test(threadId)) return reply(400, { error: 'Invalid conversation id' });
      if (feeds.size >= 4) return reply(429, { error: 'Too many event connections' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.flushHeaders();
      feeds.add(res);
      const send = (event, data) => {
        if (res.destroyed) return;
        if (res.writableLength > 256 * 1024) { res.destroy(); return; }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const unwatch = watchThread(service, threadId, snapshot => send('snapshot', snapshot), error => {
        send('feed-error', { error: error.message });
        res.end();
      });
      const recordingChanged = () => send('recording', service.recordings.snapshot(threadId));
      if (service.recordings) {
        service.recordings.on('state', recordingChanged);
        recordingChanged();
      }
      // Keep only the local HTTP connection alive; nothing is sent to the band.
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
      heartbeat.unref();
      res.once('close', () => {
        clearInterval(heartbeat); unwatch(); feeds.delete(res);
        service.recordings?.off('state', recordingChanged);
      });
      return;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON is required' });
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) return reply(413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await service.handle(request);
      reply(200, { v: 1, id: request.id, result });
    } catch (error) { reply(400, { error: error.message }); }
  });
  server.closeFeeds = () => { for (const response of feeds) response.destroy(); };
  return server;
}

async function main() {
  const local = fileURLToPath(new URL('../.local/', import.meta.url));
  await mkdir(local, { recursive: true, mode: 0o700 });
  const tokenFile = join(local, 'bridge-token');
  let token;
  try { token = (await readFile(tokenFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
  }
  const port = Number(process.env.BAND_CODEX_PORT || 32178);
  const client = new CodexClient();
  const service = new BandService(client, { allowSend: process.argv.includes('--allow-send') });
  const exec = promisify(execFile);
  const asrScript = fileURLToPath(new URL('../scripts/transcribe-recording.py', import.meta.url));
  let recordingRoot;
  try {
    const source = JSON.parse(await readFile(join(local, 'recording-source.json'), 'utf8'));
    if (source.schema === 1 && /^\/sdcard\/Recordings\/recorder\/sync\/[a-zA-Z0-9_-]+$/.test(source.root)) recordingRoot = source.root;
  } catch {}
  service.recordings = new RecordingSessions({
    root: recordingRoot || '/sdcard/Recordings/recorder/sync', stateFile: join(local, 'recording-session.json'),
    ready: async () => {
      if (!recordingRoot) throw new Error('系统录音来源尚未绑定，请先配置这只手环的同步目录');
      try {
        const config = JSON.parse(await readFile(join(local, 'offline-asr.json'), 'utf8'));
        await Promise.all([recordingRoot, config.binary, config.model, config.tokens].map(path => access(path)));
      } catch { throw new Error('本地转写资源尚未就绪，请在 Termux 运行 setup-offline-asr.py'); }
    },
    validateTarget: async params => {
      await client.connect();
      const { thread } = await client.request('thread/read', { threadId: params.threadId });
      if (typeof params.cwd !== 'string' || thread.cwd !== params.cwd) throw new Error('项目和对话不匹配');
      return { threadId: thread.id, cwd: thread.cwd, projectName: basename(thread.cwd),
        threadTitle: (thread.name || params.threadTitle || '未命名对话').slice(0, 160) };
    },
    transcribe: async (file, { signal }) => {
      const { stdout } = await exec('python', [asrScript, file], { signal, timeout: 85000, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    }
  });
  await service.recordings.init();
  client.on('serverRequest', message => {
    // Until an approval UI is implemented, explicitly reject requests instead
    // of leaving a turn silently waiting or granting execution rights.
    client.socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Band client has no approval UI. Continue this turn in the main Codex client.' } }));
  });
  const server = createBridgeServer(service, token);
  server.on('error', error => { console.error(error.message); client.close(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', async () => {
    await writeFile(join(local, 'companion-config.json'), JSON.stringify({ port, token }), { mode: 0o600 });
    console.log(`Band Codex bridge: http://127.0.0.1:${port}; send=${service.allowSend}`);
  });
  const stop = () => { service.recordings.close(); server.closeFeeds(); server.close(); client.close(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
