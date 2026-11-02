"""Model the .043 publisher's subscription guard using its actual ARM code."""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_LR,UC_ARM_REG_SP,UC_ARM_REG_PC
p=argparse.ArgumentParser(description=__doc__);p.add_argument('ap',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
ap=a.ap.read_bytes();sha=hashlib.sha256(ap).hexdigest();assert sha=='519307675665e4866d722a8119a98589c397b614ac3294cb87bfc86de45756ec'
results=[]
for name in ['bc.shell.req','bc.capture.req']:
 for registered in [False,True]:
  u=Uc(UC_ARCH_ARM,UC_MODE_THUMB);size=(len(ap)+4095)&~4095
  for base in [0x0c0c0000,0x2c0c0000]:u.mem_map(base,size);u.mem_write(base,ap)
  u.mem_map(0x20000000,0x100000);u.mem_map(0x0e000000,4096)
  stop=0x0e000000;stack=0x20080000;logs=[];state={'returned':False,'reachedAllocation':False,'publishCalls':0}
  u.mem_write(0x20001000,name.encode()+b'\0');u.mem_write(0x20002000,struct.pack('<II',0x20001000,0))
  u.mem_write(stack,struct.pack('<I',0x20002000))
  def hook(mu,address,size,data):
   result=None
   if address==stop:state['returned']=True;mu.emu_stop();return
   if address in [0x0c890fac,0x0c861e20,0x0c88f7f0]:result=0
   elif address==0x0c861e44:result=1
   elif address==0x0c8908ac:result=int(registered)
   elif address==0x0c88e7a8:logs.append(mu.reg_read(UC_ARM_REG_R1));result=0
   elif address==0x0c861c58:state['reachedAllocation']=True;mu.emu_stop();return
   elif address==0x0c861ecc:result=0x20003000
   elif address==0x0c588980:
    from unicorn.arm_const import UC_ARM_REG_R2
    ptr=mu.reg_read(UC_ARM_REG_R0);mu.mem_write(ptr,b'\0'*mu.reg_read(UC_ARM_REG_R2));result=ptr
   elif address==0x0c2e64ac:state['publishCalls']+=1;raise AssertionError('Do not model a real uORB publication')
   if result is not None:mu.reg_write(UC_ARM_REG_R0,result);mu.reg_write(UC_ARM_REG_PC,mu.reg_read(UC_ARM_REG_LR))
  u.hook_add(UC_HOOK_CODE,hook);u.reg_write(UC_ARM_REG_SP,stack);u.reg_write(UC_ARM_REG_LR,stop|1);u.reg_write(UC_ARM_REG_R0,0x20004000)
  u.emu_start(0x0c88e86d,stop+2,count=5000)
  if registered:assert state['reachedAllocation'] and not state['returned']
  else:assert state['returned'] and not state['reachedAllocation'] and logs==[0x2cc94998]
  assert state['publishCalls']==0
  results.append({'name':name,'registered':registered,**state})
report={'apSha256':sha,'offlineOnly':True,'publisher':'0x0c88e86c','eventRegistryLookup':'0x0c8908ac',
 'diagnosticAddress':'0x2cc94998','diagnostic':'event %s is not subscribed before, publish fail',
 'cases':results,'realDeviceCommandsExecuted':False,'realUorbUsed':False,
 'limitations':['Registry lookup and feature context are stubs.','Registered case stops before allocation; no complete publish is modeled.']}
a.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
