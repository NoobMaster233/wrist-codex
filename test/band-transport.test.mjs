import {readWorkspaceScript} from './fixtures/workspace-script.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {pageConnectionDependencies} from './fixtures/legacy-connection.mjs';
import {privatePhoneFrames} from '../bridge/bluetooth/app-protocol.mjs';

test('band requests satisfy the native object contract and reassemble a phone response', async () => {
  const script = await readWorkspaceScript('globalThis.page =');
  let received;
  const connection = {
    send(options) {
      // Xiaomi's native boundary accepts an object and serializes it to the
      // byte[] delivered by the Android Wearable SDK.
      if (typeof options.data !== 'object' || options.data === null) {
        options.fail?.('invalid parameter: data must be an object', 202);
        return;
      }
      received = JSON.parse(JSON.stringify(options.data));
      options.success?.();
    }
  };
  const context = vm.createContext({ ...pageConnectionDependencies, interconnect: { instance: () => connection }, setTimeout, clearTimeout });
  vm.runInContext(script, context);
  const page = context.page;
  Object.assign(page, JSON.parse(JSON.stringify(page.private)));
  // Supply the framework hooks used after a successful response renders a page.
  page.$nextTick = callback => callback();
  page.$element = () => null;
  page.onInit();
  let result;
  page.rpc('projects.list', {}, data => { result = data; });
  assert.equal(received.method, 'projects.list');
  assert.ok(page.pending);
  const text = JSON.stringify({ v: 1, id: received.id, result: { projects: [{ name: '项目🛰️', path: '/projects/test' }] } });
  const parts = [text.slice(0, 60), text.slice(60)];
  // Deliver the second fragment twice, then the first, to cover retries and
  // out-of-order delivery across the phone/band link.
  for (const index of [1, 1, 0]) connection.onmessage({ data: JSON.stringify({ bc: 1, id: received.id, part: index, total: parts.length, data: parts[index] }) });
  assert.equal(result.projects[0].name, '项目🛰️');
  assert.equal(page.pending, null);
  assert.equal(page.busy, false);
  assert.equal(page.status, '已同步');
  page.onDestroy();
});

test('fragmented auxiliary replies and capability commands preserve the normal page request', async t => {
  const script = await readWorkspaceScript('globalThis.page =');
  const sent=[];
  const context=vm.createContext({...pageConnectionDependencies,interconnect:{instance:()=>({send:({data})=>sent.push(data)})},setTimeout,clearTimeout});
  vm.runInContext(script,context);const page=context.page;
  Object.assign(page,JSON.parse(JSON.stringify(page.private)));page.onInit();t.after(()=>page.onDestroy());
  page.rpc('projects.list',{},()=>{});const normal=page.pending;
  const auxiliary=page.auxiliaryRpc('blob.frame',{t:'open'});const request=sent.at(-1);
  const deliver=(message,id)=>{
    const encoded=JSON.stringify(message),parts=[];
    for(let i=0;i<encoded.length;i+=100)parts.push(encoded.slice(i,i+100));
    for(let i=parts.length-1;i>=0;--i)page.receive({bc:1,id,part:i,total:parts.length,data:parts[i]});
  };
  deliver({id:request.id,result:{value:'a'.repeat(600)}},request.id);
  assert.equal((await auxiliary).value.length,600);assert.equal(page.pending,normal);
  let command;page.capabilityProbe=value=>{command=value;};
  deliver({bc_command:'capabilityProbe',probeId:'probe-long',b64:'A'.repeat(1500)},'command-12345678');
  assert.equal(command.probeId,'probe-long');assert.equal(page.pending,normal);
  let navigations=0;page.loadProjects=()=>{navigations++;};
  deliver({bc_command:'probeProjects',padding:'x'.repeat(600)},'command-navigation');
  page.receive({bc_command:'probeProjects'});
  assert.equal(navigations,2,'fragmented and small navigation commands share dispatch');
  page.receive({bc_command:'connectionReady'});
  page.receive(null);
  assert.equal(page.pending,normal,'reconnection cannot clear an in-flight request');
});

test('private fragments reconstruct a large Unicode response within the native frame bound',async t=>{
  const source = await readWorkspaceScript('globalThis.page =');
  let request;
  const context=vm.createContext({...pageConnectionDependencies,interconnect:{instance:()=>({send:({data})=>{request=data;}})},setTimeout,clearTimeout});
  vm.runInContext(source,context);const page=context.page;Object.assign(page,JSON.parse(JSON.stringify(page.private)));page.onInit();t.after(()=>page.onDestroy());
  let result;page.rpc('message.read',{},value=>{result=value;});
  const text='你好🛰️\\"'.repeat(3500),response={v:1,id:request.id,result:{text}};
  const frames=privatePhoneFrames(response);assert.ok(frames.length>1&&frames.length<=32);
  for(const frame of frames.toReversed()){assert.ok(Buffer.byteLength(frame)<=32768);page.receive(frame);}
  assert.equal(result.text,text);assert.equal(page.busy,false);
});
