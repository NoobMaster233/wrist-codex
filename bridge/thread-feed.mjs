// Refresh only in response to Codex events. No history polling or model turns.
export function watchThread(service, threadId, onSnapshot, onError, { settleMs = 120 } = {}) {
  const client = service.client;
  let closed = false;
  let initializing = true;
  let reading = false;
  let dirty = false;
  let timer;
  let previous;

  const close = () => {
    closed = true;
    clearTimeout(timer);
    client.off('notification', notification);
    client.off('disconnected', disconnected);
  };
  const fail = error => {
    if (closed) return;
    close();
    onError(error);
  };
  const read = async () => {
    if (closed || initializing || reading) { dirty = true; return; }
    reading = true;
    try {
      do {
        dirty = false;
        const snapshot = await service.handle({ method: 'messages.list', params: { threadId } });
        if (closed) return;
        const encoded = JSON.stringify(snapshot);
        if (encoded !== previous) {
          previous = encoded;
          onSnapshot(snapshot);
        }
      } while (dirty && !closed);
    } catch (error) { fail(error); }
    finally { reading = false; }
  };
  const notification = ({ method, params = {} }) => {
    if (closed || params.threadId !== threadId) return;
    const textItem = method === 'item/completed' && ['agentMessage', 'userMessage'].includes(params.item?.type);
    if (!textItem && !['turn/started', 'turn/completed', 'thread/status/changed'].includes(method)) return;
    dirty = true;
    if (initializing || reading) return;
    clearTimeout(timer);
    timer = setTimeout(read, method === 'turn/completed' ? 0 : settleMs);
  };
  const disconnected = () => fail(new Error('Codex connection closed'));
  client.on('notification', notification);
  client.on('disconnected', disconnected);
  (async () => {
    try {
      await client.connect();
      if (closed) return;
      // Rejoin the existing thread without changing its model, permissions or
      // instructions. The server then sends this connection turn/item events.
      await client.request('thread/resume', { threadId, excludeTurns: true });
      if (closed) return;
      initializing = false;
      await read();
    } catch (error) { fail(error); }
  })();
  return close;
}
