import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupTargets,dailyFace,testPackage,removeTestApp,removeOldFace,removedFaceResponse,assertPreserved} from '../bridge/bluetooth/test-resource-cleanup.mjs';
import {wear,pbNumber,fields,last} from '../bridge/bluetooth/protobuf.mjs';
const own={packageName:'dev.bandcodex.remote',versionCode:32,fingerprint:Buffer.alloc(32,1)};
const app={packageName:testPackage,versionCode:2,fingerprint:Buffer.alloc(32,2)};
const faces=[{id:dailyFace,current:true},{id:'219667860',current:false},{id:'219667851',current:false},{id:'120917385439',current:false}];
test('cleanup selects only obsolete project resources, preserving service loader, new face and user resources',()=>{
 const plan=cleanupTargets([own,app,{...app,packageName:'user.app'}],faces);
 assert.deepEqual(plan.apps,[app]);assert.deepEqual(plan.faces,[faces[2]]);
 for(const id of [dailyFace,'219667875','120917385439','219667899'])assert.throws(()=>removeOldFace(id),/known obsolete/);
 assert.throws(()=>removeTestApp(own),/known installation/);
 assert.throws(()=>cleanupTargets([own,app],faces.map(face=>({...face,current:face.id==='219667851'}))),/Select/);
 assert.throws(()=>cleanupTargets([own,{...app,versionCode:3}],faces),/Unknown/);
});
test('cleanup preserves the chosen production design and removes the old audio helper only after its replacement is verified',()=>{
 const designs=faces.map(face=>({...face,current:false})).concat([{id:'219667871',current:true},
  {id:'219667875',current:false},{id:'219667879',current:false}]);
 const newer={...own,versionCode:36};
 assert.equal(cleanupTargets([newer],designs).faces.some(face=>face.id==='219667860'),false);
 assert.equal(cleanupTargets([newer],designs,{recoveryVerified:true}).faces.some(face=>face.id==='219667860'),true);
 assert.equal(cleanupTargets([own],designs,{recoveryVerified:true}).faces.some(face=>face.id==='219667860'),false);
 assert.equal(cleanupTargets([newer],designs.filter(face=>face.id!=='219667875'),{recoveryVerified:true}).faces.some(face=>face.id==='219667860'),false);
 const layered=designs.map(face=>({...face,id:face.id==='219667875'?'219667880':face.id==='219667871'?'219667882':face.id}));
 assert.equal(cleanupTargets([{...own,versionCode:37}],layered,{recoveryVerified:true}).faces.some(face=>face.id==='219667860'),true);
 assert.equal(cleanupTargets([newer],layered,{recoveryVerified:true}).faces.some(face=>face.id==='219667860'),false);
 assert.equal(cleanupTargets([{...own,versionCode:37}],layered).faces.some(face=>face.id==='219667860'),false);
 const plan=cleanupTargets([newer],designs,{recoveryVerified:true});
 const after={apps:[newer],faces:designs.filter(face=>!plan.faces.includes(face))};
 assert.doesNotThrow(()=>assertPreserved({apps:[newer],faces:designs},after,{apps:[],faces:plan.faces.map(face=>face.id)}));
 assert.throws(()=>assertPreserved({apps:[newer],faces:designs},{...after,faces:after.faces.map(face=>({...face,current:face.id===dailyFace}))},{apps:[],faces:plan.faces.map(face=>face.id)}),/selection/);
});
test('uninstall binds to current test certificate and requires explicit watchface success',()=>{
 const top=fields(removeTestApp(app)),basic=fields(last(fields(last(top,22,2).data),5,2).data);
 assert.equal(last(basic,1,2).data.toString(),testPackage);assert.deepEqual(last(basic,2,2).data,app.fingerprint);
 const ack=n=>Buffer.concat([Buffer.from([1,1]),wear(4,2,6,pbNumber(4,n))]);
 assert.equal(removedFaceResponse(ack(1)),true);assert.throws(()=>removedFaceResponse(ack(0)),/not confirmed/);
 assert.equal(removedFaceResponse(Buffer.concat([Buffer.from([1,1]),wear(4,1,6,pbNumber(4,1))])),null);
});
test('cleanup readback catches other app, certificate, face or selection loss',()=>{
 const before={apps:[own,app],faces};
 const after={apps:[own],faces:faces.filter(face=>face.id!=='219667851')};
 const removed={apps:[testPackage],faces:['219667851']};
 assert.doesNotThrow(()=>assertPreserved(before,after,removed));
 assert.throws(()=>assertPreserved(before,{...after,apps:[]},removed),/App outside/);
 assert.throws(()=>assertPreserved(before,{...after,apps:[{...own,fingerprint:Buffer.alloc(32)}]},removed),/App outside/);
 assert.throws(()=>assertPreserved(before,{...after,faces:after.faces.slice(0,2)},removed),/outside/);
 assert.throws(()=>assertPreserved(before,{...after,faces:after.faces.map(face=>({...face,current:false}))},removed),/selection/);
});
