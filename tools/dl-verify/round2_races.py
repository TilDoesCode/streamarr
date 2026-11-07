#!/usr/bin/env python3
"""Security-revocation/renew and expiry/accounting races; own Dev World 39311 only."""
import concurrent.futures as cf
import os
import sqlite3
import threading
import time
import adversarial as a

os.environ['DL_VERIFY_RESULT_FILE']='round2-races-results.json'
au=a.call('POST','/api/v1/auth/login',{'username':'admin','password':'streamarr-dev'})[1]
a.ADMIN=au.get('accessToken') or au['token']
t=a.login('anna')
vid=next(v['id'] for v in a.call('GET','/api/v1/config/viewers',token=a.ADMIN)[1] if v['username']=='anna')
c=a.call('POST','/api/v1/viewer/downloads/candidates',dict(workId='tmdb-movie-10378',device=a.TV),t)[1]
r=next(c['version']['releaseId'] for c in c['candidates'] if 'BluRay.DDP5.1' in c['version']['name'])
d=a.prepare(t,'tmdb-movie-10378',r)
rows=[]
for i in range(20):
    a.call('DELETE','/api/v1/config/viewers/'+vid+'/sessions',token=a.ADMIN)
    t=a.login('anna')
    gate=threading.Barrier(2)
    def renew():
        gate.wait()
        return a.call('POST','/api/v1/viewer/downloads/'+d['downloadId']+'/renew?deviceId=verify-device',{},t)
    def revoke():
        gate.wait()
        return a.call('DELETE','/api/v1/config/viewers/'+vid+'/sessions',token=a.ADMIN)
    with cf.ThreadPoolExecutor(max_workers=2) as pool:
        f=pool.submit(renew)
        g=pool.submit(revoke)
        renewed,revoked=f.result(),g.result()
    fs=a.call('HEAD',renewed[1]['fileUrl'])[0] if renewed[0]==200 else None
    rows.append(dict(renew=renewed[0],revoke=revoked[0],file=fs,oldBearer=a.call('GET','/api/v1/viewer/downloads',token=t)[0]))
a.check('renew cannot resurrect access after concurrent security sign-out',not any(x['file']==200 for x in rows),dict(trials=rows,usableAfterSignOut=sum(x['file']==200 for x in rows)))

# Accounting is flushed every 2 seconds with CancellationToken.None. Keep only
# this verifier's SQLite writer occupied while a pre-existing 4-second deadline passes.
t=a.login('anna')
d=a.prepare(t,'tmdb-movie-10378',r)
a.settings(bandwidthKbps=8000)
try:
    deadline=time.time()+4
    with sqlite3.connect(a.OUT/'state/streamarr.db') as db:
        db.execute('UPDATE ViewerDownloads SET ExpiresAt=? WHERE Id=?',(int(deadline*1000),d['downloadId']))
    reader=a.Reader(d['fileUrl'])
    with sqlite3.connect(a.OUT/'state/streamarr.db') as db:
        db.execute('BEGIN IMMEDIATE')
        time.sleep(max(0,deadline+2.2-time.time()))
        a.check('expiry ends transfer within 2s even while accounting waits for SQLite writer',reader.done.is_set(),dict(secondsAfterExpiry=2.2,ended=reader.done.is_set(),bytes=reader.got,activeTransfers=a.activity()['activeTransfers']))
        db.rollback()
    ended=reader.done.wait(5)
    a.check('unlocking SQLite lets expired transfer release its slot',ended and a.active_zero()==0,dict(ended=ended,error=reader.error,activeTransfers=a.activity()['activeTransfers']))
    reader.abort()
finally:
    a.settings(bandwidthKbps=0)
