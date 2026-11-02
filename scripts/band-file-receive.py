"""Receive one existing private RPK file over Bluetooth and verify its saved SHA256."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--name',required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--wait',type=int,default=180)
p.add_argument('--shell-owner',help='Read-only evidence for this unknown Shell request')
args=p.parse_args()
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}',args.name):p.error('Expected a private file basename')
if args.output.exists():p.error('Output already exists; choose a new file')
headers={'Authorization':'Bearer '+(root/'.local/astro-plugin-token').read_text().strip(),'Content-Type':'application/json'}
def request(path,body=None):
    req=urllib.request.Request('http://127.0.0.1:32179'+path,headers=headers,
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
job=request('/files/receive',{'name':args.name,'chunkBytes':1024,**({'shellOwner':args.shell_owner} if args.shell_owner else {})})
print(json.dumps(job,ensure_ascii=False),flush=True)
if not re.fullmatch(r'upload-[a-f0-9-]{36}',job.get('id','')):raise SystemExit('Unexpected upload id')
deadline=time.monotonic()+max(args.wait,0)
last=None
while time.monotonic()<deadline:
    job=request('/files/receive/status?id='+urllib.parse.quote(job['id']))
    stage=(job['phase'],(job.get('received') or {}).get('bytes',0)//4096)
    if stage!=last:print(json.dumps(job,ensure_ascii=False),flush=True);last=stage
    if job['phase']=='error':raise SystemExit(2)
    if job['phase']=='complete':
        data=(root/'.local/native-files'/(job['id']+'.bin')).read_bytes()
        if len(data)!=job['size'] or hashlib.sha256(data).hexdigest()!=job['sha256']:raise SystemExit('Saved file differs from Bluetooth receipt')
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('xb') as output:output.write(data)
        args.output.chmod(0o600)
        print(json.dumps({'output':str(args.output),'size':len(data),'sha256':job['sha256']},ensure_ascii=False))
        raise SystemExit(0)
    time.sleep(1)
raise SystemExit('Still pending; inspect /files/receive/status before retrying')
