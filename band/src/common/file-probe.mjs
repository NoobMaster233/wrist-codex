import { crc32, decode64, uploadBlob } from './bytes.mjs';

const call = (file, method, options) => new Promise((resolve, reject) => {
  file[method]({ ...options, success: resolve, fail: (message, code) => reject(new Error(method + ':' + code)) });
});

export function probeEventLoop(event, nonce) {
  return new Promise(resolve => {
    let id, timer, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (typeof id === 'number') { try { event.unsubscribe({ id }); } catch (_) {} }
      resolve(result);
    };
    try {
      id = event.subscribe({ eventName: 'bc.capture.probe', callback: result => {
        if (result && result.package === 'dev.bandcodex.remote' && result.params && result.params.n === nonce)
          finish({ supported: true, received: true });
      } });
      if (typeof id !== 'number') { finish({ supported: false, received: false }); return; }
      timer = setTimeout(() => finish({ supported: true, received: false }), 3000);
      event.publish({ eventName: 'bc.capture.probe', options: {
        params: { n: nonce }, permissions: ['dev.bandcodex.remote']
      } });
    } catch (_) { finish({ supported: false, received: false }); }
  });
}

/** Only our named temporary cache file; no microphone, shell, or system paths. */
export async function runFileProbe({ file, event, command, rpc, alive = () => true }) {
  if (command && command.probeId) command = { ...command, id: command.probeId };
  if (!command || !/^probe-[a-f0-9-]{36}$/.test(command.id || '')) throw new Error('Invalid probe id');
  const bytes = decode64(command.b64, 4096);
  if (bytes.length !== command.size || crc32(bytes) !== command.crc) throw new Error('Probe payload differs');
  const uri = 'internal://cache/bc-' + command.id + '.bin';
  let created = false;
  const checkAlive = () => { if (!alive()) throw new Error('Probe cancelled'); };
  try {
    checkAlive(); await rpc('capabilities.progress', { id:command.id, stage:'writing' });
    await call(file, 'writeArrayBuffer', { uri, buffer: bytes, position: 0, append: false }); created = true;
    checkAlive(); await rpc('capabilities.progress', { id:command.id, stage:'reading' });
    const read = await call(file, 'readArrayBuffer', { uri, position: 0, length: bytes.length });
    checkAlive();
    const copy = read.buffer instanceof Uint8Array ? read.buffer : new Uint8Array(read.buffer);
    if (copy.length !== bytes.length || crc32(copy) !== command.crc) throw new Error('Probe readback differs');
    await rpc('capabilities.progress', { id:command.id, stage:'events' });
    const eventResult = await probeEventLoop(event, command.id.slice(-12));
    if (!alive()) throw new Error('App closed during probe');
    await rpc('capabilities.progress', { id:command.id, stage:'uploading' });
    const uploaded = await uploadBlob(copy, { id: command.id, name: 'band-binary-probe.bin',
      chunkBytes:command.uploadChunkBytes===undefined?128:command.uploadChunkBytes,
      rpc: params => rpc('blob.frame', params), cancelled: () => !alive() });
    return await rpc('capabilities.report', { id: command.id, fileReadWrite: true,
      event: eventResult, transfer: { state: uploaded.state, size: uploaded.size, crc: uploaded.crc } });
  } catch (error) {
    try { await rpc('capabilities.report', { id: command.id, error: String(error.message || error).slice(0, 100) }); } catch (_) {}
    throw error;
  } finally {
    if (created) { try { await call(file, 'delete', { uri }); } catch (_) {} }
  }
}
