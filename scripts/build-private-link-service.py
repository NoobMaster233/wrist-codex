"""Build the authenticated native App transport; no keys or device operations."""
import argparse
import json
from pathlib import Path
from native_rel_build import build

root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--revision',type=int,default=4);a=p.parse_args()
if not 1<=a.revision<=99:p.error('Revision must be 1..99')
stem='private-link-service-043-v'+str(a.revision);out=root/'artifacts/research'/stem
directory=root/'phone-research/native-audio'
names=['private-link-service-043.c','private-link-wire.c','private-link-wire.h','private-spp-043.h','event-wire.h',
 'management-043.c','management-043.h','shell-wire.c','shell-wire.h','rel-module-043.ld']
m=build(root,out,stem,[directory/n for n in names],100000)
m.update(firmware='3.101.043',uuid='4aac2058-2595-47b8-b8c7-229f6d3d98de',scn=11,
 moduleName='bc_link043',statusBasename='bc-private-link-v1.status',statusBytes=72,keyBytes=32,
 keyPath='/data/files/dev.bandcodex.remote/bc-private-link-v1.key',bootCounterBasename='bc-private-link-v1.boot',
 acceptsNativeShellCommands=True,managementProtocol=1,linkProtocol=2,fileLimit=1048576,
 managementRequiresApp=False,microphone=False,phoneSystemSettingsChanged=False,
 maxPayload=32768,mutualAuthentication='HMAC-SHA256',keyEmbedded=False,deviceCommandsExecuted=False)
(out/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
print(json.dumps({k:m[k] for k in ['artifact','bytes','sha256','constructorOffset','workerOffset']}))
