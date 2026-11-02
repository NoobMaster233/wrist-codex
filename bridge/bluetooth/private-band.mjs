import {EventEmitter} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PRIVATE_UUID,PrivateFrameDecoder,PrivateAuthSession,LinkType,privateFrame,MAX_PRIVATE_PAYLOAD} from './private-link-wire.mjs';
import {privatePhoneFrames} from './app-protocol.mjs';

const adb=['-s',process.env.BAND_ADB_SERIAL||'127.0.0.1:5555'];
export class PrivateBand extends EventEmitter {
  constructor(root,{service=false}={}) {
    super();this.root=root;this.service=service;this.decoder=new PrivateFrameDecoder();this.waiters=new Set();
    this.sendChain=Promise.resolve();this.txSequence=0;this.rxSequence=1;this.pingSequence=0;this.managementSequence=0;this.appVisible=false;
  }
  fail(error){if(this.failure||this.closing)return;this.failure=error;this.emit('failure',error);}
  wait(name,predicate=()=>true,timeout=15000) {
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{
      const clean=()=>{clearTimeout(timer);this.off(name,receive);this.off('failure',failed);this.waiters.delete(cancel);};
      const failed=error=>{clean();reject(error);},cancel=()=>failed(new Error('Private Bluetooth session closed'));
      const receive=value=>{try{const result=predicate(value);if(result){clean();resolve(result);}}catch(error){failed(error);}};
      const timer=setTimeout(()=>failed(new Error('Private Bluetooth '+name+' timeout')),timeout);
      this.on(name,receive);this.on('failure',failed);this.waiters.add(cancel);
    });
  }
  raw(bytes) {
    if(this.failure)throw this.failure;
    if(!this.child||this.closing)throw new Error('Private Bluetooth unavailable');
    this.child.stdin.write(JSON.stringify({type:'tx',base64:bytes.toString('base64')})+'\n');
  }
  accept(bytes) {
    for(const packet of this.decoder.push(bytes)) {
      if(this.auth.phase==='hello'){this.raw(this.auth.challenge(packet));continue;}
      if(this.auth.phase==='auth'){
        this.sessionInfo=this.auth.ready(packet);this.authenticatedAt=Date.now();this.emit('authenticated',this.sessionInfo);continue;
      }
      if(this.auth.phase!=='ready')throw new Error('Private message before authentication');
      if(packet.type===LinkType.MANAGEMENT_REPLY&&packet.sequence&&this.sessionInfo.protocolVersion>=2){this.emit('management-reply',packet);continue;}
      if(packet.type===LinkType.ACK&&packet.sequence&&packet.payload.length===0){this.emit('ack',packet.sequence);continue;}
      if(packet.type===LinkType.PONG){
        if(!packet.sequence){
          if(packet.payload.length!==5||packet.payload.toString('ascii',0,4)!=='BCLV'||packet.payload[4]>1)throw new Error('Invalid private visibility');
          this.appVisible=packet.payload[4]===1;this.emit('visibility',this.appVisible);
        }else this.emit('pong',packet);
        continue;
      }
      if(packet.type!==LinkType.JSON||!packet.sequence)throw new Error('Unexpected private message');
      const digest=createHash('sha256').update(packet.payload).digest('hex');
      if(packet.sequence!==this.rxSequence){
        if(packet.sequence===this.rxSequence-1&&digest===this.lastRxDigest){this.raw(privateFrame(LinkType.ACK,packet.sequence));continue;}
        throw new Error('Unexpected private receive sequence');
      }
      const text=packet.payload.toString('utf8');if(!Buffer.from(text,'utf8').equals(packet.payload))throw new Error('Invalid private JSON encoding');
      const message=JSON.parse(text);if(!message||typeof message!=='object'||Array.isArray(message))throw new Error('Invalid private JSON');
      this.rxSequence++;this.lastRxDigest=digest;this.raw(privateFrame(LinkType.ACK,packet.sequence));this.emit('message',message);
    }
  }
  sendJSON(message) {
    const pieces=privatePhoneFrames(message).map(text=>Buffer.from(text));
    const task=this.sendChain.then(async()=>{
      for(const payload of pieces){
        const sequence=++this.txSequence;if(sequence>0xffffffff)throw new Error('Private send sequence exhausted');
        const acknowledged=this.wait('ack',value=>value===sequence);
        try{this.raw(privateFrame(LinkType.JSON,sequence,payload));}catch(error){this.fail(error);}
        await acknowledged;
      }
    });
    this.sendChain=task.catch(error=>this.fail(error));return task;
  }
  async ping(payload=Buffer.alloc(0)) {
    const sequence=++this.pingSequence;if(sequence>0xffffffff)throw new Error('Private ping sequence exhausted');
    const response=this.wait('pong',p=>p.sequence===sequence?p:null,5000);
    try{this.raw(privateFrame(LinkType.PING,sequence,payload));}catch(error){this.fail(error);}
    const packet=await response;if(!packet.payload.equals(payload))throw new Error('Private ping data differs');return packet;
  }
  async management(payload) {
    if(this.sessionInfo?.protocolVersion<2||!this.sessionInfo)throw new Error('Native management is unavailable');
    const sequence=++this.managementSequence;if(sequence>0xffffffff)throw new Error('Management sequence exhausted');
    const response=this.wait('management-reply',p=>p.sequence===sequence?p:null,6000);
    try{this.raw(privateFrame(LinkType.MANAGEMENT,sequence,payload));}catch(error){this.fail(error);}
    // No automatic retransmission, including EXEC. File recovery explicitly
    // observes its original transfer ID on the next authenticated connection.
    try{return (await response).payload;}catch(error){this.fail(error);throw error;}
  }
  async open() {
    const path=join(this.root,'.local/private-link-auth.json');
    if((await stat(path)).mode&0o077)throw new Error('Private link key file permissions differ');
    const config=JSON.parse(await readFile(path));
    const address=config.bandAddress;
    if(!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(address||'')||config.firmware!=='3.101.043'||config.uuid!==PRIVATE_UUID||!/^[a-f0-9]{64}$/.test(config.keyHex||''))
      throw new Error('Private link target differs');
    this.auth=new PrivateAuthSession(Buffer.from(config.keyHex,'hex'));
    const manifest=JSON.parse(await readFile(join(this.root,'artifacts/research/private-bluetooth-pipe-v1/manifest.json')));
    const artifact=join(this.root,manifest.artifact),jar=await readFile(artifact);
    if(createHash('sha256').update(jar).digest('hex')!==manifest.sha256)throw new Error('Private pipe artifact differs');
    const remote='/data/local/tmp/private-bluetooth-pipe-v1.jar';
    execFileSync('adb',[...adb,'push',artifact,remote],{stdio:'pipe'});execFileSync('adb',[...adb,'shell','chmod','444',remote],{stdio:'pipe'});
    if(execFileSync('adb',[...adb,'shell','sha256sum',remote],{encoding:'utf8'}).split(/\s/)[0]!==manifest.sha256)throw new Error('Private pipe remote hash differs');
    const ready=this.wait('pipe-ready',()=>true,10000);
    this.child=spawn('adb',[...adb,'shell','env','CLASSPATH='+remote,'/system/bin/app_process','/system/bin',
      'dev.bandcodex.bt.PrivateBluetoothPipe',address,PRIVATE_UUID,...(this.service?['--service']:[])],{stdio:['pipe','pipe','pipe']});
    this.child.on('error',error=>this.fail(error));this.child.stdin.on('error',error=>this.fail(error));this.child.stderr.on('data',()=>{});
    this.child.on('close',()=>{this.exited=true;if(!this.closing)this.fail(new Error('Private pipe exited'));});
    createInterface({input:this.child.stdout}).on('line',line=>{
      try{
        if(line.length>100000)throw new Error('Excessive private pipe message');if(!line.startsWith('{'))return;
        const item=JSON.parse(line);
        if(item.type==='ready'&&item.protocol===2&&item.uuid===PRIVATE_UUID&&item.secureRfcomm===true)this.emit('pipe-ready');
        else if(item.type==='rx'){
          if(typeof item.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))throw new Error('Invalid private pipe data');
          this.accept(Buffer.from(item.base64,'base64'));
        }else if(item.type==='closed')this.socketClosed=true;
        else if(item.type==='error'||item.type==='eof')this.fail(new Error('Private pipe '+(item.errorClass||item.type)));
      }catch(error){this.fail(error);}
    });
    await ready;const authenticated=this.wait('authenticated',()=>true,10000);this.raw(this.auth.start());await authenticated;
    this.connectionInfo={transport:'private-spp',uuid:PRIVATE_UUID,configuredScn:11,secureRfcomm:true,mutualAuthentication:true,
      nativeManagement:this.sessionInfo.protocolVersion>=2};
    return this.connectionInfo;
  }
  async close() {
    this.closing=true;for(const cancel of [...this.waiters])cancel();
    if(this.child&&!this.exited){
      this.child.stdin.end('{"type":"close"}\n');const until=Date.now()+3000;
      while(!this.exited&&Date.now()<until)await delay(10);
      if(!this.exited)this.child.kill('SIGTERM');
    }
    return this.socketClosed===true;
  }
}
