import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fields,last,pbBytes,pbNumber,wear} from '../bridge/bluetooth/protobuf.mjs';
import {installPrepare,installPrepareResponse,massPrepare,massPrepareResponse,massFrames,installResult,watchfaceListResponse,watchfaceSelectedResponse,cancelMassTransfer} from '../bridge/bluetooth/install-resource.mjs';

const vector=JSON.parse(await readFile(new URL('./fixtures/mass-synthetic.json',import.meta.url)));
const resumeVector=JSON.parse(await readFile(new URL('./fixtures/mass-resume-synthetic.json',import.meta.url)));
const packet=(type,id,tag,data)=>Buffer.concat([Buffer.from([1,1]),wear(type,id,tag,data)]);
test('MASS header, original-file MD5, length, CRC endian and slices match independent Python vectors',()=>{
  const data=Buffer.from(vector.inputHex,'hex'),parts=massFrames(data,64,vector.sliceLength);
  assert.ok(parts.every(part=>part.length<=vector.sliceLength));
  parts.forEach((part,i)=>{assert.equal(part[0],2);assert.equal(part[1],1);assert.equal(part.readUInt16LE(2),parts.length);assert.equal(part.readUInt16LE(4),i+1);});
  assert.equal(Buffer.concat(parts.map(part=>part.subarray(6))).toString('hex'),vector.innerHex);
  assert.equal(massPrepare(data,64).md5.toString('hex'),vector.md5);
  assert.throws(()=>massFrames(data,32,100),/parameters/,'firmware MASS type is excluded');
});
test('RPK preparation requires explicit READY and encodes actual package, version and length',()=>{
  const out=installPrepare('rpk','dev.bandcodex.installcheck',2,34356),top=fields(out),app=fields(last(top,22,2).data),req=fields(last(app,2,2).data);
  assert.equal(last(req,1,2).data.toString(),'dev.bandcodex.installcheck');assert.equal(last(req,2,0).number,2n);assert.equal(last(req,3,0).number,34356n);
  assert.equal(installPrepareResponse(packet(20,1,22,pbBytes(3,pbNumber(1,0))),'rpk'),true);
  assert.throws(()=>installPrepareResponse(packet(20,1,22,pbBytes(3,Buffer.alloc(0))),'rpk'),/Missing/);
  assert.throws(()=>installPrepareResponse(packet(20,1,22,pbBytes(3,pbNumber(1,4))),'rpk'),/rejected/);
});
test('MASS prepare binds the response to the digest and rejects unknown resume or compression',()=>{
  const digest=Buffer.from(vector.md5,'hex');
  const response=(id=digest,extra=[])=>packet(22,0,24,pbBytes(2,Buffer.concat([pbBytes(1,id),pbNumber(2,0),pbNumber(5,512),...extra])));
  assert.equal(massPrepareResponse(response(),digest),512);
  assert.throws(()=>massPrepareResponse(response(Buffer.alloc(16)),digest),/another file/);
  assert.throws(()=>massPrepareResponse(response(digest,[pbNumber(4,10)]),digest),error=>{
    assert.equal(error.transferState.reportedLength,'10');assert.equal(error.transferState.dataId,vector.md5);return /retained/.test(error.message);
  });
  assert.throws(()=>massPrepareResponse(response(digest,[pbNumber(3,1)]),digest),/compression/);
});
test('partial transfer cancellation binds to the exact file digest and excludes firmware',()=>{
  const data=Buffer.from(vector.inputHex,'hex'),top=fields(cancelMassTransfer(data,16));
  assert.equal(last(top,1,0).number,22n);assert.equal(last(top,2,0).number,1n);
  const control=fields(last(fields(last(top,24,2).data),3,2).data);
  assert.equal(last(control,1,0).number,2n);assert.equal(last(control,2,0).number,16n);
  assert.equal(last(control,3,2).data.toString('hex'),vector.md5);
  assert.throws(()=>cancelMassTransfer(data,32),/known/);
  assert.throws(()=>cancelMassTransfer(Buffer.alloc(0),16),/known/);
});
test('explicit partial-file continuation preserves the full digest and matches an independent Python CRC vector',()=>{
  const data=Buffer.from(resumeVector.inputHex,'hex');
  const parts=massFrames(data,16,resumeVector.sliceLength,resumeVector.resumeBytes);
  const inner=Buffer.concat(parts.map(part=>part.subarray(6)));
  assert.equal(inner.toString('hex'),resumeVector.innerHex);
  assert.equal(inner.subarray(2,18).toString('hex'),resumeVector.fullMd5);
  assert.equal(inner.readUInt32LE(18),data.length-resumeVector.resumeBytes);
  assert.throws(()=>massFrames(data,16,17,-1),/parameters/);
  assert.throws(()=>massFrames(data,16,17,data.length),/parameters/);
  const digest=Buffer.from(resumeVector.fullMd5,'hex');
  const reply=packet(22,0,24,pbBytes(2,Buffer.concat([pbBytes(1,digest),pbNumber(2,0),pbNumber(4,4),pbNumber(5,17)])));
  assert.throws(()=>massPrepareResponse(reply,digest),/retained/);
  assert.equal(massPrepareResponse(reply,digest,{expectedResumeBytes:4}),17);
  assert.throws(()=>massPrepareResponse(reply,digest,{expectedResumeBytes:5}),/retained/);
});
test('RPK and watchface final codes differ; identity and explicit success must both match',()=>{
  const pkg='dev.bandcodex.installcheck';
  const appResult=(code,name=pkg)=>packet(20,2,22,pbBytes(4,Buffer.concat([pbNumber(1,code),pbBytes(2,Buffer.from(name))])));
  assert.equal(installResult(appResult(0),'rpk',pkg).code,0);
  assert.throws(()=>installResult(appResult(1),'rpk',pkg),/failed/);
  assert.throws(()=>installResult(appResult(0,'other.app'),'rpk',pkg),/differs/);
  const faceResult=code=>packet(4,5,6,pbBytes(7,Buffer.concat([pbBytes(1,Buffer.from('219667869')),pbNumber(2,code)])));
  assert.equal(installResult(faceResult(2),'watchface','219667869').code,2);
  assert.throws(()=>installResult(faceResult(0),'watchface','219667869'),/failed/);
});
test('watchface prepare reply, installed list and selection require matching identity and explicit flags',()=>{
  const id='219667869';
  const prepare=packet(4,4,6,pbBytes(9,Buffer.concat([pbBytes(1,Buffer.from(id)),pbNumber(2,0)])));
  assert.equal(installPrepareResponse(prepare,'watchface',id),true);
  assert.throws(()=>installPrepareResponse(prepare,'watchface','219667865'),/differs/);
  const listed=flag=>packet(4,0,6,pbBytes(1,pbBytes(1,Buffer.concat([pbBytes(1,Buffer.from(id)),...(flag===undefined?[]:[pbNumber(3,flag)])]))));
  assert.deepEqual(watchfaceListResponse(listed(1)),[{id,current:true}]);
  assert.throws(()=>watchfaceListResponse(listed()),/Invalid/);
  assert.equal(watchfaceSelectedResponse(packet(4,1,6,pbNumber(4,1))),true);
  assert.throws(()=>watchfaceSelectedResponse(packet(4,1,6,pbNumber(4,0))),/rejected/);
});
