import test from 'node:test';
import assert from 'node:assert/strict';
import{readFile}from'node:fs/promises';
import vm from'node:vm';
const source=await readFile(new URL('../scripts/run-direct-band.mjs',import.meta.url),'utf8');
const actual=source.slice(source.indexOf('const pageCommands='),source.indexOf('const diagnostic='));
function driver(){
 const delivered=[],managed=[];let wakes=0;
 const ctx=vm.createContext({Date,Set,Promise,privateMode:true,appVisible:false,appSeenAt:0,
  outgoing:Promise.resolve(),incoming:Promise.resolve(),failed:e=>{throw e},
  nativeManagement:{async handle(command){if(['fileReceive','fileUpload','nativeShellControl'].includes(command.bc_command)){managed.push(command.bc_command);return true}return false}},
  band:{async sendJSON(value){delivered.push(value)}},
 });
 ctx.wakeApp=async()=>{
  wakes++;ctx.appVisible=true;ctx.appSeenAt=Date.now();
  // Real onShow behavior: the resumed page starts its prior conversation
  // read. The new navigation must follow this reply, without a queue cycle.
  ctx.incoming=Promise.resolve().then(()=>ctx.send({id:'old-read',result:{messages:[]}}));
 };
 vm.runInContext(actual+'\nthis.send=send;',ctx);
 return {ctx,delivered,managed,wakes:()=>wakes};
}
test('resuming a page drains its prior read before new navigation or subscription reply',{timeout:2000},async()=>{
 for(const command of [{bc_command:'probeConversation',thread:{id:'new'}},{event:'messages.updated',watchId:'current'}]){
  const d=driver();await d.ctx.send(command);
  assert.equal(d.wakes(),1);assert.equal(d.delivered[0].id,'old-read');assert.equal(d.delivered[1],command);
 }
});
test('native Shell and files do not wake or wait for a hidden page',{timeout:2000},async()=>{
 const d=driver();d.ctx.incoming=new Promise(()=>{});
 for(const bc_command of ['fileReceive','fileUpload','nativeShellControl'])await d.ctx.send({bc_command});
 assert.equal(d.wakes(),0);assert.equal(d.delivered.length,0);assert.deepEqual(d.managed,['fileReceive','fileUpload','nativeShellControl']);
});
