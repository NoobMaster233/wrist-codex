"""Offline ARM GNU builder: local tools only; no SSH, deployment, or firmware copy."""
import base64,hashlib,json,os,shutil,struct,subprocess,tempfile
from pathlib import Path

def build(root,out,stem,sources,memory_limit,aliases=None,object_names=None):
 if out.exists():raise SystemExit('Preserve existing native build; choose a fresh output')
 inputs={(aliases or {}).get(p.name,p.name):p.read_bytes() for p in sources}
 assert len(inputs)==len(sources) and 'rel-module-043.ld' in inputs
 prefix=os.environ.get('ARM_NONE_EABI_PREFIX','arm-none-eabi-')
 tools={name:shutil.which(prefix+name) for name in ['gcc','ld','readelf','objdump']}
 if not all(tools.values()):raise SystemExit('Install gcc-arm-none-eabi and binutils-arm-none-eabi, or set ARM_NONE_EABI_PREFIX')
 objects=[(object_names or {}).get(name,name[:-2]+'.o') for name in inputs if name.endswith('.c')]
 flags=[tools['gcc'],'-std=c11','-mcpu=cortex-m3','-mthumb','-mfloat-abi=soft','-Os','-ffreestanding','-fno-builtin','-fno-unwind-tables','-fno-asynchronous-unwind-tables','-ffunction-sections','-fdata-sections','-fvisibility=hidden','-Wall','-Wextra','-Werror','-c']
 commands=[flags+[name,'-o',(object_names or {}).get(name,name[:-2]+'.o')] for name in inputs if name.endswith('.c')]
 commands.append([tools['ld'],'-r','-T','rel-module-043.ld','--entry=bc_event043_anchor','--build-id=none',*objects,'-o',stem+'.ko'])
 with tempfile.TemporaryDirectory(prefix='wrist-codex-native-') as temporary:
  work=Path(temporary)
  for name,data in inputs.items():(work/name).write_bytes(data)
  for command in commands:subprocess.run(command,cwd=work,check=True,timeout=60)
  (work/'build-command.json').write_text(json.dumps(commands,indent=2)+'\n')
  (work/'elf-report.txt').write_bytes(subprocess.check_output([tools['readelf'],'-hSWrs',stem+'.ko'],cwd=work))
  (work/'disassembly.txt').write_bytes(subprocess.check_output([tools['objdump'],'-dr',stem+'.ko'],cwd=work))
  outputs={name:(work/name).read_bytes() for name in [stem+'.ko','elf-report.txt','disassembly.txt','build-command.json']}
 binary=outputs[stem+'.ko']
 assert binary[:6]==b'\x7fELF\x01\x01' and struct.unpack_from('<HH',binary,16)==(1,40)
 offset=struct.unpack_from('<I',binary,32)[0];stride,count,ni=struct.unpack_from('<HHH',binary,46);assert stride==40
 sections=[struct.unpack_from('<10I',binary,offset+stride*i) for i in range(count)]
 s=sections[ni];names=binary[s[4]:s[4]+s[5]];summary=[];symbols={};ctors=0
 for index,s in enumerate(sections):
  name=names[s[0]:].split(b'\0')[0].decode()
  summary.append({'index':index,'name':name,'type':s[1],'flags':s[2],'bytes':s[5],'alignment':s[8]})
  assert s[1] not in (4,6,15,16) and not(s[2]&1 and s[2]&4)
  if s[2]&2:assert s[8]>0
  if s[1]==14:assert name=='.init_array' and s[5]==4;ctors+=1
  if s[1]==9:
   assert s[9]==8
   for at in range(0,s[5],8):assert struct.unpack_from('<II',binary,s[4]+at)[1]&255 in (2,10,30)
  if s[1]==2:
   table=sections[s[6]];table=binary[table[4]:table[4]+table[5]]
   for at in range(16,s[5],16):
    no,value,size,info,other,si=struct.unpack_from('<IIIBBH',binary,s[4]+at)
    assert si!=0,'Undefined symbol: '+table[no:].split(b'\0')[0].decode()
    name=table[no:].split(b'\0')[0].decode()
    if name:symbols[name]={'value':value,'bytes':size,'section':si}
 assert ctors==1 and 'worker' in symbols and 'bc_event043_ctor' in symbols
 assert sum(s['bytes'] for s in summary if s['flags']&2)<memory_limit
 out.mkdir(mode=0o700,parents=True)
 for name,data in outputs.items():(out/name).write_bytes(data)
 for name,data in inputs.items():(out/name).write_bytes(data)
 return {'artifact':str((out/(stem+'.ko')).relative_to(root)),'bytes':len(binary),'sha256':hashlib.sha256(binary).hexdigest(),
  'elfType':'ET_REL','imports':0,'initializers':1,'finalizers':0,'symbols':symbols,'sections':summary,
  'constructorOffset':symbols['bc_event043_ctor']['value']&~1,'workerOffset':symbols['worker']['value']&~1,
  'sources':{name:hashlib.sha256(data).hexdigest() for name,data in inputs.items()},'deviceTested':False}
