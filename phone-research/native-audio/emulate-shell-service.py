"""Run the pinned executor's ARM code with explicit in-memory OS/task stubs.

No real NSH, files, radio, microphone, or band is used. File-action ABI is
audited separately against actual .043 wrappers; here its effects are modeled.
"""
from collections import Counter
import json
import struct
import zlib
from unicorn.arm_const import UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_R0, UC_ARM_REG_R1

DIRECTORY=b'/data/files/dev.bandcodex.remote/'
SCENARIOS=['normal','create-failure','selftest-attribute-failure','selftest-actions-failure',
 'selftest-spawn-failure','selftest-mismatch','selftest-read-failure','intent-unknown',
 'receipt-running','receipt-unreaped','intent-verify-failure','receipt-write-failure',
 'request-wait-error','request-kill-failure','request-output-read-failure','request-invalid-crc']

class ShellServiceModel:
 def __init__(self,mu,word,put,ret,get_state,scenario,stack,stop,worker_offset):
  assert scenario in SCENARIOS
  self.mu=mu;self.word=word;self.put=put;self.ret=ret;self.get_state=get_state
  self.scenario=scenario;self.stack=stack;self.stop=stop;self.worker_offset=worker_offset
  self.files={};self.stream=None;self.calls=Counter();self.jobs={};self.commands=[]
  self.worker=None;self.parent=None;self.suspended=None;self.startup=False;self.returned=False
  self.time=0xffff0000;self.kills=[];self.actions={};self.events=[];self.pending=None;self.published=[];self.idle=False
  self.ids=['00000000-0000-4000-8000-%012d'%i for i in range(1,5)]
  def event(op,id,package='dev.bandcodex.remote'):
   return struct.pack('<32s32s128s64s',b'bc.shell.req',package.encode(),
    json.dumps({'v':1,'op':op,'id':id},separators=(',',':')).encode(),b'dev.bandcodex.remote')
  commands=['echo shell-model','false','sleep 2','echo many-bytes']
  for id,command in zip(self.ids,commands):
   body=command.encode();timeout=250 if command=='sleep 2' else 3000
   self.files[DIRECTORY+b'bc-file-'+id.encode()+b'.bin']=bytearray(
    struct.pack('<8s5I',b'BCSH0431',1,timeout,len(body),zlib.crc32(body),128)+body)
  if scenario=='normal':
   self.events=[event('exec',self.ids[0],'other.app'),event('ping',self.ids[0]),
    event('exec',self.ids[0]),event('exec',self.ids[0])]+[event('exec',id) for id in self.ids[1:]]
  else:
   id=self.ids[2] if scenario=='request-kill-failure' else self.ids[0]
   self.events=[event('exec',id),event('exec',id),event('exec',self.ids[1])]
  if scenario in ['intent-unknown','receipt-running','receipt-unreaped']:
   self.files[self.path(self.ids[0],b'.intent')]=bytearray(b'old intent')
   if scenario!='intent-unknown':
    phase=1 if scenario=='receipt-running' else 2
    self.files[self.path(self.ids[0],b'.status')]=bytearray(struct.pack('<8sII4i9I',
     b'BCSR0431',1,phase,500,0,0,0,0,0,0,0,3000,0,0,0,0)[:64])
  if scenario=='request-invalid-crc':self.files[DIRECTORY+b'bc-file-'+self.ids[0].encode()+b'.bin'][-1]^=1
 def path(self,id,suffix):return DIRECTORY+b'bc-shell-'+id.encode()+suffix
 def text(self,address,limit=1200):
  data=bytes(self.mu.mem_read(address,limit));assert b'\0' in data;return data.split(b'\0')[0]
 def status(self,id):
  b=self.files[self.path(id,b'.status')];assert len(b)==64
  return struct.unpack('<8sII4i8I',b)
 def handle(self,address,a,b,c,d):
  u=self.mu;selftest=not self.calls['subscribe']
  if address==self.stop+0x40:self.returned=True;u.emu_stop();return True
  if address==0x0c1eadcc:
   assert self.stream is None
   path,mode=self.text(a),self.text(b,8);assert path.startswith(DIRECTORY) and mode in (b'rb',b'wb',b'wbx')
   if (mode==b'rb' and path not in self.files) or (mode==b'wbx' and path in self.files):self.ret(0);return True
   if mode!=b'rb':self.files[path]=bytearray()
   self.stream={'path':path,'offset':0,'mode':mode};self.ret(0x20018000);return True
  if address==0x0c1eb54c:
   assert self.stream and b==1 and d==0x20018000
   path=self.stream['path'];data=bytes(u.mem_read(a,c))
   if self.scenario=='receipt-write-failure' and path.endswith(b'.status') and b'selftest' not in path:
    self.ret(0);return True
   if self.scenario=='intent-verify-failure' and path.endswith(b'.intent'):data=bytes([data[0]^1])+data[1:]
   self.files[path]+=data;self.ret(c);return True
  if address==0x0c1eafd0:
   assert self.stream and b==1 and d==0x20018000
   path=self.stream['path'];offset=self.stream['offset']
   failure=(self.scenario=='selftest-read-failure' and b'selftest' in path and path.endswith(b'.out')) or (
    self.scenario=='request-output-read-failure' and b'selftest' not in path and path.endswith(b'.out'))
   if failure:self.put(0x20008000,5);self.ret(0);return True
   data=bytes(self.files[path][offset:offset+c]);u.mem_write(a,data);self.stream['offset']+=len(data);self.ret(len(data));return True
  if address==0x0c1eaea0:
   assert self.stream and a==0x20018000;self.stream=None;self.ret(0);return True
  if address==0x0c208b48:
   sp=u.reg_read(UC_ARM_REG_SP)
   assert self.text(a)==b'bc_shell043' and [b,c,d]==[100,0,8192] and self.word(sp+4)==0
   self.worker=self.word(sp);assert self.worker==self.word(self.get_state())+self.worker_offset+1
   self.calls['create']+=1;self.ret(-1 if self.scenario=='create-failure' else 321);return True
  if address==0x0c1f5d0c:
   assert a==10000
   if self.parent is None and self.suspended is None:
    self.parent=u.context_save();self.startup=True
    u.reg_write(UC_ARM_REG_SP,self.stack-0x20000);u.reg_write(UC_ARM_REG_LR,(self.stop+0x40)|1)
    u.reg_write(UC_ARM_REG_R0,0);u.reg_write(UC_ARM_REG_R1,0);u.reg_write(UC_ARM_REG_PC,self.worker)
   else:self.time+=a;self.ret(0)
   return True
  if address==0x0c2e987c:self.ret(self.time&0xffffffff);u.reg_write(UC_ARM_REG_R1,self.time>>32);return True
  if address==0x0c1ea724:
   if self.startup:
    self.suspended=u.context_save();self.startup=False;u.context_restore(self.parent);self.ret(0);return True
   self.calls['attr_init']+=1
   if selftest and self.scenario=='selftest-attribute-failure':self.ret(12);return True
   u.mem_write(a,b'\0'*20);self.ret(0);return True
  if address==0x0c1ea7a0:assert self.word(b)==100;u.mem_write(a+1,b'\x64');self.ret(0);return True
  if address==0x0c1ea7c4:assert b==8192;self.put(a+12,b);self.ret(0);return True
  if address==0x0c1ea780:assert b==4;u.mem_write(a,b'\x04');self.ret(0);return True
  if address==0x0c1ea7e0:self.calls['attr_destroy']+=1;self.ret(0);return True
  if address==0x0c1ea710:
   assert not any(not j['reaped'] for j in self.jobs.values()),'Reused live child storage'
   self.actions={'pointer':a};self.put(a,0x2001a000);self.ret(0);return True
  if address==0x0c1ea67c:
   assert a==self.actions['pointer'] and b==1 and d==38 and self.word(u.reg_read(UC_ARM_REG_SP))==0o600
   if selftest and self.scenario=='selftest-actions-failure':self.ret(12);return True
   self.actions['output']=self.text(c);self.ret(0);return True
  if address==0x0c1ea63c:assert [a,b,c]==[self.actions['pointer'],1,2];self.actions['dup']=True;self.ret(0);return True
  if address==0x0c1ea6e4:
   assert a==self.actions['pointer'] and all(j['reaped'] for j in self.jobs.values()),'Destroyed file actions before reap'
   self.calls['actions_destroy']+=1;self.put(a,0);self.ret(0);return True
  if address==0x0c209770:
   sp=u.reg_read(UC_ARM_REG_SP);args=self.word(sp)
   assert self.text(a)==b'bc_shell_cmd043' and b==0x0c2390e1 and c==self.actions['pointer'] and self.word(sp+4)==0
   assert bytes(u.mem_read(d,2))==bytes([4,100]) and self.word(d+12)==8192
   assert self.text(self.word(args))==b'-c' and self.word(args+8)==0 and self.actions['dup']
   command=self.text(self.word(args+4));self.commands.append(command.decode());self.calls['spawn_calls']+=1
   if selftest and self.scenario=='selftest-spawn-failure':self.put(0x20008000,12);self.ret(-1);return True
   output={b'echo bc-shell-fd-v1':b'bc-shell-fd-v1\n',b'echo shell-model':b'shell-model\n',
    b'false':b'',b'sleep 2':b'',b'echo many-bytes':b'x'*300}[command]
   if selftest and self.scenario=='selftest-mismatch':output=b'wrong\n'
   self.files[self.actions['output']]=bytearray(output);pid=400+len(self.jobs)
   self.jobs[pid]={'doneAt':self.time+(2000000 if command==b'sleep 2' else 0),'status':65280 if command==b'false' else 0,'reaped':False}
   self.ret(pid);return True
  if address==0x0c2063c4:
   assert a in self.jobs and c==2 and not self.jobs[a]['reaped'];self.calls['wait']+=1
   if not selftest and self.scenario=='request-wait-error':self.put(0x20008000,10);self.ret(-1);return True
   job=self.jobs[a]
   if self.time<job['doneAt']:self.ret(0);return True
   self.put(b,job['status']);job['reaped']=True;self.ret(a);return True
  if address==0x0c207a48:
   assert a>=2 and a in self.jobs and not self.jobs[a]['reaped'] and a not in self.kills and b==9
   self.kills.append(a)
   if self.scenario=='request-kill-failure':self.put(0x20008000,1);self.ret(-1);return True
   self.jobs[a]['doneAt']=self.time;self.jobs[a]['status']=0;self.ret(0);return True
  if address==0x0c2e97ac:
   assert a==0x2cda393c and b==0;self.calls['subscribe']+=1;self.ret(7);return True
  if address==0x0c1d0d1c:
   assert [b,c]==[1,0xffffffff] and [self.word(a+4*i) for i in range(6)]==[7,1,0,0,0,0]
   if not self.events:self.idle=True;u.emu_stop();return True
   self.pending=self.events.pop(0);self.put(a+8,1);self.ret(1);return True
  if address==0x0c2e97c4:
   assert a==7 and c==256 and self.pending;u.mem_write(b,self.pending);self.pending=None;self.ret(256);return True
  if address==0x0c2e64ac:
   assert a==0x2cda393c
   name,pkg,data,permissions=[v.split(b'\0')[0] for v in struct.unpack('<32s32s128s64s',u.mem_read(b,256))]
   assert (name,pkg,permissions)==(b'bc.shell.evt',b'dev.bandcodex.shell',b'dev.bandcodex.remote')
   self.published.append(json.loads(data));self.ret(0);return True
  return False
 def run_worker(self):
  if self.scenario=='create-failure':return
  assert self.suspended is not None;self.mu.context_restore(self.suspended)
  self.mu.emu_start(self.mu.reg_read(UC_ARM_REG_PC)|1,self.stop+0x100,timeout=12000000,count=1500000)
  assert (self.returned or self.idle) and self.stream is None,'Worker failed to reach idle or a terminal selftest error'
 def report(self):
  service=bytes(self.files[DIRECTORY+b'bc-nsh-shell-v1.service']).decode()
  if self.scenario=='create-failure':assert service=='worker-create-failed\n' and not self.commands
  elif self.scenario.startswith('selftest-'):
   assert service=='selftest-failed\n' and not self.calls['subscribe'] and not self.published
  else:
   assert service=='ready:shell043-v1\n' and self.idle and self.calls['subscribe']==1
   assert self.commands[0]=='echo bc-shell-fd-v1'
   if self.scenario=='normal':
    assert self.commands==['echo bc-shell-fd-v1','echo shell-model','false','sleep 2','echo many-bytes']
    assert len(self.published)==6 and self.published[0]['op']=='pong'
    assert self.published[2]['f']==128 and self.published[2]['b']==12
    assert self.published[3]['r']==65280
    assert self.published[4]['f']==1 and self.published[4]['r']==0
    assert self.published[5]['f']==10 and self.published[5]['b']==128
    assert len(self.files[self.path(self.ids[3],b'.out')])==128
   elif self.scenario in ['intent-unknown','receipt-running','receipt-unreaped']:
    assert len(self.commands)==1 and all(p['op']=='unknown' for p in self.published)
   elif self.scenario in ['request-wait-error','request-kill-failure']:
    assert len(self.commands)==2 and all(p['op']=='unknown' for p in self.published)
    assert self.calls['actions_destroy']==1,'Uncertain child resources must remain alive'
   elif self.scenario=='receipt-write-failure':assert len(self.commands)==1 and self.published[1]['op']=='unknown'
   elif self.scenario in ['intent-verify-failure','request-invalid-crc']:
    assert 'echo shell-model' not in self.commands
   elif self.scenario=='request-output-read-failure':
    assert self.published[0]['f']==32 and self.published[1]['f']==160 and self.commands.count('echo shell-model')==1
  return {'scenario':self.scenario,'serviceState':service.strip(),'idlePollBlocks':self.idle,
   'commandsModeled':self.commands,'published':self.published,'killPids':self.kills,
   'unreapedPids':[pid for pid,j in self.jobs.items() if not j['reaped']],
   'callsMocked':dict(self.calls),'clockCrossed32BitWrap':self.time>0xffffffff,
   'actualNshExecuted':False,'actualOsProcessesStarted':False,'actualDeviceCommandsExecuted':False,
   'fileActionsAreStubs':True,'explicitSchedulingInterleavingOnly':True}
