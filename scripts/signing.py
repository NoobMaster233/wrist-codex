from pathlib import Path
import shutil
import subprocess


def prepare_signing(root: Path):
    debug = root / 'band/sign/debug'
    release = root / 'band/sign/release'
    local = root / '.local'
    for path in (debug, release, local):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    private = debug / 'private.pem'
    certificate = debug / 'certificate.pem'
    if not private.exists() and ((release / 'private.pem').exists() or (release / 'certificate.pem').exists()):
        raise RuntimeError('Existing release identity found; preserve it rather than generating a replacement')
    if not private.exists() and not certificate.exists():
        subprocess.run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(private), '-x509', '-days', '3650', '-subj', '/CN=Band Codex Local/', '-out', str(certificate)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        private.chmod(0o600)
    if not private.exists() or not certificate.exists():
        raise RuntimeError('Incomplete signing identity; preserve existing keys and repair the missing file')
    for name in ('private.pem', 'certificate.pem'):
        destination = release / name
        if destination.exists() and destination.read_bytes() != (debug / name).read_bytes():
            raise RuntimeError('Release signing identity differs; no overwrite performed')
    for name in ('private.pem', 'certificate.pem'):
        shutil.copy2(debug / name, release / name)
    der = local / 'android-key.pk8'
    subprocess.run(['openssl', 'pkcs8', '-topk8', '-nocrypt', '-outform', 'DER', '-in', str(private), '-out', str(der)], check=True)
    der.chmod(0o600)
    return der, certificate


if __name__ == '__main__':
    prepare_signing(Path(__file__).resolve().parents[1])
    print('Local RPK/APK signing identity is ready')
