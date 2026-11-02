import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

export class CodexClient extends EventEmitter {
  constructor({ socketPath = process.env.BAND_CODEX_SOCKET || join(homedir(), '.codex', 'app-server-control-termux', 'app-server-control.sock'), timeout = 15000, maxPayload = 16 * 1024 * 1024 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeout = timeout;
    this.maxPayload = maxPayload;
    this.pending = new Map();
    this.sequence = 0;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.open().catch(error => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  async open() {
    const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, { maxPayload: this.maxPayload, handshakeTimeout: this.timeout });
    this.socket = socket;
    let transportErrorCode;
    socket.on('error', error => {
      if(typeof error.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code))transportErrorCode=error.code;
      this.emit('connectionError', error);
    });
    socket.on('close', code => {
      if(this.socket!==socket)return;
      this.lastDisconnect={at:Date.now(),code,...(transportErrorCode?{transportErrorCode}:{}),
        pendingMethods:[...new Set([...this.pending.values()].map(entry=>entry.method))]};
      this.connecting = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Codex connection closed'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    socket.on('message', data => this.receive(data));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const result = await this.request('initialize', {
      clientInfo: { name: 'xiaomi_band_codex', title: 'Band Codex', version: '0.3.2' },
      capabilities: { experimentalApi: true }
    });
    this.notify('initialized');
    return result;
  }

  receive(data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.method) {
      // Server requests (including approvals) are surfaced to the caller.
      // They must never be accepted automatically.
      this.emit(message.id === undefined ? 'notification' : 'serverRequest', message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      entry.reject(error);
    } else entry.resolve(message.result);
  }

  notify(method, params) {
    this.socket.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }));
  }

  request(method, params = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex is disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() { this.socket?.close(); }
  snapshot() { return {connected:this.socket?.readyState===WebSocket.OPEN,lastDisconnect:this.lastDisconnect||null}; }
}
