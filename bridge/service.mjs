import { basename } from 'node:path';
import { SendJournal } from './send-journal.mjs';

const SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'unknown'];
function textPage(text, offset = 0) {
  const characters = Array.from(text);
  return { text: characters.slice(offset, offset + 900).join(''), nextOffset: offset + 900 < characters.length ? offset + 900 : null };
}
export class BandService {
  constructor(client, { allowSend = false, sendJournal = new SendJournal() } = {}) {
    this.client = client;
    this.allowSend = allowSend;
    this.sends = sendJournal;
  }

  async handle({ id, method, params = {} } = {}) {
    if (typeof method !== 'string' || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid request');
    if (method.startsWith('recording.')) {
      if (!this.recordings) throw new Error('自动录音接收尚未配置');
      return this.recordings.handle({ method, params });
    }
    try { await this.client.connect(); }
    catch(error) {
      if(method==='prompt.send')error.sendNotStarted=true;
      throw error;
    }
    switch (method) {
      case 'projects.list': {
        const projects = new Map();
        let cursor;
        for (let page = 0; page < 100; page++) {
          const result = await this.client.request('thread/list', { limit: 100, sourceKinds: SOURCE_KINDS, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
          for (const thread of result.data) {
            if (thread.cwd && !projects.has(thread.cwd)) projects.set(thread.cwd, { path: thread.cwd, name: basename(thread.cwd) || thread.cwd });
          }
          cursor = result.nextCursor;
          if (!cursor) return { projects: [...projects.values()], truncated: false };
        }
        return { projects: [...projects.values()], truncated: true };
      }
      case 'threads.list': {
        if (typeof params.cwd !== 'string' || !params.cwd) throw new Error('Project path is required');
        const result = await this.client.request('thread/list', { cwd: params.cwd, sourceKinds: SOURCE_KINDS, limit: 10, sortKey: 'updated_at', ...(params.cursor ? { cursor: params.cursor } : {}) });
        return { threads: result.data.map(thread => ({ id: thread.id, title: thread.name || thread.preview?.slice(0, 60) || '未命名对话', status: thread.status, updatedAt: thread.updatedAt })), nextCursor: result.nextCursor };
      }
      case 'messages.list': {
        this.requireThread(params);
        const [page, metadata] = await Promise.all([
          this.client.request('thread/turns/list', { threadId: params.threadId, limit: 2, sortDirection: 'desc', itemsView: 'full', ...(params.cursor ? { cursor: params.cursor } : {}) }),
          this.client.request('thread/read', { threadId: params.threadId })
        ]);
        const messages = [];
        for (const turn of [...page.data].reverse()) {
          for (const item of turn.items || []) {
            const text = this.messageText(item);
            if (text === null) continue;
            const page = textPage(text);
            messages.push({ id: item.id, turnId: turn.id, role: item.type === 'userMessage' ? 'user' : 'assistant', text: page.text, truncated: page.nextOffset !== null });
          }
        }
        return { messages, nextCursor: page.nextCursor, status: metadata.thread.status };
      }
      case 'message.read': {
        this.requireThread(params);
        if (typeof params.turnId !== 'string' || typeof params.itemId !== 'string') throw new Error('Message identifiers are required');
        const result = await this.client.request('thread/items/list', { threadId: params.threadId, turnId: params.turnId, limit: 100 });
        let items = result.data;
        let cursor = result.nextCursor;
        while (!items.some(entry => entry.item.id === params.itemId) && cursor) {
          const more = await this.client.request('thread/items/list', { threadId: params.threadId, turnId: params.turnId, limit: 100, cursor });
          items = more.data;
          cursor = more.nextCursor;
        }
        const item = items.find(entry => entry.item.id === params.itemId)?.item;
        if (!item) throw new Error('Message not found');
        const text = this.messageText(item);
        if (text === null) throw new Error('Unsupported message type');
        const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
        return textPage(text, offset);
      }
      case 'prompt.send': {
        if (!this.allowSend) throw new Error('当前是读取测试模式，发送尚未启用');
        this.requireThread(params);
        if (typeof id !== 'string' || id.length < 8 || id.length > 100) throw new Error('A unique request id is required');
        if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 8000) throw new Error('Message must contain 1–8000 characters');
        return this.sends.run(id,[params.threadId,params.text],async()=>{
          const metadata = await this.client.request('thread/read', { threadId: params.threadId });
          if (metadata.thread.status.type === 'active') throw new Error('这段对话正在处理任务，请等待完成后再发送');
          // Sending needs a live session, not its entire transcript. Full
          // history can exceed the bounded WebSocket frame size for long
          // research threads. Message history is already read by page.
          await this.client.request('thread/resume', { threadId: params.threadId, excludeTurns: true });
        },async()=>{
          const result = await this.client.request('turn/start', { threadId: params.threadId, input: [{ type: 'text', text: params.text }] });
          return { threadId: params.threadId, turnId: result.turn.id, status: result.turn.status };
        });
      }
      default: throw new Error(`Unsupported operation: ${method}`);
    }
  }

  requireThread(params) {
    if (typeof params.threadId !== 'string' || !params.threadId) throw new Error('Conversation id is required');
  }

  messageText(item) {
    if (item.type === 'agentMessage') return item.text || '';
    if (item.type === 'userMessage') return (item.content || []).filter(entry => entry.type === 'text').map(entry => entry.text).join('\n');
    return null;
  }
}
