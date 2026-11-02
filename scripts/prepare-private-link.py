"""Prepare phone-private link material without printing it or deploying."""
import json
import os
from pathlib import Path
import re
import time

root=Path(__file__).resolve().parents[1];local=root/'.local'
local.mkdir(exist_ok=True, mode=0o700)
factory=json.loads((local/'direct-bluetooth-auth.json').read_text())
address=factory['bandAddress']
if not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}',address) or factory.get('firmware')!='3.101.043':
 raise SystemExit('Run configure-device.py with your own device first')
config=local/'private-link-auth.json';keyfile=local/'private-link-v1.key'
if config.exists():
 if config.stat().st_mode&0o077:raise SystemExit('Existing private configuration permissions differ')
 saved=json.loads(config.read_text())
 if saved.get('bandAddress')!=address or saved.get('firmware')!='3.101.043' or saved.get('uuid')!='4aac2058-2595-47b8-b8c7-229f6d3d98de' or not re.fullmatch('[0-9a-f]{64}',saved.get('keyHex','')):
  raise SystemExit('Existing configuration belongs to a different target')
 key=bytes.fromhex(saved['keyHex'])
else:
 key=os.urandom(32)
 saved={'bandAddress':address,'firmware':'3.101.043','uuid':'4aac2058-2595-47b8-b8c7-229f6d3d98de',
        'keyHex':key.hex(),'createdAtMs':int(time.time()*1000)}
 with open(config,'x',opener=lambda p,flags:os.open(p,flags,0o600)) as out:json.dump(saved,out);out.write('\n')
if keyfile.exists():
 if keyfile.read_bytes()!=key or keyfile.stat().st_mode&0o077:raise SystemExit('Existing key file differs')
else:
 with open(keyfile,'xb',opener=lambda p,flags:os.open(p,flags,0o600)) as out:out.write(key)
print(json.dumps({'prepared':True,'bytes':32,'configuration':str(config.relative_to(root)),'secretsPrinted':False,'deviceOperations':False}))
