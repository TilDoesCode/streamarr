#!/usr/bin/env python3
"""Port the 14 compatible disposal regressions into a verifier-local git archive."""
import io
from pathlib import Path
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
dest = root / 'tools/dl-verify/pre-round5'
dest.mkdir(exist_ok=True)
if not (dest / 'server').exists():
    archive = subprocess.check_output(['git', 'archive', '3752e5ad', 'server'], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        entries.extractall(dest)
path = Path('server/tests/Streamarr.Server.Tests/Viewers/Downloads/DownloadLeaseDisposalTests.cs')
source = (root / path).read_text()
pos = source.index('ALease_IsSafeToReadAndAbort_AfterItWasDisposed_AndAbortsOnce(')
start = source.rfind('    [Fact]', 0, pos)
opening = source.index('{', pos)
depth, end = 1, opening + 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
source = source[:start] + source[end:]
(dest / path).write_text(source)
print('Prepared', dest)
