import test from 'node:test';
import assert from 'node:assert/strict';
import {createAstroServer} from '../bridge/http-server.mjs';

test('unknown shell audit can read fixed boot evidence but cannot access arbitrary files or act for a finished job',async t=>{
  const owner='00000000-0000-4000-8000-000000000001', reads=[];
  let phase='unknown';
  const relay={shell:{snapshot:id=>id===owner?{phase}:null},
    startFileUpload:(...args)=>{reads.push(args);return {id:'audit-read'};}};
  const server=createAstroServer(relay,'audit-test-token');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const request=body=>fetch(`http://127.0.0.1:${server.address().port}/files/receive`,{
    method:'POST',headers:{Authorization:'Bearer audit-test-token'},body:JSON.stringify(body)});
  for(const name of ['bc-daily-v1-uptime.txt','bc-daily-v1-modules.txt','bc-shell-selftest-v1.status'])
    assert.equal((await request({shellOwner:owner,name})).status,202);
  assert.equal(reads.length,3);
  for(const name of ['../apps.json','unrelated.bin','bc-shell-wrong.status'])
    assert.equal((await request({shellOwner:owner,name})).status,400);
  phase='failed';
  assert.equal((await request({shellOwner:owner,name:'bc-daily-v1-uptime.txt'})).status,400);
  assert.equal(reads.length,3);
  assert.ok(reads.every(args=>args[3]===owner));
});
