import test from 'node:test';
import assert from 'node:assert/strict';
import {AstroRelay} from '../bridge/astro-server.mjs';

function setup(t){
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const relay=new AstroRelay({handle:()=>{throw new Error('No prompt allowed');}});
  relay.nativeOnly=true;relay.decodeNativeAudio=()=>{throw new Error('No ASR path allowed');};
  relay.recording={state:{phase:'cancelled'},handle:()=>{throw new Error('No draft changes allowed');}};
  relay.connected=true;relay.lastSeen=Date.now();return relay;
}
test('operator audio check stops after acknowledgement without creating a draft or uploading',async t=>{
  const relay=setup(t),check=relay.startNativeAudioCheck();
  assert.equal(relay.events[0].data.action,'start');
  assert.throws(()=>relay.startNativeAudioCheck(),/当前/);
  await assert.rejects(relay.handle({method:'recording.arm',params:{}}),/自检/);
  t.mock.timers.tick(500);
  await relay.handle({method:'native.audio.state',params:{sessionId:check.id,phase:'recording'}});
  t.mock.timers.tick(1000);assert.equal(relay.events.at(-1).data.action,'stop');
  const name='bc-audio-'+check.id.replace(/-/g,'')+'.bcap';
  await relay.handle({method:'native.audio.state',params:{sessionId:check.id,phase:'receiving',name}});
  t.mock.timers.tick(20000);
  assert.equal(relay.nativeAudioCheck.phase,'complete');assert.equal(relay.nativeAudioCheck.name,name);
  assert.equal(relay.fileUpload,undefined);assert.equal(relay.recording.state.phase,'cancelled');
  assert.equal(relay.events.length,2);
});
test('diagnostic timeout removes queued starts and rejects delayed capture completion',async t=>{
  const relay=setup(t),check=relay.startNativeAudioCheck();
  t.mock.timers.tick(30000);
  assert.equal(relay.nativeAudioCheck.phase,'error');
  assert.equal(relay.events.length,1);assert.equal(relay.events[0].data.action,'cancel');
  assert.deepEqual(await relay.handle({method:'native.audio.state',params:{sessionId:check.id,phase:'recording'}}),{accepted:false});
  assert.equal(relay.recording.state.phase,'cancelled');assert.equal(relay.fileUpload,undefined);
});
test('a capture starting late in the wake window gets its own bounded stop deadline',async t=>{
  const relay=setup(t),check=relay.startNativeAudioCheck();
  t.mock.timers.tick(24000);
  await relay.handle({method:'native.audio.state',params:{sessionId:check.id,phase:'recording'}});
  t.mock.timers.tick(7000);assert.equal(relay.nativeAudioCheck.phase,'pending');
  const name='bc-audio-'+check.id.replace(/-/g,'')+'.bcap';
  await relay.handle({method:'native.audio.state',params:{sessionId:check.id,phase:'receiving',name}});
  assert.equal(relay.nativeAudioCheck.phase,'complete');assert.equal(relay.recording.state.phase,'cancelled');
});
test('service recovery cannot interrupt a draft or capture and expires without replay',async t=>{
  const relay=setup(t);relay.recording.state.phase='ready';
  assert.throws(()=>relay.startNativeRecovery(),/当前/);relay.recording.state.phase='cancelled';
  relay.recording.state.phase='cancelled';
  const job=relay.startNativeRecovery();
  assert.equal(relay.events[0].kind,'maintenance');
  await assert.rejects(relay.handle({method:'recording.arm',params:{}}),/恢复/);
  assert.throws(()=>relay.startNativeAudioCheck(),/恢复/);
  assert.throws(()=>relay.startNativeRecovery(),/恢复/);
  t.mock.timers.tick(90000);relay.expireNativeRecovery();
  assert.equal(relay.nativeRecovery.phase,'error');assert.equal(relay.events.length,0);
  assert.equal(relay.recording.state.phase,'cancelled');assert.equal(relay.nativeRecovery.id,job.id);
});
