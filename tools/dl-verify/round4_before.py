#!/usr/bin/env python3
"""Prepare a verifier-local 591724de archive for compatible round-3 regressions."""
import io
from pathlib import Path
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
dest = root / 'tools/dl-verify/pre-round3'
dest.mkdir(exist_ok=True)
if not (dest / 'server').exists():
    archive = subprocess.check_output(['git', 'archive', '591724de', 'server'], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        entries.extractall(dest)
tests = Path('server/tests/Streamarr.Server.Tests')
# New test-host constructor supports a second host on one DB for restart proof.
# No product sources are substituted in the archive.
for relative in ['Viewers/Downloads/DownloadAccessTests.cs', 'Viewers/Downloads/DownloadTestHost.cs', 'Viewers/Downloads/DownloadAccountingTests.cs']:
    (dest / tests / relative).write_text((root / tests / relative).read_text())
path = tests / 'Persistence/ViewerDownloadsLifecycleMigrationTests.cs'
source = (root / path).read_text()
# The two assertions call a new helper not present before the fix. Stored-value
# assertions are unchanged and independently fail before reaching these lines.
source = '\n'.join(line for line in source.split('\n') if 'ViewerDownloadService.DeviceIdOf(' not in line)
(dest / path).write_text(source)
print('Prepared pre-round-3 archive', dest)
