"""Import the owner's factory auth from a private JSON file; never print keys."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--address', required=True, help='Your own bonded band Bluetooth address')
parser.add_argument('--auth-file', required=True, type=Path, help='Private JSON containing authKeyHex, not a command-line key')
args = parser.parse_args()
address = args.address.upper()
if not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address):
    parser.error('Expected a Bluetooth address')
if args.auth_file.stat().st_mode & 0o077:
    parser.error('Auth input must have permission 600')
try:
    supplied = json.loads(args.auth_file.read_text())
    key = supplied['authKeyHex']
    assert re.fullmatch(r'[0-9a-fA-F]{32}', key)
    assert supplied.get('bandAddress', address).upper() == address
except (ValueError, KeyError, TypeError, AssertionError):
    parser.error('Expected your own 16-byte authKeyHex and matching optional bandAddress')
local = ROOT / '.local'
local.mkdir(mode=0o700, exist_ok=True)
configuration = {'bandAddress': address, 'firmware': '3.101.043', 'authKeyHex': key.lower()}
path = local / 'direct-bluetooth-auth.json'
if path.exists():
    if path.stat().st_mode & 0o077 or json.loads(path.read_text()) != configuration:
        raise SystemExit('Existing identity differs; preserve it and inspect before changing devices')
else:
    with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump(configuration, output); output.write('\n')
subprocess.run([sys.executable, str(ROOT / 'scripts/prepare-private-link.py')], check=True)
mode = local / 'direct-transport.json'
if not mode.exists():
    with open(mode, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump({'version': 1, 'transport': 'spp'}, output); output.write('\n')
print(json.dumps({'configured': True, 'firmware': '3.101.043', 'secretValuesPrinted': False,
                  'deviceOperations': False, 'initialTransport': 'factory-spp'}))
