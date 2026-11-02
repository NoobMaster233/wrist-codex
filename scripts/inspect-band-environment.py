"""Collect bounded, read-only NSH environment queries through the existing relay.

Raw outputs stay private on this phone. Saved request IDs are observed on a
resumed run; an execution is never automatically resubmitted.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    'system': [
        ('uname', 'uname -a'),
        ('firmware', 'getprop ro.build.version'),
        ('uptime', 'uptime'),
        ('date', 'date'),
        ('memory', 'free'),
        ('storage', 'df'),
        ('cwd', 'pwd'),
        ('path', 'echo $PATH'),
    ],
    'filesystem': [
        ('root', 'ls -l /'),
        ('proc-entries', 'ls /proc'),
        ('device-entries', 'ls /dev'),
        ('etc-entries', 'ls /etc'),
        ('data-entries', 'ls /data'),
        ('mounts', 'cat /proc/mounts'),
    ],
    'runtime': [
        ('tasks', 'ps'),
        ('modules', 'lsmod'),
        ('self-status', 'cat /proc/self/status'),
        ('help', 'help -v'),
    ],
    'network': [
        ('network-help', 'help ifconfig'),
        ('interfaces', 'ifconfig'),
    ],
    'details': [
        ('cpuinfo', 'cat /proc/cpuinfo'),
        ('kernel-version', 'cat /proc/version'),
        ('cpu-load', 'cat /proc/cpuload'),
        ('filesystem-proc-entries', 'ls /proc/fs'),
        ('partitions', 'cat /proc/partitions'),
        ('tmp-files', 'ls -l /tmp'),
        ('startup-entries', 'ls /etc/init.d'),
        ('app-entries', 'ls /data/app'),
        ('network-proc-entries', 'ls /proc/net'),
        ('uorb-entries', 'ls /dev/uorb'),
    ],
    'mount-details': [
        ('mount-table', 'cat /proc/fs/mount'),
        ('filesystem-blocks', 'cat /proc/fs/blocks'),
        ('startup-script', 'cat /etc/init.d/rcS'),
        ('sysinit-script', 'cat /etc/init.d/rc.sysinit'),
    ],
    'final': [
        ('uptime-after', 'uptime'),
        ('memory-after', 'free'),
        ('modules-after', 'lsmod'),
    ],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--group', required=True, choices=GROUPS)
    parser.add_argument('--run-dir', type=Path, required=True)
    args = parser.parse_args()
    folder = args.run_dir.resolve()
    private = (ROOT / '.local').resolve()
    if not folder.is_relative_to(private) or folder == private:
        parser.error('Raw inspection outputs must stay in this project private .local directory')
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    folder.chmod(0o700)
    token = (private / 'astro-plugin-token').read_text().strip()

    def request(path, body=None):
        req = urllib.request.Request('http://127.0.0.1:32179' + path,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
            data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError('Local relay HTTP ' + str(error.code)) from None

    journal_path = folder / (args.group + '.json')
    if journal_path.exists():
        journal = json.loads(journal_path.read_text())
        expected = [(name, command) for name, command in GROUPS[args.group]]
        actual = [(item['name'], item['command']) for item in journal['queries']]
        if actual != expected:
            raise SystemExit('Saved inspection plan differs; preserve it and choose a new run directory')
    else:
        journal = {'group': args.group, 'startedAt': int(time.time() * 1000), 'phase': 'running',
            'commandExecutionRetried': False, 'firmwareWrites': False, 'microphoneOpened': False,
            'queries': [{'name': name, 'command': command} for name, command in GROUPS[args.group]]}

    def save():
        part = journal_path.with_suffix('.tmp')
        with open(part, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
            json.dump(journal, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        part.replace(journal_path)

    save()
    for index, item in enumerate(journal['queries']):
        if item.get('phase') == 'complete':
            data = (folder / item['outputFile']).read_bytes()
            if hashlib.sha256(data).hexdigest() != item['sha256']:
                raise SystemExit('Saved inspection output differs')
            continue
        if not item.get('id'):
            status = request('/status')
            if status.get('busy'):
                raise SystemExit('A task is active; inspection will not interrupt it')
            # Save submission intent before POST; a lost POST response is never retried.
            if item.get('submissionAttempted'):
                raise SystemExit('A previous submission result is unknown; inspect existing jobs before proceeding')
            item['submissionAttempted'] = True
            item['submittedAt'] = int(time.time() * 1000)
            save()
            job = request('/shell', {'command': item['command'], 'timeoutMs': 3000, 'outputLimit': 32768})
            item['id'] = job['id']
            save()
        else:
            job = request('/shell/status?id=' + item['id'])
        print(json.dumps({'query': item['name'], 'index': index + 1, 'total': len(journal['queries']),
                          'id': item['id'], 'phase': job['phase']}), flush=True)
        deadline = time.monotonic() + 175
        while job['phase'] not in ['complete', 'failed']:
            if job['phase'] == 'unknown':
                if item.get('reconciliationAttempted'):
                    break
                item['reconciliationAttempted'] = True
                save()
                job = request('/shell/reconcile', {'id': item['id']})
            if time.monotonic() >= deadline:
                item['phase'] = job['phase']
                save()
                raise SystemExit('Observe saved request ID; the command was not resubmitted')
            time.sleep(.5)
            job = request('/shell/status?id=' + item['id'])
        item['phase'] = job['phase']
        item['status'] = job.get('status')
        item['finishedAt'] = int(time.time() * 1000)
        if job['phase'] != 'complete':
            item['error'] = job.get('error', 'Query result not confirmed')
            journal['phase'] = 'stopped'
            save()
            raise SystemExit(item['error'])
        output = request('/shell/output?id=' + item['id'])
        data = base64.b64decode(output['base64'], validate=True)
        if len(data) != output['bytes']:
            raise SystemExit('Output byte count differs')
        item['outputFile'] = item['name'] + '.out'
        item['bytes'] = len(data)
        item['sha256'] = hashlib.sha256(data).hexdigest()
        out = folder / item['outputFile']
        with out.open('xb') as stream:
            stream.write(data)
        out.chmod(0o600)
        save()
        print(json.dumps({'query': item['name'], 'phase': 'complete', 'bytes': len(data),
                          'outcome': job['status']['outcome'], 'rawStatus': job['status']['rawStatus']}), flush=True)
    journal['phase'] = 'complete'
    journal['finishedAt'] = int(time.time() * 1000)
    save()


if __name__ == '__main__':
    main()
