"""Start this project's unified AstroBox relay as a Termux background process."""
import argparse
from bridge_process import stop_project_node
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--allow-send', action='store_true')
parser.add_argument('--native-only', action='store_true', default=True, help='Default: use the native service and disable previous recorder controls')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
local = root / '.local'
local.mkdir(exist_ok=True, mode=0o700)
server = root / 'bridge/astro-server.mjs'
try:
    token=(local/'astro-plugin-token').read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:32179/status',headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(request,timeout=2) as response:
        status=json.load(response)
    pending=status.get('activeRequests',[r for r in status.get('requests',[]) if not r.get('settled')])
    if (status.get('busy') or pending or status.get('recording',{}).get('phase') in ['preparing','recording','receiving','transcribing'] or
        any((status.get(key) or {}).get('phase')=='pending' for key in ['nativeAudioCheck','nativeRecovery','fileProbe','nativeProbe'])):
        raise SystemExit('当前有未完成请求或录音，请完成后再重启项目桥接')
except (OSError,ValueError):
    pass
stop_project_node('bridge/astro-server.mjs')
with (local / 'astro-relay.log').open('ab') as output:
    command = [shutil.which('node'), str(server)] + (['--allow-send'] if args.allow_send else [])
    if args.native_only:
        command.append('--native-only')
    child = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
(local / 'astro-relay.pid').write_text(str(child.pid))
for _ in range(40):
    if child.poll() is not None:
        raise SystemExit('Astro relay exited; see .local/astro-relay.log')
    try:
        token = (local / 'astro-plugin-token').read_text().strip()
        request = urllib.request.Request('http://127.0.0.1:32179/status', headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=1) as response:
            if json.load(response).get('service') == 'band-codex':
                print('Unified Astro relay ready on loopback; send requires an explicit band action:', args.allow_send)
                break
    except (OSError, ValueError):
        pass
    time.sleep(.1)
else:
    raise SystemExit('Astro relay did not become ready; see .local/astro-relay.log')
