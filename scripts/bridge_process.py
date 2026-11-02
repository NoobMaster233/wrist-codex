"""Manage only an exact Node entry point in this project's working directory."""
import os
from pathlib import Path
import signal
import time

ROOT = Path(__file__).resolve().parents[1]


def stop_project_node(entrypoint):
    server = (ROOT / entrypoint).resolve()
    stopped = 0
    for process in Path('/proc').glob('[0-9]*'):
        try:
            argv = (process / 'cmdline').read_bytes().split(b'\0')
            if len(argv) < 2 or Path(os.fsdecode(argv[0])).name != 'node':
                continue
            if (process / 'cwd').resolve(strict=True) != ROOT:
                continue
            if (ROOT / os.fsdecode(argv[1])).resolve() != server:
                continue
            os.kill(int(process.name), signal.SIGTERM)
            for attempt in range(50):
                if not process.exists():
                    break
                time.sleep(.1)
            else:
                raise SystemExit('Project bridge did not stop; no additional process started')
            stopped += 1
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return stopped
