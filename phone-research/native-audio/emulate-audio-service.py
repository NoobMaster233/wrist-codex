"""OS-call model for one pinned ARM capture service. No real audio or device.

The main loader model runs the real insert/relocation instructions. This
adapter supplies explicit constructor/worker/callback scheduling interleavings.
"""
from collections import Counter
import json,struct
from unicorn.arm_const import UC_ARM_REG_SP,UC_ARM_REG_LR,UC_ARM_REG_PC,UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3

class AudioServiceModel:
    def __init__(self,mu,word,put,ret,get_state,scenario,stack,stop):
        self.mu=mu;self.word=word;self.put=put;self.ret=ret;self.get_state=get_state
        self.scenario=scenario;self.stack=stack;self.stop=stop
        self.files={};self.stream=None;self.mode=None;self.calls=Counter();self.events=[]
        self.worker=None;self.worker_context=None;self.constructor_context=None;self.startup=False
        self.callback=None;self.callback_context=None;self.callback_lengths=[];self.callback_return=0
        self.callback_calls=0;self.late_ignored=0;self.time_us=0xffff0000;self.audio_stage=0
        self.pending=None;self.idle_reached=False;self.worker_returned=False;self.open_count=0
        self.a='a'*32;self.b='b'*32
        self.queue=[('ping',self.a),('start',self.a)]
        if scenario=='repeat':self.queue += [('status',self.a),('stop',self.a),('start',self.a),('start',self.b),('stop',self.a),('stop',self.b),('start',self.a)]
        elif scenario=='cancel':self.queue += [('cancel',self.a)]
        elif scenario in ['overflow','quarantine']:self.queue += [('stop',self.a)]
        elif scenario not in ['busy','autostop','spawn-failure','startup-timeout']:raise ValueError('Unknown audio model scenario')

    def data(self):return self.word(self.get_state()+4)
    def capture(self):return self.data()+132
    def cstring(self,p,max_length=128):
        b=bytes(self.mu.mem_read(p,max_length));assert b'\0' in b;return b.split(b'\0')[0]
    def input(self,op,nonce):
        return struct.pack('<32s32s128s64s',b'bc.capture.req',b'dev.bandcodex.remote',
            json.dumps({'v':2,'op':op,'n':nonce},separators=(',',':')).encode(),b'dev.bandcodex.remote')
    def begin_callbacks(self,lengths,value):
        assert self.callback_context is None and self.callback is not None
        self.callback_context=self.mu.context_save();self.callback_lengths=list(lengths);self.callback_return=value
        self.next_callback()
    def next_callback(self):
        if not self.callback_lengths:
            self.mu.context_restore(self.callback_context);self.callback_context=None;self.ret(self.callback_return);return
        length=self.callback_lengths.pop(0);self.callback_calls+=1
        self.mu.mem_write(0x20019000,bytes((i*17+3)&255 for i in range(min(length,4096))))
        self.mu.reg_write(UC_ARM_REG_SP,self.stack-0x30000)
        self.mu.reg_write(UC_ARM_REG_R0,0x20019000);self.mu.reg_write(UC_ARM_REG_R1,length)
        self.mu.reg_write(UC_ARM_REG_LR,(self.stop+0x30)|1);self.mu.reg_write(UC_ARM_REG_PC,self.callback)

    def handle(self,address,a,b,c,d):
        u=self.mu
        if address==self.stop+0x30:
            assert u.reg_read(UC_ARM_REG_R0)==0
            if self.callback_context is not None:self.next_callback()
            else:self.worker_returned=True;u.emu_stop()
            return True
        if address==0x0c1eadcc:
            assert self.stream is None
            path=self.cstring(a);mode=self.cstring(b,4)
            assert path==b'/data/files/dev.bandcodex.remote/bc-native-audio-service-043-v1.status' or (
                path.startswith(b'/data/files/dev.bandcodex.remote/bc-audio-') and path.endswith(b'.bcap') and len(path)==79)
            self.calls['fopen_'+mode.decode()]+=1
            if mode==b'rb' and path not in self.files:self.ret(0);return True
            assert mode in [b'wb',b'rb'];self.stream=path;self.mode=mode
            if mode==b'wb':self.files[path]=bytearray()
            self.ret(0x20018000);return True
        if address==0x0c1eb54c:
            assert self.stream is not None and self.mode==b'wb' and b==1 and 0<c<=65536 and d==0x20018000
            self.files[self.stream]+=bytes(u.mem_read(a,c));self.calls['fwrite']+=1;self.ret(c);return True
        if address==0x0c1eaea0:
            assert self.stream is not None and a==0x20018000
            self.stream=None;self.calls['fclose']+=1;self.ret(0);return True
        if address==0x0c208b48:
            sp=u.reg_read(UC_ARM_REG_SP)
            assert self.cstring(a)==b'bc_audio043' and b==100 and c==0 and d==8192 and self.word(sp+4)==0
            self.worker=self.word(sp);assert self.worker==self.word(self.get_state())+1001
            self.calls['task_create']+=1;self.ret(-1 if self.scenario=='spawn-failure' else 321);return True
        if address==0x0c1f5d0c:
            assert a==10000 and self.worker is not None and self.worker_context is None
            self.calls['startup_yield']+=1
            if self.scenario=='startup-timeout':self.ret(0);return True
            self.constructor_context=u.context_save();self.startup=True
            u.reg_write(UC_ARM_REG_SP,self.stack-0x20000);u.reg_write(UC_ARM_REG_LR,(self.stop+0x30)|1)
            u.reg_write(UC_ARM_REG_R0,0);u.reg_write(UC_ARM_REG_R1,0);u.reg_write(UC_ARM_REG_PC,self.worker);return True
        if address==0x0c2e97ac:
            assert a==0x2cda393c and b==0
            if self.startup:
                # The actual worker has run its CAS and reached the subscribe
                # call. Suspend it, finish insert, then resume this context.
                self.worker_context=u.context_save();self.startup=False
                u.context_restore(self.constructor_context);self.constructor_context=None;self.ret(0);return True
            self.calls['subscribe']+=1;self.ret(7);return True
        if address==0x0c2e64ac:
            assert a==0x2cda393c
            e=[x.split(b'\0')[0].decode() for x in struct.unpack('<32s32s128s64s',u.mem_read(b,256))]
            assert e[0]=='bc.capture.evt' and e[1]=='dev.bandcodex.native' and e[3]=='dev.bandcodex.remote'
            event=json.loads(e[2]);assert event['v']==2 and event['n'] in [self.a,self.b]
            assert event['op'] in ['ready','recording','done','cancelled','error'] and isinstance(event['e'],int)
            self.events.append(event);self.calls['publish']+=1;self.ret(0);return True
        if address==0x0c2e987c:
            self.calls['clock']+=1;u.reg_write(UC_ARM_REG_R1,self.time_us>>32);self.ret(self.time_us&0xffffffff);return True
        if address==0x0c220a5c:
            self.calls['busy']+=1;self.ret(1 if self.scenario=='busy' or self.audio_stage else 0);return True
        if address==0x0c220a28:
            assert self.audio_stage==0 and [self.word(a),self.word(a+4)]==[0x3e800000,0x803]
            self.calls['configure']+=1;self.ret(0);return True
        if address==0x0c220a68:
            assert self.audio_stage==0 and a==1 and b&1 and c==16000 and d==20
            self.audio_stage=1;self.callback=b;self.open_count+=1;self.calls['open']+=1;self.ret(0);return True
        if address==0x0c220bb8:
            assert self.audio_stage==1 and a==1 and self.word(self.capture())==1
            self.audio_stage=2;self.put(0x200f7604,4321);self.calls['start']+=1;self.ret(0);return True
        if address==0x0c220b20:
            assert self.audio_stage==2 and a==1 and self.word(self.capture())==0
            before=self.word(self.capture()+8)
            self.audio_stage=0;self.calls['close']+=1;self.late_ignored+=1
            # A real ARM callback executes after deactivation. The final
            # container checks below also prove it added no packet bytes.
            self.begin_callbacks([80],0);self.last_close_used=before;return True
        if address==0x0c205910:
            assert a==4321;self.calls['task_exists']+=1
            assert self.word(self.capture()+8)==self.last_close_used
            self.ret(0x20007000 if self.scenario=='quarantine' else 0);return True
        if address==0x0c1d0d1c:
            assert b==1 and [self.word(a+i*4) for i in range(6)]==[7,1,0,0,0,0]
            recording=self.audio_stage==2
            assert c==(200 if recording else 0xffffffff)
            self.calls['poll']+=1
            if not self.queue and not recording:
                self.idle_reached=True;u.emu_stop();return True
            if self.queue:
                op,nonce=self.queue.pop(0);self.pending=self.input(op,nonce);self.put(a+8,1);value=1
            else:value=0
            if recording:
                self.time_us+=200000
                self.begin_callbacks([4096]*17 if self.scenario=='overflow' else [80]*3,value)
            else:self.ret(value)
            return True
        if address==0x0c2e97c4:
            assert a==7 and c==256 and self.pending is not None
            u.mem_write(b,self.pending);self.pending=None;self.calls['copy']+=1;self.ret(256);return True
        if address==0x0c2e9650:
            assert a==7;self.calls['unsubscribe']+=1;self.ret(0);return True
        return False

    def run_worker(self):
        u=self.mu
        if self.scenario=='spawn-failure':return
        if self.scenario=='startup-timeout':
            assert self.worker_context is None and self.word(self.data()+128)==2
            u.reg_write(UC_ARM_REG_SP,self.stack-0x20000);u.reg_write(UC_ARM_REG_LR,(self.stop+0x30)|1)
            u.reg_write(UC_ARM_REG_R0,0);u.reg_write(UC_ARM_REG_R1,0);u.reg_write(UC_ARM_REG_PC,self.worker)
        else:
            assert self.worker_context is not None and self.word(self.data()+128)==1
            u.context_restore(self.worker_context)
        u.emu_start(u.reg_read(UC_ARM_REG_PC)|1,self.stop+0x100,timeout=8000000,count=1000000)
        assert self.idle_reached or self.worker_returned,'Worker did not reach the modeled idle boundary'
        assert self.audio_stage==0 and self.stream is None and self.callback_context is None

    def report(self):
        status=bytes(self.files[b'/data/files/dev.bandcodex.remote/bc-native-audio-service-043-v1.status'])
        h=struct.unpack('<8s4I3i7I',status);assert h[0]==b'BCAP0432' and h[1:4]==(2,16000,20)
        audio={}
        for path,data in self.files.items():
            if not path.endswith(b'.bcap'):continue
            f=struct.unpack('<8s4I3i7I',data[:64]);assert f[5:8]==(0,0,0) and f[10]==0 and f[-1]==3
            position=64;frames=0
            while position<len(data):
                length=struct.unpack_from('<I',data,position)[0];assert length==80
                position+=4+length;frames+=1
            assert position==len(data) and frames==f[8] and len(data)==64+f[9]
            audio[path.decode().rsplit('/',1)[-1]]={'frames':frames,'bytes':f[9],'durationMs':f[4]}
        if self.scenario=='repeat':
            assert len(audio)==2 and self.open_count==2 and {a['frames'] for a in audio.values()}=={6}
            assert [e['e'] for e in self.events if e['op']=='error']==[26,24]
        elif self.scenario=='cancel':assert not audio and h[-1]==18 and self.calls['close']==1
        elif self.scenario=='autostop':assert len(audio)==1 and h[4]==24000 and self.calls['close']==1
        elif self.scenario=='busy':assert not audio and not self.open_count and any(e['e']==10 for e in self.events)
        elif self.scenario=='overflow':assert not audio and h[-1]==19 and h[8]==15 and h[10]==2
        elif self.scenario=='quarantine':assert not audio and h[-1]==17 and self.calls['task_exists']==1
        elif self.scenario in ['spawn-failure','startup-timeout']:assert not audio and h[-1]==20 and not self.open_count and not self.calls['subscribe']
        return {'scenario':self.scenario,'actualMicrophoneStarted':False,'realOsTaskStarted':False,
            'explicitSchedulingInterleavingOnly':True,'idleBoundaryReached':self.idle_reached,
            'lateStartupExited':self.scenario=='startup-timeout' and self.worker_returned,
            'finalStage':h[-1],'files':audio,'events':self.events,'callsMocked':dict(self.calls),
            'callbackInstructionsExecuted':self.callback_calls,'lateCallbacksIgnored':self.late_ignored,
            'micClosed':self.audio_stage==0,'clockCrossed32BitWrap':self.time_us>0xffffffff}
