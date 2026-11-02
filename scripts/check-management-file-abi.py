"""Execute .043 stdio/Lua wrappers with VFS/Lua internals stubbed, offline only."""
import argparse,hashlib,json,struct
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3,UC_ARM_REG_SP,UC_ARM_REG_LR,UC_ARM_REG_PC
p=argparse.ArgumentParser(description=__doc__);p.add_argument('ap',type=Path);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
ap=a.ap.read_bytes();assert hashlib.sha256(ap).hexdigest()=='519307675665e4866d722a8119a98589c397b614ac3294cb87bfc86de45756ec'
u=Uc(UC_ARCH_ARM,UC_MODE_THUMB);size=(len(ap)+4095)&~4095
for base in (0x0c0c0000,0x2c0c0000):u.mem_map(base,size);u.mem_write(base,ap)
u.mem_map(0x20000000,0x20000);u.mem_map(0x0e000000,4096)
registers=[UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3];stop=0x0e000000;calls=[]
def word(p):return struct.unpack('<I',u.mem_read(p,4))[0]
def hook(uc,address,size,data):
 args=[uc.reg_read(r)for r in registers];value=None
 if address==stop:uc.emu_stop();return
 if address==0x0c1eb1ac:
  calls.append({'function':'fseeko64','file':args[0],'low':args[2],'high':args[3],'whence':word(uc.reg_read(UC_ARM_REG_SP))});value=0
 elif address==0x0c1eb24c:uc.reg_write(UC_ARM_REG_R1,0);value=131075
 elif address==0x0c6cc2cc:value=0x20001000 if args[1]==1 else 0x20002000
 elif address==0x0c1d12e8:assert args[:2]==[0x20001000,0x20002000];calls.append({'function':'rename','argumentOrderVerified':True});value=0
 elif address==0x0c6cbfd0:assert args[1]==1;value=1
 elif address==0x0c1d2444:assert args[0]==0x20001000;calls.append({'function':'unlink','calledFromRemove':True});value=0
 if value is not None:uc.reg_write(UC_ARM_REG_R0,value);uc.reg_write(UC_ARM_REG_PC,uc.reg_read(UC_ARM_REG_LR))
u.hook_add(UC_HOOK_CODE,hook)
def call(entry,*args):
 for reg,arg in zip(registers,args):u.reg_write(reg,arg&0xffffffff)
 u.reg_write(UC_ARM_REG_SP,0x20018000);u.reg_write(UC_ARM_REG_LR,stop|1)
 u.emu_start(entry|1,stop+2,count=50000);assert u.reg_read(UC_ARM_REG_PC)==stop;return u.reg_read(UC_ARM_REG_R0)
for offset,whence in [(0,2),(4097,0),(1048576,0),(-7,1)]:
 assert call(0x0c1eb198,0x20003000,offset,whence)==0
 assert calls[-1]=={'function':'fseeko64','file':0x20003000,'low':offset&0xffffffff,'high':0xffffffff if offset<0 else 0,'whence':whence}
assert call(0x0c1eb240,0x20003000)==131075
assert call(0x0c6e8760,0x20004000)==1
assert call(0x0c1eabe0,0x20001000)==0
modes={}
for mode in ['rb','wb','ab','wbx']:
 u.mem_write(0x20005000,mode.encode()+b'\0');modes[mode]=call(0x0c1eac3c,0x20005000)
assert modes=={'rb':1,'wb':38,'ab':22,'wbx':46}
report={'passed':True,'offlineOnly':True,'firmware':'3.101.043','apSha256':hashlib.sha256(ap).hexdigest(),
 'realThumbWrappersExecuted':True,'actualVfsIoExecuted':False,'functions':{'fseek':'0x0c1eb199','ftell':'0x0c1eb241','rename':'0x0c1d12e9','unlink':'0x0c1d2445'},'calls':calls,'fopenModes':modes}
a.report.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
