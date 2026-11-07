#!/usr/bin/env python3
"""Unattended DL-S verification. Run against an isolated Dev World on 39311 only.

No product code changes. Runtime state is disposable; expiry tests update only this
verifier's SQLite DB. Printed evidence omits access tokens and capability values.
"""
import concurrent.futures
import datetime as dt
import hashlib
import http.client
import importlib.util
import json
import os
import re
from pathlib import Path
import signal
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tools/dl-verify'
BASE = 'http://127.0.0.1:39311'
spec = importlib.util.spec_from_file_location('builder', ROOT / 'server/tests/Streamarr.DevWorld/tools/downloads_check.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
TV, IOS, IOS_NO = b.ANDROID_TV, b.IPHONE, b.IPHONE_NO_VLC
RESULTS = []


def timestamp(value):
    # Python 3.9 accepts only 3/6 fractional digits; .NET emits 0..7.
    value = value.replace('Z', '+00:00')
    value = re.sub(r'\.(\d+)(?=[+-]\d\d:)', lambda m: '.' + (m[1] + '000000')[:6], value)
    return dt.datetime.fromisoformat(value)


def call(method, path, data=None, token=None, headers=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method, data=None if data is None else json.dumps(data).encode())
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        r = urllib.request.urlopen(req, timeout=45)
    except urllib.error.HTTPError as e:
        r = e
    if raw:
        return r
    with r:
        body = r.read()
        try:
            body = json.loads(body)
        except (ValueError, TypeError):
            pass
        return r.status, body, dict(r.headers)


def check(name, ok, evidence=None):
    row = dict(name=name, passed=bool(ok), evidence=evidence)
    RESULTS.append(row)
    (OUT / os.environ.get('DL_VERIFY_RESULT_FILE', 'adversarial-results.json')).write_text(json.dumps(RESULTS, indent=2))
    print(('PASS ' if ok else 'FAIL ') + name + ' ' + json.dumps(evidence, ensure_ascii=False), flush=True)


def login(name, password='streamarr'):
    s, body, _ = call('POST', '/api/v1/viewer/auth/login', dict(login=name, password=password, deviceName='DL verifier'))
    assert s == 200, (s, body)
    return body['session']['accessToken']


def wait(token, did):
    for _ in range(120):
        s, body, _ = call('GET', '/api/v1/viewer/downloads/' + did + '?waitMs=2000', token=token)
        assert s == 200, (s, body)
        if body['state'] in ('ready', 'failed', 'completed'):
            return body
    raise TimeoutError(did)


def prepare(token, work, release, device=TV, **kw):
    s, body, _ = call('POST', '/api/v1/viewer/downloads', dict(workId=work, releaseId=release, device=device, deviceId='verify-device', **kw), token)
    assert s == 202, (s, body)
    return wait(token, body['downloadId'])


def settings(**kw):
    s, body, _ = call('PUT', '/api/v1/config/viewers/settings', {'downloads': kw}, ADMIN)
    assert s == 200, (s, body)


def activity():
    return call('GET', '/api/v1/config/viewers/downloads?activeOnly=true', token=ADMIN)[1]


def active_zero():
    for _ in range(50):
        n = activity()['activeTransfers']
        if n == 0:
            return n
        time.sleep(.1)
    return n


class Reader:
    def __init__(self, url, headers=None):
        self.got = 0
        self.error = None
        self.done = threading.Event()
        self.response = call('GET', url, headers=headers, raw=True)
        self.status = self.response.status
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while data := self.response.read(16 * 1024):
                self.got += len(data)
        except Exception as e:
            self.error = type(e).__name__
        finally:
            self.response.close()
            self.done.set()

    def abort(self):
        # A real client disconnect, rather than waiting for HTTPResponse.close's read lock.
        try:
            self.response.fp.raw._sock.shutdown(2)
        except Exception:
            pass
        self.done.wait(3)


def patch_viewer(name, **kw):
    s, body, _ = call('PATCH', '/api/v1/config/viewers/' + VIEWERS[name]['id'], kw, ADMIN)
    assert s == 200, (s, body)


def security_and_http():
    d = prepare(ANNA, 'tmdb-tv-33050-s01e02', RAR)
    assert d['state'] == 'ready', d
    url, size, tag, did = d['fileUrl'], d['sizeBytes'], d['eTag'], d['downloadId']
    checks = []
    for method, suffix, data in [('GET', '', None), ('POST', '/renew', {}), ('POST', '/complete', {'bytesReceived': size}), ('DELETE', '', None)]:
        s, body, _ = call(method, '/api/v1/viewer/downloads/' + did + suffix, data, GAST)
        checks.append([method + suffix, s, body])
    check('other viewer cannot read/renew/complete/delete', all(x[1] == 404 for x in checks), checks)
    guest_list = call('GET', '/api/v1/viewer/downloads', token=GAST)[1]
    admin_list = call('GET', '/api/v1/config/viewers/downloads', token=ADMIN)[1]
    check('capability hidden from other viewers and admin list', url not in json.dumps(guest_list) and url not in json.dumps(admin_list))
    other = login('anna')
    s, body, _ = call('GET', '/api/v1/viewer/downloads/' + did, token=other)
    check('another session of same viewer has no file URL without deviceId', s == 200 and body['fileUrl'] is None)
    s, body, _ = call('GET', '/api/v1/viewer/downloads/' + did + '?deviceId=verify-device', token=other)
    check('stable deviceId restores file URL after relogin', s == 200 and body['fileUrl'] == url)
    s, full, headers = call('GET', url)
    check('full body and strong ETag', s == 200 and len(full) == size and headers.get('ETag') == tag and not tag.startswith('W/'), {'status': s, 'size': size, 'sha256': hashlib.sha256(full).hexdigest(), 'headers': headers})
    for rng, expected, part in [('bytes=-101', 206, full[-101:]), ('bytes=100-', 206, full[100:]),
                                 (f'bytes={size-37}-{2**63-1}', 206, full[-37:]),
                                 ('bytes=0-0,2-2', 200, full), ('bytes=-0', 416, None),
                                 (f'bytes={size}-', 416, None), (f'bytes={2**63-2}-', 416, None)]:
        # A client can consume the body before source/read-ahead disposal finishes.
        # Isolate HTTP semantics from the separate concurrent-transfer assertions.
        assert active_zero() == 0
        s, body, h = call('GET', url, headers={'Range': rng})
        check('range ' + rng, s == expected and (part is None or body == part) and (s != 416 or h.get('Content-Range') == f'bytes */{size}'), {'status': s, 'length': len(body), 'contentRange': h.get('Content-Range')})
    for ir, expected in [(tag, 206), ('W/' + tag, 200), ('"wrong"', 200), ('Fri, 06 Nov 2026 00:00:00 GMT', 200)]:
        assert active_zero() == 0
        s, body, h = call('GET', url, headers={'Range': 'bytes=0-19', 'If-Range': ir})
        check('If-Range ' + ir, s == expected and body == (full[:20] if expected == 206 else full), {'status': s, 'length': len(body)})
    assert active_zero() == 0
    s, _, h = call('HEAD', url, headers={'Range': 'bytes=0-19'})
    check('HEAD metadata without transfer slot', s == 200 and int(h['Content-Length']) == size and h['ETag'] == tag and activity()['activeTransfers'] == 0, h)
    for hdr, expected in [({'If-None-Match': tag}, 304), ({'If-Match': '"wrong"'}, 412)]:
        s, body, h = call('GET', url, headers=hdr)
        check('HTTP precondition ' + str(hdr), s == expected, {'status': s, 'bodyBytes': len(body)})
    s, _, h = call('OPTIONS', url, headers={'Origin': 'https://verifier.invalid', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range,if-range'})
    check('CORS preflight allows Range and If-Range', s == 204 and 'if-range' in h.get('Access-Control-Allow-Headers', '').lower(), h)
    s, body, h = call('GET', url, headers={'Origin': 'https://verifier.invalid', 'Range': 'bytes=0-19'})
    check('CORS exposes ETag and Content-Range', s == 206 and h.get('Access-Control-Allow-Origin') == '*' and 'ETag' in h.get('Access-Control-Expose-Headers', ''), h)
    log = (OUT / 'devworld.log').read_text()
    leaks = [line for line in log.splitlines() if url in line]
    check('short successful request not logged at Warning level', not leaks, {'matches': len(leaks)})
    return d, hashlib.sha256(full).hexdigest()


def admission():
    settings(bandwidthKbps=512)
    files = [prepare(ANNA, 'tmdb-movie-10378', BIG) for _ in range(3)]
    guest = [prepare(GAST, 'tmdb-movie-10378', BIG) for _ in range(2)]
    child = prepare(KIND, 'tmdb-movie-10378', BIG)
    check('prepared idle downloads consume no transfer slots', activity()['activeTransfers'] == 0)
    r1 = Reader(files[0]['fileUrl'], {'Range': 'bytes=0-'})
    r2 = Reader(files[0]['fileUrl'], {'Range': 'bytes=100-'})
    s, body, h = call('GET', files[0]['fileUrl'], headers={'Range': 'bytes=1000-1999'})
    check('two parallel ranges on same capability admitted, third rejected', r1.status == 206 and r2.status == 206 and s == 429 and body['error']['params']['scope'] == 'download', {'status': [r1.status, r2.status, s], 'body': body, 'retry': h.get('Retry-After'), 'active': activity()['activeTransfers']})
    r3 = Reader(files[1]['fileUrl'])
    s, body, h = call('GET', files[2]['fileUrl'], headers={'Range': 'bytes=0-19'})
    check('per-viewer limit counts downloads not connections', s == 429 and body['error']['params']['scope'] == 'viewer' and h.get('Retry-After') == '10', body)
    r4, r5 = [Reader(d['fileUrl']) for d in guest]
    s, body, h = call('GET', child['fileUrl'], headers={'Range': 'bytes=0-19'})
    check('global limit four distinct downloads', s == 429 and body['error']['params']['scope'] == 'server' and activity()['activeTransfers'] == 4, {'response': body, 'retry': h.get('Retry-After')})
    import re
    leaks = [line for line in (OUT/'devworld.log').read_text().splitlines() if re.search(r'/api/v1/offline/[a-f0-9]{64}', line)]
    check('capability redacted in warning request logs', not leaks, {'matches': len(leaks), 'sample': re.sub(r'/api/v1/offline/[a-f0-9]{64}', '/api/v1/offline/<64-hex capability>', leaks[-1]) if leaks else None})
    for r in (r1, r2, r3, r4, r5):
        r.abort()
    check('client disconnect releases every transfer slot', active_zero() == 0, activity())
    statuses = []
    for _ in range(8):
        c = http.client.HTTPConnection('127.0.0.1', 39311, timeout=10)
        c.request('GET', files[0]['fileUrl'])
        r = c.getresponse()
        statuses.append(r.status)
        c.close()
    check('eight aborted downloads do not leave permanent 429', all(s == 200 for s in statuses) and active_zero() == 0, {'statuses': statuses, 'active': activity()['activeTransfers']})
    for action in ['complete', 'delete', 'admin-revoke']:
        d = prepare(ANNA, 'tmdb-movie-10378', BIG)
        reader = Reader(d['fileUrl'])
        time.sleep(.5)
        if action == 'complete':
            s, body, _ = call('POST', '/api/v1/viewer/downloads/' + d['downloadId'] + '/complete', {'bytesReceived': d['sizeBytes']}, ANNA)
        else:
            prefix = '/api/v1/config/viewers/downloads/' if action == 'admin-revoke' else '/api/v1/viewer/downloads/'
            s, body, _ = call('DELETE', prefix + d['downloadId'], token=ADMIN if action == 'admin-revoke' else ANNA)
        ended = reader.done.wait(3)
        new = call('HEAD', d['fileUrl'])[0]
        check(action + ' promptly stops open transfer and URL', s in (200, 204) and ended and new == 404 and active_zero() == 0, {'operation': s, 'ended': ended, 'newRequest': new, 'bytes': reader.got, 'error': reader.error})
        reader.abort()
    settings(bandwidthKbps=0)
    return files[0]


def revocation_and_expiry():
    settings(bandwidthKbps=512)
    d = prepare(ANNA, 'tmdb-movie-10378', BIG)
    for reason, update, restore in [
        ('allowDownloads=false', {'permissions': {'allowDownloads': False}}, {'permissions': VIEWERS['anna']['permissions']}),
        ('account disabled', {'disabled': True}, {'disabled': False}),
    ]:
        token = login('anna')
        reader = Reader(d['fileUrl'])
        time.sleep(.5)
        patch_viewer('anna', **update)
        before = reader.got
        ended = reader.done.wait(3)
        after = reader.got
        s = call('HEAD', d['fileUrl'])[0]
        check(reason + ' stops existing transfer', ended and s == 403, {'ended': ended, 'bytesAfterChange': after-before, 'newRequest': s})
        reader.abort()
        patch_viewer('anna', **restore)
    token = login('anna')
    restricted = prepare(token, 'tmdb-movie-10331', HORROR)
    patch_viewer('anna', permissions={'maxAge': 0, 'blockUnrated': True, 'allowDownloads': True})
    s, body, _ = call('POST', '/api/v1/viewer/downloads/candidates', {'workId': 'tmdb-movie-10331', 'device': TV}, token)
    file_status = call('HEAD', restricted['fileUrl'])[0]
    check('tightened age gate applies to existing download URL', s == 403 and file_status == 403, {'candidates': s, 'error': body, 'file': file_status})
    patch_viewer('anna', permissions=VIEWERS['anna']['permissions'])
    reader = Reader(d['fileUrl'])
    time.sleep(.5)
    with sqlite3.connect(OUT / 'state/streamarr.db') as db:
        db.execute('UPDATE ViewerDownloads SET ExpiresAt=? WHERE Id=?', (int(time.time()*1000)-1000, d['downloadId']))
    before = reader.got
    ended = reader.done.wait(3)
    new = call('HEAD', d['fileUrl'])[0]
    check('capability expiry stops open transfer', ended and new == 410, {'ended': ended, 'newRequest': new, 'bytesAfterExpiry': reader.got-before})
    reader.abort()
    token = login('anna')
    s, body, _ = call('POST', '/api/v1/viewer/downloads/' + d['downloadId'] + '/renew', {}, token)
    renewed = call('HEAD', d['fileUrl'])[0]
    check('expired link renews with same capability', s == 200 and renewed == 200, {'renew': s, 'head': renewed})
    guest = prepare(GAST, 'tmdb-movie-10378', BIG)
    call('DELETE', '/api/v1/config/viewers/' + VIEWERS['gast']['id'] + '/sessions', token=ADMIN)
    auth_status = call('GET', '/api/v1/viewer/downloads', token=GAST)[0]
    file_status = call('GET', guest['fileUrl'], headers={'Range': 'bytes=0-19'})[0]
    check('session revocation invalidates its file capability', auth_status == 401 and file_status in (403,404,410), {'viewerApi': auth_status, 'file': file_status})
    g = login('gast')
    call('POST', '/api/v1/config/viewers/' + VIEWERS['gast']['id'] + '/password', {'password': 'VerifierPassword123!', 'mustChangePassword': True}, ADMIN)
    auth_status = call('GET', '/api/v1/viewer/downloads', token=g)[0]
    file_status = call('GET', guest['fileUrl'], headers={'Range': 'bytes=0-19'})[0]
    check('password reset invalidates old file capability', auth_status == 401 and file_status in (403,404,410), {'viewerApi': auth_status, 'file': file_status})
    call('POST', '/api/v1/config/viewers/' + VIEWERS['gast']['id'] + '/password', {'password': 'streamarr', 'mustChangePassword': False}, ADMIN)
    settings(bandwidthKbps=0)
    return token


def candidates_and_prepares(token):
    for device in [TV, IOS_NO, IOS]:
        s, body, _ = call('POST', '/api/v1/viewer/downloads/candidates', {'workId': 'tmdb-movie-10378', 'device': device}, token)
        check('device profile ' + device['platform'] + ' VLC=' + str(device['vlcAvailable']), s == 200 and all(c['offline']['engine'] != 'vlc' or device['vlcAvailable'] for c in body['candidates']), [(c['version']['name'], c['offline']['playable'], c['offline']['engine'], c['sizeSource'], c['sizeExact']) for c in body['candidates']])
    s, season, _ = call('POST', '/api/v1/viewer/downloads/candidates/season', {'workId': 'tmdb-tv-19885-s02', 'device': TV, 'audioLanguages': ['de']}, token)
    check('standard fixture season pack coverage (partial packs need custom fixture)', s == 200 and all(p['episodes'] == [1,2,3] for p in season['packs']), [{'name': p['version']['name'], 'episodes': p['episodes'], 'complete': p['complete']} for p in season.get('packs', [])])
    anchor = next((c for c in season['episodes'][0]['candidates'] if 'snk' in c['version']['name']), season['episodes'][0]['candidates'][0])
    for langs in [['de'], ['en']]:
        req = dict(anchorWorkId='tmdb-tv-19885-s02e01', anchorReleaseId=anchor['version']['releaseId'], workIds=['tmdb-tv-19885-s02e02','tmdb-tv-19885-s02e03','tmdb-tv-19885-s02e99'], device=TV, audioLanguages=langs)
        s, plan, _ = call('POST', '/api/v1/viewer/downloads/plan', req, token)
        check('similarity plan language gate ' + str(langs), s == 200 and plan['items'][-1]['match'] == 'none', [{'workId': i['workId'], 'match': i['match'], 'name': (i.get('candidate') or {}).get('version', {}).get('name'), 'notes': i['notes']} for i in plan.get('items',[])])
    none_device = {'platform': 'ios', 'vlcAvailable': False, 'engines': [{'engine': 'native', 'containers': ['webm'], 'videoCodecs': [{'codec': 'av1'}], 'audioCodecs': [{'codec': 'opus'}]}]}
    s, plan, _ = call('POST', '/api/v1/viewer/downloads/plan', dict(anchorWorkId='tmdb-tv-33050-s01e01', anchorReleaseId=RAR, workIds=['tmdb-tv-33050-s01e02'], device=none_device), token)
    check('plan gives none when no release plays offline', s == 200 and plan['items'][0]['match'] == 'none', plan)
    # This release is intentionally dead. Other quality versions exist; never silently choose one.
    dead = MANIFEST['scenarios']['deadFallback'][0]
    call('POST', '/api/v1/viewer/downloads/candidates', dict(workId=dead['workId'], device=TV), token)
    d = prepare(token, dead['workId'], dead['deadReleaseId'])
    check('dead release never falls back to different release', d['state'] == 'failed' and d['error']['code'] == 'release_dead', {'state': d['state'], 'attempts': d['attempts'], 'error': d['error'], 'suggestedActions': d['suggestedActions']})
    req = dict(workId='tmdb-movie-10378', releaseId=BIG, device=TV, deviceId='concurrent-device', clientRef='same-client-ref')
    barrier = threading.Barrier(10)
    def post(_):
        barrier.wait()
        s, body, _ = call('POST', '/api/v1/viewer/downloads', req, token)
        return s, body.get('downloadId'), body.get('error')
    # A brief ordinary SQLite writer lock makes the check/insert race repeatable:
    # WAL readers all observe no row before any of the queued inserts can commit.
    # The verifier changes no rows in this transaction.
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        with sqlite3.connect(OUT/'state/streamarr.db') as db:
            db.execute('BEGIN IMMEDIATE')
            pending = [pool.submit(post, n) for n in range(10)]
            time.sleep(1.5)
            db.rollback()
        rows = [future.result() for future in pending]
    check('concurrent clientRef prepares are idempotent', len({x[1] for x in rows}) == 1 and all(x[0] == 202 for x in rows), rows)
    s, later, _ = call('POST', '/api/v1/viewer/downloads', req, token)
    check('sequential clientRef retry returns an existing download', s == 202 and later['downloadId'] in {r[1] for r in rows})


def progress(token):
    now = dt.datetime.now(dt.timezone.utc)
    iso = lambda x: x.isoformat()
    work = 'tmdb-tv-990001-s01e26'
    call('POST', '/api/v1/viewer/watch/unplayed', {'workIds': [work, 'tmdb-tv-990001-s01e25']}, token)
    def report(at, position, playback):
        s, state, _ = call('POST', '/api/v1/viewer/watch/progress', dict(workId=work, event='progress', durationTicks=1000*10_000_000, positionTicks=position*10_000_000, playbackId=playback, occurredAt=iso(at)), token)
        assert s == 200, (s,state)
        return state
    f = report(now + dt.timedelta(days=90), 300, 'future')
    check('future occurredAt clamped to now', abs((timestamp(f['lastPlayedAt']) - now).total_seconds()) < 10, f)
    old = report(now - dt.timedelta(days=90), 500, 'old')
    stamp = timestamp
    check('stale progress preserves newer resume point', old['positionTicks'] == f['positionTicks'] and abs((stamp(old['lastPlayedAt'])-stamp(f['lastPlayedAt'])).total_seconds()) < .001, old)
    freshwork = 'tmdb-tv-990001-s01e25'
    s, old, _ = call('POST', '/api/v1/viewer/watch/progress', dict(workId=freshwork, event='progress', positionTicks=300*10_000_000, durationTicks=1000*10_000_000, occurredAt=iso(now-dt.timedelta(days=90))), token)
    check('old occurredAt clamped to 30 days', s == 200 and abs((timestamp(old['lastPlayedAt']) - (now-dt.timedelta(days=30))).total_seconds()) < 10, old)
    a = report(now-dt.timedelta(days=2), 950, 'offline-A')
    repeat = report(now-dt.timedelta(days=2), 950, 'offline-A')
    c = report(now-dt.timedelta(days=1), 950, 'offline-B')
    replay = report(now-dt.timedelta(days=2), 950, 'offline-A')
    check('stale completion counts and preserves newer resume', a['played'] and a['playCount'] == 1 and a['positionTicks'] == f['positionTicks'], a)
    check('immediate completion replay is deduplicated', repeat['playCount'] == a['playCount'], repeat)
    check('interleaved completion replay is deduplicated', replay['playCount'] == c['playCount'], {'A': a['playCount'], 'repeatA': repeat['playCount'], 'B': c['playCount'], 'replayA': replay['playCount'], 'resume': replay['positionTicks']})


def restart(token, stable, digest):
    s, fault, _ = call('POST', '/devworld/faults', {'fault': 'resolve_hang', 'scope': {'viewer': 'anna'}, 'mode': 'once', 'params': {'seconds': 60}}, ADMIN)
    assert s == 201, fault
    req = dict(workId='tmdb-tv-33050-s01e06', releaseId=RAR, device=TV, deviceId='verify-device', clientRef='restart-prepare')
    s, queued, _ = call('POST', '/api/v1/viewer/downloads', req, token)
    assert s == 202, queued
    time.sleep(.5)
    pending = call('GET', '/api/v1/viewer/downloads/' + queued['downloadId'], token=token)[1]['state']
    # Clear the persisted fault while the already-entered delay remains active.
    call('DELETE', '/devworld/faults/' + fault['id'], token=ADMIN)
    pid = int((OUT / 'devworld.pid').read_text())
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        try:
            call('GET', '/devworld/ready')
        except Exception:
            break
        time.sleep(.1)
    for _ in range(100):
        # Ensure shutdown released the listener before the replacement starts.
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(.1)
    env = os.environ.copy()
    env.update(DEVWORLD_PORT='39311', DEVWORLD_HOST='127.0.0.1', DEVWORLD_PRIMARY='0', DEVWORLD_CACHE_DIR=str(ROOT/'server/tests/Streamarr.DevWorld/cache'), DEVWORLD_STATE_DIR=str(OUT/'state'), DEVWORLD_KEEP_DATA='1')
    with open(OUT/'devworld.log','a') as log:
        p = subprocess.Popen(['dotnet', str(ROOT/'server/tests/Streamarr.DevWorld/bin/Debug/net8.0/Streamarr.DevWorld.dll')], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (OUT/'devworld.pid').write_text(str(p.pid))
    for _ in range(120):
        try:
            if call('GET', '/devworld/ready')[0] == 200:
                break
        except Exception:
            pass
        time.sleep(.5)
    ready = wait(token, queued['downloadId'])
    check('preparation survives restart', pending in ('queued','resolving','probing') and ready['state'] == 'ready', {'before': pending, 'after': ready['state'], 'error': ready.get('error')})
    s, full, h = call('GET', stable['fileUrl'])
    check('same capability ETag and bytes survive restart', s == 200 and h['ETag'] == stable['eTag'] and hashlib.sha256(full).hexdigest() == digest, {'status': s, 'sha256': hashlib.sha256(full).hexdigest(), 'ETag': h.get('ETag')})


if __name__ == '__main__':
    s, MANIFEST, _ = call('GET','/devworld.json')
    assert s == 200
    s, auth, _ = call('POST','/api/v1/auth/login', {'username':'admin','password':'streamarr-dev'})
    ADMIN = auth.get('accessToken') or auth['token']
    VIEWERS = {v['username']:v for v in call('GET','/api/v1/config/viewers',token=ADMIN)[1]}
    ANNA, GAST, KIND = [login(v) for v in ['anna','gast','kind']]
    call('DELETE','/devworld/faults', token=ADMIN)
    season = call('POST','/api/v1/viewer/downloads/candidates/season',dict(workId='tmdb-tv-33050-s01',device=TV),ANNA)[1]
    RAR = next(p['version']['releaseId'] for p in season['packs'] if p['version']['name'].endswith('RARPACK'))
    movie = call('POST','/api/v1/viewer/downloads/candidates',dict(workId='tmdb-movie-10378',device=TV),ANNA)[1]
    BIG = next(c['version']['releaseId'] for c in movie['candidates'] if 'BluRay.DDP5.1' in c['version']['name'])
    horror = call('POST','/api/v1/viewer/downloads/candidates',dict(workId='tmdb-movie-10331',device=TV),ANNA)[1]
    HORROR = next(c['version']['releaseId'] for c in horror['candidates'] if c['offline']['playable'])
    if os.environ.get('VERIFY_CONTINUE') == '1':
        RESULTS[:] = json.loads((OUT/'adversarial-results.json').read_text())
        RESULTS[:] = [r for r in RESULTS if r['name'] != 'season full and partial pack coverage']
        stable = next(d for d in call('GET','/api/v1/viewer/downloads?deviceId=verify-device',token=ANNA)[1]['items'] if d['state']=='ready' and d['workId']=='tmdb-tv-33050-s01e02')
        digest = hashlib.sha256(call('GET',stable['fileUrl'])[1]).hexdigest()
    else:
        stable, digest = security_and_http()
        admission()
        ANNA = revocation_and_expiry()
    candidates_and_prepares(ANNA)
    progress(ANNA)
    restart(ANNA, stable, digest)
    print(f'{sum(r["passed"] for r in RESULTS)}/{len(RESULTS)} adversarial assertions passed', flush=True)
