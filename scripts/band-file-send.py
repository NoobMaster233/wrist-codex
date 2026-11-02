"""Send one file over the active Bluetooth app channel to our RPK's private inbox.

Files are saved as data. This tool cannot install or execute native code.
"""
import argparse
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('file',type=Path)
parser.add_argument('--name',help='Logical name retained in the phone receipt')
parser.add_argument('--chunk-bytes',type=int,choices=[128,1024,4096],default=128,help='Larger chunks require RPK 0.2.9 or later')
parser.add_argument('--wait',type=int,default=120,help='Maximum receipt observation seconds; does not cancel on timeout')
args=parser.parse_args()
if not args.file.is_file() or args.file.stat().st_size>1048576:parser.error('Expected a file at most 1 MiB')
token=(root/'.local/astro-plugin-token').read_text().strip()
headers={'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream',
         'X-File-Name':urllib.parse.quote(args.name or args.file.name,safe=''),'X-Chunk-Bytes':str(args.chunk_bytes)}
base='http://127.0.0.1:32179'
request=urllib.request.Request(base+'/files/send',data=args.file.read_bytes(),headers=headers)
with urllib.request.urlopen(request,timeout=5) as response:receipt=json.load(response)
if not re.fullmatch(r'file-[a-f0-9-]{36}',receipt.get('id','')):
    raise SystemExit('Unexpected file receipt id')
receipts=root/'.local/file-delivery-receipts'
receipts.mkdir(parents=True,exist_ok=True,mode=0o700)
receipt_path=receipts/(receipt['id']+'.json')
def save_receipt(value):
    receipt_path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    receipt_path.chmod(0o600)
save_receipt(receipt)
print(json.dumps(receipt,ensure_ascii=False),flush=True)
deadline=time.monotonic()+max(0,args.wait)
last=None
last_percent=-1
while time.monotonic()<deadline:
    request=urllib.request.Request(base+'/files/status?id='+receipt['id'],headers={'Authorization':headers['Authorization']})
    with urllib.request.urlopen(request,timeout=5) as response:status=json.load(response)
    percent=int(status['sentBytes']/max(1,status['size'])*10)*10
    if status['state']!='sending' or percent!=last_percent:
        save_receipt(status);print(json.dumps(status,ensure_ascii=False),flush=True);last=status;last_percent=percent
    if status['state']=='complete':raise SystemExit(0)
    if status['state']=='error':raise SystemExit(2)
    time.sleep(1)
raise SystemExit('Receipt still pending; query /files/status with this id before retrying')
