import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createNativeManagement,managementRequest,managementResponse,ManagementOp as Op} from '../bridge/bluetooth/native-management.mjs';
import {crc32,encode64} from '../band/src/common/bytes.mjs';

// Native C has separate filesystem/intent and actual ARM gates. This model
// checks that the existing JS transfer engines use the binary file boundary.
function transport(files=new Map()) {
 return {files,calls:[],async management(r){
  if(this.failure)throw this.failure;
  const op=r[4],a=r[6],b=r[7],offset=r.readUInt32LE(8),length=r.readUInt32LE(12);
  const name=r.toString('ascii',16,16+a),target=r.toString('ascii',16+a,16+a+b);
  this.calls.push({op,name,offset,length});let result=Buffer.alloc(0),error=0;
  if(this.cut&&this.cut({op,name,offset,length})){this.failure=new Error('cut own model pipe');throw this.failure;}
  const source=files.get(name);
  if(op===Op.STAT){if(!source)error=2;else{result=Buffer.alloc(4);result.writeUInt32LE(source.length);}}
  else if(op===Op.READ){if(!source)error=2;else if(offset+length>source.length)error=22;else result=source.subarray(offset,offset+length);}
  else if(op===Op.WRITE){const data=r.subarray(16+a+b);if(r[5]&&source?.length!==offset)error=22;else{files.set(name,Buffer.concat([r[5]?source:Buffer.alloc(0),data]));result=Buffer.alloc(4);result.writeUInt32LE(offset+length);}}
  else if(op===Op.MOVE){if(!source)error=2;else{files.set(target,source);files.delete(name);}}
  else if(op===Op.DELETE){if(!source)error=2;else files.delete(name);}
  else if(op===Op.EXEC){this.execs=(this.execs||0)+1;result=Buffer.alloc(4);result.writeUInt32LE(1);}
  else throw new Error('unexpected op');
  const header=Buffer.alloc(12);header.write('BCR1');header[4]=op;header.writeInt32LE(error,8);return Buffer.concat([header,result]);
 }};
}
const id='file-11111111-2222-4333-8444-555555555555';
test('native file delivery reuses bounded chunks and exact persisted-byte checks without App RPC',async()=>{
 const t=transport(),data=randomBytes(131075);let receipt;
 const manager=createNativeManagement({transport:t,rpc:async(method,p)=>{
  if(method==='files.pull'){const bytes=data.subarray(p.seq*4096,(p.seq+1)*4096);return {seq:p.seq,b64:encode64(bytes),crc:crc32(bytes)};}
  assert.equal(method,'files.received');receipt=p;return {};
 }});
 assert.equal(await manager.handle({bc_command:'fileReceive',transferId:id,size:data.length,crc:crc32(data),chunkBytes:4096,resumable:true}),true);
 assert.deepEqual(t.files.get('bc-'+id+'.bin'),data);assert.equal(receipt.metadata.length,data.length);
 assert(t.calls.filter(x=>x.op===Op.READ).every(x=>x.length<=4096));
});
test('a cut native write preserves its original transfer and resumes from the persisted prefix',async()=>{
 const data=randomBytes(8195),t=transport();let failures=0;const sequences=[];
 const rpc=async(method,p)=>{
  if(method==='files.pull'){sequences.push(p.seq);const bytes=data.subarray(p.seq*4096,(p.seq+1)*4096);return {seq:p.seq,b64:encode64(bytes),crc:crc32(bytes)};}
  assert.equal(method,'files.received');if(p.error)failures++;return {};
 };
 const command={bc_command:'fileReceive',transferId:id,size:data.length,crc:crc32(data),chunkBytes:4096,resumable:true};
 t.cut=x=>x.op===Op.WRITE&&x.offset===4096;
 await assert.rejects(createNativeManagement({transport:t,rpc}).handle(command),/Phone send failed/);
 assert.equal(t.files.get('bc-'+id+'.part').length,4096);assert.equal(failures,0);
 const resumed=transport(t.files);await createNativeManagement({transport:resumed,rpc}).handle(command);
 assert.deepEqual(t.files.get('bc-'+id+'.bin'),data);assert.equal(sequences.filter(x=>x===0).length,1);
});
test('native uploads preserve checksum, resume position and final receipt',async()=>{
 const bytes=randomBytes(8195),t=transport(new Map([['capture.bcap',bytes]]));const blocks=[];let receipt;
 await createNativeManagement({transport:t,rpc:async(method,p)=>{
  if(method==='files.uploaded'){receipt=p;return {};}
  assert.equal(method,'blob.frame');
  if(p.t==='open'){assert.equal(p.crc,crc32(bytes));return {next:2,chunkBytes:1024};}
  if(p.t==='chunk'){blocks.push({seq:p.seq,data:Buffer.from(p.b64,'base64')});return {next:p.seq+1};}
  assert.equal(p.t,'finish');return {state:'complete'};
 }}).handle({bc_command:'fileUpload',transferId:'upload-11111111-2222-4333-8444-555555555555',name:'capture.bcap',chunkBytes:1024,resumable:true});
 assert.equal(blocks[0].seq,2);assert.deepEqual(Buffer.concat(blocks.map(x=>x.data)),bytes.subarray(2048));assert.equal(receipt.size,bytes.length);
});
test('native Shell submits once and reads its saved receipt without a UI wake',async()=>{
 const status=Buffer.alloc(64);status.write('BCSR0431');status.writeUInt32LE(1,8);status.writeUInt32LE(2,12);
 status.writeInt32LE(282,16);status.writeInt32LE(282,20);status.writeUInt32LE(3000,48);
 const id='11111111-2222-4333-8444-555555555555',t=transport(new Map([['bc-shell-'+id+'.status',status]]));let report;
 const manager=createNativeManagement({transport:t,rpc:async(method,p)=>{assert.equal(method,'native.shell.report');report=p;}});
 await manager.handle({bc_command:'nativeShellControl',requestId:id,timeoutMs:3000,expiresAt:Date.now()+3000});
 assert.equal(t.execs,1);assert.deepEqual(report,{id,op:'no-event'});
 await manager.handle({bc_command:'nativeShellControl',requestId:id,expiresAt:0});assert.equal(t.execs,1);assert.equal(report.notStarted,true);
});
test('management framing rejects invalid paths, oversized blocks and malformed replies',()=>{
 assert.throws(()=>managementRequest(Op.READ,{name:'../key',length:1}),/Invalid/);
 assert.throws(()=>managementRequest(Op.WRITE,{name:'test.part',length:4097,data:Buffer.alloc(4097)}),/Invalid/);
 assert.throws(()=>managementResponse(Buffer.alloc(12),Op.STAT),/Invalid/);
 assert.throws(()=>managementRequest(Op.STAT,{name:'test',offset:1}),/Invalid/);
});
