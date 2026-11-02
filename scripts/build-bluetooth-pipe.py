"""Build the phone-local Shell Bluetooth byte pipe; never connect or deploy."""
from pathlib import Path
import hashlib
import json
import subprocess
import argparse

root = Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--version',choices=['10'],default='10');args=p.parse_args()
out = root / ('artifacts/research/termux-bluetooth-pipe-v'+args.version)
out.mkdir(mode=0o700, exist_ok=False)
sources = [root / 'phone/termux-bt' / name for name in ['BluetoothPipe.java','BlePipe.java']]
for source in sources:(out / source.name).write_bytes(source.read_bytes())
classes, dex = out / 'classes', out / 'dex'
classes.mkdir(); dex.mkdir()
subprocess.run(['javac', '--release', '8', '-cp', str(root / '.cache/vendor/android.jar'),
                '-d', str(classes), *[str(out / source.name) for source in sources]], check=True)
subprocess.run(['jar', 'cf', str(out / 'classes.jar'), '-C', str(classes), '.'], check=True)
subprocess.run(['java', '-cp', str(root / '.cache/vendor/r8.jar'), 'com.android.tools.r8.D8',
                '--lib', str(root / '.cache/vendor/android.jar'), '--min-api', '26', '--output',
                str(dex), str(out / 'classes.jar')], check=True)
artifact = out / ('band-bluetooth-pipe-v'+args.version+'.jar')
subprocess.run(['jar', 'cf', str(artifact), '-C', str(dex), 'classes.dex'], check=True)
manifest = {'artifact': str(artifact.relative_to(root)), 'bytes': artifact.stat().st_size,
            'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(),
            'sourceFiles': {source.name:hashlib.sha256(source.read_bytes()).hexdigest() for source in sources},
            'connectAttemptTimeoutSeconds': 6, 'connectionAttemptsMax': 2, 'diagnosticLifetimeSeconds': 300,
            'serviceMode': 'Explicit --service: lifetime ends on owned stdin EOF or close command',
            'scanInvoked': False, 'pairingInvoked': False, 'systemSettingsChanged': False}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
