// Standard face installation over the owned phone's independent SPP client.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DirectBand} from '../bridge/bluetooth/direct-band.mjs';
import {installResource,watchfaceListResponse,watchfaceSelectedResponse,cancelMassTransfer} from '../bridge/bluetooth/install-resource.mjs';
import {wear,pbBytes} from '../bridge/bluetooth/protobuf.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
let file,reportPath,discardPartial,resumePartial,select=false,transport='spp';
for(let i=0;i<args.length;i++) {
  if(args[i]==='--face')file=resolve(args[++i]);
  else if(args[i]==='--report')reportPath=resolve(args[++i]);
  else if(args[i]==='--select')select=true;
  else if(args[i]==='--transport')transport=args[++i];
  else if(args[i]==='--discard-partial')discardPartial=args[++i];
  else if(args[i]==='--resume-partial')resumePartial=args[++i];
  else throw new Error('Expected --face FILE, optional --select and --report NEW_FILE');
}
if(!file)throw new Error('Expected a watchface file');
if(reportPath){try{await access(reportPath);throw new Error('Report already exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
const data=await readFile(file);
if(data.length<304||data.length>16*1024*1024||data.subarray(0,4).toString('hex')!=='5aa53412')throw new Error('Expected a supported .face container');
const faceId=data.subarray(40,49).toString('ascii');if(!/^\d{9}$/.test(faceId))throw new Error('Invalid face ID in container');
const id=randomUUID(),journalPath=join(root,'.local/resource-installs',id+'.json');
await mkdir(join(root,'.local/resource-installs'),{recursive:true,mode:0o700});
const journal={id,kind:'watchface',watchfaceId:faceId,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),
  transport:transport==='ble'?'independent phone Shell BLE GATT':'independent phone Shell SPP',phase:'opening',submitted:false,startedAt:Date.now(),rebootRequested:false};
if(discardPartial) {
  if(!/^[0-9a-f-]{36}$/.test(discardPartial))throw new Error('Expected a saved interrupted install UUID');
  const previous=JSON.parse(await readFile(join(root,'.local/resource-installs',discardPartial+'.json')));
  if(previous.phase!=='unknown'||previous.kind!=='watchface'||previous.watchfaceId!==faceId||previous.sha256!==journal.sha256||previous.bytes!==data.length||previous.deviceResult)
    throw new Error('Partial cleanup requires the same file and an interrupted, unconfirmed watchface install');
  journal.discardPartialFor=discardPartial;
}
let resumeBytes=0;
if(resumePartial) {
  if(discardPartial||!/^[0-9a-f-]{36}$/.test(resumePartial))throw new Error('Expected one saved interrupted install UUID');
  const previous=JSON.parse(await readFile(join(root,'.local/resource-installs',resumePartial+'.json')));
  const digest=createHash('md5').update(data).digest('hex');
  if(previous.phase!=='unknown'||previous.kind!=='watchface'||previous.watchfaceId!==faceId||previous.sha256!==journal.sha256||previous.bytes!==data.length||previous.deviceResult||previous.transferState?.dataId!==digest)
    throw new Error('Resume requires the same file and an observed matching partial transfer');
  const amount=previous.transferState.reportedLength;
  if(typeof amount!=='string'||!/^\d{1,8}$/.test(amount))throw new Error('Missing observed byte offset');
  resumeBytes=Number(amount);
  if(resumeBytes<=0||resumeBytes>=data.length)throw new Error('Partial file offset must be inside the same file');
  journal.resumePartialFor=resumePartial;journal.resumeBytes=resumeBytes;
}
await writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
const save=()=>writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{mode:0o600});
const band=new DirectBand(root,{transport});
console.log(JSON.stringify({event:'watchface-install-created',id,watchfaceId:faceId,bytes:data.length}));
try {
  await band.open();
  const list=()=>band.requestL2(band.auth.encode(wear(4,0)),watchfaceListResponse);
  const before=await list();journal.beforeFaces=before;
  if(before.some(face=>face.id===faceId))throw new Error('Face ID already installed; inspect before overwriting');
  if(discardPartial) {
    journal.phase='cancelling-own-partial';await save();
    await band.sendPb(cancelMassTransfer(data,16));
    journal.partialCancelAcknowledged=true;await save();await delay(700);
  }
  journal.phase='submitting';journal.submitted=true;await save();
  let last=-1;
  journal.deviceResult=await installResource(band,{kind:'watchface',id:faceId,version:65536,data,resumeBytes,
    stage:async stage=>{journal.stage={...stage,at:Date.now()};await save();},
    progress:async progress=>{
      journal.phase='transferring';journal.progress=progress;await save();
      const percent=Math.floor(progress.sentSlices/progress.totalSlices*10)*10;
      if(percent!==last){console.log(JSON.stringify({event:'watchface-progress',id,percent}));last=percent;}
    }});
  let after=await list();
  if(!after.some(face=>face.id===faceId))throw new Error('Install result succeeded but face list is missing the ID');
  if(before.some(face=>!after.some(other=>other.id===face.id)))throw new Error('Another watchface disappeared');
  journal.installedListVerified=true;
  if(select) {
    await band.requestL2(band.auth.encode(wear(4,1,6,pbBytes(2,Buffer.from(faceId)))),watchfaceSelectedResponse);
    after=await list();if(!after.some(face=>face.id===faceId&&face.current))throw new Error('Selected face list does not match');
    journal.actualSelectedIdVerified=true;
  }
  journal.afterFaces=after;journal.phase='complete';journal.physicalDisplayConfirmed=false;
} catch(error) {
  journal.phase=journal.submitted?'unknown':'not-submitted';journal.error=error.message;process.exitCode=1;
  if(error.transferState)journal.transferState=error.transferState;
} finally {
  journal.socketClosed=await band.close();journal.finishedAt=Date.now();await save();
}
if(reportPath)await writeFile(reportPath,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(journal));
