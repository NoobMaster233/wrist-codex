"""Check public source paths, credential markers and pinned native binaries."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
result = subprocess.run(['git', 'ls-files', '--stage', '-z'], cwd=root, capture_output=True)
indexed = result.returncode == 0 and bool(result.stdout)
index_modes = {}
if indexed:
    for record in result.stdout.split(b'\0'):
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        mode, _, stage = metadata.split()
        if stage != b'0':
            raise SystemExit('Resolve the Git index conflicts before publication checks')
        index_modes[name.decode()] = mode
    files = [root / name for name in index_modes]
else:
    files = [p for p in root.rglob('*') if p.is_file() and
             not set(p.relative_to(root).parts) & {'.git', '.local', '.cache', 'node_modules', 'artifacts', '__pycache__', 'dist', 'build', 'sign'}]
def public_bytes(path):
    if indexed:
        data = subprocess.run(['git', 'show', ':' + path.relative_to(root).as_posix()],
                              cwd=root, capture_output=True, check=True).stdout
        return data
    return path.read_bytes()

manifest = json.loads(public_bytes(root / 'resources/native/3.101.043/manifest.json'))
native = {m['artifact']: m for m in manifest['modules'].values()}
failures = []
patterns = [
    ('private-key', re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')),
    ('github-credential', re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})')),
    ('openai-credential', re.compile(rb'sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{36,}')),
    ('jwt', re.compile(rb'eyJ[A-Za-z0-9_-]{30,}\.eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{30,}')),
]
for path in files:
    relative = path.relative_to(root).as_posix()
    if (indexed and index_modes[relative] not in {b'100644', b'100755'}) or (not indexed and path.is_symlink()):
        failures.append({'file': relative, 'reason': 'non-regular Git object or symlink requires review'}); continue
    name = path.name.lower()
    private_name = (name == '.env' or (name.startswith('.env.') and name != '.env.example') or
                    name == 'auth.json' or
                    (name.endswith('.json') and any(marker in name for marker in ['credentials', 'auth-key', 'authkey'])) or
                    re.search(r'\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$', name))
    if (set(Path(relative).parts) & {'.local', '.cache', 'sign', 'node_modules', 'artifacts'} or
        private_name or path.suffix.lower() in {'.pem', '.key', '.pk8', '.p12', '.jks', '.keystore',
            '.wav', '.ogg', '.opus', '.mp3', '.m4a', '.aac', '.flac', '.pcm', '.webm',
            '.sqlite', '.db', '.rpk', '.apk', '.abp', '.face', '.zip', '.gz'}):
        failures.append({'file': relative, 'reason': 'private or generated path'})
    data = public_bytes(path)
    for label, pattern in patterns:
        if pattern.search(data):
            failures.append({'file': relative, 'reason': label})
    if relative in native:
        spec = native[relative]
        if len(data) != spec['bytes'] or hashlib.sha256(data).hexdigest() != spec['sha256']:
            failures.append({'file': relative, 'reason': 'native binary differs'})
    if path.suffix in {'.js', '.mjs', '.py', '.java', '.json', '.md', '.lua', '.in', '.yml'}:
        for address in re.findall(rb'(?<![A-Za-z0-9])(?:[0-9A-F]{2}:){5}[0-9A-F]{2}(?![A-Za-z0-9])', data, re.IGNORECASE):
            address = address.upper()
            if address != b'AA:BB:CC:DD:EE:FF' and not address.startswith(b'02:00:00:00:00:'):
                failures.append({'file': relative, 'reason': 'literal non-example Bluetooth address'})
        if re.search(rb'192\.168\.[0-9]{1,3}\.[0-9]{1,3}', data):
            failures.append({'file': relative, 'reason': 'private LAN target'})
print(json.dumps({'passed': not failures, 'filesChecked': len(files), 'findings': failures}, indent=2))
raise SystemExit(1 if failures else 0)
