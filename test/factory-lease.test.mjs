import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FactoryLease} from '../bridge/bluetooth/factory-lease.mjs';
test('owned factory operations cannot overlap and the kernel releases the lease',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bc-factory-'));await mkdir(join(root,'.local'));
  const first=new FactoryLease(root),second=new FactoryLease(root),third=new FactoryLease(root);
  t.after(async()=>{await first.release();await second.release();await third.release();await rm(root,{recursive:true,force:true});});
  await first.acquire();await assert.rejects(second.acquire(),/in use/);await first.release();await third.acquire();
});
