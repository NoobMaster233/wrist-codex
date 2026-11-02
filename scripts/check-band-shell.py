"""Actual NSH acceptance: UI presets, exact I/O, nonzero exit and owned timeout."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
if a.report.exists():raise SystemExit('Preserve existing Shell acceptance evidence')
headers={'Authorization':'Bearer '+(ROOT/'.local/astro-plugin-token').read_text().strip(),'Content-Type':'application/json'}
def request(path,body=None):
 q=urllib.request.Request('http://127.0.0.1:32179'+path,headers=headers,data=None if body is None else json.dumps(body).encode())
 with urllib.request.urlopen(q,timeout=5)as r:return json.load(r)
presets=json.loads(subprocess.check_output(['node','--input-type=module','-e',
 "import {shellPresets} from './band/src/common/device-tools.mjs';process.stdout.write(JSON.stringify(shellPresets))"],cwd=ROOT,text=True))
cases=[{'name':x['name'],'command':x['command'],'expected':['completed','output-limit']}for x in presets]
testfile='/data/files/dev.bandcodex.remote/bc-nsh-acceptance-20261028.txt'
cases.extend([
 {'name':'exact stdout','command':'echo orbit042_native_nsh_ok','expected':['completed'],'bytes':b'orbit042_native_nsh_ok\n'},
 {'name':'nonzero exit','command':'bandcodex_no_such_command_20261028','expected':['completed'],'nonzero':True},
 {'name':'owned timeout','command':'sleep 2','timeoutMs':250,'expected':['timeout']},
 {'name':'write private file','command':'echo orbit042_private_io > '+testfile,'expected':['completed']},
 {'name':'read private file','command':'cat '+testfile,'expected':['completed'],'bytes':b'orbit042_private_io\n'},
 {'name':'remove own test file','command':'rm '+testfile,'expected':['completed']},
])
report={'passed':False,'startedAt':int(time.time()*1000),'cases':[],
        'commandsRunOn':'band NuttX NSH','promptSendCount':0,'microphoneStarted':False,'phoneSettingsChanged':False}
def save():
 a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');a.report.chmod(0o600)
try:
 status=request('/status')
 if not status['connected']or status['busy']:raise RuntimeError('Connected idle service required')
 for case in cases:
  job=request('/shell',{'command':case['command'],'timeoutMs':case.get('timeoutMs',3000),'outputLimit':32768})
  record={'name':case['name'],'id':job['id'],'command':case['command']};report['cases'].append(record);save()
  deadline=time.monotonic()+150
  while time.monotonic()<deadline:
   job=request('/shell/status?id='+job['id'])
   if job['phase']in ['complete','failed','unknown']:break
   time.sleep(.25)
  record['phase']=job['phase'];record['status']=job.get('status');save()
  if job['phase']!='complete':raise RuntimeError('Inspect existing '+job['id']+'; no command was resubmitted')
  output=request('/shell/output?id='+job['id']);data=base64.b64decode(output['base64'],validate=True)
  if len(data)!=output['bytes']:raise RuntimeError('Shell byte count differs')
  record.update(outputBytes=len(data),outputSha256=hashlib.sha256(data).hexdigest())
  outcome=job['status']['outcome'];raw=job['status']['rawStatus']
  if outcome not in case['expected']:raise RuntimeError(case['name']+' outcome differs')
  if case.get('nonzero'):
   if raw==0:raise RuntimeError('Failed command was reported successful')
  elif outcome=='completed'and raw!=0:raise RuntimeError(case['name']+' command failed')
  if 'bytes'in case and data!=case['bytes']:raise RuntimeError('Exact stdout differs')
  if case['command']=='ps':
   record['nativeWorkersPresent']=all(x in data for x in [b'bc_link043',b'bc_shell043',b'bc_audio043'])
   if not record['nativeWorkersPresent']:raise RuntimeError('Expected own native tasks not present in band PS')
  if outcome=='timeout'and job['status']['waitPid']!=job['status']['pid']:raise RuntimeError('Timeout child was not reaped')
  record['passed']=True;save();print(json.dumps({'case':case['name'],'passed':True,'outcome':outcome,'bytes':len(data)},ensure_ascii=False),flush=True)
 report['originalRecordingPhase']=request('/status')['recording']['phase'];report['passed']=True
except Exception as error:
 report['error']=str(error);raise
finally:
 report['finishedAt']=int(time.time()*1000);save();print(json.dumps({'passed':report['passed'],'cases':len(report['cases']),'error':report.get('error')},ensure_ascii=False),flush=True)
