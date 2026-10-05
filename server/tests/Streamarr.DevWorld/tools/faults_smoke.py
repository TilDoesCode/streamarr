#!/usr/bin/env python3
"""Live check of the Dev World fault layer (/devworld/faults) against a running Dev World.

Usage: faults_smoke.py [base_url] [--only name,name] [--json FILE] [--list]
Default base_url http://127.0.0.1:39310. Never run it against a Dev World other agents use for real playback
(it arms global faults for a moment); a fresh instance is best.

For every fault it arms the fault against a fresh or shared playback of the Dev World's movies (viewers anna and
kind), provokes it with plain HTTP and checks the wire behaviour (status, envelope code, headers, body change,
timing), clears it and prints one PASS/FAIL line. Also checks list/get/clear, once/always/count, scope isolation
and global exclusivity. Exits non-zero when any check fails. Reusable helpers: arm(), clear(), start_playback().
"""
import http.client
import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ARGS = sys.argv[1:]
if ARGS and ARGS[0] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0)


def option(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        value = ARGS[i + 1]
        del ARGS[i:i + 2]
        return value
    return default


ONLY = set(filter(None, (option("--only") or "").split(",")))
JSON_OUT = option("--json")
LIST = "--list" in ARGS
if LIST:
    ARGS.remove("--list")
BASE = (ARGS[0] if ARGS else "http://127.0.0.1:39310").rstrip("/")
HOST = urllib.parse.urlparse(BASE)
results = []

CHROME = {"platform": "web", "vlcAvailable": False, "engines": [
    {"engine": "web", "hls": True, "maxAudioChannels": 2, "containers": ["mp4", "webm"],
     "videoCodecs": [{"codec": "h264"}, {"codec": "vp9"}, {"codec": "av1", "maxBitDepth": 10}, {"codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10"]}],
     "audioCodecs": [{"codec": "aac"}, {"codec": "mp3"}, {"codec": "opus"}, {"codec": "flac"}],
     "subtitleFormats": ["webvtt"]}]}


# ---------------------------------------------------------------- HTTP helpers

class Resp:
    def __init__(self, status, headers, body, error=None, seconds=0.0):
        self.status, self.headers, self.body, self.error, self.seconds = status, headers, body, error, seconds

    def json(self):
        try:
            return json.loads(self.body)
        except ValueError:
            return None

    def code(self):
        j = self.json()
        return (j or {}).get("error", {}).get("code") if isinstance(j, dict) else None

    def header(self, name):
        return next((v for k, v in self.headers.items() if k.lower() == name.lower()), None)

    def __repr__(self):
        return f"{self.status} {self.code() or ''} {len(self.body or b'')}B {self.error or ''}".strip()


def raw(method, path, body=None, token=None, headers=None, timeout=60):
    """One request over http.client so resets and short bodies are visible instead of raised."""
    started = time.time()
    conn = http.client.HTTPConnection(HOST.hostname, HOST.port, timeout=timeout)
    hdrs = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    if path.startswith("http"):
        path = urllib.parse.urlparse(path).path
    try:
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        headers_out = dict(resp.getheaders())
        chunks = []
        try:
            while True:
                chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
            payload = b"".join(chunks)
            declared = resp.getheader("Content-Length")
            error = "incomplete" if declared is not None and method != "HEAD" and len(payload) < int(declared) else None
            return Resp(resp.status, headers_out, payload, error, time.time() - started)
        except http.client.IncompleteRead as e:
            return Resp(resp.status, headers_out, b"".join(chunks) + e.partial, "incomplete", time.time() - started)
        except (ConnectionError, OSError) as e:
            return Resp(resp.status, headers_out, b"".join(chunks), f"reset:{type(e).__name__}", time.time() - started)
    except (ConnectionError, http.client.RemoteDisconnected, OSError) as e:
        return Resp(0, {}, b"", f"transport:{type(e).__name__}", time.time() - started)
    finally:
        conn.close()


def api(method, path, body=None, token=None, timeout=60):
    r = raw(method, path, body, token, timeout=timeout)
    return r.status, r.json()


def arm(fault, scope, **extra):
    body = {"fault": fault, "scope": scope}
    body.update(extra)
    status, answer = api("POST", "/devworld/faults", body)
    if status != 201:
        raise RuntimeError(f"arm {fault}: {status} {answer}")
    return answer["id"]


def clear(scope=None):
    raw("DELETE", "/devworld/faults" + (f"?scope={urllib.parse.quote(scope)}" if scope else ""))


def fault_info(fault_id):
    return api("GET", f"/devworld/faults/{fault_id}")[1]


def login(user, device="faults-smoke"):
    status, body = api("POST", "/api/v1/viewer/auth/login",
                       {"login": user, "password": "streamarr", "deviceName": device, "clientName": "faults-smoke"})
    assert status == 200 and body.get("session"), f"login {user}: {status} {body}"
    return body["session"]


def start_playback(token, work_id, release_id, wait_ready=True, timeout=120):
    status, body = api("POST", "/api/v1/viewer/playback",
                       {"workId": work_id, "releaseId": release_id, "device": CHROME, "preferences": {}}, token)
    if status != 202 or not wait_ready:
        return status, body
    return status, wait_state(token, body["playbackId"], ("ready", "failed"), timeout)


def wait_state(token, playback_id, states, timeout=120):
    deadline = time.time() + timeout
    body = None
    while time.time() < deadline:
        status, body = api("GET", f"/api/v1/viewer/playback/{playback_id}", token=token)
        if status != 200 or body["state"] in states:
            return body
        time.sleep(0.3)
    return body


