"""Execute pinned libc file-action/stdio wrappers with OS allocation/I/O stubbed.

Run on the research host with Unicorn. No band or real task is touched.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3,UC_ARM_REG_SP,UC_ARM_REG_LR,UC_ARM_REG_PC

p=argparse.ArgumentParser(description=__doc__);p.add_argument('ap',type=Path);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
ap=a.ap.read_bytes();sha=hashlib.sha256(ap).hexdigest()
assert sha=='519307675665e4866d722a8119a98589c397b614ac3294cb87bfc86de45756ec'
u=Uc(UC_ARCH_ARM,UC_MODE_THUMB);size=(len(ap)+4095)&~4095
for base in (0x0c0c0000,0x2c0c0000):u.mem_map(base,size);u.mem_write(base,ap)
u.mem_map(0x20000000,0x200000);u.mem_map(0x0e000000,4096)
regs=[UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]
stop=0x0e000000;stack=0x20080000;next_heap=0x200a0000;allocs=[];freed=[];io=[]
def words(ptr,n):return struct.unpack('<'+'I'*n,u.mem_read(ptr,4*n))
def string(ptr):
 b=bytearray()
 for i in range(512):
  c=u.mem_read(ptr+i,1)[0]
  if not c:return bytes(b)
  b.append(c)
 raise AssertionError('unterminated string')
def hook(uc,address,size,data):
 global next_heap
 args=[uc.reg_read(r) for r in regs];result=None
 if address==stop:uc.emu_stop();return
 if address==0x0c1e4180:raise AssertionError('firmware assertion')
 if address==0x0c1f90bc:
  result=next_heap;next_heap+=(args[0]+7)&~7;allocs.append((result,args[0]))
 elif address==0x0c1f8ff8:freed.append(args[0]);result=0
 elif address==0x0c5885b0:result=len(string(args[0]))
 elif address==0x0c1f0ab8:u.mem_write(args[0],bytes(u.mem_read(args[1],args[2])));result=args[0]
 elif address in (0x0c1ebc68,0x0c1ebc74):result=0
 elif address==0x0c1eb008:io.append(args[:3]);result=min(args[1],6)
 elif address==0x0c1e45bc:result=0x20009000
 if result is not None:uc.reg_write(UC_ARM_REG_R0,result);uc.reg_write(UC_ARM_REG_PC,uc.reg_read(UC_ARM_REG_LR))
u.hook_add(UC_HOOK_CODE,hook)
def call(entry,*args,stack_args=()):
 for reg,arg in zip(regs,args):u.reg_write(reg,arg)
 u.reg_write(UC_ARM_REG_SP,stack);u.reg_write(UC_ARM_REG_LR,stop|1)
 if stack_args:u.mem_write(stack,struct.pack('<'+'I'*len(stack_args),*stack_args))
 u.emu_start(entry|1,stop+2,count=20000)
 assert u.reg_read(UC_ARM_REG_PC)==stop
 return u.reg_read(UC_ARM_REG_R0)
modes={}
for mode in ('rb','wb','wx','wbx'):
 u.mem_write(0x20001000,mode.encode()+b'\0');modes[mode]=call(0x0c1eac3c,0x20001000)
assert modes=={'rb':1,'wb':38,'wx':302,'wbx':46},modes
actions=0x20002000;path=0x20003000;output=b'/data/files/dev.bandcodex.remote/bc-shell-model.out'
u.mem_write(path,output+b'\0')
assert call(0x0c1ea710,actions)==0 and words(actions,1)==(0,)
assert call(0x0c1ea67c,actions,1,path,modes['wb'],stack_args=(0o600,))==0
first=words(actions,1)[0]
assert u.mem_read(first+4,1)==b'\x03'
assert words(first+8,3)==(1,38,0o600) and string(first+20)==output
assert call(0x0c1ea63c,actions,1,2)==0
second=words(first,1)[0]
assert second and words(second,1)==(0,) and u.mem_read(second+4,1)==b'\x02' and words(second+8,2)==(1,2)
assert call(0x0c1eafd0,0x20004000,2,4,0x20005000)==3
assert io==[[0x20004000,8,0x20005000]]
assert call(0x0c1ea6e4,actions)==0 and words(actions,1)==(0,)
assert freed==[first,second] and len(allocs)==2
report={'firmware':'3.101.043','apSha256':sha,'offlineOnly':True,'realDeviceCommandsExecuted':False,
 'execution':'real Thumb libc wrappers; allocation, copying, locks and inner stdio read stubbed',
 'modeFlags':modes,'fileActionObjectBytes':4,
 'functions':{'init':'0x0c1ea710','addOpen':'0x0c1ea67c','addDup2':'0x0c1ea63c','destroy':'0x0c1ea6e4','fread':'0x0c1eafd0','fopenModeParser':'0x0c1eac3c'},
 'openAction':{'type':3,'fd':1,'flags':38,'mode':384,'pathCopied':True},
 'dupAction':{'type':2,'sourceFd':1,'destinationFd':2},'bothNodesReleased':True,
 'freadSizeCountForwardingVerified':True,'exclusiveWriteModeAvailable':True,
 'liveFileActionsVerified':False,'spawnFileActionsLifetimeVerified':False,
 'limitations':['No real fd redirection or task spawn ran.','The actual task_spawn lifetime and live stdio path still need validation.']}
a.report.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
