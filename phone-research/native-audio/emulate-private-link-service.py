"""Native authenticated link ARM model; all files, peers and events synthetic."""
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import struct
import zlib
from unicorn.arm_const import UC_ARM_REG_SP,UC_ARM_REG_PC,UC_ARM_REG_R0

spec=importlib.util.spec_from_file_location('spp_base',Path(__file__).with_name('emulate-private-spp-probe.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
SCENARIOS=['normal','cleanup','lost-sent-event','duplicate-rx','wrong-auth','auth-timeout',
 'app-rx-timeout','bad-crc','missing-key','boot-write-failure','boot-verify-failure',
 'management','management-unauth']
D=base.DIRECTORY

def packet(kind,seq,body=b''):
 header=b'BCP1'+bytes([kind,0])+struct.pack('<HI',len(body),seq)
 return header+struct.pack('<I',zlib.crc32(body,zlib.crc32(header)))+body

class PrivateLinkServiceModel(base.PrivateSppProbeModel):
 def __init__(self,mu,word,put,ret,get_state,scenario,stack,stop,worker_offset):
  assert scenario in SCENARIOS
  super().__init__(mu,word,put,ret,get_state,'normal',stack,stop,worker_offset)
  self.scenario=scenario;self.key=bytes(range(32));self.files[D+b'bc-private-link-v1.key']=bytearray(self.key)
  if scenario=='missing-key':del self.files[D+b'bc-private-link-v1.key']
  self.events=[];self.published=[];self.wire=[];self.callback_kind='return';self.poll_descriptor=None
  self.status_address=None;self.connected_once=False;self.client_nonce=bytes(range(16));self.server_nonce=None
  self.rx_body=b'{"bc_command":"ping"}';self.tx_body=b'{"v":1,"id":"model","method":"projects.list","params":{}}'
  self.tx_id='0123456789abcdef';self.ready=False;self.completed=False;self.idle=False;self.early_return=False
  self.rx_deliveries=0;self.ack_count=0;self.sent_events=0;self.native_json_count=0;self.scratch=0x20080000
  self.management_cases=[];self.management_results=[];self.management_exec_publishes=0;self.management_index=0
  self.management_seq=0
 def management_request(self,op,name=b'',target=b'',offset=0,count=0,data=b'',flags=0):
  return b'BCM1'+bytes([op,flags,len(name),len(target)])+struct.pack('<II',offset,count)+name+target+data
 def start_management(self):
  part=b'bc-file-11111111-2222-4333-8444-555555555555.part';final=part[:-5]+b'.bin'
  id=b'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';cmd=b'pwd'
  command=b'BCSH0431'+struct.pack('<5I',1,3000,len(cmd),zlib.crc32(cmd),128)+cmd
  self.files[D+b'bc-file-'+id+b'.bin']=bytearray(command)
  r=self.management_request
  # expected response data, errno, whether to duplicate this exact wire ID
  self.management_cases=[
   (r(7),struct.pack('<I',127),0,False),
   (r(1,part),b'',2,False),
   (r(3,part,count=3,data=b'abc'),struct.pack('<I',3),0,False),
   (r(3,part,offset=3,count=4,data=b'defg',flags=1),struct.pack('<I',7),0,True),
   (r(2,part,offset=1,count=5),b'bcdef',0,False),
   (r(4,part,final),b'',0,False),
   (r(2,final,count=7),b'abcdefg',0,False),
   (r(3,final,count=1,data=b'x'),b'',22,False),
   (r(2,b'../outside',count=1),b'',22,False),
   (r(1,b'bc-private-link-v1.key'),b'',22,False),
   (r(2,final,count=4097),b'',22,False),
   (r(6,id),struct.pack('<I',1),0,True),
   (r(6,id),struct.pack('<I',2),0,False),
   (r(5,final),b'',0,False),
   (r(1,final),b'',2,False)]
  self.next_management()
 def next_management(self,duplicate=False):
  if self.management_index>=len(self.management_cases):self.completed=True;return
  request,_,_,_=self.management_cases[self.management_index]
  if not duplicate:self.management_seq+=1
  self.enqueue_bytes(packet(11,self.management_seq,request))
 def enqueue_bytes(self,data):
  pointer=self.scratch;self.scratch+=((len(data)+15)//16)*16+16
  assert self.scratch<0x20180000;self.mu.mem_write(pointer,data)
  self.enqueue(self.read_cb,[self.pipe_id,pointer,len(data)])
 def app_event(self,op,id=None):
  params=json.dumps({'v':1,'op':op,'id':id or self.tx_id},separators=(',',':')).encode()
  self.events.append(struct.pack('<32s32s128s64s',b'bc.link.req',b'dev.bandcodex.remote',params,b'dev.bandcodex.remote'))
 def proxy(self,state):
  self.mu.mem_write(0x2001a000,b'btspp-link0\0')
  self.enqueue(self.word(self.callbacks+12),[self.app,0x20019000,state,11,1,0x2001a000])
 def begin_callbacks(self):
  self.callback_resume=self.mu.context_save();self.next_callback()
 def next_callback(self):
  if self.queue:return super().next_callback()
  self.mu.context_restore(self.callback_resume);self.callback_resume=None
  if self.callback_kind=='poll':self.finish_poll()
  else:self.ret(0)
 def finish_poll(self):
  if self.events:self.put(self.poll_descriptor+8,1);self.ret(1);return
  if self.completed or self.connected_once and not self.pipe:
   self.idle=True;self.mu.emu_stop();return
  self.time+=1100000;self.put(self.poll_descriptor+8,0);self.ret(0)
 def peer_frame(self,data):
  assert data[:4]==b'BCP1' and not data[5] and len(data)==16+struct.unpack_from('<H',data,6)[0]
  assert struct.unpack_from('<I',data,12)[0]==zlib.crc32(data[16:],zlib.crc32(data[:12]))
  kind,seq,body=data[4],struct.unpack_from('<I',data,8)[0],data[16:];self.wire.append((kind,seq,len(body)))
  if kind==2:
   assert seq==0 and len(body)==48;self.server_nonce=body[:16]
   expected=hmac.new(self.key,b'BCP1/server'+self.client_nonce+self.server_nonce,hashlib.sha256).digest()
   assert body[16:]==expected,'Native server proof differs from Python HMAC'
   proof=hmac.new(self.key,b'BCP1/client'+self.client_nonce+self.server_nonce,hashlib.sha256).digest()
   if self.scenario=='wrong-auth':proof=bytes([proof[0]^1])+proof[1:]
   self.enqueue_bytes(packet(3,0,proof))
  elif kind==4:
   assert len(body)==12 and struct.unpack_from('<II',body,4) in [(1,32768),(2,32768)];self.ready=True
   if self.scenario=='management':assert struct.unpack_from('<I',body,4)[0]==2;self.start_management();return
   incoming=packet(5,1,self.rx_body)
   if self.scenario=='bad-crc':incoming=incoming[:-1]+bytes([incoming[-1]^1])
   self.enqueue_bytes(incoming)
  elif kind==6:
   assert seq==1 and not body;self.ack_count+=1
   if self.scenario=='duplicate-rx' and self.ack_count==1:self.enqueue_bytes(packet(5,1,self.rx_body))
   else:
    self.files[D+b'bc-link-tx-'+self.tx_id.encode()+b'.json']=bytearray(self.tx_body);self.app_event('tx')
  elif kind==5:
   assert seq==1 and body==self.tx_body;self.native_json_count+=1;self.enqueue_bytes(packet(6,seq))
  elif kind==8:
   assert seq==0 and len(body)==5 and body[:4]==b'BCLV' and body[4] in (0,1)
  elif kind==12:
   assert self.scenario=='management' and seq==self.management_seq
   request,expected,error,duplicate=self.management_cases[self.management_index]
   assert body[:4]==b'BCR1' and body[4]==request[4] and not any(body[5:8])
   assert struct.unpack_from('<I',body,8)[0]==error and body[12:]==expected
   self.management_results.append((request[4],error))
   if duplicate:
    self.management_cases[self.management_index]=(request,expected,error,False);self.next_management(duplicate=True)
   else:self.management_index+=1;self.next_management()
  else:raise AssertionError(('Unexpected native frame',kind,seq,len(body)))
 def handle(self,address,a,b,c,d):
  u=self.mu
  if address==self.stop+0x40 and self.startup and self.suspended is None:
   self.early_return=True;self.startup=False;u.context_restore(self.parent);self.ret(0);return True
  if address==0x0c1eadcc:
   assert self.stream is None;path,mode=self.text(a),self.text(b,8);assert path.startswith(D)
   assert mode in (b'rb',b'wb',b'ab',b'wbx')
   if mode==b'rb' and path not in self.files:self.put(0x20008000,2);self.ret(0);return True
   if mode==b'wbx' and path in self.files:self.put(0x20008000,17);self.ret(0);return True
   if mode in (b'wb',b'wbx'):self.files[path]=bytearray()
   if mode==b'ab' and path not in self.files:self.files[path]=bytearray()
   self.stream={'path':path,'offset':len(self.files[path])if mode==b'ab'else 0,'mode':mode};self.ret(0x20018000);return True
  if address==0x0c1eb198:
   assert self.stream and a==0x20018000 and c in (0,2)
   self.stream['offset']=(len(self.files[self.stream['path']])if c==2 else 0)+b;self.ret(0);return True
  if address==0x0c1eb240:
   assert self.stream and a==0x20018000;self.ret(self.stream['offset']);return True
  if address==0x0c1d12e8:
   old,new=self.text(a),self.text(b);assert old.startswith(D)and new.startswith(D)
   self.files[new]=self.files.pop(old);self.ret(0);return True
  if address==0x0c1d2444:
   path=self.text(a);assert path.startswith(D)
   if path not in self.files:self.put(0x20008000,2);self.ret(0xffffffff)
   else:del self.files[path];self.ret(0)
   return True
  if address==0x0c1eafd0:
   assert self.stream and b==1 and d==0x20018000
   data=bytes(self.files[self.stream['path']][self.stream['offset']:self.stream['offset']+c])
   u.mem_write(a,data);self.stream['offset']+=len(data);self.ret(len(data));return True
  if address==0x0c1eb54c:
   assert self.stream and b==1 and d==0x20018000
   path=self.stream['path'];data=bytes(u.mem_read(a,c))
   if path.endswith(b'.status'):assert c==72;self.status_address=a
   if path.endswith(b'.boot'):
    assert c==16
    if self.scenario=='boot-write-failure':self.ret(0);return True
    if self.scenario=='boot-verify-failure':data=data[:-1]+bytes([data[-1]^1])
   self.files[path]+=data;self.ret(c);return True
  if address==0x0c1eaea0:
   assert self.stream and a==0x20018000;self.stream=None;self.ret(0);return True
  if address==0x0c208b48:
   sp=u.reg_read(UC_ARM_REG_SP)
   assert self.text(a)==b'bc_link043' and [b,c,d]==[100,0,8192] and self.word(sp+4)==0
   self.worker=self.word(sp);assert self.worker==self.word(self.get_state())+self.worker_offset+1
   self.calls['create']+=1;self.ret(321);return True
  if address==0x0c3aa380:
   assert b==1 and self.text(c)==b'bc_link_io';self.loop=a;self.calls['loop_run']+=1;self.ret(0);return True
  if address==0x0c3b1434:
   assert a==self.instance and self.text(b)==b'bandcodex-link' and self.word(c)==16
   self.callbacks=c;self.calls['register']+=1;self.ret(self.app);return True
  if address==0x0c3b152c:
   assert [a,b,c]==[self.instance,self.app,11] and self.word(u.reg_read(UC_ARM_REG_SP))==1
   assert bytes(u.mem_read(d,20))==bytes.fromhex('10000000de983d6d9f22c7b8b84795255820ac4a')
   self.calls['start']+=1;self.ret(0);return True
  if address==0x0c2e97ac:
   assert a==0x2cda393c and b==0;self.calls['subscribe']+=1;self.ret(7);return True
  if address==0x0c2e9650:
   assert a==7;self.calls['unsubscribe']+=1;self.ret(0);return True
  if address==0x0c1d0d1c:
   assert b==1 and self.word(a)==7 and self.word(a+4)==1
   assert c in (1000,0xffffffff);self.poll_descriptor=a
   if not self.connected_once:
    self.connected_once=True;self.proxy(0)
   if self.queue:
    self.callback_kind='poll';self.begin_callbacks()
   else:self.finish_poll()
   return True
  if address==0x0c2e97c4:
   assert a==7 and c==256 and self.events;u.mem_write(b,self.events.pop(0));self.ret(256);return True
  if address==0x0c2e64ac:
   assert a==0x2cda393c
   raw=bytes(u.mem_read(b,256));name,pkg,params,permissions=[x.split(b'\0')[0] for x in struct.unpack('<32s32s128s64s',raw)]
   if name==b'bc.shell.req':
    assert self.scenario=='management' and (pkg,permissions)==(b'dev.bandcodex.remote',b'dev.bandcodex.remote')
    assert json.loads(params)=={'v':1,'op':'exec','id':'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}
    self.management_exec_publishes+=1;self.events.append(raw);self.ret(0);return True
   assert (name,pkg,permissions)==(b'bc.link.evt',b'dev.bandcodex.link',b'dev.bandcodex.remote')
   message=json.loads(params);self.published.append(message);self.events.append(raw)
   if message['op']=='rx':
    self.rx_deliveries+=1;path=D+b'bc-link-rx-'+message['id'].encode()+b'.json'
    assert bytes(self.files[path])==self.rx_body and message['b']==len(self.rx_body)
    if self.scenario!='app-rx-timeout':self.app_event('rxack',message['id'])
   if message['op']=='sent':
    self.sent_events+=1
    if self.scenario=='lost-sent-event' and self.sent_events==1:self.app_event('txstatus')
    elif self.scenario=='cleanup':self.enqueue_bytes(packet(10,2))
    else:self.completed=True
   self.ret(0);return True
  if address==0x0c3a9cac:
   assert a==self.loop and self.text(b)==b'btspp-link0';self.calls['pipe_connect']+=1
   self.pipe=True;self.enqueue(c,[self.pipe_id,0,d]);self.ret(self.pipe_id);return True
  if address==0x0c3a9a74:
   assert a==self.pipe_id and b==1024 and d==0;self.read_cb=c;self.calls['read_start']+=1
   if self.scenario=='management-unauth':self.enqueue_bytes(packet(11,1,self.management_request(7)))
   elif self.scenario!='auth-timeout':self.enqueue_bytes(packet(1,0,self.client_nonce))
   self.ret(0);return True
  if address==0x0c3a9bfc:
   assert a==self.pipe_id and 16<=c<=32784
   self.calls['write']+=1;self.enqueue(d,[self.pipe_id,b,0]);self.peer_frame(bytes(u.mem_read(b,c)));self.ret(0);return True
  if address==0x0c3aa474:
   self.calls['loop_exit']+=1;self.callback_kind='return'
   if self.queue:self.begin_callbacks()
   else:self.ret(0)
   return True
  return super().handle(address,a,b,c,d)
 def run_worker(self):
  if self.early_return:return
  assert self.suspended is not None
  self.mu.context_restore(self.suspended);self.calls['loop_init']+=1;self.ret(0)
  # Management covers seventeen replies (including duplicate wire IDs), not
  # the single UI message used by the original transport cases.
  self.mu.emu_start(self.mu.reg_read(UC_ARM_REG_PC)|1,self.stop+2,
   timeout=12000000 if self.scenario=='management'else 5000000,
   count=1400000 if self.scenario=='management'else 700000)
  assert self.idle or self.returned,{'error':'Native link did not reach idle/exit','scenario':self.scenario,
   'pc':hex(self.mu.reg_read(UC_ARM_REG_PC)),'ready':self.ready,'managementIndex':self.management_index,
   'managementResults':self.management_results,'wireTail':self.wire[-6:],'queuedCallbacks':len(self.queue)}
 def report(self):
  s=struct.unpack('<8sII3i11I',self.mu.mem_read(self.status_address,72))
  assert s[0]==b'BCLN0431' and s[1] in (1,2) and s[14]==0
  if self.scenario in ('normal','lost-sent-event','duplicate-rx','cleanup'):
   assert self.ready and self.rx_deliveries==1 and self.native_json_count==1 and self.sent_events>=1
   assert self.ack_count==(2 if self.scenario=='duplicate-rx' else 1)
   assert self.sent_events==(2 if self.scenario=='lost-sent-event' else 1)
  if self.scenario=='cleanup':assert self.returned and s[2]==7 and self.calls['unregister']==1 and self.calls['bt_delete']==1 and self.calls['loop_exit']==1
  if self.scenario in ('wrong-auth','auth-timeout','app-rx-timeout','bad-crc'):assert not self.pipe and not s[6] and self.native_json_count==0
  if self.scenario=='missing-key':assert s[2]==110 and not self.calls['bt_create']
  if self.scenario.startswith('boot-'):assert s[2]==116 and not self.calls['bt_create']
  if self.scenario=='management':
   assert s[1]==2 and self.management_index==15 and len(self.management_results)==17
   assert self.management_exec_publishes==1 and self.rx_deliveries==0 and self.native_json_count==0
   assert bytes(self.files[D+b'bc-shell-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mgmt'])==bytes(self.files[D+b'bc-file-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin'])
  if self.scenario=='management-unauth':assert not self.ready and not self.pipe and self.management_exec_publishes==0
  return {'scenario':self.scenario,'finalPhase':s[2],'authenticated':bool(s[6]),'nativeServerProofMatchesPythonHmac':self.server_nonce is not None,
   'appRxDeliveries':self.rx_deliveries,'wireJsonTransmissions':self.native_json_count,'sentEvents':self.sent_events,
   'wireAckCount':self.ack_count,'pendingWrites':s[14],'protocolErrors':s[12],'authFailures':s[13],
   'callsMocked':dict(self.calls),'workerMachineCodeExecuted':True,'actualBluetoothStarted':False,'actualOsTasksStarted':False,
   'nativeManagementResults':self.management_results,'nativeShellPublishes':self.management_exec_publishes}
