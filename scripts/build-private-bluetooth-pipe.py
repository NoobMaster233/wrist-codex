"""Build only the dedicated UUID byte pipe; production v10 is preserved."""
from pathlib import Path
import hashlib
import json
import subprocess

root=Path(__file__).resolve().parents[1]
out=root/'artifacts/research/private-bluetooth-pipe-v1'
out.mkdir(mode=0o700,exist_ok=False)
sources=[root/'phone/termux-bt'/n for n in ['OwnedBandContext.java','PrivateBluetoothPipe.java']]
for source in sources:(out/source.name).write_bytes(source.read_bytes())
classes,dex=out/'classes',out/'dex';classes.mkdir();dex.mkdir()
subprocess.run(['javac','--release','8','-Xlint:-options','-cp',str(root/'.cache/vendor/android.jar'),
 '-d',str(classes),*[str(out/source.name) for source in sources]],check=True)
subprocess.run(['jar','cf',str(out/'classes.jar'),'-C',str(classes),'.'],check=True)
subprocess.run(['java','-cp',str(root/'.cache/vendor/r8.jar'),'com.android.tools.r8.D8','--lib',
 str(root/'.cache/vendor/android.jar'),'--min-api','26','--output',str(dex),str(out/'classes.jar')],check=True)
artifact=out/'private-bluetooth-pipe-v1.jar'
subprocess.run(['jar','cf',str(artifact),'-C',str(dex),'classes.dex'],check=True)
m={'artifact':str(artifact.relative_to(root)),'bytes':artifact.stat().st_size,
 'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),
 'sources':{s.name:hashlib.sha256(s.read_bytes()).hexdigest() for s in sources},
 'uuid':'4aac2058-2595-47b8-b8c7-229f6d3d98de','protocol':2,'secureRfcomm':True,
 'connectTimeoutSeconds':6,'diagnosticLifetimeSeconds':180,'factoryUuidAllowed':False,
 'pairingInvoked':False,'systemSettingsChanged':False}
(out/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
print(json.dumps(m))
