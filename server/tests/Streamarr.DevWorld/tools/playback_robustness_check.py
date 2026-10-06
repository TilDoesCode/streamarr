#!/usr/bin/env python3
"""Live check of the playback robustness follow-ups (B13) against a running Dev World with the fault layer on.

Usage: playback_robustness_check.py [base_url] [--only name,name]
Default base_url http://127.0.0.1:39310. Use a fresh instance: it changes the server's transcoding settings for a
moment (segment retention, throttle) and restores them, and it arms faults for its own playbacks only.

Checks: a stalled transcode answers 504 segment_timeout with Retry-After within the wait budget (~25 s); a seek back
behind the retained window restarts the run at the target instead of waiting; a progress report says whether the
playbackId is still a live server playback (playbackAlive); /switch {audioFallback} converts the selected audio to AAC
stereo (verified with ffprobe on the delivered segment); a cross-origin faulted 503 exposes Retry-After; a /switch on a
playback with an active segment/playlist fault leaves `starting`; a held start replaced by a switch leaves no second session; fault answers on audio/subtitle renditions and video
segments are named in the next progress answer (deliveryIssues); two players (own `?p=` tags) far apart do not ping-pong
restarts, while one player's own far seek and straight back is answered at once; a parked run keeps its slot (a new start
is refused, the parked playback resumes) until it lapses, after which its resume competes like a new start; one player's
far/near flips restart at most about once per second; a resumed transcode continues the previous segment exactly (ffprobe);
during play the playback GET follows a real PAR2 repair to ready (Lighthouse Logs S01E26), or to failed when the recovery
volumes go missing (S01E25); each repairs once per instance (the server keeps the articles it read).
Exits non-zero when a check fails.
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
        known = handles(admin)
        _, p = fs.start_playback(anna, *fs.TRANSCODE)
        assert p["state"] == "ready" and p["method"] == "transcode", p
        base = p["url"].rsplit("/", 1)[0]
        segments = [line for line in fs.raw("GET", base + "/main.m3u8").body.decode().splitlines() if line.endswith(".m4s")]
        last = min(len(segments) - 6, 24)
        assert last >= 18, f"the source is too short for the check ({len(segments)} segments)"
        for i in range(last + 1):
            r = fs.raw("GET", f"{base}/{i}.m4s", timeout=120)
            assert r.status == 200, f"segment {i}: {r}"
        session = own_session(admin, known)
        running = session["job"]["running"] or session["job"]["paused"]
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
        ("seg_corrupt", {"target": "video", "params": {"mode": "garbage"}, "mode": "always"}, {"positionTicks": 290_000_000, "stepDown": True}),
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


def check_superseded_start():
    """A start held by start_hang and replaced by a switch never leaves a second session (B14)."""
    anna = fs.ctx.anna["accessToken"]
    admin = admin_token()
    before = {s["handle"] for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1]}
    fid = fs.arm("start_hang", {"next": "anna"}, params={"seconds": 8})
    _, p = fs.start_playback(anna, *fs.REMUX, wait_ready=False)
    fs.wait_state(anna, p["playbackId"], ("starting",), 30)
    fs.api("POST", f"/api/v1/viewer/playback/{p['playbackId']}/switch", {"positionTicks": 0}, anna)
    b = wait_revision(anna, p["playbackId"], 1)
    seen = set()
    deadline = time.time() + 12
    while time.time() < deadline:
        seen |= {s["handle"] for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1]} - before
        time.sleep(0.5)
    hits = fs.fault_info(fid)["fault"]["hits"]
    fs.stop(anna, p["playbackId"])
    left = {s["handle"] for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1]} - before
    ok = b["state"] == "ready" and hits == 1 and len(seen) == 1 and not left
    return ok, f"held start replaced: revision 1 {b['state']} {b.get('method')}; sessions seen over 12 s {len(seen)}; after stop {len(left)}"


def check_delivery_issues():
    """Fault-layer answers on audio/subtitle renditions and video segments come back in the next progress answer (B15)."""
    anna = fs.ctx.anna["accessToken"]
    _, p = fs.start_playback(anna, *fs.REMUX)
    base = p["url"].rsplit("/", 1)[0]
    pid, work = p["playbackId"], p["workId"]
    out, ok = [], True
    first = progress(anna, pid, 10_000_000, work)[1].get("deliveryIssues")
    ok &= first == []
    out.append(f"before {first}")
    cases = [
        ("split_abort", {"target": "audio", "rendition": "1", "params": {"afterBytes": 500}}, "/audio/1/1.m4s",
         ("audioRendition", "1", None, "rendition_split_failed", 500)),
        ("subtitle_status", {"target": "subtitle", "rendition": "3", "params": {"status": 404}}, "/subtitles/3/main.m3u8",
         ("subtitleRendition", None, 3, "unknown_subtitle_stream", 404)),
        ("seg_status", {"target": "video", "params": {"status": 503, "code": "segment_unavailable"}}, "/2.m4s",
         ("segment", None, None, "segment_unavailable", 503)),
    ]
    for fault, arm, path, expected in cases:
        fs.arm(fault, fs.pb(p), **arm)
        fs.raw("GET", base + path)
        answer = progress(anna, pid, 20_000_000, work)[1]
        named = [(i["kind"], i.get("renditionId"), i.get("subtitleStreamIndex"), i["code"], i["status"]) for i in answer.get("deliveryIssues") or []]
        again = progress(anna, pid, 21_000_000, work)[1].get("deliveryIssues")
        good = named == [expected] and again == []
        ok &= good
        out.append(f"{fault}: {named} then {again}")
    # A product answer (unknown audio rendition) goes through the same hook; another viewer never sees it.
    fs.raw("GET", base + "/audio/9/main.m3u8")
    status, body = fs.api("GET", f"/api/v1/viewer/playback/{pid}", token=anna)
    listed = [(i["kind"], i.get("renditionId"), i["code"]) for i in body.get("deliveryIssues") or []]
    gast = fs.login("gast")["accessToken"]
    foreign = progress(gast, pid, 1, work)[1]
    fs.stop(anna, pid)
    fs.clear()
    good = ("audioRendition", "9", "unknown_audio_rendition") in listed and len(listed) == 4 and foreign.get("deliveryIssues") is None
    ok &= good
    out.append(f"status lists {len(listed)} incl. unknown rendition 9: {good}; other viewer {foreign.get('deliveryIssues')}")
    return ok, "; ".join(out)


def handles(admin):
    return {s["handle"] for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1]}


def pinned_session(admin, known):
    """Reads the session this check created (the first new one), even after the check starts another playback."""
    handle = []

    def read():
        if not handle:
            handle.append(own_session(admin, known)["handle"])
        return by_handle(admin, handle[0])
    return read


def by_handle(admin, handle):
    return next(s for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1] if s["handle"] == handle)


def own_session(admin, known):
    """The newest session that did not exist before this check started, so other sessions on the instance never interfere."""
    return max((s for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1] if s["handle"] not in known), key=lambda s: s["createdAt"])


def player_tag(base):
    """The `?p=N` a master playlist hands one player (B17: one player's own seeks never wait for each other)."""
    return next(line for line in fs.raw("GET", base + "/master.m3u8").body.decode().splitlines() if line.startswith("main.m3u8"))[len("main.m3u8"):]


def check_competing_requests():
    """Two players far apart on one transcode session: the newer position keeps the run, no restart storm (B16)."""
    import threading
    anna, admin = fs.ctx.anna["accessToken"], admin_token()
    known = handles(admin)
    _, p = fs.start_playback(anna, *fs.TRANSCODE)
    base = p["url"].rsplit("/", 1)[0]
    mine = pinned_session(admin, known)
    tag_a, tag_b = player_tag(base), player_tag(base)
    count = len([line for line in fs.raw("GET", base + "/main.m3u8").body.decode().splitlines() if line.endswith(".m4s")])
    far = max(20, count - 12)
    assert fs.raw("GET", base + "/0.m4s", timeout=90).status == 200
    restarts0 = mine()["restarts"]
    stop_b, stop_a = threading.Event(), threading.Event()
    a, b, b_stopped = [], [], []

    def reader(start, stop, out, limit, tag):
        i = start
        while not stop.is_set() and i < limit:
            r = fs.raw("GET", f"{base}/{i}.m4s{tag}", timeout=60)
            out.append((time.time(), r.status, r.code()))
            i += 1

    tb = threading.Thread(target=reader, args=(far, stop_b, b, count, tag_b))
    ta = threading.Thread(target=reader, args=(1, stop_a, a, far - 1, tag_a))
    tb.start()
    time.sleep(1.0)
    ta.start()
    time.sleep(12)
    contested = mine()["restarts"] - restarts0
    stop_b.set()
    tb.join(60)
    b_stopped.append(time.time())
    time.sleep(10)
    stop_a.set()
    ta.join(60)
    total = mine()["restarts"] - restarts0
    fs.stop(anna, p["playbackId"])
    a_after = [x for x in a if x[0] > b_stopped[0] and x[1] == 200]
    errors = sorted({f"{s} {c}" for _, s, c in a + b if s != 200})
    served = sum(1 for x in a if x[1] == 200), sum(1 for x in b if x[1] == 200)
    # No restart storm and no attempt-exhausted 503: each reader gets its segments or a 504 at its wait budget.
    ok = contested <= 2 and total <= 3 and min(served) > 0 and all(e.startswith("504") for e in errors)
    return ok, (f"far reader from {far}: {served[1]}/{len(b)} served; near reader {served[0]}/{len(a)} served ({len(a_after)} after the far one stopped); "
                f"restarts while contested {contested}, total {total}; non-200 {errors}")


def check_throttle_no_block():
    """A parked (throttled) run leaves no stopped ffmpeg and does not delay another start (B16)."""
    import subprocess
    anna, admin = fs.ctx.anna["accessToken"], admin_token()
    _, before = fs.api("GET", "/api/v1/transcoding/config", token=admin)
    fs.api("PUT", "/api/v1/transcoding/config", {"throttleBufferSeconds": 30}, admin)
    try:
        known = handles(admin)
        _, p = fs.start_playback(anna, *fs.REMUX)
        base = p["url"].rsplit("/", 1)[0]
        mine = pinned_session(admin, known)
        for i in range(2):
            fs.raw("GET", f"{base}/{i}.m4s", timeout=60)
        deadline, parked = time.time() + 60, False
        while time.time() < deadline and not parked:
            job = mine().get("job") or {}
            parked = bool(job.get("paused")) and not job.get("running")
            time.sleep(0.5)
        stopped = [l for l in subprocess.run(["ps", "-ax", "-o", "stat=,comm="], capture_output=True, text=True).stdout.splitlines()
                   if "ffmpeg" in l and l.strip().startswith("T")]
        # Another device starts a transcode: probe + ffmpeg spawns while the first run is parked.
        other = fs.login("anna", "throttle-check-2")["accessToken"]
        started = time.time()
        _, q = fs.start_playback(other, *fs.TRANSCODE, timeout=60)
        took = time.time() - started
        fs.stop(other, q["playbackId"])
        fs.stop(anna, p["playbackId"])
        ok = parked and not stopped and q["state"] == "ready" and took < 5
        return ok, f"run parked {parked}, stopped ffmpeg processes {len(stopped)}; a transcode start on another device ready in {took:.1f}s ({q['state']})"
    finally:
        fs.api("PUT", "/api/v1/transcoding/config", {"throttleBufferSeconds": before["throttleBufferSeconds"]}, admin)


def check_own_seek_back():
    """One player seeking far ahead and straight back gets its segment at once; it is never competing with itself (B17)."""
    anna = fs.ctx.anna["accessToken"]
    _, p = fs.start_playback(anna, *fs.TRANSCODE)
    base = p["url"].rsplit("/", 1)[0]
    tag = player_tag(base)
    count = len([line for line in fs.raw("GET", base + "/main.m3u8" + tag).body.decode().splitlines() if ".m4s" in line])
    fs.raw("GET", f"{base}/0.m4s{tag}", timeout=90)
    fs.raw("GET", f"{base}/{count - 20}.m4s{tag}", timeout=60)
    started = time.time()
    back = fs.raw("GET", f"{base}/3.m4s{tag}", timeout=60)
    took = time.time() - started
    fs.stop(anna, p["playbackId"])
    return back.status == 200 and took < 2, f"far {count - 20} then straight back to 3: {back.status} in {took:.2f}s (B16: 3.4-4 s)"


def check_parked_resume_capacity():
    """A parked run keeps its slot: with every slot taken a new start is refused, the parked playback resumes (B17)."""
    anna, admin = fs.ctx.anna["accessToken"], admin_token()
    _, before = fs.api("GET", "/api/v1/transcoding/config", token=admin)
    fs.api("PUT", "/api/v1/transcoding/config", {"throttleBufferSeconds": 30, "maxConcurrentTranscodes": 1}, admin)
    try:
        known = handles(admin)
        _, p = fs.start_playback(anna, *fs.TRANSCODE)
        base = p["url"].rsplit("/", 1)[0]
        mine = pinned_session(admin, known)
        for i in range(2):
            fs.raw("GET", f"{base}/{i}.m4s", timeout=60)
        deadline, job = time.time() + 90, {}
        while time.time() < deadline and not (job.get("paused") and not job.get("running")):
            job = mine().get("job") or {}
            time.sleep(0.5)
        front = job.get("front", 0)
        other = fs.login("anna", "capacity-check-2")["accessToken"]
        _, q = fs.start_playback(other, *fs.TRANSCODE, wait_ready=False)
        q = fs.wait_state(other, q["playbackId"], ("ready", "failed"), 60)
        fs.stop(other, q["playbackId"])
        statuses = [fs.raw("GET", f"{base}/{i}.m4s", timeout=60).status for i in range(2, front + 2)]
        fs.stop(anna, p["playbackId"])
        code = (q.get("error") or {}).get("code")
        ok = bool(job.get("paused")) and q["state"] == "failed" and all(s == 200 for s in statuses)
        return ok, f"parked at {front}; another start with the one slot taken: {q['state']} {code}; parked playback 2..{front + 1}: {sorted(set(statuses))}"
    finally:
        fs.api("PUT", "/api/v1/transcoding/config", {k: before[k] for k in ("throttleBufferSeconds", "maxConcurrentTranscodes")}, admin)


def wait_parked(read):
    deadline, job = time.time() + 90, {}
    while time.time() < deadline and not (job.get("paused") and not job.get("running")):
        job = read().get("job") or {}
        time.sleep(0.5)
    return job


def check_lapsed_reservation():
    """A parked run idle past jobIdleTimeoutSeconds loses its slot for good: reading stored segments does not revive it (B17 fix 1)."""
    anna, admin = fs.ctx.anna["accessToken"], admin_token()
    _, before = fs.api("GET", "/api/v1/transcoding/config", token=admin)
    keys = ("throttleBufferSeconds", "maxConcurrentTranscodes", "jobIdleTimeoutSeconds")
    fs.api("PUT", "/api/v1/transcoding/config", {"throttleBufferSeconds": 30, "maxConcurrentTranscodes": 1, "jobIdleTimeoutSeconds": 10}, admin)
    q = None
    other = fs.login("anna", "lapsed-check-2")["accessToken"]
    try:
        known = handles(admin)
        _, p = fs.start_playback(anna, *fs.TRANSCODE)
        base = p["url"].rsplit("/", 1)[0]
        for i in range(2):
            fs.raw("GET", f"{base}/{i}.m4s", timeout=60)
        job = wait_parked(pinned_session(admin, known))
        front = job.get("front", 0)
        time.sleep(11)
        _, q = fs.start_playback(other, *fs.TRANSCODE, wait_ready=False)
        q = fs.wait_state(other, q["playbackId"], ("ready", "failed"), 60)
        stored = [fs.raw("GET", f"{base}/{i}.m4s", timeout=60).status for i in range(2, front)]
        refused = fs.raw("GET", f"{base}/{front}.m4s", timeout=60)
        running = sum(1 for s in fs.api("GET", "/api/v1/transcoding/sessions", token=admin)[1] if (s.get("job") or {}).get("running"))
        fs.stop(other, q["playbackId"])
        resumed = fs.raw("GET", f"{base}/{front}.m4s", timeout=60)
        fs.stop(anna, p["playbackId"])
        ok = (bool(job.get("paused")) and q["state"] == "ready" and all(x == 200 for x in stored) and refused.status == 503
              and refused.code() == "transcode_capacity" and refused.header("Retry-After") == "1" and running == 1 and resumed.status == 200)
        return ok, (f"parked at {front}, idle 11 s; another start {q['state']}; stored 2..{front - 1}: {sorted(set(stored))}; front -> "
                    f"{refused.status} {refused.code()} Retry-After {refused.header('Retry-After')}; running encodes {running}; "
                    f"after the other stopped: {resumed.status}")
    finally:
        if q is not None:
            fs.stop(other, q["playbackId"])
        fs.api("PUT", "/api/v1/transcoding/config", {k: before[k] for k in keys}, admin)


def check_own_flip_pacing():
    """One player flipping far/near ten times in 2 s restarts its run at most about once per second (B17 fix 1)."""
    import threading
    anna, admin = fs.ctx.anna["accessToken"], admin_token()
    known = handles(admin)
    _, p = fs.start_playback(anna, *fs.TRANSCODE)
    base = p["url"].rsplit("/", 1)[0]
    tag = player_tag(base)
    count = len([line for line in fs.raw("GET", base + "/main.m3u8").body.decode().splitlines() if line.endswith(".m4s")])
    assert fs.raw("GET", f"{base}/0.m4s{tag}", timeout=90).status == 200
    mine = pinned_session(admin, known)
    restarts0 = mine()["restarts"]
    threads, answers = [], {}
    started = time.time()
    for i in range(10):
        index = count - 12 if i % 2 == 0 else 30
        t = threading.Thread(target=lambda n=index, k=i: answers.__setitem__(k, fs.raw("GET", f"{base}/{n}.m4s{tag}", timeout=60).status), daemon=True)
        t.start()
        threads.append(t)
        time.sleep(0.2)
    burst = mine()["restarts"] - restarts0
    took = time.time() - started
    for t in threads:
        t.join(60)
    session = mine()
    fs.stop(anna, p["playbackId"])
    ok = 2 <= burst <= 4 and answers.get(9) == 200
    return ok, (f"10 flips in {took:.1f}s -> {burst} restarts (B17 before pacing: 9 in 1.9 s); total {session['restarts'] - restarts0}, "
                f"latest request (segment 30) -> {answers.get(9)}, run at {session['job']['startSegment']}")


def repair_run(fail):
    """A starts a PAR2 episode with a hole and waits for its repair (held in downloadingRecovery); B starts meanwhile and plays."""
    title = next(t for t in fs.manifest["titles"] if t["title"] == "The Lighthouse Logs")
    episode = title["seasons"][0]["episodes"][24 if fail else 25]
    work, release = episode["workId"], episode["releases"][0]["releaseId"]
    first = fs.login("anna", "repair-check-1")["accessToken"]
    second = fs.login("anna", "repair-check-2")["accessToken"]
    fs.arm("usenet_hole", {"workId": work}, params={"fromPercent": 70, "toPercent": 95}, ttlSeconds=300)
    stall = fs.arm("usenet_stall", {"workId": work}, params={"file": "recovery", "ms": 10000}, ttlSeconds=300)
    _, a = fs.start_playback(first, work, release, wait_ready=False)
    get = lambda token, playback: fs.api("GET", f"/api/v1/viewer/playback/{playback['playbackId']}", token=token)[1]
    deadline = time.time() + 20
    while time.time() < deadline and (get(first, a).get("repair") or {}).get("state") != "downloadingRecovery":
        time.sleep(0.3)
    _, b = fs.start_playback(second, work, release, wait_ready=False)
    seen, body, started = [], {}, time.time()
    while time.time() - started < 45:
        body = get(second, b)
        state = (body.get("repair") or {}).get("state")
        if body["state"] == "ready" and (not seen or seen[-1] != state):
            seen.append(state)
            if fail and state == "downloadingRecovery":
                fs.arm("usenet_hole", {"workId": work}, params={"fromPercent": 0, "toPercent": 100, "file": "recovery"}, ttlSeconds=300)
                fs.api("DELETE", f"/devworld/faults/{stall}")
        if body["state"] == "failed" or state in ("ready", "failed", "cancelled", "evicted"):
            break
        time.sleep(0.3)
    reasons = [r["code"] for r in (body.get("decision") or {}).get("reasons", [])]
    fs.stop(first, a["playbackId"])
    fs.stop(second, b["playbackId"])
    fs.clear()
    return seen, reasons, (body.get("repair") or {}).get("failureReason")


def check_live_repair():
    """During play the playback GET follows the repair job (B18): a progressive start moves to ready, a failing repair to failed."""
    ready, ready_reasons, _ = repair_run(fail=False)
    failed, failed_reasons, reason = repair_run(fail=True)
    ok = ("repair_progressive" in ready_reasons and len(ready) >= 2 and ready[0] == "downloadingRecovery" and ready[-1] == "ready"
          and "repair_progressive" in failed_reasons and failed[0] == "downloadingRecovery" and failed[-1] == "failed")
    return ok, f"progressive start, GET during play: {' -> '.join(map(str, ready))}; recovery volumes lost: {' -> '.join(map(str, failed))} ({reason})"


def check_resume_continuity():
    """A transcode resume at the parked front continues the previous segment exactly: no repeated frame, no audio overlap (B17)."""
    anna, admin = fs.ctx.anna["accessToken"], admin_token()
    _, before = fs.api("GET", "/api/v1/transcoding/config", token=admin)
    fs.api("PUT", "/api/v1/transcoding/config", {"throttleBufferSeconds": 30}, admin)
    try:
        known = handles(admin)
        _, p = fs.start_playback(anna, *fs.TRANSCODE)
        base = p["url"].rsplit("/", 1)[0]
        mine = pinned_session(admin, known)
        init = fs.raw("GET", base + "/init.mp4", timeout=60).body
        for i in range(2):
            fs.raw("GET", f"{base}/{i}.m4s", timeout=60)
        deadline, job = time.time() + 90, {}
        while time.time() < deadline and not (job.get("paused") and not job.get("running")):
            job = mine().get("job") or {}
            time.sleep(0.5)
        front = job["front"]
        segs = {i: fs.raw("GET", f"{base}/{i}.m4s", timeout=60).body for i in (front - 1, front)}
        resumed = mine()["job"]["startSegment"] == front
        fs.stop(anna, p["playbackId"])
        gaps = {}
        with tempfile.TemporaryDirectory() as tmp:
            for i, body in segs.items():
                with open(os.path.join(tmp, f"{i}.mp4"), "wb") as f:
                    f.write(init + body)
            for sel in ("v:0", "a:0"):
                def pk(i):
                    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", sel, "-show_entries", "packet=pts_time,duration_time",
                                          "-of", "json", os.path.join(tmp, f"{i}.mp4")], capture_output=True, text=True).stdout
                    return sorted((float(x["pts_time"]), float(x.get("duration_time") or 0)) for x in json.loads(out)["packets"])
                last, first = pk(front - 1)[-1], pk(front)[0]
                gaps[sel] = first[0] - (last[0] + last[1])
        ok = resumed and all(abs(g) < 0.0005 for g in gaps.values())
        return ok, f"resumed at {front}: " + ", ".join(f"{k} next start - previous end {v * 1000:+.3f} ms" for k, v in gaps.items())
    finally:
        fs.api("PUT", "/api/v1/transcoding/config", {"throttleBufferSeconds": before["throttleBufferSeconds"]}, admin)


CHECKS = [("segment_timeout", check_segment_timeout), ("seek_back_evicted", check_seek_back_evicted),
          ("playback_alive", check_playback_alive), ("audio_fallback", check_audio_fallback),
          ("cors_retry_after", check_cors_retry_after), ("switch_under_fault", check_switch_under_fault),
          ("superseded_start", check_superseded_start), ("delivery_issues", check_delivery_issues),
          ("competing_requests", check_competing_requests), ("throttle_no_block", check_throttle_no_block),
          ("own_seek_back", check_own_seek_back), ("parked_resume_capacity", check_parked_resume_capacity),
          ("resume_continuity", check_resume_continuity), ("lapsed_reservation", check_lapsed_reservation),
          ("own_flip_pacing", check_own_flip_pacing), ("live_repair", check_live_repair)]


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
