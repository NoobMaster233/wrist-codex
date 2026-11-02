"""Compile the pure native parser and feed it the phone encoder's real bytes."""
from pathlib import Path
import subprocess
import tempfile

root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='band-shell-wire-') as temporary:
    work=Path(temporary);fixture=work/'request.bin';test=work/'shell-wire-test'
    code="import {encodeShellRequest} from './bridge/shell-protocol.mjs';process.stdout.write(encodeShellRequest('echo shell-fixture',{timeoutMs:1234,outputLimit:4096}));"
    fixture.write_bytes(subprocess.check_output(['node','--input-type=module','-e',code],cwd=root))
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-I',str(root/'phone-research/native-audio'),
        str(root/'phone-research/native-audio/shell-wire.c'),str(root/'test/shell-wire.c'),'-o',str(test)],check=True)
    subprocess.run([str(test),str(fixture)],check=True)
