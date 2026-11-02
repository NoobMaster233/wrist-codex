"""Check the pinned .043 key lookup using synthetic records only.

No device access or real key retrieval. This is not a callable deployment.
The firmware's logging helper is replaced; it must not be called on real keys.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_PC, UC_ARM_REG_SP, UC_ARM_REG_LR

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('ap',type=Path);p.add_argument('--output',type=Path,required=True)
a=p.parse_args();ap=a.ap.read_bytes()
assert hashlib.sha256(ap).hexdigest()=='519307675665e4866d722a8119a98589c397b614ac3294cb87bfc86de45756ec'
base,stride,count=0x201394d8,0x38,7
results=[]
for scenario,target in [('first',0),('middle',3),('last',6),('empty-prefix',6),('absent',None)]:
 u=Uc(UC_ARCH_ARM,UC_MODE_THUMB);size=(len(ap)+4095)&~4095
 for address in [0x0c0c0000,0x2c0c0000]:u.mem_map(address,size);u.mem_write(address,ap)
 u.mem_map(0x20000000,0x200000);u.mem_map(0x08000000,4096)
 records=bytearray(stride*count);identifiers=[];keys=[]
 for n in range(count):
  name=('synthetic-client-%015d'%n).encode();assert len(name)<=32
  key=hashlib.sha256(b'synthetic-model-key-'+bytes([n])).digest()[:16]
  records[n*stride:n*stride+len(name)]=name
  records[n*stride+0x21:n*stride+0x31]=key
  struct.pack_into('<I',records,n*stride+0x34,n+1)
  identifiers.append(name);keys.append(key)
 if scenario=='empty-prefix':records[:6*stride]=b'\0'*(6*stride)
 u.mem_write(base,bytes(records));request,output,stop=0x20010000,0x20011000,0x08000000
 u.mem_write(request,(identifiers[target] if target is not None else b'synthetic-absent')+b'\0')
 u.mem_write(output,b'\xcc'*32);copies=[];record_writes=[];returned=[False]
 def text(address):
  data=bytes(u.mem_read(address,33));assert b'\0' in data;return data.split(b'\0',1)[0]
 def hook(mu,address,size,data):
  if address==stop:returned[0]=True;mu.emu_stop();return
  if address==0x0c7ddadc:result=0  # Logging helper; never call on real key material.
  elif address==0x0c589518:
   left,right=mu.reg_read(UC_ARM_REG_R0),mu.reg_read(UC_ARM_REG_R1)
   result=0 if text(left)==text(right) else 1
  elif address==0x0c588db0:
   dest,src=mu.reg_read(UC_ARM_REG_R0),mu.reg_read(UC_ARM_REG_R1)
   from unicorn.arm_const import UC_ARM_REG_R2
   n=mu.reg_read(UC_ARM_REG_R2);assert dest==output and n==16
   assert base+0x21<=src<base+stride*count and (src-base-0x21)%stride==0
   copies.append((src-base-0x21)//stride);mu.mem_write(dest,bytes(mu.mem_read(src,n)));result=dest
  else:return
  mu.reg_write(UC_ARM_REG_R0,result);mu.reg_write(UC_ARM_REG_PC,mu.reg_read(UC_ARM_REG_LR))
 def writes(mu,access,address,size,value,data):
  if address<base+len(records) and address+size>base:record_writes.append(address)
 u.hook_add(UC_HOOK_CODE,hook);u.hook_add(UC_HOOK_MEM_WRITE,writes)
 u.reg_write(UC_ARM_REG_R0,request);u.reg_write(UC_ARM_REG_R1,output)
 u.reg_write(UC_ARM_REG_SP,0x20100000);u.reg_write(UC_ARM_REG_LR,stop|1)
 u.emu_start(0x0c7ddfd1,stop+2,count=5000)
 rc=u.reg_read(UC_ARM_REG_R0);actual=bytes(u.mem_read(output,32))
 assert returned[0] and not record_writes and bytes(u.mem_read(base,len(records)))==bytes(records)
 if target is None:assert rc==2 and not copies and actual==b'\xcc'*32
 else:assert rc==0 and copies==[target] and actual==keys[target]+b'\xcc'*16
 results.append({'scenario':scenario,'result':rc,'matchedSyntheticSlot':target,'recordWrites':0,'copiedBytes':16 if target is not None else 0})
report={'firmware':'3.101.043','sourceApSha256':hashlib.sha256(ap).hexdigest(),
 'mode':'actual ARM getter with synthetic RAM and logging/strcmp/memcpy stubs',
 'getter':'0x0c7ddfd0','recordBase':'0x201394d8','recordBytes':56,'recordCount':7,
 'identifierBytesMax':32,'keyOffset':33,'keyBytes':16,'sequenceOffset':52,
 'scenarios':results,'actualDeviceAccess':False,'actualKeysRead':False,'actualAuthenticationVerified':False,
 'limitations':['Key lifetime and live record population are not established.',
 'Logging helper is stubbed; do not invoke the firmware getter on actual secrets.',
 'Any later private device read must stay on the owned phone and must never enter public artifacts or research-host inputs.']}
with a.output.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
print('Five synthetic ARM lookup scenarios passed; no actual device keys read.')
