import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,access,symlink} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FactoryLease} from '../bridge/bluetooth/factory-lease.mjs';
test('owned factory operations cannot overlap and the kernel releases the lease',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bc-factory-'));await mkdir(join(root,'.local'));
  const first=new FactoryLease(root),second=new FactoryLease(root),third=new FactoryLease(root);
  t.after(async()=>{await first.release();await second.release();await third.release();await rm(root,{recursive:true,force:true});});
  await first.acquire();await assert.rejects(second.acquire(),/in use/);await first.release();await third.acquire();
});
test('the factory lease works with flock and Node alone, without a Python command alias',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bc-factory-path-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'.local'));const bin=join(root,'bin');await mkdir(bin);
  let flock;
  for(const folder of process.env.PATH.split(delimiter)){
    const candidate=join(folder,'flock');try{await access(candidate);flock=candidate;break;}catch{}
  }
  assert.ok(flock,'flock is a documented prerequisite');await symlink(flock,join(bin,'flock'));
  const code='const {FactoryLease}=await import(process.argv[1]); const lease=new FactoryLease(process.argv[2]); try {await lease.acquire();} finally {await lease.release();}';
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code,
    new URL('../bridge/bluetooth/factory-lease.mjs',import.meta.url).href,root],
    {env:{...process.env,PATH:bin},timeout:10000});
});
test('a missing lock directory is a helper failure, not a competing channel owner',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bc-factory-missing-'));const lease=new FactoryLease(root);
  t.after(async()=>{await lease.release();await rm(root,{recursive:true,force:true});});
  await assert.rejects(lease.acquire(),error=>/lock helper exited/.test(error.message)&&!/in use/.test(error.message));
});
