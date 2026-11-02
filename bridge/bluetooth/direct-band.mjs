import {EventEmitter} from 'node:events';
import {spawn,execFileSync,spawnSync} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {FrameDecoder,frame,startRequest,receiveWindow} from './l1.mjs';
import {AuthSession} from './auth.mjs';
import {wear,appListResponse} from './protobuf.mjs';
import {FactoryLease} from './factory-lease.mjs';

const adb=['-s',process.env.BAND_ADB_SERIAL||'127.0.0.1:5555'];
const pipeVersion='10';

/** Owned authenticated link; socket reconnection belongs to the supervisor. */
export class DirectBand extends EventEmitter {
  constructor(root,{transport='spp',service=false,channel=0}={}) {
    super();if(!['spp','ble'].includes(transport))throw new Error('Unsupported Bluetooth transport');
    if(![0,5].includes(channel)||channel&&transport!=='spp')throw new Error('Unsupported explicit RFCOMM channel');
    this.channel=channel;
    this.transport=transport;this.service=service;this.root=root;this.decoder=new FrameDecoder({preambleLimit:transport==='spp'?64:0});
    this.txSequence=0;this.rxSequence=0;this.sendChain=Promise.resolve();this.waiters=new Set();
    this.maxFlight=1;
  }
  fail(error) {
    if(this.failure||this.closing)return;
    this.failure=error;this.emit('failure',error);
  }
  wait(name,predicate=()=>true,timeout=5000) {
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{
      const clean=()=>{clearTimeout(timer);this.off(name,receive);this.off('failure',fail);this.waiters.delete(cancel);};
      const cancel=()=>{clean();reject(new Error('Direct Bluetooth session closed'));};
      const fail=error=>{clean();reject(error);};
      const receive=value=>{try{const result=predicate(value);if(result){clean();resolve(result);}}catch(e){fail(e);}};
      const timer=setTimeout(()=>fail(new Error('Direct Bluetooth '+name+' timeout')),timeout);
      this.on(name,receive);this.on('failure',fail);this.waiters.add(cancel);
    });
  }
  raw(packet) {
    if(this.failure)throw this.failure;
    if(!this.child||this.closing)throw new Error('Direct Bluetooth session unavailable');
    this.child.stdin.write(JSON.stringify({type:'tx',base64:packet.toString('base64')})+'\n');
  }
  accept(chunk) {
    for(const received of this.decoder.push(chunk)) {
      if(received.type===2){this.emit('command',received.payload);continue;}
      if(received.type===1){this.emit('ack',received.seq);continue;}
      if(received.type!==3)continue;
      if(!received.frx) {
        if(received.seq!==this.rxSequence) {
          if(received.seq===((this.rxSequence+255)&255))this.raw(frame(1,received.seq));
          else throw new Error('Unexpected direct Bluetooth receive sequence');
          continue;
        }
        this.raw(frame(1,received.seq));this.rxSequence=(this.rxSequence+1)&255;
      }
      this.emit('packet',this.auth.decode(received.payload));
    }
  }
  sendL2(payload) {return this.sendL2Batch([payload]);}
  sendL2Batch(payloads) {
    if(!Array.isArray(payloads)||payloads.length<1||payloads.length>this.maxFlight)
      return Promise.reject(new Error('Batch exceeds negotiated Bluetooth window'));
    const task=this.sendChain.then(async()=>{
      const first=this.txSequence,last=(first+payloads.length-1)&255;
      this.txSequence=(last+1)&255;
      // ACK is cumulative. Wait for the final sequence; intermediate ACKs
      // may be omitted by the peer. There is no automatic retransmission.
      const acknowledged=this.wait('ack',value=>value===last);
      const writing=async()=>{
        for(let i=0;i<payloads.length;i++) {
          this.raw(frame(3,(first+i)&255,payloads[i]));
          if(i+1<payloads.length)await delay(50);
        }
      };
      await Promise.all([acknowledged,Promise.resolve().then(writing)]);
    });
    this.sendChain=task.catch(error=>this.fail(error));return task;
  }
  async requestL2(payload,predicate) {
    const response=this.wait('packet',predicate);
    const result=await Promise.all([this.sendL2(payload),response]);return result[1];
  }
  sendPb(pb) {return this.sendL2(this.auth.encode(pb));}
  sendPbBatch(packets) {return this.sendL2Batch(packets.map(pb=>this.auth.encode(pb)));}
  async open() {
    this.factoryLease=new FactoryLease(this.root);await this.factoryLease.acquire();
    const old=spawnSync('adb',[...adb,'shell','pidof','moe.astralsight.astrobox'],{encoding:'utf8'});
    if(old.status!==1||old.stdout.trim())throw new Error('AstroBox must already be stopped');
    const path=join(this.root,'.local/direct-bluetooth-auth.json');
    if((await stat(path)).mode&0o077)throw new Error('Auth file must be private');
    let cfg;try{cfg=JSON.parse(await readFile(path));}catch{throw new Error('Cannot parse private Bluetooth configuration');}
    const address=cfg.bandAddress;
    if(!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(address||'')||cfg.firmware!=='3.101.043'||!/^[0-9a-f]{32}$/.test(cfg.authKeyHex))throw new Error('Owned auth target differs');
    this.auth=new AuthSession(Buffer.from(cfg.authKeyHex,'hex'),undefined,this.transport==='ble'?1:0);
    const manifest=JSON.parse(await readFile(join(this.root,'artifacts/research/termux-bluetooth-pipe-v'+pipeVersion+'/manifest.json')));
    const source=join(this.root,manifest.artifact),jar=await readFile(source);
    if(createHash('sha256').update(jar).digest('hex')!==manifest.sha256)throw new Error('Byte pipe artifact changed');
    const remote='/data/local/tmp/band-bluetooth-pipe-v'+pipeVersion+'.jar';
    execFileSync('adb',[...adb,'push',source,remote],{stdio:'pipe'});
    execFileSync('adb',[...adb,'shell','chmod','444',remote],{stdio:'pipe'});
    if(execFileSync('adb',[...adb,'shell','sha256sum',remote],{encoding:'utf8'}).split(/\s/)[0]!==manifest.sha256)throw new Error('Byte pipe hash differs');
    const ready=this.wait('ready',()=>true,this.transport==='ble'?40000:20000);
    this.child=spawn('adb',[...adb,'shell','env','CLASSPATH='+remote,'/system/bin/app_process','/system/bin',
      'dev.bandcodex.bt.BluetoothPipe',address,...(this.transport==='ble'?['--ble']:[]),...(this.service?['--service']:[]),...(this.channel?['--channel=5']:[])],{stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>this.fail(e));this.child.stdin.on('error',e=>this.fail(e));
    this.child.stderr.on('data',()=>{});
    this.child.on('close',()=>{this.exited=true;if(!this.closing)this.fail(new Error('Bluetooth pipe exited'));});
    createInterface({input:this.child.stdout}).on('line',line=>{
      try {
        if(line.length>100000)throw new Error('Excessive byte pipe message');if(!line.startsWith('{'))return;
        const msg=JSON.parse(line);
        if(msg.type==='ready'&&msg.protocol===1) {
          this.connectionInfo={transport:this.transport,sdpRequested:msg.sdpRequested===true,connectionAttempts:msg.connectionAttempts,
            secureRfcomm:msg.secureRfcomm===true,rfcommChannel:msg.rfcommChannel,...(this.transport==='ble'?{mtu:msg.mtu,chunkBytes:msg.chunkBytes}:{})};
          this.emit('ready');
        }
        else if(msg.type==='rx') {
          if(typeof msg.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(msg.base64))throw new Error('Invalid byte pipe input');
          this.accept(Buffer.from(msg.base64,'base64'));
        } else if(msg.type==='closed')this.socketClosed=true;
        else if(msg.type==='error'||msg.type==='eof')this.fail(new Error('Bluetooth pipe '+(msg.errorClass||msg.type)));
      } catch(e){this.fail(e);}
    });
    await ready;
    if(this.transport==='spp'){this.raw(Buffer.from('badcfe00c00300000100ef','hex'));await delay(100);}
    const started=this.wait('command',bytes=>bytes[0]===2?bytes:null);this.raw(startRequest());
    this.maxFlight=receiveWindow(await started);
    const confirm=await this.requestL2(this.auth.start(),packet=>this.auth.challenge(packet));
    await this.requestL2(confirm,packet=>this.auth.confirm(packet));
    this.apps=await this.requestL2(this.auth.encode(wear(20,0)),packet=>appListResponse(packet,{includeFingerprint:true}));
    return this.apps;
  }
  async close() {
    this.closing=true;for(const cancel of [...this.waiters])cancel();
    if(this.child&&!this.exited) {
      this.child.stdin.end(JSON.stringify({type:'close'})+'\n');
      const end=Date.now()+3000;while(!this.exited&&Date.now()<end)await delay(10);
      if(!this.exited)this.child.kill('SIGTERM');
    }
    await this.factoryLease?.release();return !!this.socketClosed;
  }
}
