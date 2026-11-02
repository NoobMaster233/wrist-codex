// Only obsolete resources produced by this project. Never a prefix match.
import {fields,last,pbBytes,wear} from './protobuf.mjs';

export const dailyFace='219667870';
export const productionFaces=new Set(['219667870','219667871','219667872','219667873','219667874',
 '219667881','219667882','219667883','219667884','219667885']);
export const testPackage='dev.bandcodex.installcheck';
export const obsoleteFaces=new Map([
 ['219667851','runtime-recovery-face-043'],['219667852','native-relpure-face-043'],
 ['219667854','native-fileio-face-043'],['219667855','native-capture-face-043'],
 ['219667856','native-event-service-face-043-v2'],['219667857','native-event-service-face-043-v3a'],
 ['219667858','native-audio-service-face-043-v1'],['219667859','native-audio-app-reload-face-043'],
 ['219667861','native-audio-recovery-reboot-face-043'],['219667862','nsh-capabilities-face-043-v1'],
 ['219667863','nsh-process-face-043-v1'],['219667864','nsh-shell-face-043-v1'],
 ['219667865','codex-daily-face-043-v2'],['219667866','rpk-032-refresh-face-043-v2'],
 ['219667868','rpk-034-refresh-face-043-v1'],['219667869','codex-daily-face-043-v3'],
 ['219667860','native-audio-bootstrap-face-043-v1'],
 ['219667876','orbit-refresh-once-043-v1'],['219667878','orbit041-refresh-once-043-v1'],
 ['219667879','orbit042-refresh-once-043-v1']
]);
export function cleanupTargets(apps,faces,{recoveryVerified=false}={}) {
 if(faces.filter(face=>face.current).length!==1||!faces.some(face=>productionFaces.has(face.id)&&face.current))
  throw new Error('Select a verified production face before cleaning old resources');
 const owned=apps.find(app=>app.packageName==='dev.bandcodex.remote');
 if(!owned||owned.versionCode<32)throw new Error('Preserve the working Codex App');
 const tests=apps.filter(app=>app.packageName===testPackage);
 if(tests.some(app=>![1,2].includes(app.versionCode)))throw new Error('Unknown test App version; inspect first');
 const replacementReady=recoveryVerified&&((owned.versionCode>=37&&faces.some(face=>face.id==='219667880'))||
   (owned.versionCode>=36&&faces.some(face=>face.id==='219667875')));
 return {apps:tests,faces:faces.filter(face=>obsoleteFaces.has(face.id)&&!face.current&&
   (face.id!=='219667860'||replacementReady))};
}
export function removeTestApp(app) {
 if(app.packageName!==testPackage||![1,2].includes(app.versionCode)||!Buffer.isBuffer(app.fingerprint)||app.fingerprint.length<16||app.fingerprint.length>64)
  throw new Error('Only the known installation test App may be removed');
 return wear(20,3,22,pbBytes(5,Buffer.concat([
  pbBytes(1,Buffer.from(app.packageName)),pbBytes(2,app.fingerprint)])));
}
export function removeOldFace(id) {
 if(!obsoleteFaces.has(id))throw new Error('Only a known obsolete test face may be removed');
 return wear(4,2,6,pbBytes(2,Buffer.from(id)));
}
export function removedFaceResponse(packet) {
 if(packet[0]!==1||packet[1]!==1)return null;
 const top=fields(packet.subarray(2));
 if(last(top,1,0)?.number!==4n||last(top,2,0)?.number!==2n)return null;
 const error=last(top,100,0);
 if(error&&error.number!==0n)throw new Error('Device rejected watchface removal');
 const data=last(top,6,2);
 if(!data||last(fields(data.data),4,0)?.number!==1n)throw new Error('Watchface removal was not confirmed');
 return true;
}
export function assertPreserved(before,after,removed) {
 for(const app of before.apps) {
  if(removed.apps.includes(app.packageName))continue;
  const retained=after.apps.find(value=>value.packageName===app.packageName);
  if(!retained||retained.versionCode!==app.versionCode||!retained.fingerprint.equals(app.fingerprint))
   throw new Error('An App outside the cleanup plan changed');
 }
 for(const face of before.faces) {
  if(!removed.faces.includes(face.id)&&!after.faces.some(value=>value.id===face.id))
   throw new Error('A watchface outside the cleanup plan disappeared');
 }
 const selected=before.faces.find(face=>face.current)?.id;
 if(after.faces.filter(face=>face.current).length!==1||!productionFaces.has(selected)||
   !after.faces.some(face=>face.id===selected&&face.current))throw new Error('Production face selection changed');
}
