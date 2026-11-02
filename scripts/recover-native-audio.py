"""Open the pinned idle-service loader, then verify its report and native pong.

Uses the already paired phone plugin. Does not record, transcribe or send a prompt.
Never automatically retries a load whose outcome is uncertain.
"""
import json
from pathlib import Path
import time
import urllib.request

root=Path(__file__).resolve().parents[1]
headers={'Authorization':'Bearer '+(root/'.local/astro-plugin-token').read_text().strip(),
         'Content-Type':'application/json'}
def request(path,body=None):
    req=urllib.request.Request('http://127.0.0.1:32179'+path,headers=headers,
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
def wait(key,identifier,seconds):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        result=request('/status').get(key)
        if result and result.get('id')==identifier and result['phase']!='pending':return result
        time.sleep(.5)
    raise SystemExit('回执仍未确认；未自动重试，请检查 /status')

job=request('/native/service',{})
print('已请求恢复待命录音服务；等待真实回执',flush=True)
receipt={'recovery':wait('nativeRecovery',job['id'],95),'microphoneOpened':False,'codexPromptSent':False}
if receipt['recovery']['phase']!='complete':raise SystemExit(receipt['recovery'].get('message','恢复失败'))
report=request('/native/report',{})
receipt['loaderReport']=wait('nativeLoaderReport',report['id'],35)
text=receipt['loaderReport'].get('reports',{}).get('report.txt',{}).get('text','')
rc=receipt['loaderReport'].get('reports',{}).get('rc.txt',{}).get('text','')
# Restoring the consumed one-shot reboot test face rewrites the shared display
# report. Its harmless marker report does not erase the bootstrap return code.
# A fresh random native pong is still required below; a cached code is not proof.
report_ok=text.startswith('audio-bootstrap-v1:ready\n') or text.startswith('audio-recovery-reboot-v1: marker already present; no additional reboot\n')
if receipt['loaderReport']['phase']!='complete' or not report_ok or rc not in ['audio-bootstrap-v1:loaded\n','audio-bootstrap-v1:already-loaded\n']:
    raise SystemExit('加载器未报告就绪；未自动重试')
probe=request('/native/probe',{})
receipt['nativeEventProbe']=wait('nativeProbe',probe['id'],130)
ok=receipt['nativeEventProbe'].get('nativeTx') and receipt['nativeEventProbe'].get('nativeRx')
receipt['actualNativeDuplexVerified']=bool(ok)
folder=root/'.local/native-recovery-receipts';folder.mkdir(exist_ok=True,mode=0o700)
path=folder/(job['id']+'.json')
with path.open('x') as output:json.dump(receipt,output,ensure_ascii=False,indent=2)
path.chmod(0o600)
print(json.dumps({'recoveryId':job['id'],'loaderReady':True,'actualNativeDuplexVerified':bool(ok),
    'microphoneOpened':False,'codexPromptSent':False},ensure_ascii=False))
if not ok:raise SystemExit('原生事件应答未通过，请检查手环状态；未自动重试')
