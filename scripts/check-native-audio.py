"""Record a bounded diagnostic clip, read it over Bluetooth and decode it locally.

No speech recognition, draft changes or Codex prompt. Audio stays on this phone.
The paired RPK must be running; this command never retries an uncertain start.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

root=Path(__file__).resolve().parents[1]
headers={'Authorization':'Bearer '+(root/'.local/astro-plugin-token').read_text().strip(),
         'Content-Type':'application/json'}
def request(path,body=None):
    req=urllib.request.Request('http://127.0.0.1:32179'+path,headers=headers,
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
check=request('/native/audio/check',{})
if not re.fullmatch(r'[a-f0-9-]{36}',check.get('id','')):raise SystemExit('Unexpected check id')
deadline=time.monotonic()+45
while time.monotonic()<deadline:
    check=request('/status')['nativeAudioCheck']
    if check['phase']!='pending':break
    time.sleep(.5)
if check['phase']!='complete':raise SystemExit('录音自检未完成；没有重试或发送转写')
folder=root/'.local/native-audio-checks'/check['id'];folder.mkdir(parents=True,mode=0o700)
capture=folder/'capture.bcap';wav=folder/'capture.wav'
subprocess.run([sys.executable,str(root/'scripts/band-file-receive.py'),'--name',check['name'],
    '--output',str(capture),'--wait','125'],check=True,cwd=root)
decoded=json.loads(subprocess.check_output([sys.executable,str(root/'scripts/read-native-capture.py'),
    str(capture),'--wav',str(wav)],cwd=root,text=True))
report={'check':check,'capture':decoded,'actualAppStartStop':True,'actualBluetoothReadback':True,
    'actualLocalOpusDecode':True,'transcriptionInvoked':False,'codexPromptSent':False,
    'rawAudioPrivateOnPhone':True,'spokenEndToEndAcceptance':False}
path=folder/'report.json'
with path.open('x') as output:json.dump(report,output,ensure_ascii=False,indent=2)
path.chmod(0o600)
print(json.dumps({'id':check['id'],'captureHeader':decoded['header'],'decoded':decoded['decoded'],
    'captureSha256':decoded['sha256'],'wavSha256':decoded['wavSha256'],
    'transcriptionInvoked':False,'codexPromptSent':False},ensure_ascii=False))
