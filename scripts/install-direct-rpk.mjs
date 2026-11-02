// Install one signed RPK through the owned phone's authenticated SPP session.
// Single submission; an unknown result is recorded and is never auto-retried.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {DirectBand} from '../bridge/bluetooth/direct-band.mjs';
import {installResource} from '../bridge/bluetooth/install-resource.mjs';
import {wear,appListResponse,pbBytes} from '../bridge/bluetooth/protobuf.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);let file,reportPath,resumePartial,launch=false,transport='spp';
for(let i=0;i<args.length;i++) {
  if(args[i]==='--rpk')file=resolve(args[++i]);
  else if(args[i]==='--report')reportPath=resolve(args[++i]);
  else if(args[i]==='--launch')launch=true;
  else if(args[i]==='--resume-partial')resumePartial=args[++i];
  else if(args[i]==='--transport')transport=args[++i];
  else throw new Error('Expected --rpk FILE, optional --report NEW_FILE and --launch');
}
if(!file||!file.toLowerCase().endsWith('.rpk'))throw new Error('Expected an RPK file');
if(reportPath){try{await access(reportPath);throw new Error('Report already exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
const data=await readFile(file);if(data.length<1||data.length>16*1024*1024)throw new Error('RPK size outside supported bound');
const inspect=`import sys,json,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 i=z.getinfo('manifest.json')
 assert i.file_size<=65536
 m=json.loads(z.read(i))
 print(json.dumps({'package':m['package'],'versionCode':m['versionCode'],'versionName':m['versionName'],'entry':m.get('router',{}).get('entry','pages/index')}))
`;
const meta=JSON.parse(execFileSync('python',['-c',inspect,file],{encoding:'utf8',maxBuffer:131072}));
if(!/^[A-Za-z][A-Za-z0-9_.-]{1,199}$/.test(meta.package)||!Number.isInteger(meta.versionCode)||meta.versionCode<1)
  throw new Error('Invalid RPK manifest identity');
if(!/^[A-Za-z0-9_/-]{1,100}$/.test(meta.entry)||meta.entry.includes('..'))throw new Error('Invalid RPK entry path');
const id=randomUUID(),journalPath=join(root,'.local/resource-installs',id+'.json');
await mkdir(join(root,'.local/resource-installs'),{recursive:true,mode:0o700});
const journal={id,kind:'rpk',package:meta.package,versionCode:meta.versionCode,versionName:meta.versionName,
  bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),transport:transport==='ble'?'independent phone Shell BLE GATT':'independent phone Shell SPP',
  phase:'opening',submitted:false,startedAt:Date.now(),rebootRequested:false,commandReexecuted:false};
let resumeBytes=0;
if(resumePartial){
  if(!/^[0-9a-f-]{36}$/.test(resumePartial))throw new Error('Expected a saved interrupted install UUID');
  const previous=JSON.parse(await readFile(join(root,'.local/resource-installs',resumePartial+'.json')));
  if(previous.phase!=='unknown'||previous.kind!=='rpk'||previous.package!==meta.package||previous.versionCode!==meta.versionCode||
     previous.sha256!==journal.sha256||previous.bytes!==data.length||previous.deviceResult||
     previous.transferState?.dataId!==createHash('md5').update(data).digest('hex'))
    throw new Error('Resume requires the same RPK and an observed matching partial transfer');
  const amount=previous.transferState.reportedLength;
  if(typeof amount!=='string'||!/^\d{1,8}$/.test(amount))throw new Error('Missing observed byte offset');
  resumeBytes=Number(amount);
  if(resumeBytes<=0||resumeBytes>=data.length)throw new Error('Observed partial offset must be inside the same RPK');
  journal.resumePartialFor=resumePartial;journal.resumeBytes=resumeBytes;
}
await writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
const save=()=>writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{mode:0o600});
const band=new DirectBand(root,{transport});console.log(JSON.stringify({event:'install-created',id,package:meta.package,versionCode:meta.versionCode}));
try {
  const before=await band.open();
  const existing=before.find(app=>app.packageName===meta.package);
  if(existing&&existing.versionCode>=meta.versionCode)throw new Error('Installed version is already equal or newer; inspect it before another install');
  journal.beforeApps=before.map(({packageName,versionCode})=>({packageName,versionCode}));
  // Persist intent before publishing any mutating prepare request.
  journal.submitted=true;journal.phase='submitting';await save();
  let lastProgress=-1;
  journal.deviceResult=await installResource(band,{kind:'rpk',id:meta.package,version:meta.versionCode,data,resumeBytes,
    progress:async progress=>{
      journal.phase='transferring';journal.progress=progress;await save();
      const percent=Math.floor(progress.sentSlices/progress.totalSlices*10)*10;
      if(percent!==lastProgress){console.log(JSON.stringify({event:'install-progress',id,percent}));lastProgress=percent;}
    }});
  journal.phase='verifying';await save();
  const apps=await band.requestL2(band.auth.encode(wear(20,0)),packet=>appListResponse(packet,{includeFingerprint:true}));
  journal.afterApps=apps.map(({packageName,versionCode})=>({packageName,versionCode}));
  const installed=apps.find(app=>app.packageName===meta.package);
  if(installed?.versionCode!==meta.versionCode)throw new Error('Device install result succeeded but fresh App list version differs');
  for(const app of before.filter(app=>app.packageName!==meta.package))
    if(!apps.some(item=>item.packageName===app.packageName&&item.versionCode===app.versionCode))throw new Error('Another installed App disappeared or changed');
  journal.installedVersionVerified=true;journal.otherAppsPreserved=true;journal.ordinaryRebootRequired=false;
  if(launch) {
    const basic=Buffer.concat([pbBytes(1,Buffer.from(meta.package)),pbBytes(2,installed.fingerprint)]);
    const launchInfo=Buffer.concat([pbBytes(1,basic),pbBytes(2,Buffer.from('hap://app/'+meta.package+'/'+meta.entry))]);
    await band.sendPb(wear(20,4,22,pbBytes(6,launchInfo)));journal.launchRequested=true;
    journal.actualLaunchMarkerVerified=false;
  }
  journal.phase='complete';
} catch(error) {
  journal.phase=journal.submitted?'unknown':'not-submitted';journal.error=error.message;
  if(error.transferState)journal.transferState=error.transferState;
  process.exitCode=1;
} finally {
  journal.socketClosed=await band.close();journal.finishedAt=Date.now();await save();
}
if(reportPath)await writeFile(reportPath,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(journal));
