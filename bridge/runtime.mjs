import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { CodexClient } from './codex-client.mjs';
import { BandService } from './service.mjs';
import { SendJournal } from './send-journal.mjs';
import { AstroRelay } from './relay.mjs';
import { createAstroServer } from './http-server.mjs';
import { DirectRecording } from './direct-recording.mjs';
import { BlobStore } from './blob-store.mjs';
import { NativeShell } from './native-shell.mjs';
import { transcribeChatGPTFile, TranscriptionError } from './chatgpt-transcription.mjs';

export async function startRuntime({allowSend=false}={}) {
  const local = fileURLToPath(new URL('../.local/', import.meta.url));
  await mkdir(local, { recursive: true, mode: 0o700 });
  let token;
  try { token = (await readFile(join(local, 'astro-plugin-token'), 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(join(local, 'astro-plugin-token'), token, { mode: 0o600, flag: 'wx' });
  }
  const client = new CodexClient(), service = new BandService(client, {
    allowSend,sendJournal:new SendJournal({root:join(local,'send-journal')})
  });
  const relay = new AstroRelay(service), exec = promisify(execFile);
  relay.nativeOnly = true;
  relay.blobs = new BlobStore({ root: join(local, 'native-files') }); await relay.blobs.init();
  relay.shell=new NativeShell({root:join(local,'shell-jobs'),
    sendFile:(bytes,name)=>relay.startFileDelivery(bytes,name,1024),
    receiveFile:(name,id)=>relay.startFileUpload(name,1024,undefined,id),
    dispatch:command=>relay.enqueue('band',command),
    readBlob:id=>readFile(join(local,'native-files',id+'.bin'))});
  await relay.shell.init();
  relay.decodeNativeAudio=async job=>{
    const folder=await mkdtemp(join(local,'native-decoded-'));
    try{
      const input=join(local,'native-files',job.id+'.bin'),output=join(folder,'capture.wav');
      const bytes=await readFile(input);
      if(bytes.length!==job.size||createHash('sha256').update(bytes).digest('hex')!==job.sha256)throw new Error('Native file digest differs');
      const {stdout}=await exec('python',[fileURLToPath(new URL('../scripts/read-native-capture.py',import.meta.url)),input,'--wav',output],
        {timeout:15000,maxBuffer:65536});
      const decoded=JSON.parse(stdout),audio=await readFile(output);
      if(createHash('sha256').update(audio).digest('hex')!==decoded.wavSha256)throw new Error('Decoded file digest differs');
      return audio;
    }finally{await rm(folder,{recursive:true,force:true});}
  };
  relay.recording = new DirectRecording({ stateFile: join(local, 'astro-recording.json'), audioRoot: join(local, 'astro-audio'),
    timeoutMs:240000,
    command: data => relay.nativeRecordingCommand(data),
    ready: async () => {
      relay.shell.requireIdle();
      if (!relay.connected || Date.now() - relay.lastSeen > 15000) throw new Error('手环尚未连接，请启动手机连接服务');
      if(relay.fileDeliveries.active()||relay.fileUpload?.phase==='pending'||relay.nativeProbe?.phase==='pending')throw new Error('请先完成当前文件或检测任务');
      let auth;
      try{auth=JSON.parse(await readFile(join(process.env.CODEX_HOME?.trim()||join(homedir(),'.codex'),'auth.json'),'utf8'));}catch{}
      if(typeof auth?.tokens?.access_token!=='string'||!auth.tokens.access_token)throw new Error('手机 Codex 登录不可用，请先登录');
    },
    validateTarget: async params => {
      await client.connect();
      const { thread } = await client.request('thread/read', { threadId: params.threadId });
      if (thread.cwd !== params.cwd) throw new Error('项目和对话不匹配');
      return { threadId: thread.id, cwd: thread.cwd, projectName: basename(thread.cwd), threadTitle: (thread.name || params.threadTitle || '未命名对话').slice(0,160) };
    },
    transcribe: async (path, { signal }) => {
      let result;
      try{result=await transcribeChatGPTFile(path,{signal,language:'zh'});}
      catch(error){if(error instanceof TranscriptionError)error.publicMessage=error.message;throw error;}
      const bytes=await readFile(path);
      return {...result,durationMs:Math.round((bytes.length-44)/32)};
    }
  });
  relay.recording.on('state', state => {
    if (state.target) relay.enqueue('band', { bc_command: 'recordingState', threadId: state.target.threadId, state });
  });
  await relay.recording.init();
  client.on('serverRequest', message => client.socket.send(JSON.stringify({ id: message.id,
    error: { code: -32601, message: 'Review this approval in the main Codex client.' } })));
  const server = createAstroServer(relay, token);
  server.requestTimeout = 15000;
  server.listen(32179, '127.0.0.1', () => console.log('Astro relay ready on loopback 32179; native audio:',relay.nativeOnly));
  const stop = () => { relay.close(); server.close(); client.close(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return {relay,client,server,stop};
}
