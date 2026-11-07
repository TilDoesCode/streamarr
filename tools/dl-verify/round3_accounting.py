#!/usr/bin/env python3
"""Byte totals across parallel ranges, complete, graceful restart and a hard crash."""
import concurrent.futures as cf
import hashlib
import json
import os
import signal
import sqlite3
import subprocess
import time
import adversarial as a
import world

os.environ['DL_VERIFY_RESULT_FILE'] = 'round3-accounting-results.json'
auth = a.call('POST', '/api/v1/auth/login', dict(username='admin', password='streamarr-dev'))[1]
a.ADMIN = auth.get('accessToken') or auth['token']
token = a.login('anna')
base = '/api/v1/viewer/downloads/'
items = a.call('POST', base + 'candidates', dict(workId='tmdb-movie-10378', device=a.TV), token)[1]['candidates']
release = next(c['version']['releaseId'] for c in items if 'BluRay.DDP5.1' in c['version']['name'])


def prepare():
    return a.prepare(token, 'tmdb-movie-10378', release)


def count(did):
    with sqlite3.connect(a.OUT / 'state/streamarr.db') as db:
        return db.execute('SELECT BytesServed FROM ViewerDownloads WHERE Id=?', (did,)).fetchone()[0]


def reach(did, expected):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        value = count(did)
        if value >= expected:
            return value
        time.sleep(.1)
    return count(did)


d = prepare()
expected = 0
# Warm the source; then count a parallel pair while the accounting writer is blocked.
s, first, _ = a.call('GET', d['fileUrl'], headers={'Range': 'bytes=0-65535'})
assert s == 206
expected += len(first)
assert reach(d['downloadId'], expected) == expected
with cf.ThreadPoolExecutor(max_workers=3) as pool:
    with sqlite3.connect(a.OUT / 'state/streamarr.db') as db:
        db.execute('BEGIN IMMEDIATE')
        jobs = [pool.submit(a.call, 'GET', d['fileUrl'], headers={'Range': rng}) for rng in ['bytes=65536-196607', 'bytes=131072-262143']]
        answers = [job.result() for job in jobs]
        expected += sum(len(body) for s, body, _ in answers if s == 206)
        completed = pool.submit(a.call, 'POST', base + d['downloadId'] + '/complete', dict(bytesReceived=d['sizeBytes']), token)
        time.sleep(.5)
        db.rollback()
    done = completed.result()
served = reach(d['downloadId'], expected)
a.check('parallel range bytes and complete are recorded exactly once after writer contention', all(s == 206 for s, _, _ in answers) and done[0] == 200 and served == expected, dict(rangeStatuses=[s for s, _, _ in answers], complete=done[0], expected=expected, persisted=served))
world.stop()
world.start(keep=True)
a.check('graceful restart preserves completed record totals', count(d['downloadId']) == expected, dict(expected=expected, persisted=count(d['downloadId'])))

# Crash with a known, deliberately unflushed chunk. Best-effort telemetry can lose
# it; capability, ETag and served media bytes must still survive.
token = a.login('anna')
d = prepare()
s, chunk, headers = a.call('GET', d['fileUrl'], headers={'Range': 'bytes=0-65535'})
baseline = reach(d['downloadId'], len(chunk))
with sqlite3.connect(a.OUT / 'state/streamarr.db') as db:
    db.execute('BEGIN IMMEDIATE')
    s, pending, _ = a.call('GET', d['fileUrl'], headers={'Range': 'bytes=65536-131071'})
    pid = int(world.PID.read_text())
    command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
    assert str(world.DLL) in command
    os.kill(pid, signal.SIGKILL)
    time.sleep(.2)
    db.rollback()
world.start(keep=True)
persisted = count(d['downloadId'])
s2, resumed, h2 = a.call('GET', d['fileUrl'], headers={'Range': 'bytes=65536-131071', 'If-Range': headers['ETag']})
a.check('hard crash preserves capability, ETag and range byte identity', s == 206 and s2 == 206 and pending == resumed and h2['ETag'] == headers['ETag'], dict(status=s2, sha256=hashlib.sha256(resumed).hexdigest(), eTag=h2['ETag'], persistedAtCrash=persisted, baseline=baseline, unflushed=len(pending)))
print('CRASH_ACCOUNTING ' + json.dumps(dict(baseline=baseline, beforeCrash=baseline+len(pending), persistedAfterCrash=persisted, lost=baseline+len(pending)-persisted)), flush=True)
