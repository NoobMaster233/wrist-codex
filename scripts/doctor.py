"""Read-only prerequisites and local configuration check. Does not start any service."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--adb', action='store_true', help='Check only the explicitly selected ADB transport')
args = parser.parse_args()
checks = {}
for command in ['node', 'npm', 'python', 'adb', 'openssl', 'flock']:
    checks[command] = shutil.which(command) is not None
for name in ['direct-bluetooth-auth.json', 'private-link-auth.json', 'private-link-v1.key']:
    path = root / '.local' / name
    checks[name] = path.is_file() and not (path.stat().st_mode & 0o077)
socket = Path(os.environ.get('BAND_CODEX_SOCKET', str(Path.home() / '.codex/app-server-control-termux/app-server-control.sock')))
checks['codexSocket'] = socket.exists() and stat.S_ISSOCK(socket.stat().st_mode)
for name in ['private-bluetooth-pipe-v1', 'termux-bluetooth-pipe-v10']:
    checks[name] = (root / 'artifacts/research' / name / 'manifest.json').is_file()
if args.adb and checks['adb']:
    try:
        result = subprocess.run(['adb', '-s', os.environ.get('BAND_ADB_SERIAL', '127.0.0.1:5555'), 'get-state'],
                                capture_output=True, text=True, timeout=8)
        checks['selectedAdbOnline'] = result.returncode == 0 and result.stdout.strip() == 'device'
    except subprocess.TimeoutExpired:
        checks['selectedAdbOnline'] = False
print(json.dumps({'ready': all(checks.values()), 'checks': checks, 'secretsPrinted': False,
                  'note': 'Factory authentication material and firmware compatibility require owner verification.'}, indent=2))
raise SystemExit(0 if all(checks.values()) else 1)
