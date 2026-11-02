"""Run portable C parser, audio state-machine and native management tests."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
native = root / 'phone-research/native-audio'
cases = {
    'audio': ['test/native-audio-core.test.c', 'phone-research/native-audio/capture-core.c', 'phone-research/native-audio/command-builder.c'],
    'wire': ['test/native-private-link-wire.test.c', 'phone-research/native-audio/private-link-wire.c'],
    'management': ['test/native-management.test.c', 'phone-research/native-audio/shell-wire.c'],
    'events': ['test/native-event-wire.test.c', 'phone-research/native-audio/event-wire.c'],
}
with tempfile.TemporaryDirectory(prefix='wrist-codex-tests-') as temporary:
    for name, sources in cases.items():
        executable = Path(temporary) / name
        subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(native),
                        *[str(root / source) for source in sources], '-o', str(executable)], check=True)
        subprocess.run([str(executable)], check=True, timeout=15)
