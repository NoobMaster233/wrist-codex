"""Check publication rejection rules in an isolated Git index with synthetic data."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='wrist-codex-publication-') as temporary:
    work = Path(temporary)
    shutil.copytree(root / 'resources/native', work / 'resources/native')
    (work / 'scripts').mkdir()
    shutil.copy2(root / 'scripts/check-publication.py', work / 'scripts/check-publication.py')
    (work / '.gitignore').write_text('.env\n.local/\n')

    def git(*args):
        subprocess.run(['git', *args], cwd=work, check=True, capture_output=True)

    def check(passed, path=None):
        result = subprocess.run([sys.executable, str(work / 'scripts/check-publication.py')],
                                cwd=work, capture_output=True, text=True)
        value = json.loads(result.stdout)
        assert value['passed'] == passed and result.returncode == (0 if passed else 1), value
        if path:
            assert any(item['file'] == path for item in value['findings']), value

    git('-c', 'init.defaultBranch=main', 'init', '--quiet')
    git('add', '.')
    check(True)
    example = work / '.env.example'
    example.write_text('EXAMPLE_ONLY=replace-with-your-private-value\n')
    git('add', example.name)
    check(True)
    cases = {
        '.env': 'NOT_A_SECRET=synthetic\n',
        '.env.local': 'NOT_A_SECRET=synthetic\n',
        'auth.json': '{"tokens":{"access_token":"synthetic-not-valid"}}\n',
        'capture.m4a': 'synthetic-not-a-real-recording\n',
        'session.sqlite3-wal': 'synthetic-not-a-real-database\n',
        'address.mjs': 'export const syntheticAddress="12:34:56:' + '78:9a:bc";\n',
        'notes.txt': 'ghp_' + 'x' * 40 + '\n',
    }
    for name, content in cases.items():
        path = work / name
        path.write_text(content)
        git('add', '--force', '--', name)
        # Cleaning only the worktree must never conceal what Git will publish.
        path.write_text('worktree-only cleaned content\n')
        check(False, name)
        git('rm', '--cached', '--force', '--', name)
        path.unlink()
    link = work / 'staged-link.mjs'
    link.symlink_to('resources/native/3.101.043/manifest.json')
    git('add', link.name)
    link.unlink()
    link.write_text('the worktree is now a regular file\n')
    check(False, link.name)
    git('rm', '--cached', '--force', '--', link.name)
    link.unlink()
    check(True)
print('Publication gate: clean source and examples allowed; eight staged private/object cases rejected')
