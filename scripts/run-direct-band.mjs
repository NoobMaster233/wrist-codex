// Direct phone transport for the paired RPK and existing local relay.
// The supervisor owns service lifecycle; diagnostics retain a fixed lifetime.
import {readFile,writeFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DirectBand} from '../bridge/bluetooth/direct-band.mjs';
import {PrivateBand} from '../bridge/bluetooth/private-band.mjs';
import {CursorStore} from '../bridge/bluetooth/cursor-store.mjs';
import {FileCommandStore} from '../bridge/bluetooth/file-command-store.mjs';
import {createNativeManagement} from '../bridge/bluetooth/native-management.mjs';
import {launchApp,connectedStatus,phoneMessage,phoneFrames,readAppPacket} from '../bridge/bluetooth/app-protocol.mjs';
import {watchfaceListResponse,watchfaceSelectedResponse} from '../bridge/bluetooth/install-resource.mjs';
import {wear,pbBytes} from '../bridge/bluetooth/protobuf.mjs';

const args=process.argv.slice(2);let duration=40,reportPath,transport='spp',service=false,privateMode=false;
for(let i=0;i<args.length;i++) {
  if(args[i]==='--duration')duration=Number(args[++i]);
  else if(args[i]==='--report')reportPath=resolve(args[++i]);
  else if(args[i]==='--transport')transport=args[++i];
  else if(args[i]==='--service')service=true;
  else if(args[i]==='--private')privateMode=true;
  else throw new Error('Unsupported direct driver argument');
}
if(!Number.isInteger(duration)||duration<15||duration>240)throw new Error('Diagnostic duration must be 15–240 seconds');
if(reportPath){try{await access(reportPath);throw new Error('Report already exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
const root=fileURLToPath(new URL('../',import.meta.url));
const token=(await readFile(join(root,'.local/astro-plugin-token'),'utf8')).trim();
const http=async(path,body)=>{
  const response=await fetch('http://127.0.0.1:32179'+path,{method:body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  if(!response.ok){const error=new Error('Local relay HTTP '+response.status);error.status=response.status;throw error;}return response.json();
};
const initial=await http('/status');if(initial.busy&&!service)throw new Error('Preserve active relay task before transport handover');
if(privateMode&&transport!=='spp')throw new Error('Private service uses SPP');
const band=privateMode?new PrivateBand(root,{service}):new DirectBand(root,{transport,service});
const cursorStore=service?new CursorStore(join(root,'.local/direct-band-cursor.json')):null;
const saved=await cursorStore?.load();
const fileCommands=service?new FileCommandStore(join(root,'.local/direct-file-commands.json')):null;
await fileCommands?.load();
let app,failure,nativeManagement,cursor=saved?.cursor||0,epoch=saved?.epoch||'',incoming=Promise.resolve(),outgoing=Promise.resolve(),appVisible=false;
let requestedStop=false,activeWatchId='',appSeenAt=0,nativeRpcSequence=0;
process.once('SIGTERM',()=>{requestedStop=true;});process.once('SIGINT',()=>{requestedStop=true;});
const report={transport:privateMode?'owned dedicated SPP':transport==='ble'?'owned phone Shell BLE GATT':'owned phone Shell SPP',astroBoxRequiredDuringTest:false,authenticated:false,
  serviceMode:service,appLinked:false,rpcMethods:{},diagnostics:[],eventsForwarded:0,promptSendCount:0,statusRequests:0};
const idleWait=new AbortController();let authenticatedAt,disconnectedAt;
const failed=e=>{if(!failure){failure=e;disconnectedAt=Date.now();idleWait.abort();}};band.on('failure',failed);
const wakeApp=async()=>{
  if(!privateMode){await band.sendPb(launchApp(app));await delay(900);return;}
  // The native visibility bit can outlive a destroyed/paused JS page. Only
  // a recent App receipt establishes liveness for a remote operation.
  if(appVisible&&Date.now()-appSeenAt<5000)return;
  if(appVisible&&band.appVisible){
    // An idle visible page may have no RPC traffic for many seconds. Probe
    // its safe lifecycle command before launching an already foreground App,
    // which need not emit a fresh onShow/ready event.
    const live=band.wait('message',value=>typeof value?.method==='string',4000);live.catch(()=>{});
    await band.sendJSON({bc_command:'connectionReady'});await live;
    appSeenAt=Date.now();report.activePageProbes=(report.activePageProbes||0)+1;return;
  }
  let last;
  // App launch is idempotent. Only this short UI operation uses the factory
  // channel; its failure never resends a business command or a prompt.
  for(let attempt=0;attempt<2;attempt++){
    const factory=new DirectBand(root);
    const ready=band.wait('message',message=>message.method==='diagnostics.report'||
      message.method==='app.lifecycle'&&['show','ready'].includes(message.params?.phase),15000);ready.catch(()=>{});
    try{
      const apps=await factory.open(),target=apps.find(item=>item.packageName==='dev.bandcodex.remote');
      if(!target)throw new Error('Owned App not installed');
      // Some .043 launches close the factory socket before its ACK. A fresh
      // App lifecycle/diagnostic is the acknowledgement that matters here.
      try{await factory.sendPb(launchApp(target));}catch(error){last=error;}
      await factory.close();await ready;appVisible=true;appSeenAt=Date.now();
      report.factoryWakeCount=(report.factoryWakeCount||0)+1;return;
    }catch(error){last=error;}
    finally{await factory.close();}
  }
  throw last||new Error('请打开手环上的腕上 Codex');
};
const pageCommands=new Set(['fileReceive','fileUpload','nativeShellControl','nativeAudioControl','probeProjects','probeConversation','recordingManager',
  'capabilityProbe','nativeEventProbe','nativeLoaderReport']);
const nativeCommands=new Set(['fileReceive','fileUpload','nativeShellControl']);
const send=async message=>{
  const nativeOnly=nativeManagement&&nativeCommands.has(message.bc_command);
  const needsPage=!nativeOnly&&(pageCommands.has(message.bc_command)||privateMode&&message.event==='messages.updated');
  if(needsPage&&(!appVisible||privateMode&&Date.now()-appSeenAt>=5000)){
    // A resumed page can immediately request its old conversation. Complete
    // that read/reply before submitting a new navigation command. Waiting
    // inside the delivery queue would block the very reply it needs.
    const waking=outgoing.then(wakeApp);outgoing=waking.catch(failed);
    await waking;
    await incoming;
    await outgoing;
  }
  const task=outgoing.then(async()=>{
    if(nativeManagement){
      if(await nativeManagement.handle(message))return;
      if(message.bc_command==='nativeShellRelease'&&(!appVisible||Date.now()-appSeenAt>=5000))return;
      if(message.event==='messages.connection'&&!appVisible)return;
    }
    if(privateMode){await band.sendJSON(message);appSeenAt=Date.now();return;}
    const frames=phoneFrames(message).map(text=>phoneMessage(app,text));
    for(let i=0;i<frames.length;i+=band.maxFlight)await band.sendPbBatch(frames.slice(i,i+band.maxFlight));
  });
  outgoing=task.catch(failed);return task;
};
const diagnostic=text=>{
  const version=/^快应用通信已建立 · (0\.\d{1,2}\.\d{1,4})$/.exec(text);
  if(version)return {kind:'rpk-'+version[1],count:0};
  for(const [prefix,kind] of [['项目列表已显示：','projects'],['自动推送已接通：','messages'],['录音与草稿已显示：','recording-manager']])
    if(text.startsWith(prefix))return {kind,count:Number(/\d+/.exec(text.slice(prefix.length))?.[0]||0)};
  if(text.startsWith('新回复已自动显示：'))return {kind:'messages',count:Number(/\d+/.exec(text.slice('新回复已自动显示：'.length))?.[0]||0),delivery:'push'};
  if(text.startsWith('文字草稿已显示'))return {kind:'draft-shown',count:0};return null;
};
const handle=async request=>{
  if(!request||typeof request!=='object'||typeof request.method!=='string'||typeof request.id!=='string')return;
  appSeenAt=Date.now();if(privateMode&&band.appVisible)appVisible=true;
  report.appLinked=true;report.rpcMethods[request.method]=(report.rpcMethods[request.method]||0)+1;
  if(request.method==='diagnostics.report') {
    const value=diagnostic(String(request.params?.text||''));
    if(value){await http('/diagnostic',value);report.diagnostics.push(value);}return;
  }
  if(request.method==='app.lifecycle'){
    appVisible=['show','ready'].includes(request.params?.phase);
    await http('/lifecycle',request.params||{});return;
  }
  if(request.method==='prompt.send')report.promptSendCount++;
  const response=await http('/rpc',request);
  // The band's shared event topic must deliver the native TX receipt before
  // a new RX notice. Keep that receipt and the reply in separate turns.
  if(privateMode)await delay(80);
  if(privateMode&&request.method==='messages.watch'&&!response.error)activeWatchId=request.params.watchId;
  if(privateMode&&request.method==='messages.unwatch'&&request.params.watchId===activeWatchId)activeWatchId='';
  await send(response);
};
if(privateMode){
  band.on('message',message=>{incoming=incoming.then(()=>handle(message)).catch(failed);});
  band.on('visibility',up=>{
    appVisible=up&&Date.now()-appSeenAt<5000;
    if(!up&&activeWatchId){
      const watchId=activeWatchId;activeWatchId='';
      http('/rpc',{v:1,id:'native-hide-'+Date.now(),method:'messages.unwatch',params:{watchId}}).catch(failed);
    }
  });
}
band.on('packet',packet=>{
  const value=readAppPacket(packet,app);if(!value)return;
  if(value.kind==='status'){report.statusRequests++;band.sendPb(connectedStatus(app)).catch(failed);return;}
  incoming=incoming.then(()=>handle(value.data)).catch(failed);
});
const startedAt=Date.now();
const maintenance=async command=>{
  if(command.action!=='native-audio-recover'||!/^[-a-f0-9]{36}$/.test(command.id||'')||command.expiresAt<Date.now())
    throw new Error('Unsupported or expired maintenance command');
  let previous,maintenanceApp=app;
  const control=privateMode?new DirectBand(root):band;
  const select=id=>control.requestL2(control.auth.encode(wear(4,1,6,pbBytes(2,Buffer.from(id)))),watchfaceSelectedResponse);
  try {
    if(privateMode){const apps=await control.open();maintenanceApp=apps.find(item=>item.packageName==='dev.bandcodex.remote');if(!maintenanceApp)throw new Error('Owned App not installed');}
    const faces=await control.requestL2(control.auth.encode(wear(4,0)),watchfaceListResponse);
    previous=faces.find(face=>face.current)?.id;
    const helper=faces.some(face=>face.id==='219667880')?'219667880':faces.some(face=>face.id==='219667875')?'219667875':'219667860';
    if(!previous||!faces.some(face=>face.id===helper))throw new Error('Verified recovery face is missing');
    await select(helper);await delay(['219667875','219667880'].includes(helper)?5000:3000);
    if(previous!==helper)await select(previous);
    await control.sendPb(launchApp(maintenanceApp));await delay(900);
    await http('/native/service/report',{id:command.id,phase:'complete',message:'恢复表盘已执行，录音状态以手环回执为准'});
  } catch(error) {
    if(previous&&!control.failure)await select(previous).catch(()=>{});
    await http('/native/service/report',{id:command.id,phase:'error',message:'恢复回执未确认，请查看手环服务状态'}).catch(()=>{});
    throw error;
  }finally{if(privateMode)await control.close();}
};
try {
  const opened=await band.open();authenticatedAt=Date.now();report.authenticated=true;report.connection=band.connectionInfo;
  if(privateMode&&band.connectionInfo.nativeManagement){
    report.nativeManagementOps={};report.nativeManagementRpcMethods={};
    nativeManagement=createNativeManagement({transport:band,onOperation:op=>{
      report.nativeManagementOps[op]=(report.nativeManagementOps[op]||0)+1;
    },rpc:async(method,params)=>{
      report.nativeManagementRpcMethods[method]=(report.nativeManagementRpcMethods[method]||0)+1;
      const response=await http('/rpc',{v:1,id:'native-management-'+Date.now()+'-'+(++nativeRpcSequence),method,params});
      if(response.error)throw new Error(response.error.message||response.error);
      return response.result;
    }});
  }
  if(privateMode){report.privateMessageWindow=1;appVisible=band.appVisible&&Date.now()-appSeenAt<5000;}
  else{report.negotiatedTransmitBatch=band.maxFlight;app=opened.find(item=>item.packageName==='dev.bandcodex.remote');if(!app)throw new Error('Owned App not installed');}
  // Firmware can hide the RPK on a lost connection, pausing its RPC retry
  // timers. Resume that page when work is pending; do not replay its command
  // or replace its view with a new project list.
  if(!service||initial.busy&&!nativeManagement){
    if(privateMode&&initial.busy)await delay(500);
    await wakeApp();await send({bc_command:'connectionReady'});
    if(!service){await send({bc_command:'ping'});await send({bc_command:'probeProjects'});}
    else report.pendingWorkAppResumed=true;
  }
  await http('/ready',{connected:true,nativeManagement:!!nativeManagement});
  console.log(JSON.stringify({event:'direct-bridge-ready',authenticated:true,serviceMode:service,...(!service?{durationSeconds:duration}:{})}));
  const until=service?Infinity:Date.now()+duration*1000;
  let draining=false,stopDeadline=Infinity,restoreFiles=true,nextFileRecovery=0;
  const hardStop=service?Infinity:startedAt+280000;
  while(Date.now()<hardStop&&!failure) {
    if(requestedStop||Date.now()>=until) {
      draining=true;
      if(stopDeadline===Infinity)stopDeadline=Date.now()+120000;
      const status=await http('/status');
      if(!status.busy&&status.queuedEvents===0)break;
      if(Date.now()>=stopDeadline)throw new Error('Stop deadline reached; inspect saved task IDs before retrying');
    }
    const result=await http('/events?'+new URLSearchParams({cursor:String(cursor),epoch}));
    epoch=result.epoch;if(result.reset)cursor=0;
    if(fileCommands&&Date.now()>=nextFileRecovery) {
      report.fileTransfersResumed=(report.fileTransfersResumed||0)+await fileCommands.recover(epoch,{query:http,send,force:restoreFiles});
      restoreFiles=false;nextFileRecovery=Date.now()+10000;
    }
    if(result.event) {
      if(!['band','maintenance'].includes(result.event.kind))throw new Error('Unsupported relay event');
      const message=fileCommands&&result.event.kind==='band'?await fileCommands.remember(epoch,result.event.data):result.event.data;
      if(cursorStore){await cursorStore.claim(epoch,result.event.id,result.event.kind);cursor=result.event.id;}
      if(result.event.kind==='band')await send(message);
      else await maintenance(result.event.data);
      cursor=result.event.id;report.eventsForwarded++;
    }
    try{await delay(result.event?20:Math.min(result.pollAfterMs||750,service?4000:750),undefined,{signal:idleWait.signal});}
    catch(error){if(failure)throw failure;throw error;}
  }
  report.drainedTasksBeforeClose=draining;
  if(Date.now()>=hardStop&&(await http('/status')).busy)throw new Error('Diagnostic lifetime ended with pending work; inspect saved job IDs, do not resend');
  if(failure)throw failure;
  await incoming;await outgoing;
  // Service mode reserves before transmission, so uncertain delivery is never
  // replayed. Diagnostics acknowledge sent events. Later events stay queued.
  await http('/events?'+new URLSearchParams({cursor:String(cursor),epoch}));
} catch(e) {report.error=e.message;}
finally {
  report.authenticatedDurationMs=authenticatedAt?Math.max(0,(disconnectedAt||Date.now())-authenticatedAt):0;
  report.socketClosed=await band.close();report.elapsedMs=Date.now()-startedAt;
  await http('/ready',{connected:false}).catch(()=>{});
}
if(reportPath)await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
if(report.error||(!service&&!report.appLinked)||!report.socketClosed)process.exitCode=1;
