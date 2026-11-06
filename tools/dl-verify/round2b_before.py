#!/usr/bin/env python3
"""Create an ignored cdd6a6b8 archive with the round 1b integration tests."""
import io
from pathlib import Path
import re
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
dest = root / 'tools/dl-verify/pre-1b'
dest.mkdir(exist_ok=True)
if not (dest / 'server').exists():
    archive = subprocess.check_output(['git', 'archive', 'cdd6a6b8', 'server'], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        entries.extractall(dest)
path = Path('server/tests/Streamarr.Server.Tests/Viewers/Downloads/DownloadLanguageGateTests.cs')
source = (root / path).read_text()
# This unit-only method references the new SameLanguage API and cannot compile
# against the old implementation. All eight integration cases stay unchanged.
source = re.sub(r'    \[Theory\]\n(?:    \[InlineData[^\n]*\n)+    public void TheLanguageClass_.*?;\n', '', source, flags=re.S)
assert 'TheLanguageClass_' not in source
(dest / path).write_text(source)
print('Prepared', dest)
