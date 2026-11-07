#!/usr/bin/env python3
"""Same-release fallback, admin authorization and independent stream/download limits."""
import json
import os
import time
import adversarial as a

os.environ['DL_VERIFY_RESULT_FILE'] = 'extras-results.json'
auth = a.call('POST','/api/v1/auth/login',{'username':'admin','password':'streamarr-dev'})[1]
a.ADMIN = auth.get('accessToken') or auth['token']
anna, gast = a.login('anna'), a.login('gast')
admin_status = a.call('GET','/api/v1/config/viewers/downloads',token=gast)[0]
anonymous_status = a.call('GET','/api/v1/config/viewers/downloads')[0]
a.check('admin activity cannot be read by a viewer or anonymous caller', admin_status in (401,403) and anonymous_status == 401, {'viewer':admin_status,'anonymous':anonymous_status})
season = a.call('POST','/api/v1/viewer/downloads/candidates/season',dict(workId='tmdb-tv-19885-s02',device=a.TV),anna)[1]
pack = next(p for p in season['packs'] if '1080p' in p['version']['name'])
s, fault, _ = a.call('POST','/devworld/faults',dict(fault='resolve_dead',scope={'viewer':'anna'},mode='once'),a.ADMIN)
assert s == 201, fault
d = a.prepare(anna,'tmdb-tv-19885-s02e01',pack['version']['releaseId'])
attempts = d['attempts']
a.check('dead pack copy falls back only to same-release mirror', d['state']=='ready' and [x['status'] for x in attempts]==['dead','ready'] and len({x['name'] for x in attempts})==1 and d['fallbackFrom'] is not None, {'state':d['state'],'attempts':attempts,'fallbackFrom':d['fallbackFrom']})
a.call('DELETE','/devworld/faults/'+fault['id'],token=a.ADMIN)
movie = a.call('POST','/api/v1/viewer/downloads/candidates',dict(workId='tmdb-movie-10378',device=a.TV),gast)[1]
release = next(c['version']['releaseId'] for c in movie['candidates'] if 'BluRay.DDP5.1' in c['version']['name'])
files = [a.prepare(gast,'tmdb-movie-10378',release) for _ in range(2)]
a.settings(bandwidthKbps=128,bandwidthWhileStreamingKbps=128)
readers = [a.Reader(d['fileUrl']) for d in files]
s, play, _ = a.call('POST','/api/v1/viewer/playback',dict(workId='tmdb-movie-10378',releaseId=release,device=a.TV),gast)
while s == 202 and play['state'] not in ('ready','failed'):
    play = a.call('GET','/api/v1/viewer/playback/'+play['playbackId']+'?waitMs=2000',token=gast)[1]
other_device = a.login('gast')
s2, denied, _ = a.call('POST','/api/v1/viewer/playback',dict(workId='tmdb-movie-10331',device=a.TV),other_device)
a.check('two transfers coexist with one live playback at maxConcurrentStreams=1', s==202 and play['state']=='ready' and all(r.status==200 for r in readers) and s2==409, {'firstPlayback':s,'state':play['state'],'transfers':[r.status for r in readers],'secondPlayback':s2,'error':denied})
for r in readers:r.abort()
if play.get('playbackId'): a.call('POST','/api/v1/viewer/playback/'+play['playbackId']+'/stop',{},gast)
for d in files:a.call('DELETE','/api/v1/viewer/downloads/'+d['downloadId'],token=gast)
a.settings(bandwidthKbps=0,bandwidthWhileStreamingKbps=16000)
a.check('all extra-test transfer slots released',a.active_zero()==0)

# Reports from different versions can have different durations.
import datetime as dt
now = dt.datetime.now(dt.timezone.utc)
a.call('POST','/api/v1/viewer/watch/unplayed',{'workIds':['tmdb-tv-990001-s01e24']},anna)
for age,duration,position,pid in [(0,1000,300,'new-duration'),(2,500,475,'old-complete')]:
    s, state, _ = a.call('POST','/api/v1/viewer/watch/progress',dict(event='progress',workId='tmdb-tv-990001-s01e24',positionTicks=position*10_000_000,durationTicks=duration*10_000_000,playbackId=pid,occurredAt=(now-dt.timedelta(days=age)).isoformat()),anna)
a.check('old completion uses its own reported duration',s==200 and state['played'] and state['playCount']==1 and state['positionTicks']==300*10_000_000, {k:state.get(k) for k in ['durationTicks','positionTicks','played','playCount']})
