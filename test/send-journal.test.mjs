import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendJournal } from '../bridge/send-journal.mjs';
import { AstroRelay } from '../bridge/relay.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'band-send-journal-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
const accepted={threadId:'thread',turnId:'accepted',status:'inProgress'};

test('a confirmed send survives restart and memory eviction without storing text',async t=>{
  const root=await fixture(t),first=new SendJournal({root,limit:1});let calls=0;
  const submit=async()=>{calls++;return accepted;};
  await Promise.all([first.run('request-a',['thread','private words'],async()=>{},submit),first.run('request-a',['thread','private words'],async()=>{},submit)]);
  await first.run('request-b',['thread','other'],async()=>{},submit);
  const restarted=new SendJournal({root});
  assert.deepEqual(await restarted.run('request-a',['thread','private words'],()=>assert.fail('prepare repeated'),()=>assert.fail('submit repeated')),accepted);
  assert.equal(calls,2);
  await assert.rejects(restarted.run('request-a',['thread','changed'],async()=>{},submit),/reused/);
  for (const file of await readdir(root)) assert.equal((await readFile(join(root,file),'utf8')).includes('private words'),false);
});

test('an unconfirmed start stays blocked across restart, with no automatic resend',async t=>{
  const root=await fixture(t);let calls=0;
  const lost=async()=>{calls++;throw new Error('connection closed');};
  await assert.rejects(new SendJournal({root}).run('uncertain',['thread','words'],async()=>{},lost),/closed/);
  await assert.rejects(new SendJournal({root}).run('uncertain',['thread','words'],async()=>{},lost),/尚未确认/);
  assert.equal(calls,1);
});

test('preflight rejection is safe to retry, and a failed durable write cannot submit',async t=>{
  const root=await fixture(t),journal=new SendJournal({root});let calls=0;
  const submit=async()=>{calls++;return accepted;};
  await assert.rejects(journal.run('retry',['thread','words'],async()=>{throw new Error('busy');},submit),e=>e.sendNotStarted===true);
  assert.deepEqual(await readdir(root),[]);
  await journal.run('retry',['thread','words'],async()=>{},submit);
  const broken=new SendJournal({root:join(root,'missing','not-a-folder')});
  broken.write=async()=>{throw new Error('disk unavailable');};
  await assert.rejects(broken.run('write-failure',['thread','words'],async()=>{},submit),e=>e.sendNotStarted===true);
  assert.equal(calls,1);
});

test('more than a thousand page refreshes remain bounded and concurrent retries share work',async t=>{
  let calls=0;
  const relay=new AstroRelay({handle:async()=>{calls++;return {projects:[]};}});
  t.after(()=>relay.close());
  for (let i=0;i<1200;i++) await relay.rpc({id:'read-'+i,method:'projects.list'});
  assert.ok(relay.requests.size<=256);
  const request={id:'same-read',method:'projects.list'};
  await Promise.all([relay.rpc(request),relay.rpc(request)]);
  assert.equal(calls,1201);
  await assert.rejects(relay.rpc({...request,method:'threads.list'}),/reused/);
});
