import { CodexClient } from '../bridge/codex-client.mjs';

const client = new CodexClient();
try {
  const info = await client.connect();
  const page = await client.request('thread/list', {
    limit: 50, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer', 'unknown']
  });
  const paths = [...new Set(page.data.map(thread => thread.cwd))];
  const target = page.data.find(thread => thread.cwd === process.cwd()) || page.data[0];
  let history;
  if (target) {
    const data = await client.request('thread/turns/list', { threadId: target.id, limit: 5, itemsView: 'full', sortDirection: 'desc' });
    history = { readable: true, turnsInPage: data.data.length };
  }
  console.log(JSON.stringify({ connected: true, platform: info.platformOs, threadCountInPage: page.data.length, projectPaths: paths, hasMoreThreads: Boolean(page.nextCursor), history, sendsPerformed: 0 }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ connected: false, error: error.message }));
  process.exitCode = 1;
} finally { client.close(); }
