"""Run NSH on the band through the paired App; never Android/Termux Shell."""
import argparse
import base64
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('command',nargs='?',help='One quoted NSH command string, executed on the band')
p.add_argument('--timeout-ms',type=int,default=3000)
p.add_argument('--output-limit',type=int,default=8192)
p.add_argument('--wait',type=int,default=180)
p.add_argument('--status',metavar='UUID',help='Observe an existing job without executing again')
p.add_argument('--reconcile',metavar='UUID',help='Only read an unknown job receipt/output; never re-execute')
p.add_argument('--close-unknown',metavar='UUID',help='Retain an unknown result and release the phone queue; never claim success or rerun')
p.add_argument('--reason',help='Required explanation for --close-unknown')
p.add_argument('--list',action='store_true')
p.add_argument('--output',type=Path,help='Write exact output bytes to a new local file')
a=p.parse_args()
if sum([a.command is not None,a.status is not None,a.reconcile is not None,a.close_unknown is not None,a.list])!=1:p.error('Choose command, --status, --reconcile, --close-unknown or --list')
if a.close_unknown and not a.reason:p.error('--close-unknown requires --reason')
if a.output and a.output.exists():p.error('Output already exists')
for id in [a.status,a.reconcile,a.close_unknown]:
 if id and not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',id):p.error('Invalid request UUID')
headers={'Authorization':'Bearer '+(root/'.local/astro-plugin-token').read_text().strip(),'Content-Type':'application/json'}
def request(path,body=None):
 req=urllib.request.Request('http://127.0.0.1:32179'+path,headers=headers,data=None if body is None else json.dumps(body).encode())
 try:
  with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)
 except urllib.error.HTTPError as error:
  try:message=json.load(error).get('error','Request failed')
  except Exception:message='Request failed'
  raise SystemExit(message)
if a.list:
 print(json.dumps(request('/shell/status'),ensure_ascii=False,indent=2));raise SystemExit(0)
if a.close_unknown:
 result=request('/shell/close-unknown',{'id':a.close_unknown,'reason':a.reason,'confirm':'preserve-unknown'})
 print(json.dumps(result,ensure_ascii=False));raise SystemExit(0)
if a.command is not None:job=request('/shell',{'command':a.command,'timeoutMs':a.timeout_ms,'outputLimit':a.output_limit})
elif a.reconcile:job=request('/shell/reconcile',{'id':a.reconcile})
else:job=request('/shell/status?id='+a.status)
identifier=job['id'];print('Band NSH request:',identifier,file=sys.stderr,flush=True)
deadline=time.monotonic()+max(a.wait,0);last=None
while True:
 phase=job['phase']
 if phase!=last:print('Band NSH:',phase,file=sys.stderr,flush=True);last=phase
 if phase in ['complete','failed','unknown']:break
 if time.monotonic()>=deadline:raise SystemExit('Still pending. Inspect --status '+identifier+'; do not resend the command.')
 time.sleep(1);job=request('/shell/status?id='+identifier)
if job['phase']!='complete':raise SystemExit(job.get('error','Unknown band command result'))
result=request('/shell/output?id='+identifier);data=base64.b64decode(result['base64'],validate=True)
if len(data)!=result['bytes']:raise SystemExit('Output byte count differs')
if a.output:
 a.output.parent.mkdir(parents=True,exist_ok=True)
 with a.output.open('xb') as output:output.write(data)
 a.output.chmod(0o600)
else:sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
status=job['status'];print(json.dumps(status,ensure_ascii=False),file=sys.stderr)
outcome=status['outcome']
if outcome=='timeout':raise SystemExit(124)
if outcome=='output-limit':raise SystemExit(125)
if outcome!='completed':raise SystemExit(2)
raise SystemExit((status['rawStatus']>>8)&255)
