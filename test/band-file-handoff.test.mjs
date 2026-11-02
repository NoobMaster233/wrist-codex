import {readWorkspaceScript} from './fixtures/workspace-script.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';
import {shellPresets} from '../band/src/common/device-tools.mjs';

const script = await readWorkspaceScript('return');

function harness() {
  const timers = [], receives = [], uploads = [], reports = [], awake = [];
  let finish;
  const task = new Promise(resolve => { finish = resolve; });
  const page = new Function('file', 'receiveFile', 'sendOwnFile', 'setTimeout', 'shellPresets', script)(
    {}, options => { receives.push(options); return task; },
    options => { uploads.push(options); return task; }, callback => { timers.push(callback); return timers.length; },shellPresets);
  Object.assign(page, page.private, {
    destroyed: false, hidden: false, fileReceptionRunning: true,
    activeFileReceiveId: '', activeFileUploadId: 'previous', nativeShellSession: '',
    cancelledAudioSessions: [],
    auxiliaryRpc: async (method, params) => { reports.push({ method, params }); },
    keepRecordingAwake: enabled => { awake.push(enabled); }
  });
  return { page, timers, receives, uploads, reports, awake, finish };
}

test('next incoming file waits for prior upload ACK, then starts once and retains active Shell wake', async () => {
  const h = harness(), command = { transferId: 'next-incoming-file' };
  h.page.receiveFileCommand(command);
  assert.equal(h.receives.length, 0);
  assert.equal(h.reports.length, 0);
  h.page.fileReceptionRunning = false;
  h.page.nativeShellSession = 'active-shell';
  h.timers.shift()();
  assert.equal(h.receives.length, 1);
  h.page.receiveFileCommand({ ...command });
  assert.equal(h.receives.length, 1);
  assert.equal(h.reports.length, 0);
  h.finish(); await tick();
  assert.equal(h.page.fileReceptionRunning, false);
  assert.equal(h.page.activeFileReceiveId, '');
  assert.equal(h.awake.at(-1), true);
});

test('ordinary outgoing files also wait for the previous final ACK', async () => {
  const h = harness(), command = { transferId: 'next-upload', purpose: 'file' };
  h.page.uploadFileCommand(command);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.reports.length, 0);
  h.page.fileReceptionRunning = false;
  h.timers.shift()();
  assert.equal(h.uploads.length, 1);
  h.page.uploadFileCommand({ ...command });
  assert.equal(h.uploads.length, 1);
  h.finish(); await tick();
  assert.equal(h.page.fileReceptionRunning, false);
});

test('a genuinely busy device rejects after a bounded local wait without receiving a second file', async () => {
  const h = harness();
  h.page.receiveFileCommand({ transferId: 'bounded-wait' });
  let steps = 0;
  while (h.timers.length) { h.timers.shift()(); assert.ok(++steps <= 60); }
  assert.equal(h.receives.length, 0);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].method, 'files.received');
  assert.match(h.reports[0].params.error, /已有任务/);
});

test('closing the page while awaiting an ACK cannot start a delayed file operation', () => {
  const h = harness();
  h.page.receiveFileCommand({ transferId: 'closed-page' });
  h.page.destroyed = true;
  h.timers.shift()();
  assert.equal(h.receives.length, 0);
  assert.equal(h.reports.length, 0);
});
