// Restore exact previously healthy services through the standard face selector.
// This never installs, unpairs, changes the official service or repeats a job.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DirectBand} from '../bridge/bluetooth/direct-band.mjs';
import {PrivateBand} from '../bridge/bluetooth/private-band.mjs';
import {launchApp} from '../bridge/bluetooth/app-protocol.mjs';
import {watchfaceListResponse,watchfaceSelectedResponse} from '../bridge/bluetooth/install-resource.mjs';
import {wear,pbBytes} from '../bridge/bluetooth/protobuf.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
let restoreOverride,launchRequested=false;
for(let i=0;i<args.length;i++){
 if(args[i]==='--restore-face'&&/^\d{9,12}$/.test(args[i+1]||''))restoreOverride=args[++i];
 else if(args[i]==='--launch-app')launchRequested=true;
 else throw new Error('Expected optional --restore-face INSTALLED_ID and --launch-app');
}
const manifest=JSON.parse(await readFile(join(root,'artifacts/research/private-service-recovery-043-v2-compact/manifest.json')));
if(manifest.firmware!=='3.101.043'||manifest.watchfaceId!=='219667880'||manifest.linkStatusVersion!==2)throw new Error('Recovery target differs');
const privateLink=new PrivateBand(root);
privateLink.on('failure',()=>{});
let previous,selected=false,restored=false;
const report={event:'private-link-bootstrap',startedAt:Date.now(),passed:false,loadsRetried:false,reboot:false};
async function factory(operation){
  const band=new DirectBand(root);
  try{return await operation(band,await band.open());}finally{await band.close();}
}
const list=band=>band.requestL2(band.auth.encode(wear(4,0)),watchfaceListResponse);
const select=(band,id)=>band.requestL2(band.auth.encode(wear(4,1,6,pbBytes(2,Buffer.from(id)))),watchfaceSelectedResponse);
async function restore(){
  let last;
  for(let attempt=0;attempt<2;attempt++){
    try{
      await factory(async(band,apps)=>{
        const faces=await list(band),current=faces.find(face=>face.current)?.id;
        if(current!==manifest.watchfaceId&&current!==previous)throw new Error('Face changed while restoring; preserve current choice');
        if(current!==previous)await select(band,previous);
        const after=await list(band);
        if(!after.some(face=>face.id===previous&&face.current))throw new Error('Selected face readback differs');
        restored=true;report.previousWatchfaceRestored=true;
        report.launchRequested=launchRequested;
        if(launchRequested){
          const app=apps.find(item=>item.packageName==='dev.bandcodex.remote');
          if(!app)throw new Error('Owned App is not installed');
          try{await band.sendPb(launchApp(app));report.appLaunchAcknowledged=true;}
          catch{report.appLaunchAcknowledged=false;}
        }
      });return;
    }catch(error){last=error;if(restored)throw error;await delay(300);}
  }
  throw last;
}
try{
  await factory(async(band,apps)=>{
    if(!apps.some(app=>app.packageName==='dev.bandcodex.remote'))throw new Error('Owned App is not installed');
    const faces=await list(band);
    previous=restoreOverride||faces.find(face=>face.current)?.id;
    if(!restoreOverride&&['219667875','219667876','219667878','219667879','219667880','219667886'].includes(previous)){
      try{const saved=JSON.parse(await readFile(join(root,'.local/band-preferred-face.json')));
        if(saved.version===1&&faces.some(face=>face.id===saved.watchfaceId))previous=saved.watchfaceId;
      }catch{}
    }
    if(!previous||!faces.some(face=>face.id===previous)||!faces.some(face=>face.id===manifest.watchfaceId))throw new Error('Recovery or previous face is not installed');
    report.previousWatchfaceId=previous;
    // Record intent before submission: the firmware can apply this change
    // and close SCN5 before its ACK. The finally block must still restore it.
    selected=true;report.helperSelectionRequested=true;
    await select(band,manifest.watchfaceId);
  });
  // Release the factory channel while the timer loads the services. The
  // official connection can use it during this wait.
  await delay(1500);
  await privateLink.open();await privateLink.ping(Buffer.from('recovery-043'));report.nativeAuthenticated=true;
  await privateLink.close();await restore();report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
  if(selected&&!restored&&previous&&previous!==manifest.watchfaceId){
    try{await restore();}catch{report.previousWatchfaceRestored=false;}
  }
  report.privateSocketClosed=await privateLink.close();report.finishedAt=Date.now();
}
console.log(JSON.stringify(report));
