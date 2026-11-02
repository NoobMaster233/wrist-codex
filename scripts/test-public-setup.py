"""Exercise identity and bundle generation in a temporary synthetic checkout."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='wrist-codex-setup-') as temporary:
    work = Path(temporary)
    for folder in ['resources/native', 'device-probe', 'test']:
        shutil.copytree(root / folder, work / folder)
    (work / 'scripts').mkdir()
    for name in ['configure-device.py', 'prepare-private-link.py', 'build-service-bundle.py', 'lua_face.py']:
        shutil.copy2(root / 'scripts' / name, work / 'scripts' / name)
    supplied = work / 'private-input.json'
    supplied.write_text(json.dumps({'authKeyHex': '01' * 16}))
    supplied.chmod(0o600)
    command = [sys.executable, str(work / 'scripts/configure-device.py'),
               '--address', '02:00:00:00:00:01', '--auth-file', str(supplied)]
    first = subprocess.run(command, capture_output=True, text=True, check=True)
    key_path = work / '.local/private-link-v1.key'
    key = key_path.read_bytes()
    assert len(key) == 32 and not key_path.stat().st_mode & 0o077
    subprocess.run(command, capture_output=True, text=True, check=True)
    assert key_path.read_bytes() == key
    supplied.write_text(json.dumps({'authKeyHex': '02' * 16}))
    refused = subprocess.run(command, capture_output=True, text=True)
    assert refused.returncode != 0 and key_path.read_bytes() == key
    assert key.hex() not in first.stdout
    manifest = json.loads((work / 'resources/native/3.101.043/manifest.json').read_text())
    build = [sys.executable, str(work / 'scripts/build-service-bundle.py')]
    for index, kind in enumerate(['audio', 'shell', 'link', 'key'], 1):
        content = key if kind == 'key' else (work / manifest['modules'][kind]['artifact']).read_bytes()
        receipt = work / '.local' / (kind + '-receipt.json')
        identity = '00000000-0000-4000-8000-' + str(index).zfill(12)
        receipt.write_text(json.dumps({'state': 'complete', 'size': len(content),
                          'sha256': hashlib.sha256(content).hexdigest(),
                          'uri': 'internal://files/bc-file-' + identity + '.bin'}))
        build += ['--' + kind + '-receipt', str(receipt)]
    subprocess.run(build, check=True)
    out = work / 'artifacts/research/private-service-recovery-043-v2-compact'
    for p in out.iterdir():
        if p.is_file():
            data = p.read_bytes()
            assert key not in data and key.hex().encode() not in data
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir()}
    refused = subprocess.run(build, capture_output=True, text=True)
    assert refused.returncode != 0
    assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir()}
print('Public setup: identity reuse, overwrite refusal, private permissions, receipt binding, both Lua models and no embedded key passed')
