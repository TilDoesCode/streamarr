#!/usr/bin/env python3
"""Live check of the playback robustness follow-ups (B13) against a running Dev World with the fault layer on.

Usage: playback_robustness_check.py [base_url] [--only name,name]
Default base_url http://127.0.0.1:39310. Use a fresh instance: it changes the server's transcoding settings for a
moment (segment retention, throttle) and restores them, and it arms faults for its own playbacks only.

Checks: a stalled transcode answers 504 segment_timeout with Retry-After within the wait budget (~25 s); a seek back
behind the retained window restarts the run at the target instead of waiting; a progress report says whether the
playbackId is still a live server playback (playbackAlive); /switch {audioFallback} converts the selected audio to AAC
stereo (verified with ffprobe on the delivered segment); a cross-origin faulted 503 exposes Retry-After; a /switch on a
playback with an active segment/playlist fault leaves `starting`. Exits non-zero when a check fails.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import faults_smoke as fs  # noqa: E402  (parses argv and loads the manifest on import)

WAIT_BUDGET = 25


def admin_token():
    status, body = fs.api("POST", "/api/v1/auth/login", {"username": "admin", "password": fs.manifest["admin"]["password"]})
    assert status == 200, f"admin login: {status} {body}"
    return body["token"]


def progress(token, playback_id, position, work_id):
    return fs.api("POST", "/api/v1/viewer/watch/progress",
                  {"event": "progress", "workId": work_id, "positionTicks": position, "playbackId": playback_id}, token)


def check_segment_timeout():
    anna = fs.ctx.anna["accessToken"]
    fs.arm("transcode_slow", {"next": "anna"}, params={"readrate": 0.05})
    _, p = fs.start_playback(anna, *fs.TRANSCODE)
    assert p["state"] == "ready" and p["method"] == "transcode", p
    base = p["url"].rsplit("/", 1)[0]
    r = fs.raw("GET", base + "/2.m4s", timeout=120)
    fs.stop(anna, p["playbackId"])
    ok = r.status == 504 and r.code() == "segment_timeout" and r.header("Retry-After") == "1" \
        and WAIT_BUDGET - 1 <= r.seconds <= WAIT_BUDGET + 4
    return ok, f"slow run (-readrate 0.05): segment 2 -> {r.status} {r.code()} Retry-After {r.header('Retry-After')} after {r.seconds:.1f}s"


def check_seek_back_evicted():
    anna, admin = fs.ctx.anna["accessToken"], admin_token()
    _, before = fs.api("GET", "/api/v1/transcoding/config", token=admin)
    status, _ = fs.api("PUT", "/api/v1/transcoding/config", {"segmentRetentionSeconds": 60, "throttleBufferSeconds": 30}, admin)
    assert status == 200, status
    try:
        fs.arm("transcode_slow", {"next": "anna"}, params={"readrate": 3})
        _, p = fs.start_playback(anna, *fs.TRANSCODE)
        assert p["state"] == "ready" and p["method"] == "transcode", p
        base = p["url"].rsplit("/", 1)[0]
        segments = [line for line in fs.raw("GET", base + "/main.m3u8").body.decode().splitlines() if line.endswith(".m4s")]
        last = min(len(segments) - 6, 24)
        assert last >= 18, f"the source is too short for the check ({len(segments)} segments)"
        for i in range(last + 1):
            r = fs.raw("GET", f"{base}/{i}.m4s", timeout=120)
            assert r.status == 200, f"segment {i}: {r}"
        sessions = fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1]
        session = max(sessions, key=lambda s: s.get("job", {}).get("front", 0) if s.get("job") else 0)
        running = session["job"]["running"]
        restarts = session["restarts"]
        time.sleep(16)
        r = fs.raw("GET", f"{base}/1.m4s", timeout=120)
        after = next(s for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1] if s["handle"] == session["handle"])
        fs.stop(anna, p["playbackId"])
        ok = running and r.status == 200 and r.seconds < 15 and after["restarts"] == restarts + 1 and after["job"]["startSegment"] == 1
        return ok, (f"run alive at front {session['job']['front']} after segment {last}; 16 s later segment 1 -> {r.status} in "
                    f"{r.seconds:.1f}s, restarts {restarts} -> {after['restarts']}, new run starts at {after['job']['startSegment']}")
    finally:
        fs.api("PUT", "/api/v1/transcoding/config",
               {"segmentRetentionSeconds": before["segmentRetentionSeconds"], "throttleBufferSeconds": before["throttleBufferSeconds"]}, admin)


def check_playback_alive():
    anna = fs.ctx.anna["accessToken"]
    work_id = fs.DIRECT[0]
    _, p = fs.start_playback(anna, *fs.DIRECT)
    s1, live = progress(anna, p["playbackId"], 100_000_000, work_id)
    fs.stop(anna, p["playbackId"])
    s2, dead = progress(anna, p["playbackId"], 110_000_000, work_id)
    s3, none = progress(anna, None, 120_000_000, work_id)
    ok = (s1, s2, s3) == (200, 200, 200) and live["playbackAlive"] is True and dead["playbackAlive"] is False \
        and none["playbackAlive"] is None and dead["positionTicks"] == 110_000_000
    return ok, f"live -> {live['playbackAlive']}, after stop -> {dead['playbackAlive']} (position saved {dead['positionTicks']}), without id -> {none['playbackAlive']}"


def probe_audio(base, rendition_path=""):
    data = fs.raw("GET", f"{base}/{rendition_path}init.mp4").body + fs.raw("GET", f"{base}/{rendition_path}0.m4s", timeout=120).body
    with tempfile.NamedTemporaryFile(suffix=".mp4") as fh:
        fh.write(data)
        fh.flush()
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name,channels",
                              "-of", "json", fh.name], capture_output=True, text=True, check=False)
    return [(s["codec_name"], s["channels"]) for s in json.loads(out.stdout or "{}").get("streams", [])]


def wait_revision(token, playback_id, revision):
    deadline = time.time() + 120
    while time.time() < deadline:
        _, body = fs.api("GET", f"/api/v1/viewer/playback/{playback_id}", token=token)
        if body["revision"] == revision and body["state"] in ("ready", "failed"):
            return body
        time.sleep(0.3)
    raise TimeoutError(f"revision {revision} of {playback_id}")


def check_audio_fallback():
    anna = fs.ctx.anna["accessToken"]
    out, ok = [], True
    _, d = fs.start_playback(anna, *fs.DIRECT)
    fs.api("POST", f"/api/v1/viewer/playback/{d['playbackId']}/switch", {"positionTicks": 0, "audioFallback": True}, anna)
    d2 = wait_revision(anna, d["playbackId"], 1)
    track = next(t for t in d2["mediaInfo"]["audioTracks"] if t["selected"])
    audio = probe_audio(d2["url"].rsplit("/", 1)[0]) if d2["state"] == "ready" else []
    good = d["method"] == "direct" and d2["method"] == "remux" and d2["audioFallback"] and track["deliveredAs"] == "converted" \
        and audio == [("aac", 2)]
    ok &= good
    out.append(f"direct {d['method']} -> {d2['method']} audioFallback={d2['audioFallback']} {track['deliveredAs']} {track['deliveredCodec']} "
               f"{track['deliveredChannels']} ch, ffprobe {audio}")
    fs.stop(anna, d["playbackId"])

    _, r = fs.start_playback(anna, *fs.REMUX)
    fs.api("POST", f"/api/v1/viewer/playback/{r['playbackId']}/switch", {"audioStreamIndex": 2, "audioFallback": True}, anna)
    r2 = wait_revision(anna, r["playbackId"], 1)
    tracks = {t["index"]: t["deliveredAs"] for t in r2["mediaInfo"]["audioTracks"]}
    audio = probe_audio(r2["url"].rsplit("/", 1)[0]) if r2["state"] == "ready" else []
    fs.api("POST", f"/api/v1/viewer/playback/{r['playbackId']}/switch", {"audioFallback": False}, anna)
    r3 = wait_revision(anna, r["playbackId"], 2)
    good = r["inSessionAudioSwitch"] and r2["method"] == "remux" and not r2["inSessionAudioSwitch"] and tracks.get(2) == "converted" \
        and audio == [("aac", 2)] and not r3["audioFallback"] and r3["inSessionAudioSwitch"]
    ok &= good
    out.append(f"dual audio remux (group {r['inSessionAudioSwitch']}) + track 2 -> {tracks}, group {r2['inSessionAudioSwitch']}, ffprobe {audio}; "
               f"off -> group {r3['inSessionAudioSwitch']}")
    fs.stop(anna, r["playbackId"])
    return ok, "; ".join(out)


def check_cors_retry_after():
    anna = fs.ctx.anna["accessToken"]
    _, p = fs.start_playback(anna, *fs.REMUX)
    base = p["url"].rsplit("/", 1)[0]
    fs.arm("seg_status", fs.pb(p), target="video", params={"status": 503, "code": "segment_unavailable", "retryAfter": 10}, mode="always")
    origin = {"Origin": "http://localhost:8083"}
    pre = fs.raw("OPTIONS", base + "/3.m4s", headers={**origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range"})
    r = fs.raw("GET", base + "/3.m4s", headers=origin)
    fs.stop(anna, p["playbackId"])
    exposed = [h.strip().lower() for h in (r.header("Access-Control-Expose-Headers") or "").split(",")]
    ok = pre.status == 204 and r.status == 503 and r.header("Retry-After") == "10" and r.header("Access-Control-Allow-Origin") \
        and "retry-after" in exposed
    return ok, f"preflight {pre.status}; faulted {r.status} Retry-After {r.header('Retry-After')}, allow-origin {r.header('Access-Control-Allow-Origin')}, exposed {exposed}"


def check_switch_under_fault():
    anna = fs.ctx.anna["accessToken"]
    cases = [
        ("seg_status", {"target": "video", "params": {"status": 503, "code": "segment_unavailable", "retryAfter": 10}, "mode": {"count": 9}},
         {"positionTicks": 410_000_000, "preferences": {"maxHeight": 720}}),
        ("seg_corrupt", {"target": "video", "params": {"how": "garbage"}, "mode": "always"}, {"positionTicks": 290_000_000, "stepDown": True}),
        ("playlist_endless", {"params": {"segments": 10}, "mode": "always"}, {"positionTicks": 450_000_000, "stepDown": True}),
    ]
    out, ok = [], True
    for fault, arm, body in cases:
        _, p = fs.start_playback(anna, *fs.REMUX)
        base = p["url"].rsplit("/", 1)[0]
        fs.arm(fault, fs.pb(p), **arm)
        for i in range(8):
            fs.raw("GET", f"{base}/{i}.m4s")
        started = time.time()
        fs.api("POST", f"/api/v1/viewer/playback/{p['playbackId']}/switch", body, anna)
        b = wait_revision(anna, p["playbackId"], 1)
        took = time.time() - started
        fs.stop(anna, p["playbackId"])
        fs.clear()
        ok &= b["state"] == "ready" and took < 65
        out.append(f"{fault}: {b['state']} {b.get('method')} in {took:.1f}s")
    return ok, "; ".join(out)


CHECKS = [("segment_timeout", check_segment_timeout), ("seek_back_evicted", check_seek_back_evicted),
          ("playback_alive", check_playback_alive), ("audio_fallback", check_audio_fallback),
          ("cors_retry_after", check_cors_retry_after), ("switch_under_fault", check_switch_under_fault)]


def main():
    fs.clear()
    fs.ctx.anna = fs.login("anna", "robustness-check")
    failed = 0
    for name, fn in CHECKS:
        if fs.ONLY and name not in fs.ONLY:
            continue
        started = time.time()
        try:
            ok, detail = fn()
        except Exception as e:  # noqa: BLE001
            ok, detail = False, f"{type(e).__name__}: {e}"
        finally:
            fs.clear()
        failed += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {name:18} {time.time() - started:5.1f}s  {detail}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
