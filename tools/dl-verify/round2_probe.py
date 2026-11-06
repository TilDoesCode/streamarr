#!/usr/bin/env python3
"""Round 2 security and concurrency probes on the verifier's 39311 instance."""
import concurrent.futures as cf
import hashlib
import json
import os
import sqlite3
import threading
import time
import adversarial as a

os.environ['DL_VERIFY_RESULT_FILE'] = 'round2-new-results.json'
auth = a.call('POST','/api/v1/auth/login',{'username':'admin','password':'streamarr-dev'})[1]
a.ADMIN = auth.get('accessToken') or auth['token']
a.VIEWERS = {v['username']:v for v in a.call('GET','/api/v1/config/viewers',token=a.ADMIN)[1]}
token = a.login('anna')
movie = a.call('POST','/api/v1/viewer/downloads/candidates',dict(workId='tmdb-movie-10378',device=a.TV),token)[1]
big = next(c['version']['releaseId'] for c in movie['candidates'] if 'BluRay.DDP5.1' in c['version']['name'])
base = '/api/v1/viewer/downloads/'

def record(did,t=token):
    return a.call('GET',base+did+'?deviceId=verify-device',token=t)[1]

def prepare(**kw):
    req = dict(workId='tmdb-movie-10378',releaseId=big,device=a.TV,deviceId='verify-device')
    req.update(kw)
    s,d,_ = a.call('POST',base.rstrip('/'),req,token)
    assert s == 202,(s,d)
    return d

# Security sign-out while the resolver is still running.
s,fault,_ = a.call('POST','/devworld/faults',dict(fault='resolve_hang',scope={'viewer':'anna'},mode='once',params={'seconds':4}),a.ADMIN)
assert s == 201,fault
pending = prepare(clientRef='revoke-while-preparing')
for _ in range(50):
    state=record(pending['downloadId'])['state']
    if state == 'resolving':break
    time.sleep(.02)
a.call('DELETE','/api/v1/config/viewers/'+a.VIEWERS['anna']['id']+'/sessions',token=a.ADMIN)
token = a.login('anna')
d = a.wait(token,pending['downloadId'])
d = record(d['downloadId'],token)
status = a.call('HEAD',d['fileUrl'])[0] if d.get('fileUrl') else None
a.check('security sign-out also covers preparing downloads',not d.get('fileUrl') and d.get('fileUrlRevoked') is True,dict(before=state,after=d['state'],fileUrlRevoked=d.get('fileUrlRevoked'),fileStatus=status))
a.call('DELETE','/devworld/faults/'+fault['id'],token=a.ADMIN)

# A real rotation resumes using the same ETag and byte offsets.
d = a.wait(token,prepare(clientRef='round2-rotate')['downloadId'])
s,full,h = a.call('GET',d['fileUrl'])
url,tag = d['fileUrl'],d['eTag']
a.call('DELETE','/api/v1/config/viewers/'+a.VIEWERS['anna']['id']+'/sessions',token=a.ADMIN)
token = a.login('anna')
old = a.call('GET',url,headers={'Range':'bytes=100-'})
s,renewed,_ = a.call('POST',base+d['downloadId']+'/renew?deviceId=verify-device',{},token)
s2,part,h2 = a.call('GET',renewed['fileUrl'],headers={'Range':'bytes=100-','If-Range':tag})
a.check('rotated capability resumes identical bytes with original If-Range',old[0]==410 and old[1]['error']['code']=='download_revoked' and s==200 and renewed['fileUrl']!=url and s2==206 and part==full[100:] and h2['ETag']==tag,dict(oldStatus=old[0],renewStatus=s,resumeStatus=s2,sha256=hashlib.sha256(full[:100]+part).hexdigest(),eTag=h2.get('ETag')))

# Concurrent renewals after rotation must return a working URL to every caller.
a.call('DELETE','/api/v1/config/viewers/'+a.VIEWERS['anna']['id']+'/sessions',token=a.ADMIN)
token = a.login('anna')
barrier=threading.Barrier(10)
def renew(_):
    barrier.wait()
    return a.call('POST',base+d['downloadId']+'/renew?deviceId=verify-device',{},token)[:2]
with cf.ThreadPoolExecutor(max_workers=10) as pool:
    with sqlite3.connect(a.OUT/'state/streamarr.db') as db:
        db.execute('BEGIN IMMEDIATE')
        jobs=[pool.submit(renew,n) for n in range(10)]
        time.sleep(1)
        db.rollback()
    answers=[job.result() for job in jobs]
urls={v['fileUrl'] for s,v in answers if s==200}
statuses=[a.call('HEAD',u)[0] for u in urls]
a.check('concurrent renewals return one usable capability',len(urls)==1 and statuses==[200],dict(responseStatuses=[s for s,_ in answers],distinctUrls=len(urls),fileStatuses=statuses))

# Delimiter ambiguity: these are different valid viewer/device/clientRef tuples.
d1=prepare(deviceId='alpha|beta',clientRef='gamma')
d2=prepare(deviceId='alpha',clientRef='beta|gamma')
a.check('distinct device and client references do not collide',d1['downloadId']!=d2['downloadId'],dict(firstDownload=d1['downloadId'],secondDownload=d2['downloadId']))

# Dynamic rate changes and self-probes checked through live admin state.
a.check('preparations leave no live hold',not a.activity()['throttled'] and a.activity()['liveStreams']==0,dict(liveStreams=a.activity()['liveStreams'],throttled=a.activity()['throttled']))
print(str(sum(r['passed'] for r in a.RESULTS))+'/'+str(len(a.RESULTS))+' round2 assertions passed',flush=True)
