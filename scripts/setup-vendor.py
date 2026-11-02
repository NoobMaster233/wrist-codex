from pathlib import Path
import hashlib
import io
import urllib.request
import zipfile

root = Path(__file__).resolve().parents[1]
vendor = root / '.cache/vendor'
vendor.mkdir(parents=True, exist_ok=True)

def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'BandCodex/0.1'})
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.read()

def checked(data, digest):
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('Vendor checksum mismatch; the downloaded tool was not used')
    return data

android_digest = '4566663c3876e022b4fa4ced8c8697c4ab1688267f090114fd92d027b32e619b'
if not (vendor / 'android.jar').is_file():
    archive = zipfile.ZipFile(io.BytesIO(fetch('https://dl.google.com/android/repository/platform-35_r02.zip')))
    name = next(name for name in archive.namelist() if name.endswith('/android.jar'))
    (vendor / 'android.jar').write_bytes(checked(archive.read(name), android_digest))
checked((vendor / 'android.jar').read_bytes(), android_digest)

r8_digest = '59753e70a74f918389cc87f1b7d66b5c0862932559167425708ded159e3de439'
if not (vendor / 'r8.jar').is_file():
    data = fetch('https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.3.37/r8-8.3.37.jar')
    (vendor / 'r8.jar').write_bytes(checked(data, r8_digest))
checked((vendor / 'r8.jar').read_bytes(), r8_digest)

print('Android API 35 and D8 are ready; checksums verified')
