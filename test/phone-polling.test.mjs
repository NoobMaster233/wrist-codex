import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AstroRelay } from '../bridge/astro-server.mjs';

test('idle and protected drafts reduce phone work without losing or sending them', t => {
  let calls=0;
  const relay=new AstroRelay({handle(){calls++;}});
  t.after(()=>relay.close());
  relay.recording={state:{phase:'ready',id:'protected',text:'草稿'},close(){}};
  assert.equal(relay.poll(0).pollAfterMs,4000);
  assert.equal(calls,0);
  assert.equal(relay.recording.state.text,'草稿');
  relay.watchId='watch';
  assert.equal(relay.poll(0).pollAfterMs,1500);
});

test('recording and maintenance deadlines keep a short phone interval', t => {
  const relay=new AstroRelay({});t.after(()=>relay.close());
  relay.recording={state:{phase:'recording'},close(){}};
  assert.equal(relay.poll(0).pollAfterMs,750);
  relay.recording.state.phase='idle';
  relay.nativeRecovery={phase:'pending'};
  assert.equal(relay.poll(0).pollAfterMs,750);
  relay.nativeRecovery.phase='complete';
  relay.fileUpload={phase:'pending',updatedAt:Date.now()};
  assert.equal(relay.poll(0).pollAfterMs,750);
});

test('a burst drains quickly, unacknowledged events survive, then polling slows', t => {
  const relay=new AstroRelay({});t.after(()=>relay.close());
  relay.enqueue('band',{bc_command:'first'});
  relay.enqueue('band',{bc_command:'second'});
  const first=relay.poll(0);
  assert.equal(first.pollAfterMs,250);
  assert.deepEqual(relay.poll(0).event,first.event);
  const second=relay.poll(first.event.id);
  assert.equal(second.event.data.bc_command,'second');
  assert.equal(second.pollAfterMs,250);
  const drained=relay.poll(second.event.id);
  assert.equal(drained.event,null);
  assert.equal(drained.pollAfterMs,4000);
});
