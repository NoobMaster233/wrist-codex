import {readWorkspaceScript} from './fixtures/workspace-script.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {DirectRecording} from '../bridge/direct-recording.mjs';
import {AstroRelay} from '../bridge/astro-server.mjs';
import {BlobStore} from '../bridge/blob-store.mjs';
import {crc32} from '../band/src/common/bytes.mjs';
import {sendOwnFile} from '../band/src/common/file-upload.mjs';
const target={threadId:'native_thread_a',cwd:'/project/a',threadTitle:'Synthetic test'};
const hash=b=>createHash('sha256').update(b).digest('hex');
function wav(){
  const b=Buffer.alloc(6444);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;
}
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'bc-native-integration-'));let transcriptions=0;
  const relay=new AstroRelay({handle:async()=>{throw new Error('No prompt may be sent in this test');}});
  relay.nativeOnly=true;relay.connected=true;relay.lastSeen=Date.now();
  relay.blobs=new BlobStore({root:join(root,'files')});await relay.blobs.init();
  relay.decodeNativeAudio=async()=>wav();
  const rec=new DirectRecording({stateFile:join(root,'state.json'),audioRoot:join(root,'audio'),
    command:data=>relay.nativeRecordingCommand(data),ready:async()=>{},validateTarget:async p=>({...p}),
    transcribe:async path=>{transcriptions++;return {text:'仅供测试的草稿',sha256:hash(await readFile(path))};}});
  relay.recording=rec;await rec.init();
  t.after(async()=>{rec.close();await rec.writes;await relay.blobs.close();await rm(root,{recursive:true,force:true});});
  const session=await rec.handle({method:'recording.arm',params:target});
  return {rec,relay,session,root,transcriptions:()=>transcriptions};
}
test('native completion, exact BLE receipt and WAV conversion produce one isolated draft',async t=>{
  const s=await setup(t),id=s.session.sessionId,name='bc-audio-'+id.replace(/-/g,'')+'.bcap';
  await assert.rejects(s.relay.handle({method:'native.audio.state',params:{sessionId:id,phase:'receiving',name:'other.bcap'}}),/differs/);
  await s.relay.handle({method:'native.audio.state',params:{sessionId:id,phase:'recording'}});
  await s.relay.handle({method:'native.audio.state',params:{sessionId:id,phase:'receiving',name}});
  const job=s.relay.fileUpload,command=s.relay.events.at(-1).data;
  assert.equal(command.purpose,'audio');assert.equal(command.sessionId,id);
  s.relay.events=[];await s.relay.handle({method:'native.audio.state',params:{sessionId:id,phase:'receiving',name}});
  assert.equal(s.relay.events[0].data.transferId,job.id,'reopening resumes the same transfer');
  const bytes=Uint8Array.from({length:2051},(_,i)=>i*13&255);
  const file={get(o){o.success({length:bytes.length});},readArrayBuffer(o){o.success({buffer:bytes.slice(o.position,o.position+o.length)});}};
  const ready=new Promise(resolve=>s.rec.on('state',state=>{if(state.phase==='ready')resolve();}));
  await sendOwnFile({file,command,rpc:(method,params)=>s.relay.handle({method,params})});await ready;
  assert.equal(s.transcriptions(),1);assert.equal(s.rec.state.target.threadId,target.threadId);
  assert.equal(s.rec.state.phase,'ready');assert.ok(s.rec.state.revision>s.session.revision);
  assert.deepEqual(s.rec.snapshot('other_thread'),{phase:'idle'});
  await s.relay.handle({method:'files.uploaded',params:{id:job.id,size:bytes.length,crc:crc32(bytes)}});
  assert.equal(s.transcriptions(),1);assert.deepEqual(await readFile(join(s.root,'audio',id+'.wav')),wav());
});
test('cancelling an in-flight native upload closes the blob and never starts transcription',async t=>{
  const s=await setup(t),id=s.session.sessionId,name='bc-audio-'+id.replace(/-/g,'')+'.bcap';
  await s.relay.handle({method:'native.audio.state',params:{sessionId:id,phase:'receiving',name}});
  const job=s.relay.fileUpload;
  await s.relay.handle({method:'blob.frame',params:{t:'open',id:job.id,name,size:2048,crc:0,chunkBytes:1024}});
  await s.rec.handle({method:'recording.cancel',params:{threadId:target.threadId,sessionId:id}});await s.relay.blobs.chain;
  assert.equal(job.phase,'error');assert.equal(s.relay.blobs.snapshot(job.id).state,'cancelled');
  assert.equal(s.rec.state.phase,'cancelled');assert.equal(s.transcriptions(),0);
  assert.equal(s.relay.events.some(e=>e.data?.bc_command==='fileUpload'),false);
  assert.deepEqual(await s.relay.handle({method:'native.audio.state',params:{sessionId:id,phase:'receiving',name}}),{accepted:false});
});
test('malformed PCM metadata is rejected without claiming a draft or consuming the session',async t=>{
  const s=await setup(t),id=s.session.sessionId;
  await s.rec.telemetry({sessionId:id,phase:'receiving'});
  for(const offset of [4,22,24,28,32,34,40]){
    const bad=wav();bad[offset]^=1;
    await assert.rejects(s.rec.ingest(id,bad),/格式/);assert.equal(s.rec.state.phase,'receiving');
  }
  assert.equal(s.transcriptions(),0);
});
async function pageFixture(){
  const source = await readWorkspaceScript('globalThis.page =');
  const sent=[];let timer=0;
  const context=vm.createContext({...pageConnectionDependencies,interconnect:{instance:()=>({send:({data})=>sent.push(data)})},setTimeout:()=>++timer,clearTimeout:()=>{}});
  vm.runInContext(source,context);const page=context.page;Object.assign(page,JSON.parse(JSON.stringify(page.private)));
  page.$nextTick=fn=>fn();page.$element=()=>null;page.onInit();return {page,sent};
}
test('a late arm response cannot roll recording back after a newer native state',async t=>{
  const {page,sent}=await pageFixture();t.after(()=>page.onDestroy());
  page.view='input';page.threadId=target.threadId;page.cwd=target.cwd;page.startRecording();const request=sent.at(-1);
  const sessionId='01234567-89ab-cdef-0123-456789abcdef';
  page.receive({bc_command:'recordingState',threadId:target.threadId,state:{sessionId,phase:'recording',revision:20}});
  page.receive({id:request.id,result:{sessionId,phase:'preparing',revision:19}});
  assert.equal(page.view,'recording');assert.equal(page.recordingPhase,'recording');
  page.applyRecordingState({sessionId:'older_session',phase:'error',revision:18});assert.equal(page.recordingSession,sessionId);
});
test('a cancel received after the UI completes still reaches the native microphone',async t=>{
  const {page}=await pageFixture();t.after(()=>page.onDestroy());const commands=[];
  page.nativeAudio={control:c=>commands.push(c),destroy:()=>{}};
  page.completedRecordingSession='completed_session';page.nativeAudioCommand({action:'cancel',sessionId:'completed_session'});
  assert.equal(commands.length,1);assert.equal(commands[0].action,'cancel');
  assert.ok(page.cancelledAudioSessions.includes('completed_session'));
});
import {pageConnectionDependencies} from './fixtures/legacy-connection.mjs';
test('returning to the terminal observes a background job without submitting it again',async t=>{
 const {page,sent}=await pageFixture();t.after(()=>page.onDestroy());const reads=[];let displayed;
 page.view='terminal';page.shellJob='existing-job';page.hidden=true;
 page.auxiliaryRpc=async(method,params)=>{reads.push({method,params});return {id:'existing-job',phase:'complete'};};
 page.updateShellState=state=>{displayed=state;};
 page.onShow();await Promise.resolve();await Promise.resolve();
 assert.equal(reads.length,1);assert.equal(reads[0].method,'device.shell.status');assert.equal(reads[0].params.id,'existing-job');
 assert.equal(displayed.phase,'complete');assert.equal(sent.some(x=>x.method==='device.shell.start'),false);
});
test('native file completion releases the capture lease while keeping transcription UI awake',async t=>{
 const {page}=await pageFixture();t.after(()=>page.onDestroy());const awake=[];
 page.keepRecordingAwake=value=>awake.push(value);page.recordingSession='capture-session';
 page.holdNativeCapture('capture-session');assert.equal(page.nativeCaptureSession,'capture-session');
 page.applyRecordingState({phase:'transcribing',sessionId:'capture-session'});
 assert.equal(page.nativeCaptureSession,'');assert.equal(awake.at(-1),true);
 page.view='draft';page.applyRecordingState({phase:'ready',sessionId:'capture-session'});assert.equal(awake.at(-1),false);
});
test('cancel while microphone authorization is in flight prevents a later start and releases capture wake',async t=>{
  const {page}=await pageFixture();t.after(()=>page.onDestroy());const controls=[];let grant;
  const authorized=new Promise(resolve=>{grant=resolve;});
  page.auxiliaryRpc=async method=>method==='native.audio.authorize'?authorized:{accepted:true};
  page.nativeAudio={control:c=>controls.push(c),destroy(){}};
  const sessionId='01234567-89ab-cdef-0123-456789abcdef';
  page.nativeAudioCommand({action:'start',sessionId});
  page.nativeAudioCommand({action:'cancel',sessionId});
  grant({allowed:true,leaseMs:5000});await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(controls.map(c=>c.action),['cancel']);assert.equal(page.nativeCaptureSession,'');
});
