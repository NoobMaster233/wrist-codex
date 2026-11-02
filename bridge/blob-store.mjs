import { access, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32, decode64 } from '../band/src/common/bytes.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const u32 = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/** Authenticated relay's bounded file receiver. Logical names never form paths. */
export class BlobStore {
  constructor({ root, maxBytes = 1024 * 1024, maxActive = 2, maxChunkBytes = 1024, now = Date.now }) {
    if (![128,1024].includes(maxChunkBytes)) throw new Error('Invalid upload chunk limit');
    Object.assign(this, { root, maxBytes, maxActive, maxChunkBytes, now });
    this.entries = new Map(); this.chain = Promise.resolve(); this.waiting = 0;
  }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  snapshot(id) {
    const e = this.entries.get(id);
    if (!e) return null;
    return { id, state: e.state, size: e.size, bytes: e.bytes, next: e.next, chunkBytes:e.chunkBytes,
      crc: e.crc, ...(e.sha256 ? { sha256: e.sha256 } : {}) };
  }
  frame(message) {
    if (this.closed || this.waiting >= 32) return Promise.reject(new Error('File receiver unavailable'));
    ++this.waiting;
    const result = this.chain.catch(() => {}).then(() => this.handle(message));
    this.chain = result;
    return result.finally(() => { --this.waiting; });
  }
  async abandon(e, state = 'cancelled') {
    e.state = state;
    const handle = e.handle; e.handle = null;
    try { await handle?.close(); } finally { await rm(e.part, { force: true }); }
    e.hashes = []; e.hash = null;
  }
  async handle(m) {
    if (!m || !/^[A-Za-z0-9_-]{8,64}$/.test(m.id || '')) throw new Error('Invalid transfer id');
    for (const e of this.entries.values())
      if (e.state === 'receiving' && this.now() - e.updated > 120000) await this.abandon(e, 'expired');
    let e = this.entries.get(m.id);
    if (m.t === 'open') {
      const requestedChunkBytes=m.chunkBytes===undefined?128:m.chunkBytes;
      if (!Number.isInteger(m.size) || m.size < 0 || m.size > this.maxBytes || !u32(m.crc) ||
          typeof m.name !== 'string' || !m.name || m.name.length > 80 || /[\x00-\x1f/\\]/.test(m.name) ||
          ![128,1024].includes(requestedChunkBytes))
        throw new Error('Invalid file metadata');
      if (e) {
        if (e.size !== m.size || e.expectedCrc !== m.crc || e.name !== m.name || e.requestedChunkBytes!==requestedChunkBytes)
          throw new Error('Transfer id reused');
        if (!['receiving', 'complete'].includes(e.state)) throw new Error('Transfer is closed');
        return this.snapshot(m.id);
      }
      const active = [...this.entries.values()].filter(v => v.state === 'receiving').length;
      if (active >= this.maxActive) throw new Error('Too many active transfers');
      while (this.entries.size >= 64) {
        const oldest = [...this.entries].find(([, value]) => value.state !== 'receiving');
        if (!oldest) throw new Error('File transfer history full');
        this.entries.delete(oldest[0]);
      }
      const part = join(this.root, m.id + '.part');
      try {
        await access(join(this.root, m.id + '.bin'));
        throw new Error('Completed transfer id already exists on disk');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const handle = await open(part, 'wx', 0o600);
      e = { id: m.id, name: m.name, size: m.size, expectedCrc: m.crc, crc: 0, bytes: 0,
        requestedChunkBytes, chunkBytes:Math.min(requestedChunkBytes,this.maxChunkBytes),
        next: 0, state: 'receiving', handle, part, hash: createHash('sha256'), hashes: [], updated: this.now() };
      this.entries.set(m.id, e);
      return this.snapshot(m.id);
    }
    if (!e) throw new Error('Unknown transfer');
    if (m.t === 'finish' && e.state === 'complete') return this.snapshot(m.id);
    if (m.t === 'cancel') {
      if (e.state === 'receiving') await this.abandon(e);
      return this.snapshot(m.id);
    }
    if (e.state !== 'receiving') throw new Error('Transfer is closed');
    e.updated = this.now();
    if (m.t === 'chunk') {
      if (!Number.isInteger(m.seq) || m.seq < 0 || !u32(m.crc)) throw new Error('Invalid file frame');
      const data = decode64(m.b64, e.chunkBytes);
      if (!data.length || crc32(data) !== m.crc) throw new Error('File chunk checksum differs');
      if (m.seq < e.next) {
        if (e.hashes[m.seq] !== sha(data)) throw new Error('Conflicting duplicate chunk');
        return this.snapshot(m.id);
      }
      if (m.seq !== e.next) throw new Error('File chunk out of order');
      if (data.length !== Math.min(e.chunkBytes, e.size - e.bytes)) throw new Error('File chunk length differs');
      try {
        let offset = 0;
        while (offset < data.length) {
          const { bytesWritten } = await e.handle.write(data, offset, data.length - offset, e.bytes + offset);
          if (!bytesWritten) throw new Error('File write made no progress');
          offset += bytesWritten;
        }
        e.hashes.push(sha(data)); e.hash.update(data); e.crc = crc32(data, e.crc);
        e.bytes += data.length; ++e.next;
      } catch (error) { await this.abandon(e, 'error'); throw error; }
      return this.snapshot(m.id);
    }
    if (m.t === 'finish') {
      if (e.bytes !== e.size) throw new Error('File is incomplete');
      if (e.crc !== e.expectedCrc) { await this.abandon(e, 'error'); throw new Error('File checksum differs'); }
      try {
        await e.handle.sync(); await e.handle.close(); e.handle = null;
        e.sha256 = e.hash.digest('hex'); e.hash = null;
        await rename(e.part, join(this.root, m.id + '.bin'));
        await writeFile(join(this.root, m.id + '.json'), JSON.stringify({ id: e.id, name: e.name,
          size: e.size, crc: e.crc, sha256: e.sha256, chunkBytes:e.chunkBytes }), { flag: 'wx', mode: 0o600 });
        e.state = 'complete'; e.hashes = [];
      } catch (error) { await this.abandon(e, 'error'); throw error; }
      return this.snapshot(m.id);
    }
    throw new Error('Unknown file operation');
  }
  async close() {
    this.closed = true; await this.chain.catch(() => {});
    for (const e of this.entries.values()) if (e.state === 'receiving') await this.abandon(e);
  }
}
