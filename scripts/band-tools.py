"""Unified phone-side maintenance entrypoint for the paired Codex band App."""
import argparse
import os
from pathlib import Path
import sys
import json
import subprocess

scripts=Path(__file__).resolve().parent
if len(sys.argv)>1 and sys.argv[1]=='shell':
    os.execv(sys.executable,[sys.executable,str(scripts/'band-shell.py'),*sys.argv[2:]])
parser=argparse.ArgumentParser(description=__doc__)
commands=parser.add_subparsers(dest='command',required=True)
start=commands.add_parser('start',help='Start or replace this project relay without restarting Codex')
start.add_argument('--allow-send',action='store_true')
start.add_argument('--direct',action='store_true',help='Use the Termux Bluetooth service without AstroBox')
stop=commands.add_parser('stop',help='Stop this project relay, or only its direct Bluetooth transport')
stop.add_argument('--direct',action='store_true')

commands.add_parser('check-audio',help='One-second native capture, Bluetooth readback and local decode; no ASR or send')
status=commands.add_parser('status',help='Read sanitized connection and recording status')
status.add_argument('--direct',action='store_true')
shell=commands.add_parser('shell',help='Execute NSH on the band, with verified output and separate timeout status')
shell.add_argument('shell_args',nargs=argparse.REMAINDER)
put=commands.add_parser('put',help='Save data in our band App private inbox, at most 1 MiB')
put.add_argument('file',type=Path);put.add_argument('--name');put.add_argument('--chunk-bytes',type=int,choices=[128,1024,4096],default=1024)
get=commands.add_parser('get',help='Read an existing basename in our band App private directory')
get.add_argument('name');get.add_argument('output',type=Path)
install=commands.add_parser('install',help='Install RPK or face through the independent standard Bluetooth installer')
install.add_argument('rpk',type=Path)
install.add_argument('--direct',action='store_true',default=True,help='Use independent Bluetooth (the public default)')
install.add_argument('--select',action='store_true',help='Select the installed .face watchface')
commands.add_parser('recover-audio',help='Restore the idle native service and verify a fresh native pong')
args=parser.parse_args()
if args.command in ['start','stop','status'] and args.direct:
    entry='direct-service.py';extra=[args.command]
    if args.command=='start' and args.allow_send:extra+=['--allow-send']
elif args.command=='start':entry='start-astro.py';extra=['--allow-send'] if args.allow_send else []
elif args.command=='stop':
    subprocess.run([sys.executable,str(scripts/'direct-service.py'),'stop'],check=True,stdout=subprocess.DEVNULL)
    from bridge_process import stop_project_node
    print('Stopped project relay processes:',stop_project_node('bridge/astro-server.mjs'))
    raise SystemExit(0)
elif args.command=='check-audio':entry='check-native-audio.py';extra=[]
elif args.command=='status':entry='astro-status.py';extra=[]
elif args.command=='shell':entry='band-shell.py';extra=args.shell_args
elif args.command=='put':
    entry='band-file-send.py';extra=[str(args.file.resolve()),'--chunk-bytes',str(args.chunk_bytes),'--wait','180']
    if args.name:extra+=['--name',args.name]
elif args.command=='get':entry='band-file-receive.py';extra=['--name',args.name,'--output',str(args.output.resolve())]
elif args.command=='recover-audio':entry='recover-native-audio.py';extra=[]
else:
    entry='direct-service.py';extra=['install',str(args.rpk.resolve())]+(['--select'] if args.select else [])
# Replace this process; do not shell-expand filenames or detach hidden workers.
os.execv(sys.executable,[sys.executable,str(scripts/entry),*extra])