def stop(token, playback_id):
    raw("POST", f"/api/v1/viewer/playback/{playback_id}/stop", {}, token)


# ---------------------------------------------------------------- fixtures

manifest = json.loads(urllib.request.urlopen(BASE + "/devworld.json", timeout=30).read())


def release(title, variant):
    for t in manifest["titles"]:
        if t["title"] == title:
            for r in t.get("releases", []):
                if r["variant"] == variant and r.get("health", "ready") == "ready":
                    return t["workId"], r["releaseId"]
    raise KeyError(f"{title} {variant}")


REMUX = release("Sintel", "mkv-dualaudio-ass-1080p")          # remux, audio renditions 1/2, subtitles 3/4/5
DIRECT = release("Big Buck Bunny", "mp4-h264-aac-1080p")       # direct play
TRANSCODE = release("Night of the Living Dead", "mpg-mpeg2-ac3-480p")  # transcode (ffmpeg runs continuously)
DIRECT2 = release("Cosmos Laundromat", "mp4-h264-aac-1080p")
DIRECT3 = release("Sprite Fright", "mp4-h264-aac-1080p")
BIG_REMUX = release("Sintel", "mkv-hevc-hdr10-dts-1080p")


class Ctx:
    anna = None
    kind = None
    hls = None
    direct = None


ctx = Ctx()


def hls_base():
    return ctx.hls["url"].rsplit("/", 1)[0]


def direct_url():
    return ctx.direct["url"]


def ensure_hls():
    if not ctx.hls or api("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"])[0] != 200 \
            or raw("GET", ctx.hls["url"]).status != 200:
        _, ctx.hls = start_playback(ctx.anna["accessToken"], *REMUX)
        assert ctx.hls["state"] == "ready" and ctx.hls["method"] == "remux", f"remux playback: {ctx.hls}"
    return ctx.hls


def ensure_direct():
    if not ctx.direct or raw("GET", ctx.direct["url"], headers={"Range": "bytes=0-1"}).status not in (200, 206):
        _, ctx.direct = start_playback(ctx.anna["accessToken"], *DIRECT)
        assert ctx.direct["state"] == "ready" and ctx.direct["method"] == "direct", f"direct playback: {ctx.direct}"
    return ctx.direct


def pb(p):
    return {"playbackId": p["playbackId"]}


# ---------------------------------------------------------------- checks (each returns (ok, detail))

def faulted(r, fid):
    return r.header("X-DevWorld-Fault") == fid


def check_seg_delay():
    ensure_hls()
    url = hls_base() + "/0.m4s"
    fid = arm("seg_delay", pb(ctx.hls), target="video", params={"ms": 1500})
    a, b = raw("GET", url), raw("GET", url)
    return a.status == 200 and a.seconds >= 1.4 and faulted(a, fid) and b.seconds < 1.0 and not faulted(b, fid), \
        f"faulted {a.seconds:.2f}s, next {b.seconds:.2f}s (once)"


def check_seg_stall():
    ensure_hls()
    fid = arm("seg_stall", pb(ctx.hls), target="video", params={"seconds": 2, "respond": True})
    a = raw("GET", hls_base() + "/1.m4s")
    fid2 = arm("seg_stall", pb(ctx.hls), target="video")
    b = raw("GET", hls_base() + "/1.m4s", timeout=2)
    hits = fault_info(fid2)["lastHits"]
    return a.status == 504 and a.code() == "segment_timeout" and a.seconds >= 1.9 and faulted(a, fid) and b.status == 0, \
        f"respond: {a} after {a.seconds:.1f}s; open stall: client timed out ({b.error}), server saw {hits[-1]['status'] if hits else 'no hit yet'}"


def check_seg_status():
    ensure_hls()
    base = hls_base()
    out = []
    ok = True
    for target, path, status, code, retry in (("video", "/2.m4s", 503, "segment_evicted", None), ("video", "/2.m4s", 503, "segment_unavailable", 2),
                                              ("master", "/master.m3u8", 404, "unknown_transcode", None), ("media", "/main.m3u8", 410, "session_closed", None),
                                              ("init", "/init.mp4", 500, "transcode_failed", None), ("video", "/2.m4s", 404, "end_of_stream", None),
                                              ("video", "/2.m4s", 504, "segment_timeout", None)):
        params = {"status": status, "code": code}
        if retry:
            params["retryAfter"] = retry
        fid = arm("seg_status", pb(ctx.hls), target=target, params=params)
        r, again = raw("GET", base + path), raw("GET", base + path)
        good = r.status == status and r.code() == code and r.header("Retry-After") == (str(retry) if retry else None) \
            and faulted(r, fid) and again.status == 200
        ok &= good
        out.append(f"{target} {status} {code}{' RA=' + str(retry) if retry else ''}{'' if good else ' FAIL ' + repr(r)}")
    return ok, "; ".join(out) + "; next request 200 each time (once)"


def check_seg_reset():
    ensure_hls()
    full = raw("GET", hls_base() + "/3.m4s")
    fid = arm("seg_reset", pb(ctx.hls), target="video", params={"afterBytes": 1000})
    r = raw("GET", hls_base() + "/3.m4s")
    return r.error is not None and len(r.body) <= 1000 < len(full.body) and faulted(r, fid), \
        f"{r.error} after {len(r.body)}/{len(full.body)} bytes"


