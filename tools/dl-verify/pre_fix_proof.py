#!/usr/bin/env python3
"""Prepare an ignored pre-fix archive with compatible builder regression tests.
Run from the verifier root. No other checkout is read or modified.
"""
import io
from pathlib import Path
import re
import subprocess
import tarfile
ROOT=Path.cwd()
DEST=ROOT/'tools/dl-verify/pre-fix'
DEST.mkdir(exist_ok=True)
if not (DEST/'server').exists():
    archive=subprocess.check_output(['git','archive','9898774a','server'])
    with tarfile.open(fileobj=io.BytesIO(archive)) as t:t.extractall(DEST)

def remove_method(s,name):
    pos=s.index(name+'(')
    begin=s.rfind('    [Fact]',0,pos)
    opening=s.index('{',pos)
    depth=1
    i=opening+1
    while depth:
        depth += (s[i]=='{')-(s[i]=='}')
        i+=1
    return s[:begin]+s[i:]

paths=['Viewers/Downloads/DownloadAccessTests.cs','Viewers/Downloads/OfflineProgressTests.cs','Services/CoreLogStoreTests.cs','Viewers/ViewerCorsMiddlewareTests.cs','Viewers/Downloads/DownloadPriorityTests.cs','Integration/DownloadTransferIntegrationTests.cs']
for rel in paths:
    path=Path('server/tests/Streamarr.Server.Tests')/rel
    s=(ROOT/path).read_text()
    if rel.endswith('DownloadAccessTests.cs'):
        for n in ['ADeleteBetweenAuthorizationAndAdmission_IsNeverServed','ARevocationBetweenAuthorizationAndAdmission_AnswersTheRevocation','TurningDownloadsOff_CancelsAPreparationInFlight']:
            s=remove_method(s,n)
        s=re.sub(r'^        FileService.BeforeAdmit = null;\n','',s,flags=re.M)
    if rel.endswith('DownloadTransferIntegrationTests.cs'):
        s=remove_method(s,'APreparationsResolve_UsesTheDownloadShare_AndItsProbeIsNeverLive')
    if rel.endswith('OfflineProgressTests.cs'):
        s=remove_method(s,'ManyCompletions_KeepABoundedMemory_AndTheOldOnesStillCount')
    if rel.endswith('DownloadPriorityTests.cs'):
        # Preserve old tests unchanged (their admission helper uses the old API).
        before=subprocess.check_output(['git','show','9898774a:'+str(path)],text=True)
        names=['ATransferAdmission_NeverEvictsAPlaybackSession','ATransferAdmission_MayReplaceAnIdleTransferSession_APlaybackOneMayToo','ACancelledThrottleWait_CostsNothing','ARateChange_ReachesARequestThatIsAlreadyWaiting']
        methods=[]
        for name in names:
            start=s.rfind('    [Fact]',0,s.index(name+'('))
            after=remove_method(s,name)
            size=len(s)-len(after)
            methods.append(s[start:start+size])
        s=before[:before.rfind('}')]+ '\n'.join(methods)+'\n}\n'
    (DEST/path).write_text(s)
print('Prepared pre-fix archive at',DEST)
