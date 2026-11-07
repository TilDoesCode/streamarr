#!/usr/bin/env python3
"""Live stream/download rates, no-starvation and pause/resume on verifier port."""
import http.client
import json
import os
import socket
import threading
import time
import adversarial as a

os.environ['DL_VERIFY_RESULT_FILE'] = 'priority-results.json'
auth = a.call('POST','/api/v1/auth/login',{'username':'admin','password':'streamarr-dev'})[1]
a.ADMIN = auth.get('accessToken') or auth['token']
token = a.login('anna')
movie = a.call('POST','/api/v1/viewer/downloads/candidates',dict(workId='tmdb-movie-10378',device=a.TV),token)[1]
big = next(c['version']['releaseId'] for c in movie['candidates'] if 'BluRay.DDP5.1' in c['version']['name'])
uhd = next(c['version']['releaseId'] for c in movie['candidates'] if '2160p' in c['version']['name'])
d = a.prepare(token,'tmdb-movie-10378',big)
s, play, _ = a.call('POST','/api/v1/viewer/playback',dict(workId='tmdb-movie-10378',releaseId=uhd,device=a.TV),token)
assert s == 202, (s,play)
while play['state'] not in ('ready','failed'):
    play = a.call('GET','/api/v1/viewer/playback/'+play['playbackId']+'?waitMs=2000',token=token)[1]
assert play['state'] == 'ready', play
a.settings(bandwidthWhileStreamingKbps=512,bandwidthKbps=0)
# Resolve-time probes also set the live signal. Let their documented hold drain.
time.sleep(16)
start = time.monotonic()
s, data, _ = a.call('GET',d['fileUrl'],headers={'Range':'bytes=0-2097151'})
baseline = len(data)/(time.monotonic()-start)
stop_live = threading.Event()
live_bytes = [0]
live_errors = []
def live():
    while not stop_live.is_set():
        c = http.client.HTTPConnection('127.0.0.1',39311,timeout=10)
        c.connect()
        c.sock.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,65536)
        c.request('GET','/api/v1/stream/'+play['streamToken'])
        r = c.getresponse()
        try:
            while not stop_live.is_set():
                data = r.read(16384)
                if not data:
                    break
                live_bytes[0] += len(data)
                time.sleep(.04)
        except Exception as e:
            live_errors.append(type(e).__name__)
        finally:
            c.close()
thread = threading.Thread(target=live,daemon=True)
thread.start()
time.sleep(1)
reader = a.Reader(d['fileUrl'])
time.sleep(1)
before, lb = reader.got, live_bytes[0]
start = time.monotonic()
time.sleep(5)
together = (reader.got-before)/(time.monotonic()-start)
live_rate = (live_bytes[0]-lb)/(time.monotonic()-start)
activity = a.activity()
a.check('download yields to live stream and still progresses', together > 0 and together < 100000 and activity['throttled'], {'downloadBaselineBps':round(baseline),'downloadWithLiveBps':round(together),'liveBps':round(live_rate),'mediaRequiredBps':round(16783910/60),'liveStreams':activity['liveStreams'],'errors':live_errors})
a.settings(bandwidthWhileStreamingKbps=0)
time.sleep(1)
before = reader.got
time.sleep(2)
a.check('cap zero pauses download while live plays', reader.got == before and not reader.done.is_set(), {'bytesAdvanced':reader.got-before,'liveStreams':a.activity()['liveStreams']})
stop_live.set()
thread.join(3)
a.call('POST','/api/v1/viewer/playback/'+play['playbackId']+'/stop',{},token)
before = reader.got
start = time.monotonic()
ended = reader.done.wait(25)
elapsed = time.monotonic()-start
# The signal intentionally holds for 15 s after the live response closes.
after_rate = (reader.got-before)/max(.01,elapsed-15)
a.check('paused download resumes and speeds up after live ends and hold drains', ended and reader.got == d['sizeBytes'] and not a.activity()['throttled'] and after_rate > together*2, {'completed':ended,'bytes':reader.got,'expected':d['sizeBytes'],'secondsIncludingHold':round(elapsed,2),'rateAfterHoldBps':round(after_rate),'liveStreams':a.activity()['liveStreams']})
reader.abort()
a.settings(bandwidthWhileStreamingKbps=16000,bandwidthKbps=0)
a.call('DELETE','/api/v1/viewer/downloads/'+d['downloadId'],token=token)
(a.OUT/'priority-results.json').write_text(json.dumps(a.RESULTS,indent=2))