def check_seg_truncate():
    ensure_hls()
    full = raw("GET", hls_base() + "/3.m4s")
    fid = arm("seg_truncate", pb(ctx.hls), target="video", params={"percent": 50})
    r = raw("GET", hls_base() + "/3.m4s")
    declared = int(r.header("Content-Length") or 0)
    return r.error is not None and declared == len(full.body) and abs(len(r.body) - len(full.body) // 2) <= 1 and faulted(r, fid), \
        f"Content-Length {declared}, got {len(r.body)} ({r.error})"


def check_seg_corrupt():
    ensure_hls()
    out, ok = [], True
    for target, path in (("video", "/4.m4s"), ("init", "/init.mp4")):
        for mode in ("mdat", "box", "garbage") if target == "video" else ("box",):
            clean = raw("GET", hls_base() + path)
            fid = arm("seg_corrupt", pb(ctx.hls), target=target, params={"mode": mode})
            r = raw("GET", hls_base() + path)
            diff = sum(1 for x, y in zip(r.body, clean.body) if x != y)
            good = r.status == 200 and len(r.body) == len(clean.body) and diff > 0 and faulted(r, fid)
            ok &= good
            out.append(f"{target}/{mode}: {diff} of {len(r.body)} bytes differ")
    return ok, "; ".join(out)


def check_rendition_status():
    ensure_hls()
    out, ok = [], True
    for status, code, path in ((404, "unknown_audio_rendition", "/audio/2/main.m3u8"), (500, "rendition_split_failed", "/audio/2/0.m4s")):
        fid = arm("rendition_status", pb(ctx.hls), target="audio", rendition="2", params={"status": status, "code": code}, mode="always")
        r = raw("GET", hls_base() + path)
        other = raw("GET", hls_base() + path.replace("/2/", "/1/"))
        clear(f"playbackId:{ctx.hls['playbackId']}")
        good = r.status == status and r.code() == code and other.status == 200 and faulted(r, fid)
        ok &= good
        out.append(f"rendition 2 {r}, rendition 1 {other.status}")
    return ok, "; ".join(out)


def check_split_abort():
    ensure_hls()
    full = raw("GET", hls_base() + "/audio/1/1.m4s")
    fid = arm("split_abort", pb(ctx.hls), target="audio", rendition="1", params={"afterBytes": 500})
    r = raw("GET", hls_base() + "/audio/1/1.m4s")
    return r.status == 200 and r.error is not None and len(r.body) <= 500 < len(full.body) and faulted(r, fid), \
        f"200 then {r.error} after {len(r.body)}/{len(full.body)} bytes"


def check_subtitle_status():
    ensure_hls()
    fid = arm("subtitle_status", pb(ctx.hls), target="subtitle", rendition="3", params={"status": 404}, mode="always")
    a = raw("GET", hls_base() + "/subtitles/3/main.m3u8")
    b = raw("GET", hls_base() + "/subtitles/4/main.m3u8")
    return a.status == 404 and a.code() == "unknown_subtitle_stream" and b.status == 200 and faulted(a, fid), f"stream 3 {a}, stream 4 {b.status}"


def check_subtitle_corrupt():
    ensure_hls()
    path = hls_base() + "/subtitles/3/0.vtt"
    clean = raw("GET", path).body.decode()
    arm("subtitle_corrupt", pb(ctx.hls), target="subtitle", params={"mode": "header"})
    header = raw("GET", path).body.decode()
    arm("subtitle_corrupt", pb(ctx.hls), target="subtitle", params={"mode": "timing"})
    timing = raw("GET", path).body.decode()
    ok = clean.lstrip("﻿").startswith("WEBVTT") and not header.lstrip("﻿").startswith("WEBVTT") and "-->" in clean \
        and "99:77:xx.000" in timing
    return ok, f"clean starts {clean[:6]!r}, header mode starts {header[:12]!r}, timing mode has invalid cue times: {'99:77:xx.000' in timing}"


def check_content_type():
    ensure_hls()
    out, ok = [], True
    for target, path, value in (("master", "/master.m3u8", "text/html"), ("media", "/main.m3u8", "application/octet-stream"),
                                ("video", "/0.m4s", "text/html"), ("subtitle", "/subtitles/3/0.vtt", "application/octet-stream")):
        fid = arm("content_type", pb(ctx.hls), target=target, params={"value": value})
        r = raw("GET", hls_base() + path)
        good = r.status == 200 and (r.header("Content-Type") or "").startswith(value) and faulted(r, fid)
        ok &= good
        out.append(f"{target}: {r.header('Content-Type')}")
    return ok, "; ".join(out)


def playlist_entries(text):
    return [line for line in text.splitlines() if line and not line.startswith("#")]


def check_playlist_endless():
    ensure_hls()
    clean = raw("GET", hls_base() + "/main.m3u8").body.decode()
    fid = arm("playlist_endless", pb(ctx.hls), target="media", params={"segments": 3}, mode="always")
    a, b = raw("GET", hls_base() + "/main.m3u8"), raw("GET", hls_base() + "/main.m3u8")
    text = a.body.decode()
    ok = "#EXT-X-ENDLIST" in clean and "#EXT-X-ENDLIST" not in text and "PLAYLIST-TYPE:VOD" not in text \
        and len(playlist_entries(text)) == 3 and b.body == a.body and faulted(a, fid)
    return ok, f"{len(playlist_entries(clean))} -> {len(playlist_entries(text))} segments, no ENDLIST, unchanged on reload"


def check_playlist_event_stale():
    ensure_hls()
    fid = arm("playlist_event_stale", pb(ctx.hls), target="media", params={"segments": 4})
    text = raw("GET", hls_base() + "/main.m3u8").body.decode()
    ok = "#EXT-X-PLAYLIST-TYPE:EVENT" in text and "#EXT-X-ENDLIST" not in text and len(playlist_entries(text)) == 4
    return ok, f"EVENT playlist with {len(playlist_entries(text))} segments, no ENDLIST"


def check_early_end():
    ensure_hls()
    playlist = raw("GET", hls_base() + "/main.m3u8").body.decode()
    durations = [float(line[8:].split(",")[0]) for line in playlist.splitlines() if line.startswith("#EXTINF:")]
    starts = [sum(durations[:i]) for i in range(len(durations))]
    cut = next(i for i, s in enumerate(starts) if s >= 12)
    fid = arm("early_end", pb(ctx.hls), target="video", params={"atSeconds": 12}, mode="always")
    before, at = raw("GET", hls_base() + f"/{cut - 1}.m4s"), raw("GET", hls_base() + f"/{cut}.m4s")
    clear(f"playbackId:{ctx.hls['playbackId']}")
    ensure_direct()
    fid2 = arm("early_end", pb(ctx.direct), target="direct", params={"atSeconds": 60}, mode="always")
    head = raw("GET", direct_url(), headers={"Range": "bytes=0-"})
    beyond = raw("GET", direct_url(), headers={"Range": f"bytes={len(head.body) + 10}-"})
    total = int((head.header("Content-Range") or "/0").split("/")[1])
    ok = before.status == 200 and at.status == 404 and at.code() == "end_of_stream" and faulted(at, fid) \
        and head.status == 206 and len(head.body) < total and beyond.status == 416
    return ok, f"HLS segment {cut - 1} 200, {cut} (starts {starts[cut]:.1f}s) {at}; direct body {len(head.body)}/{total} bytes, beyond -> {beyond.status}"


def check_throttle():
    ensure_hls()
    clean = raw("GET", hls_base() + "/5.m4s")
    kbps = max(64, len(clean.body) * 8 / 1000 / 2)  # about 2 s for the segment
    fid = arm("throttle", pb(ctx.hls), target="video", params={"kbps": kbps})
    r = raw("GET", hls_base() + "/5.m4s")
    ensure_direct()
    arm("throttle", pb(ctx.direct), target="direct", params={"kbps": 800})
    d = raw("GET", direct_url(), headers={"Range": "bytes=0-199999"})
    ok = r.status == 200 and r.body == clean.body and r.seconds >= 1.7 and faulted(r, fid) and len(d.body) == 200000 and d.seconds >= 1.8
    return ok, f"HLS {len(r.body)} B in {r.seconds:.1f}s at {kbps:.0f} kbit/s (clean {clean.seconds:.2f}s); direct 200 kB in {d.seconds:.1f}s at 800 kbit/s"


def check_direct_status():
    ensure_direct()
    out, ok = [], True
    for status, code in ((429, "stream_capacity"), (404, "unknown_stream"), (500, "internal_error"), (416, None)):
        fid = arm("direct_status", pb(ctx.direct), params={"status": status})
        r = raw("GET", direct_url(), headers={"Range": "bytes=0-99"})
        again = raw("GET", direct_url(), headers={"Range": "bytes=0-99"})
        good = r.status == status and faulted(r, fid) and again.status == 206
        if status == 429:
            good &= r.code() == code and r.header("Retry-After") == "1"
        elif status == 416:
            good &= (r.header("Content-Range") or "").startswith("bytes */")
        else:
            good &= r.code() == code
        ok &= good
        out.append(f"{status} {r.code() or r.header('Content-Range')}{' RA=' + r.header('Retry-After') if r.header('Retry-After') else ''}")
    return ok, "; ".join(out) + "; next request 206 each time"


def check_direct_reset():
    ensure_direct()
    fid = arm("direct_reset", pb(ctx.direct), params={"afterBytes": 100000})
    r = raw("GET", direct_url(), headers={"Range": "bytes=0-"})
    return r.error is not None and len(r.body) <= 100000 and faulted(r, fid), f"{r.error} after {len(r.body)} bytes"


def check_direct_truncate():
    ensure_direct()
    fid = arm("direct_truncate", pb(ctx.direct), params={"percent": 50}, mode="always")
    head = raw("GET", direct_url(), headers={"Range": "bytes=0-"})
    total = int((head.header("Content-Range") or "/0").split("/")[1])
    beyond = raw("GET", direct_url(), headers={"Range": f"bytes={int(total * 0.6)}-"})
    ok = head.status == 206 and abs(len(head.body) - total // 2) <= 1 and beyond.status == 416 \
        and beyond.header("Content-Range") == f"bytes */{total}" and faulted(head, fid)
    return ok, f"bytes=0- -> {len(head.body)}/{total}; range at 60 % -> {beyond.status} {beyond.header('Content-Range')}"


def fresh_direct(work_release=DIRECT2):
    _, p = start_playback(ctx.anna["accessToken"], *work_release)
    assert p["state"] == "ready" and p["method"] == "direct", p
    return p


def check_usenet_hole():
    # Before start: the server's own health check finds the hole. Mid-play: only where the read-ahead has not been yet.
    fid = arm("usenet_hole", {"workId": DIRECT2[0]}, params={"fromPercent": 40, "toPercent": 60}, ttlSeconds=120)
    status, body = start_playback(ctx.anna["accessToken"], *DIRECT2, wait_ready=False)
    final = wait_state(ctx.anna["accessToken"], body["playbackId"], ("ready", "failed"), 60)
    action = fault_info(fid)["lastHits"][0]["status"]
    clear()
    stop(ctx.anna["accessToken"], body["playbackId"])
    code = (final.get("error") or {}).get("code")
    _, p = start_playback(ctx.anna["accessToken"], *BIG_REMUX)
    arm("usenet_hole", pb(p), params={"fromPercent": 70, "toPercent": 95}, ttlSeconds=120)
    url = f"/api/v1/stream/{p['streamToken']}"
    head = raw("GET", url, headers={"Range": "bytes=0-1"})
    total = int((head.header("Content-Range") or "/0").split("/")[1])
    hole = raw("GET", url, headers={"Range": f"bytes={int(total * 0.9)}-{int(total * 0.9) + 65535}"}, timeout=8)
    stop(ctx.anna["accessToken"], p["playbackId"])
    mid = "stalls (server waits for repair)" if hole.status == 0 or hole.error else ("still served (read ahead before the hole)" if hole.status == 206 else f"server answers {hole.status} {hole.code() or ''}")
    return code == "release_dead", f"{action}; armed before start -> playback {final['state']} {code}; armed mid-play at 90 % of a {total // 1048576} MiB file: {mid}"


def check_usenet_stall():
    arm("usenet_stall", {"workId": DIRECT3[0]}, params={"ms": 1500}, ttlSeconds=120)
    started = time.time()
    p = fresh_direct(DIRECT3)
    ready = time.time() - started
    r = raw("GET", p["url"], headers={"Range": "bytes=0-65535"}, timeout=30)
    stop(ctx.anna["accessToken"], p["playbackId"])
    return r.status == 206 and len(r.body) == 65536 and ready >= 1.4, f"article bodies held 1.5 s: playback ready after {ready:.1f}s, then {r}"


def pid_files_with(token):
    import glob
    import os
    state = os.path.join(manifest.get("cacheDir", ""), f"state-{HOST.port}", "faults", "ffmpeg-pids")
    hits = []
    for f in glob.glob(os.path.join(state, "*")):
        try:
            if token in open(f).read():
                hits.append(open(f).read())
        except OSError:
            pass
    return hits


def check_transcode_kill():
    _, p = start_playback(ctx.anna["accessToken"], *TRANSCODE)
    assert p["state"] == "ready" and p["method"] == "transcode", p
    base = p["url"].rsplit("/", 1)[0]
    first = raw("GET", base + "/0.m4s", timeout=90)
    status, armed = api("POST", "/devworld/faults", {"fault": "transcode_kill", "scope": pb(p)})
    seen = []
    deadline = time.time() + 60
    n = 1
    while time.time() < deadline and n < 40:
        r = raw("GET", base + f"/{n}.m4s", timeout=90)
        seen.append(r.status)
        if r.status != 200:
            break
        n += 1
    stop(ctx.anna["accessToken"], p["playbackId"])
    ok = status == 201 and first.status == 200 and "killed" in (armed.get("action") or "") and not armed["action"].startswith("killed 0")
    return ok, f"{armed.get('action')}; following segments: {seen[-5:]} (500 transcode_failed or restart)"


def check_transcode_slow():
    arm("transcode_slow", {"next": "anna"}, params={"readrate": 0.5})
    started = time.time()
    _, p = start_playback(ctx.anna["accessToken"], *TRANSCODE)
    ready = time.time() - started
    base = p["url"].rsplit("/", 1)[0]
    playlist = raw("GET", base + "/main.m3u8").body.decode()
    first = float(next(line[8:].split(",")[0] for line in playlist.splitlines() if line.startswith("#EXTINF:")))
    seg_started = time.time()
    r = raw("GET", base + "/1.m4s", timeout=120)
    took = time.time() - seg_started
    args = pid_files_with(p["streamToken"])
    stop(ctx.anna["accessToken"], p["playbackId"])
    slow = any("-readrate 0.5" in a for a in args)
    return r.status == 200 and slow and ready + took >= first * 2 * 0.9, \
        f"ffmpeg started with -readrate 0.5: {slow}; segments 0+1 ({2 * first:.0f}s of media) after {ready + took:.1f}s"


def start_failure(fault, params=None, release_pair=REMUX, wait=60):
    fid = arm(fault, {"next": "anna"}, params=params or {})
    started = time.time()
    status, body = start_playback(ctx.anna["accessToken"], *release_pair, wait_ready=False)
    final = wait_state(ctx.anna["accessToken"], body["playbackId"], ("ready", "failed"), wait)
    info = fault_info(fid)
    stop(ctx.anna["accessToken"], body["playbackId"])
    return final, info, time.time() - started


def check_transcode_never_start():
    out, ok = [], True
    for code in ("transcode_capacity", "ffmpeg_unavailable"):
        final, info, _ = start_failure("transcode_never_start", {"code": code})
        good = info["fault"]["hits"] >= 1 and final["state"] in ("failed", "ready")
        ok &= good
        out.append(f"{code}: hit {info['fault']['hits']}x, playback {final['state']} {(final.get('error') or {}).get('code') or final.get('method')}")
    return ok, "; ".join(out)


def watch_state(fault, params, state_name, seconds):
    fid = arm(fault, {"next": "anna"}, params=params)
    _, body = start_playback(ctx.anna["accessToken"], *REMUX, wait_ready=False)
    time.sleep(seconds)
    _, now = api("GET", f"/api/v1/viewer/playback/{body['playbackId']}", token=ctx.anna["accessToken"])
    info = fault_info(fid)
    stop(ctx.anna["accessToken"], body["playbackId"])
    return now["state"], info


def check_start_hang():
    state, info = watch_state("start_hang", {"seconds": 30}, "starting", 6)
    last = info["lastHits"][-1]["status"] if info["lastHits"] else "no hit"
    return state == "starting" and info["fault"]["hits"] == 1, f"after 6 s the playback is still {state} ({last})"


def check_probe_fail():
    final, info, _ = start_failure("probe_fail")
    return info["fault"]["hits"] >= 1 and final["state"] in ("failed", "ready"), \
        f"hit {info['fault']['hits']}x, playback {final['state']} {(final.get('error') or {}).get('code') or final.get('method')}"


def check_stream_dead():
    ensure_hls()
    fid = arm("stream_dead", pb(ctx.hls))
    status, body = api("POST", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}/switch", {"positionTicks": 0}, ctx.anna["accessToken"])
    final = wait_state(ctx.anna["accessToken"], ctx.hls["playbackId"], ("ready", "failed"), 60)
    info = fault_info(fid)
    ctx.hls = final if final and final.get("state") == "ready" else None
    return status == 202 and info["fault"]["hits"] == 1 and final["state"] == "ready", \
        f"switch {status}: stream capability reported dead ({info['fault']['hits']}x), playback re-resolved -> {final['state']} rev {final.get('revision')}"


def check_resolve_hang():
    state, info = watch_state("resolve_hang", {"seconds": 30}, "resolving", 6)
    return state == "resolving" and info["fault"]["hits"] == 1, f"after 6 s the playback is still {state}"


def check_resolve_dead():
    final, info, _ = start_failure("resolve_dead")
    attempts = [a.get("status") for a in final.get("attempts", [])]
    code = (final.get("error") or {}).get("code")
    return info["fault"]["hits"] == 1 and ("dead" in attempts or code == "release_dead"), f"attempts {attempts}, playback {final['state']} {(final.get('error') or {}).get('code') or ''}"


def check_api_status():
    token = ctx.anna["accessToken"]
    fid = arm("api_status", {"next": "anna"}, target="api:start",
              params={"status": 409, "code": "too_many_streams", "params": {"device": "Wohnzimmer-TV", "limit": "1"}})
    r = raw("POST", "/api/v1/viewer/playback", {"workId": DIRECT[0], "releaseId": DIRECT[1], "device": CHROME, "preferences": {}}, token)
    again = raw("POST", "/api/v1/viewer/playback", {"workId": DIRECT[0], "releaseId": DIRECT[1], "device": CHROME, "preferences": {}}, token)
    if again.status == 202:
        stop(token, again.json()["playbackId"])
    params = (r.json() or {}).get("error", {}).get("params") or {}
    ensure_hls()
    fid2 = arm("api_status", pb(ctx.hls), target="api:poll", params={"body": "html", "status": 502})
    html = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=token)
    ok = r.status == 409 and r.code() == "too_many_streams" and params == {"device": "Wohnzimmer-TV", "limit": "1"} and faulted(r, fid) \
        and again.status == 202 and html.status == 502 and "text/html" in (html.header("Content-Type") or "")
    return ok, f"start {r} params {params}; next start {again.status}; poll html {html.status} {html.header('Content-Type')}"


def check_api_delay():
    ensure_hls()
    fid = arm("api_delay", pb(ctx.hls), target="api:poll", params={"ms": 1500})
    r = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"])
    return r.status == 200 and r.seconds >= 1.4 and faulted(r, fid), f"poll took {r.seconds:.2f}s"


def check_api_drop():
    ensure_hls()
    arm("api_drop", pb(ctx.hls), target="api:poll")
    r = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"])
    again = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"])
    return r.status == 0 and r.error and again.status == 200, f"poll -> {r.error}; next poll {again.status}"


def check_playback_stuck():
    ensure_hls()
    fid = arm("playback_stuck", pb(ctx.hls), target="api:poll", params={"state": "starting", "seconds": 3}, mode="always")
    a = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"]).json()
    time.sleep(3.5)
    b = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"]).json()
    ok = a["state"] == "starting" and a["pollAfterMs"] == 500 and a.get("url") is None and b["state"] == "ready"
    return ok, f"poll says {a['state']} (pollAfterMs {a['pollAfterMs']}, url {a.get('url')}); after 3.5 s {b['state']}"


def check_playback_failed():
    ensure_hls()
    arm("playback_failed", pb(ctx.hls), target="api:poll",
        params={"code": "transcode_failed", "params": {"reason": "devworld"}, "suggestedActions": ["retry", "other_version"]})
    a = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"]).json()
    b = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"]).json()
    ok = a["state"] == "failed" and a["error"]["code"] == "transcode_failed" and a["suggestedActions"] == ["retry", "other_version"] \
        and b["state"] == "ready"
    return ok, f"poll {a['state']} {a['error']['code']} {a['suggestedActions']}; next poll {b['state']}"


def check_captive_portal():
    ensure_hls()
    fid = arm("captive_portal", {"viewer": "anna"}, mode="always")
    poll = raw("GET", f"/api/v1/viewer/playback/{ctx.hls['playbackId']}", token=ctx.anna["accessToken"])
    media = raw("GET", ctx.hls["url"])
    other = raw("GET", "/api/v1/viewer/me", token=ctx.kind["accessToken"])
    clear()
    ok = poll.status == 200 and b"Hotel Wi-Fi" in poll.body and "text/html" in poll.header("Content-Type") \
        and b"Hotel Wi-Fi" in media.body and b"Hotel Wi-Fi" not in other.body and faulted(poll, fid)
    return ok, f"anna API + media -> 200 text/html portal; kind -> {other.status} {other.header('Content-Type')}"


def check_token_expire():
    session = login("gast", "faults-expire")
    me = raw("GET", "/api/v1/viewer/me", token=session["accessToken"])
    arm("token_expire", {"viewer": "gast"})
    after = raw("GET", "/api/v1/viewer/me", token=session["accessToken"])
    status, refreshed = api("POST", "/api/v1/viewer/auth/refresh", {"refreshToken": session["refreshToken"]})
    again = raw("GET", "/api/v1/viewer/me", token=(refreshed or {}).get("accessToken"))
    ok = me.status == 200 and after.status == 401 and status == 200 and again.status == 200
    return ok, f"me {me.status} -> {after.status} {after.code()}; refresh {status}; new token {again.status}"


def check_refresh_fail():
    out, ok = [], True
    for params, expect in (({"code": "refresh_session_revoked", "reason": "session_limit"}, (401, "refresh_session_revoked")),
                           ({"code": "refresh_token_reused"}, (401, "refresh_token_reused")),
                           ({"code": "refresh_session_expired"}, (401, "refresh_session_expired")),
                           ({"code": "refresh_token_unknown"}, (401, "refresh_token_unknown")),
                           ({"status": 500}, (500, "internal_error")),
                           ({"drop": True}, (0, None)),
                           ({"delayMs": 1500}, (200, None))):
        session = login("gast", "faults-refresh")
        fid = arm("refresh_fail", {"viewer": "gast"}, params=params)
        r = raw("POST", "/api/v1/viewer/auth/refresh", {"refreshToken": session["refreshToken"]})
        good = r.status == expect[0] and r.code() == expect[1]
        if "reason" in params:
            good &= (r.json() or {}).get("error", {}).get("params", {}).get("reason") == params["reason"]
        if "delayMs" in params:
            good &= r.seconds >= 1.4
        ok &= good
        out.append(f"{list(params)[0]}={list(params.values())[0]}: {r.status} {r.code() or r.error or ''}".strip())
    session = login("gast", "faults-refresh")
    arm("refresh_fail", {"viewer": "anna"}, params={"code": "refresh_token_unknown"})
    other = raw("POST", "/api/v1/viewer/auth/refresh", {"refreshToken": session["refreshToken"]})
    clear()
    ok &= other.status == 200
    return ok, "; ".join(out) + f"; a fault for anna leaves gast's refresh at {other.status}"


def check_session_revoke():
    out, ok = [], True
    for reason in ("password_changed", "session_limit", "signed_out", "token_reused"):
        session = login("gast", "faults-revoke")
        arm("session_revoke", {"viewer": "gast"}, params={"reason": reason})
        api_call = raw("GET", "/api/v1/viewer/me", token=session["accessToken"])
        r = raw("POST", "/api/v1/viewer/auth/refresh", {"refreshToken": session["refreshToken"]})
        got = (r.json() or {}).get("error", {}).get("params", {}).get("reason")
        good = api_call.status == 401 and r.status == 401 and r.code() == "refresh_session_revoked" and got == reason
        ok &= good
        out.append(f"{reason}: api {api_call.status}, refresh {r.code()} reason {got}")
    return ok, "; ".join(out)


def check_password_change():
    session = login("gast", "faults-password")
    fid = arm("password_change", {"viewer": "gast"}, mode="always")
    r = raw("POST", "/api/v1/viewer/playback", {"workId": DIRECT[0], "device": CHROME, "preferences": {}}, session["accessToken"])
    raw("DELETE", f"/devworld/faults/{fid}")
    time.sleep(0.5)
    session = login("gast", "faults-password")
    again = raw("GET", "/api/v1/viewer/me", token=session["accessToken"])
    return r.status == 403 and r.code() == "password_change_required" and again.status == 200 and \
        not (again.json() or {}).get("mustChangePassword", False), f"start {r}; after clearing: me {again.status}"


def check_playback_gone():
    _, p = start_playback(ctx.anna["accessToken"], *REMUX)
    before = raw("GET", p["url"])
    status, armed = api("POST", "/devworld/faults", {"fault": "playback_gone", "scope": pb(p), "mode": "always"})
    poll = raw("GET", f"/api/v1/viewer/playback/{p['playbackId']}", token=ctx.anna["accessToken"])
    switch = raw("POST", f"/api/v1/viewer/playback/{p['playbackId']}/switch", {"positionTicks": 0}, ctx.anna["accessToken"])
    media = raw("GET", p["url"])
    ok = before.status == 200 and poll.status == 404 and poll.code() == "playback_not_found" and switch.status == 404 and media.status == 404
    return ok, f"{armed.get('action')}; poll {poll}, switch {switch.status}, master {media}"


def check_api_lifecycle():
    """List/get/delete/clear, count mode, TTL field, redaction, invalid requests, scope isolation, global exclusivity."""
    ensure_direct()
    kind_pb = start_playback(ctx.kind["accessToken"], *DIRECT)[1]
    out, ok = [], True
    fid = arm("direct_status", pb(ctx.direct), params={"status": 503, "code": "segment_unavailable"}, mode={"count": 2})
    rs = [raw("GET", direct_url(), headers={"Range": "bytes=0-9"}).status for _ in range(3)]
    other = raw("GET", kind_pb["url"], headers={"Range": "bytes=0-9"})
    info = fault_info(fid)
    listed = api("GET", "/devworld/faults")[1]
    token = ctx.direct["url"].rsplit("/", 1)[-1]
    redacted = all(token not in h["path"] for h in info["lastHits"])
    good = rs == [503, 503, 206] and other.status == 206 and info["fault"]["remaining"] == 0 and info["fault"]["hits"] == 2 \
        and any(f["id"] == fid for f in listed) and redacted
    ok &= good
    out.append(f"count:2 -> {rs}; kind's playback {other.status} (isolation); hits/remaining {info['fault']['hits']}/{info['fault']['remaining']}; tokens redacted {redacted}")
    g = arm("direct_status", {"global": True}, params={"status": 500}, mode="always")
    second = api("POST", "/devworld/faults", {"fault": "seg_delay", "scope": {"global": True}, "params": {"ms": 1}})
    both = [raw("GET", u, headers={"Range": "bytes=0-9"}).status for u in (direct_url(), kind_pb["url"])]
    deleted = raw("DELETE", f"/devworld/faults/{g}").status
    after = raw("GET", kind_pb["url"], headers={"Range": "bytes=0-9"}).status
    good = second[0] == 400 and both == [500, 500] and deleted == 204 and after == 206
    ok &= good
    out.append(f"global -> {both}; second global {second[0]}; DELETE {deleted}; after {after}")
    bad = [api("POST", "/devworld/faults", b)[0] for b in (
        {"fault": "nope", "scope": {"global": True}}, {"fault": "seg_status", "scope": {}},
        {"fault": "seg_status", "scope": {"global": True}, "target": "direct"}, {"fault": "token_expire", "scope": {"global": True}},
        {"fault": "seg_delay", "scope": {"global": True}}, {"fault": "seg_status", "scope": {"global": True}, "ttlSeconds": 9000})]
    good = bad == [400] * 6
    ok &= good
    out.append(f"invalid requests {bad}")
    arm("seg_delay", {"viewer": "anna"}, params={"ms": 1}, mode="always")
    arm("seg_delay", {"viewer": "kind"}, params={"ms": 1}, mode="always")
    clear("viewer:anna")
    left = [f["scope"] for f in api("GET", "/devworld/faults")[1]]
    clear()
    empty = api("GET", "/devworld/faults")[1]
    good = "viewer:anna" not in left and "viewer:kind" in left and empty == []
    ok &= good
    out.append(f"clear ?scope=viewer:anna leaves {left}; clear all -> {empty}")
    stop(ctx.kind["accessToken"], kind_pb["playbackId"])
    return ok, "; ".join(out)


CHECKS = [
    ("seg_delay", check_seg_delay), ("seg_stall", check_seg_stall), ("seg_status", check_seg_status),
    ("seg_reset", check_seg_reset), ("seg_truncate", check_seg_truncate), ("seg_corrupt", check_seg_corrupt),
    ("rendition_status", check_rendition_status), ("split_abort", check_split_abort),
    ("subtitle_status", check_subtitle_status), ("subtitle_corrupt", check_subtitle_corrupt),
    ("content_type", check_content_type), ("playlist_endless", check_playlist_endless),
    ("playlist_event_stale", check_playlist_event_stale), ("early_end", check_early_end), ("throttle", check_throttle),
    ("direct_status", check_direct_status), ("direct_reset", check_direct_reset), ("direct_truncate", check_direct_truncate),
    ("usenet_hole", check_usenet_hole), ("usenet_stall", check_usenet_stall),
    ("transcode_kill", check_transcode_kill), ("transcode_slow", check_transcode_slow),
    ("transcode_never_start", check_transcode_never_start), ("start_hang", check_start_hang), ("probe_fail", check_probe_fail),
    ("stream_dead", check_stream_dead), ("resolve_hang", check_resolve_hang), ("resolve_dead", check_resolve_dead),
    ("api_status", check_api_status), ("api_delay", check_api_delay), ("api_drop", check_api_drop),
    ("playback_stuck", check_playback_stuck), ("playback_failed", check_playback_failed), ("captive_portal", check_captive_portal),
    ("token_expire", check_token_expire), ("refresh_fail", check_refresh_fail), ("session_revoke", check_session_revoke),
    ("password_change", check_password_change), ("playback_gone", check_playback_gone),
    ("api_lifecycle", check_api_lifecycle),
]


def main():
    if LIST:
        print("\n".join(name for name, _ in CHECKS))
        return 0
    clear()
    ctx.anna = login("anna")
    ctx.kind = login("kind")
    failed = 0
    for name, fn in CHECKS:
        if ONLY and name not in ONLY:
            continue
        started = time.time()
        try:
            ok, detail = fn()
        except Exception as e:  # noqa: BLE001
            ok, detail = False, f"{type(e).__name__}: {e}"
        finally:
            clear()
        failed += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {name:22} {time.time() - started:5.1f}s  {detail}", flush=True)
        results.append({"fault": name, "ok": bool(ok), "detail": detail})
    for p in (ctx.hls, ctx.direct):
        if p:
            stop(ctx.anna["accessToken"], p["playbackId"])
    print(f"{len(results) - failed}/{len(results)} passed")
    if JSON_OUT:
        with open(JSON_OUT, "w") as fh:
            json.dump(results, fh, indent=2)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
