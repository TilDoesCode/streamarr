#!/usr/bin/env python3
"""Build an ignored pre-round-2 archive and copy compatible regression cases."""
import io
from pathlib import Path
import subprocess
import tarfile

root = Path(__file__).resolve().parents[2]
dest = root / 'tools/dl-verify/pre-round2'
dest.mkdir(exist_ok=True)
if not (dest / 'server').exists():
    archive = subprocess.check_output(['git', 'archive', 'a48a0755', 'server'], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        entries.extractall(dest)


def remove_method(source, name):
    pos = source.index(name + '(')
    start = source.rfind('    [Fact]', 0, pos)
    opening = source.index('{', pos)
    depth, end = 1, opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[:start] + source[end:]


tests = Path('server/tests/Streamarr.Server.Tests')
path = tests / 'Viewers/Downloads/DownloadAccessTests.cs'
source = (root / path).read_text()
source = remove_method(source, 'ASignOutCommittingDuringARenewal_RevokesTheRenewedUrl')
source = source.replace('        Downloads.BeforeLifecycleCommit = null;\n', '')
(dest / path).write_text(source)
path = tests / 'Viewers/Downloads/DownloadPriorityTests.cs'
source = (root / path).read_text()
start = source.rfind('    [Fact]', 0, source.index('ALargeRequest_IsServedInItsTurn_WhileSmallOnesKeepArriving('))
after = remove_method(source, 'ALargeRequest_IsServedInItsTurn_WhileSmallOnesKeepArriving')
method = source[start:start + len(source) - len(after)]
# The old bucket held half a second, minimum 1 byte. Only this API-dependent
# setup line changes; the regression's requests/assertions are unchanged.
method = method.replace('await DrainAsync(governor, 1000);', 'await governor.ThrottleAsync(500, CancellationToken.None);')
old = subprocess.check_output(['git', 'show', 'a48a0755:' + str(path)], cwd=root, text=True)
(dest / path).write_text(old[:old.rfind('}')] + method + '\n}\n')
path = tests / 'Persistence/ViewerDownloadsLifecycleMigrationTests.cs'
source = (root / path).read_text()
source = remove_method(source, 'TheKey_IsUniquePerViewerDeviceAndClientReference')
source = source.replace('d => d.DeviceKey', 'd => d.IdempotencyKey')
# These post-migration helper assertions reference the new API. The regression
# fails before them while applying the original hardening migration.
source = '\n'.join(line for line in source.split('\n') if 'ViewerDownloadService.DeviceKey(' not in line)
(dest / path).write_text(source)
print('Prepared pre-round-2 regression archive', dest)
