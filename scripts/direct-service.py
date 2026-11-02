"""Run the paired band's phone transport in Termux, with an owned process lifecycle."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SELF = Path(__file__).resolve()
LOCAL = ROOT / '.local'
STATE = LOCAL / 'direct-service.json'
MODE = LOCAL / 'direct-transport.json'
ASTRO = 'moe.astralsight.astrobox'
ADB = ['adb', '-s', os.environ.get('BAND_ADB_SERIAL', '127.0.0.1:5555')]


def preferred_transport():
    if not MODE.exists():
        return 'spp'
    settings = json.loads(MODE.read_text())
    if settings.get('version') != 1 or settings.get('transport') not in ['spp', 'private-spp']:
        raise SystemExit('连接模式配置无效，请检查保存的配置')
    return settings['transport']


def select_transport(transport):
    if transport not in ['spp', 'private-spp']:
        raise ValueError('Unsupported transport')
    if transport == 'private-spp' and not (LOCAL / 'private-link-auth.json').is_file():
        raise SystemExit('专用通道的配对材料尚未准备好')
    idle_before_handover()
    running = bool(active())
    if running:
        stop()
    temporary = MODE.with_suffix('.tmp')
    with open(temporary, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump({'version': 1, 'transport': transport}, output)
        output.write('\n'); output.flush(); os.fsync(output.fileno())
    temporary.replace(MODE)
    if running:
        start()
    print(json.dumps({'preferredTransport': transport, 'wasRunning': running}))


def relay_status():
    token = (LOCAL / 'astro-plugin-token').read_text().strip()
    request = urllib.request.Request('http://127.0.0.1:32179/status', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.load(response)


def birth(pid):
    # /proc starttime identifies a process across PID reuse.
    text = (Path('/proc') / str(pid) / 'stat').read_text()
    fields = text[text.rindex(')') + 2:].split()
    if fields[0] == 'Z':
        raise ProcessLookupError('Process has exited')
    return fields[19]


def save(state):
    temporary = STATE.with_suffix('.tmp')
    with open(temporary, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump(state, output, ensure_ascii=False)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(STATE)


def active():
    try:
        state = json.loads(STATE.read_text())
        pid = state['pid']
        argv = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
        if birth(pid) != state['birth'] or len(argv) < 3:
            return None
        if Path(os.fsdecode(argv[1])).resolve() != SELF or argv[2] != b'run':
            return None
        return state
    except (OSError, ValueError, KeyError):
        return None


def idle_before_handover():
    status = relay_status()
    if status.get('busy'):
        raise SystemExit('有进行中的任务，请完成或取消后再切换连接服务')
    return status


def start(allow_send=False):
    current = active()
    if current:
        print(json.dumps({'running': True, **current}, ensure_ascii=False))
        return
    try:
        # Starting an absent transport resumes saved work. Only switching or
        # installation needs an idle handover; otherwise a pending file would
        # prevent the very connection required to finish it.
        relay_status()
    except (OSError, ValueError):
        subprocess.run([sys.executable, str(ROOT / 'scripts/start-astro.py'), *(['--allow-send'] if allow_send else [])], check=True)
        relay_status()
    subprocess.run(ADB + ['get-state'], check=True, stdout=subprocess.DEVNULL, timeout=5)
    if not (LOCAL / 'direct-bluetooth-auth.json').is_file():
        raise SystemExit('缺少此手环已验证的私有认证材料')
    # The factory channel needs an ownership handover. The private UUID can
    # coexist with another client and does not stop a manually opened app.
    if preferred_transport() == 'spp':
        subprocess.run(ADB + ['shell', 'am', 'force-stop', ASTRO], check=True, timeout=10)
    with open(LOCAL / 'direct-service.log', 'ab', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        child = subprocess.Popen([sys.executable, str(SELF), 'run'], cwd=ROOT,
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
    for _ in range(100):
        current = active()
        if current:
            print(json.dumps({'running': True, **current}, ensure_ascii=False))
            return
        if child.poll() is not None:
            raise SystemExit('连接服务未启动，请查看 .local/direct-service.log')
        time.sleep(.1)
    raise SystemExit('服务启动回执超时，请先检查状态')


def stop():
    current = active()
    if not current:
        print(json.dumps({'running': False}))
        return
    os.kill(current['pid'], signal.SIGTERM)
    for _ in range(650):
        if not active():
            print(json.dumps({'running': False, 'stopped': True}))
            return
        time.sleep(.2)
    raise SystemExit('连接服务仍在等待任务结束；未强杀，请检查状态与原任务编号')


def reconnect_delay(authenticated_ms, short_failures):
    # Recover a useful authenticated session immediately. Only repeated short
    # sessions/open failures consume the bounded burst before backing off.
    if authenticated_ms >= 10000:
        return 0, 0
    short_failures += 1
    return (0 if short_failures <= 3 else min(30, 2 ** min(short_failures - 3, 5))), short_failures


def bootstrap_due(transport, short_failures, now, last_attempt):
    return transport == 'private-spp' and short_failures >= 3 and now - last_attempt >= 300


def run():
    lock = open(LOCAL / 'direct-service.lock', 'a', opener=lambda p, flags: os.open(p, flags, 0o600))
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Only one owned connection supervisor may run')
    transport = preferred_transport()
    state = {'pid': os.getpid(), 'birth': birth(os.getpid()), 'phase': 'connecting',
             'startedAt': int(time.time() * 1000), 'attempts': 0, 'transport': transport}
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    sessions = LOCAL / 'direct-sessions'
    sessions.mkdir(exist_ok=True, mode=0o700)
    save(state)
    short_failures = 0
    last_bootstrap = float('-inf')
    try:
        while not stopping.is_set():
            # Respect a user manually returning to the fallback. Do not fight
            # another Bluetooth owner or repeatedly force-stop their UI.
            owner = subprocess.run(ADB + ['shell', 'pidof', ASTRO], capture_output=True, timeout=8) if transport == 'spp' else None
            if owner is not None and owner.returncode == 0 and owner.stdout.strip():
                state.update(phase='paused', reason='AstroBox is open; close it then start this service')
                save(state)
                break
            state.update(phase='connecting', attempts=state['attempts'] + 1)
            state.pop('reason', None)
            save(state)
            report = sessions / (str(time.time_ns()) + '.json')
            child = subprocess.Popen([shutil.which('node'), str(ROOT / 'scripts/run-direct-band.mjs'),
                                      '--service', '--report', str(report), *(['--private'] if transport == 'private-spp' else [])], cwd=ROOT,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1)
            authenticated_ms = 0
            messages = queue.Queue()
            def read_lines():
                for line in child.stdout:
                    messages.put(line)
            reader = threading.Thread(target=read_lines, daemon=True)
            reader.start()
            signalled = False
            while child.poll() is None or not messages.empty():
                if stopping.is_set() and not signalled and child.poll() is None:
                    state['phase'] = 'stopping'
                    save(state)
                    child.send_signal(signal.SIGTERM)
                    signalled = True
                try:
                    line = messages.get(timeout=.2)
                except queue.Empty:
                    continue
                print(line.rstrip(), flush=True)
                try:
                    value = json.loads(line)
                    if value.get('event') == 'direct-bridge-ready':
                        state.update(phase='online', connectedAt=int(time.time() * 1000), childPid=child.pid)
                        save(state)
                    elif isinstance(value.get('authenticatedDurationMs'), (int, float)):
                        authenticated_ms = value['authenticatedDurationMs']
                except (ValueError, AttributeError):
                    pass
            reader.join(timeout=1)
            state.update(lastExit=child.wait(), lastReport=str(report.relative_to(ROOT)))
            state.pop('childPid', None)
            if stopping.is_set():
                break
            delay_seconds, short_failures = reconnect_delay(authenticated_ms, short_failures)
            if bootstrap_due(transport, short_failures, time.monotonic(), last_bootstrap):
                # A missing resident listener after a band reboot can recover
                # through the standard selector. Never interrupt active work,
                # stop MiWearCore, change bonding or clear a pending marker.
                last_bootstrap = time.monotonic()
                try:
                    status = relay_status()
                    if not status.get('busy') and not status.get('queuedEvents'):
                        state.update(phase='recovering-services', bootstrapAttempts=state.get('bootstrapAttempts', 0) + 1)
                        save(state)
                        recovery = subprocess.run([shutil.which('node'), str(ROOT / 'scripts/bootstrap-private-link.mjs')],
                            cwd=ROOT, capture_output=True, text=True, timeout=75)
                        state['lastBootstrapSucceeded'] = recovery.returncode == 0
                        for line in recovery.stdout.splitlines():
                            try:
                                value = json.loads(line)
                                if value.get('event') == 'private-link-bootstrap':
                                    print(json.dumps(value), flush=True)
                            except (ValueError, AttributeError):
                                pass
                        if recovery.returncode == 0:
                            delay_seconds, short_failures = 0, 0
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    state['lastBootstrapSucceeded'] = False
            # Reconnect only the socket. Persistent event claims prohibit
            # replaying a command whose watch delivery became uncertain.
            state.update(phase='reconnecting', retryAfterSeconds=delay_seconds,
                         lastAuthenticatedDurationMs=authenticated_ms, shortFailures=short_failures)
            save(state)
            stopping.wait(delay_seconds)
    finally:
        state['phase'] = 'stopped'
        state['stoppedAt'] = int(time.time() * 1000)
        save(state)
        lock.close()


def install_resource(path, select=False):
    path = Path(path).resolve()
    if not path.is_file() or path.suffix.lower() not in ['.rpk', '.face']:
        raise SystemExit('请选择已存在的 .rpk 或 .face 文件')
    if select and path.suffix.lower() != '.face':
        raise SystemExit('--select 只用于表盘')
    idle_before_handover()
    was_running = bool(active())
    if was_running:
        stop()
    try:
        subprocess.run(ADB + ['shell', 'am', 'force-stop', ASTRO], check=True, timeout=10)
        script = 'install-direct-rpk.mjs' if path.suffix.lower() == '.rpk' else 'install-direct-watchface.mjs'
        option = '--rpk' if path.suffix.lower() == '.rpk' else '--face'
        subprocess.run([shutil.which('node'), str(ROOT / 'scripts' / script), option, str(path),
                        *(['--select'] if select else [])], cwd=ROOT, check=True)
    finally:
        if was_running:
            start()


if __name__ == '__main__':
    LOCAL.mkdir(exist_ok=True, mode=0o700)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'stop', 'status', 'run', 'install', 'use-private', 'use-factory'])
    parser.add_argument('file', nargs='?')
    parser.add_argument('--select', action='store_true')
    parser.add_argument('--allow-send', action='store_true', help='Enable explicit band sending if the relay must be started')
    args = parser.parse_args()
    if args.command == 'start':
        start(args.allow_send)
    elif args.command == 'stop':
        stop()
    elif args.command == 'run':
        run()
    elif args.command == 'install':
        if not args.file:
            parser.error('install requires an RPK or watchface file')
        install_resource(args.file,args.select)
    elif args.command in ['use-private', 'use-factory']:
        select_transport('private-spp' if args.command == 'use-private' else 'spp')
    else:
        current = active()
        try:
            last = json.loads(STATE.read_text())
        except (OSError, ValueError):
            last = None
        print(json.dumps({'running': bool(current), 'state': current or last}, ensure_ascii=False))
