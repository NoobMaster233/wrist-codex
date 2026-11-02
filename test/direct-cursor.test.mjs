import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CursorStore} from '../bridge/bluetooth/cursor-store.mjs';

test('claimed event survives failed send and a new transport instance',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'band-cursor-'));
  try{
    const path=join(folder,'cursor.json'),store=new CursorStore(path);
    assert.equal(await store.load(),null);
    await store.claim('relay-epoch',42,'band');
    // Radio transmission can fail here; a new owner still skips this event.
    const restored=await new CursorStore(path).load();
    assert.equal(restored.cursor,42);assert.equal(restored.epoch,'relay-epoch');
    assert.equal((await stat(path)).mode&0o777,0o600);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path))).sort(),['claimedAt','cursor','epoch','kind']);
    await store.claim('new-relay-epoch',1,'maintenance');
    assert.equal((await store.load()).epoch,'new-relay-epoch');
    await writeFile(path,'invalid');
    await assert.rejects(store.load(),/Cannot read saved/);
    await writeFile(path,'{"epoch":"e","cursor":-1}');
    await assert.rejects(store.load(),/Invalid saved/);
  }finally{await rm(folder,{recursive:true,force:true});}
});
