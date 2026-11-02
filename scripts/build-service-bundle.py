"""Build per-device first-install and recovery faces from verified transfer receipts."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
from lua_face import pack_lua_face

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
for kind in ['audio', 'shell', 'link', 'key']:
    parser.add_argument('--' + kind + '-receipt', type=Path, required=True)
args = parser.parse_args()
out = root / 'artifacts/research/private-service-recovery-043-v2-compact'
if out.exists():
    raise SystemExit('Preserve existing deployment bundle and load-intent markers')
native = json.loads((root / 'resources/native/3.101.043/manifest.json').read_text())
paths, data = {}, {}
for kind in ['audio', 'shell', 'link', 'key']:
    receipt = json.loads(getattr(args, kind + '_receipt').read_text())
    content = ((root / '.local/private-link-v1.key').read_bytes() if kind == 'key' else
               (root / native['modules'][kind]['artifact']).read_bytes())
    uri = receipt.get('uri', '')
    if (receipt.get('state') != 'complete' or receipt.get('size') != len(content) or
        receipt.get('sha256') != hashlib.sha256(content).hexdigest() or
        not re.fullmatch(r'internal://files/bc-file-[0-9a-f-]{36}\.bin', uri)):
        raise SystemExit('Incomplete or mismatched ' + kind + ' upload receipt')
    if kind != 'key' and hashlib.sha256(content).hexdigest() != native['modules'][kind]['sha256']:
        raise SystemExit('Verified module differs: ' + kind)
    paths[kind] = '/data/files/dev.bandcodex.remote/' + uri.rsplit('/', 1)[1]
    data[kind] = content
if len(set(paths.values())) != 4:
    raise SystemExit('Each uploaded object needs a distinct verified receipt')
template = (root / 'device-probe/private-service-recovery-043.lua.in').read_text()
template = template.replace('@REV@', '2').replace('@LINK_STATUS_VERSION@', '2')
template = template.replace('@ALLOW_LINK_MIGRATION@', 'false')
template = template.replace('@LINK_STATE@', '/data/bc-private-link-bootstrap-043-v2.state')
template = template.replace('bytes=unhex(', 'bytes=unbase64(')
decoder = """local function unbase64(s)
 local a='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
 local v={};for i=1,64 do v[a:sub(i,i)]=i-1 end
 assert(#s%4==0,'invalid encoded module')
 return(s:gsub('....',function(p)
  local x,y,z,w=p:sub(1,1),p:sub(2,2),p:sub(3,3),p:sub(4,4)
  local n=assert(v[x])*262144+assert(v[y])*4096+(v[z]or 0)*64+(v[w]or 0)
  return string.char(math.floor(n/65536)%256)..(z=='='and''or string.char(math.floor(n/256)%256))..(w=='='and''or string.char(n%256))
 end))
end
"""
template = template.replace('local definitions={', decoder + 'local definitions={')
for kind in ['audio', 'shell', 'link']:
    for suffix, value in [('PATH', paths[kind]), ('SHA', hashlib.sha256(data[kind]).hexdigest()),
                          ('HEX', base64.b64encode(data[kind]).decode())]:
        template = template.replace('@' + kind.upper() + '_' + suffix + '@', value)
if re.search(r'@[A-Z_]+@', template):
    raise SystemExit('Unresolved loader parameter')
out.mkdir(parents=True, mode=0o700)
for first in [False, True]:
    script = template
    if first:
        script = script.replace("prior==good or migrate,'prior load uncertain; no retry'",
                                "prior==nil or prior==good or migrate,'prior load uncertain; no retry'")
        # Provision only from an already uploaded private file. No key bytes are embedded.
        provision = (" local key_source=assert(read('" + paths['key'] + "',33),'staged private key missing')\n"
                     " assert(#key_source==32,'staged private key length differs')\n"
                     " local key_target='/data/files/dev.bandcodex.remote/bc-private-link-v1.key'\n"
                     " local existing=read(key_target,33)\n"
                     " if existing then assert(existing==key_source,'preserve existing key') else write(key_target,key_source)end\n")
        script = script.replace(" assert(#(read('/data/files/dev.bandcodex.remote/bc-private-link-v1.key',33)", provision + " assert(#(read('/data/files/dev.bandcodex.remote/bc-private-link-v1.key',33)")
    identifier, name = ('219667887', 'Codex First Setup') if first else ('219667880', 'Codex Recovery')
    stem = 'first-install' if first else 'recovery'
    lua = out / (stem + '.lua'); lua.write_text(script)
    subprocess.run(['luac', '-p', str(lua)], check=True)
    subprocess.run(['lua', str(root / 'test/private-service-recovery.lua'), str(lua),
                    *[str(root / native['modules'][k]['artifact']) for k in ['audio', 'shell', 'link']]], check=True)
    face = out / (stem + '.face')
    face.write_bytes(pack_lua_face(script.encode(), identifier, name, width=84, height=120))
manifest = {'firmware': '3.101.043', 'watchfaceId': '219667880', 'linkStatusVersion': 2,
            'firstInstallWatchfaceId': '219667887', 'modulePaths': paths,
            'artifact': str((out / 'recovery.face').relative_to(root)),
            'firstInstall': str((out / 'first-install.face').relative_to(root)),
            'firstInstallHardwareRevalidated': False, 'recoveryModelsPassed': True,
            'nativeUnload': False, 'microphoneOnLoad': False, 'reboot': False,
            'secretsEmbedded': False}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'built': True, 'output': str(out.relative_to(root)), 'deviceOperations': False,
                  'firstInstallHardwareRevalidated': False, 'secretsEmbedded': False}))
