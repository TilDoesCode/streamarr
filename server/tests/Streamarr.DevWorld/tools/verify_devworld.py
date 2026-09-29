#!/usr/bin/env python3
"""End-to-end check of a running Dev World (the curl flow from docs/client/PLAN.md M1.1).

Usage: verify_devworld.py [base_url]   (default http://127.0.0.1:39300)
Exits non-zero when any check fails. Needs ffprobe on PATH.
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0)
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:39300").rstrip("/")
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" - {detail}" if detail else ""), flush=True)
    if not ok:
        failures.append(name)
    return ok


def http(method, path, body=None, token=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode())
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read()
            status, hdrs = resp.status, dict(resp.headers)
    except urllib.error.HTTPError as err:
        raw, status, hdrs = err.read(), err.code, dict(err.headers)
    try:
        return status, hdrs, json.loads(raw) if raw else None
    except ValueError:
        return status, hdrs, raw


def ffprobe_codecs(url):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", url],
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        return None, out.stderr.strip()
    return [(s["codec_type"], s["codec_name"]) for s in json.loads(out.stdout)["streams"]], None


def expected_codecs(release):
    return [(s["type"], s["codec"]) for s in release["files"][0]["streams"]]


def all_releases(manifest):
    for title in manifest["titles"]:
        if title["type"] == "movie":
            for r in title["releases"]:
                yield title, title["workId"], r
        else:
            for season in title["seasons"]:
                for episode in season["episodes"]:
                    for r in episode["releases"]:
                        yield title, episode["workId"], r


def resolve(token, release_id, work_id):
    return http("POST", "/api/v1/resolve", {"releaseId": release_id, "workId": work_id, "client": "devworld-verify"}, token)


def main():
    status, _, ready = http("GET", "/devworld/ready")
    check("harness ready", status == 200, str(ready))
    status, _, manifest = http("GET", "/devworld.json")
    if not check("manifest served", status == 200 and isinstance(manifest, dict)):
        return

    # --- CORS for viewer endpoints (harness only) ---
    status, hdrs, _ = http("OPTIONS", "/api/v1/viewer/auth/login", headers={
        "Origin": "http://localhost:39301", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization"})
    check("CORS preflight on /api/v1/viewer", status == 204 and hdrs.get("Access-Control-Allow-Origin") == "*",
          f"{status} {hdrs.get('Access-Control-Allow-Origin')}")

    # --- admin: login + ranked search results ---
    admin = manifest["admin"]
    status, _, login = http("POST", "/api/v1/auth/login", {"username": admin["username"], "password": admin["password"]})
    if not check("admin login", status == 200 and login and login.get("token"), str(status)):
        return
    token = login["token"]

    for title in manifest["titles"]:
        if title["type"] == "movie":
            q = urllib.parse.urlencode({"q": title["title"], "type": "movie"})
            status, _, body = http("GET", f"/api/v1/search?{q}", token=token)
            work = next((w for w in (body or {}).get("results", []) if w["workId"] == title["workId"]), None)
            got = [r["releaseId"] for r in (work or {}).get("releases", [])]
            want = [r["releaseId"] for r in title["releases"]]
            alive = [r["releaseId"] for r in title["releases"] if r["health"] != "dead"]
            check(f"search '{title['title']}' ranks fixture releases", status == 200 and got in (want, alive),
                  f"{len(got)} releases" + (" (dead one hidden: recently resolved)" if got != want else "")
                  if got in (want, alive) else f"got {got} want {want}")
        else:
            for season in title["seasons"]:
                status, _, body = http("GET", f"/api/v1/tv/{title['tmdbId']}/seasons/{season['seasonNumber']}", token=token)
                episodes = {e["workId"]: e for e in (body or {}).get("episodes", [])}
                ok = status == 200
                for episode in season["episodes"]:
                    got = [r["releaseId"] for r in episodes.get(episode["workId"], {}).get("releases", [])]
                    ok = ok and got in ([r["releaseId"] for r in episode["releases"]],
                                        [r["releaseId"] for r in episode["releases"] if r["health"] != "dead"])
                check(f"tv season {title['title']} S{season['seasonNumber']:02d} lists ranked releases", ok, str(status))

    # --- resolve + stream: one ready release per variant, ffprobe must see the fixture codecs ---
    seen = set()
    for title, work_id, release in all_releases(manifest):
        if release["health"] != "ready" or release["variant"] in seen or release["seasonPack"]:
            continue
        seen.add(release["variant"])
        status, _, body = resolve(token, release["releaseId"], work_id)
        if not check(f"resolve {release['name']}", status == 200 and body.get("status") == "ready" and body.get("streamUrl"),
                     f"{status} {body.get('status') if isinstance(body, dict) else body}"):
            continue
        codecs, err = ffprobe_codecs(BASE + body["streamUrl"])
        check(f"ffprobe stream [{release['variant']}]", codecs == expected_codecs(release),
              f"{codecs}" if codecs == expected_codecs(release) else f"got {codecs or err} want {expected_codecs(release)}")

    # --- dead release ranked first falls back automatically ---
    for scenario in manifest["scenarios"]["deadFallback"]:
        status, _, body = resolve(token, scenario["deadReleaseId"], scenario["workId"])
        ok = (status == 200 and body.get("status") == "ready"
              and body.get("releaseId") == scenario["expectedFallbackReleaseId"]
              and body.get("fallbackFromReleaseId") == scenario["deadReleaseId"])
        check(f"dead {scenario['deadName']} (rank {scenario['deadRank']}) falls back", ok,
              f"attempts={[a['status'] for a in body.get('attempts', [])]}" if isinstance(body, dict) else str(body))
        if ok:
            codecs, err = ffprobe_codecs(BASE + body["streamUrl"])
            check("fallback stream probes", codecs is not None, str(codecs or err))

    for scenario in manifest["scenarios"]["degraded"]:
        status, _, body = resolve(token, scenario["releaseId"], scenario["workId"])
        check(f"degraded {scenario['name']} resolves as degraded and streams",
              status == 200 and body.get("status") == "degraded" and body.get("streamUrl"),
              f"{status} {body.get('status') if isinstance(body, dict) else body}")

    for scenario in manifest["scenarios"]["seasonPacks"]:
        title = next(t for t in manifest["titles"] if t["type"] == "tv" and any(
            p["releaseId"] == scenario["releaseId"] for s in t["seasons"] for p in s["seasonPacks"]))
        episode = next(e for s in title["seasons"] for e in s["episodes"] if e["episodeNumber"] == 2 and s["seasonPacks"])
        pack = next(r for r in episode["releases"] if r["releaseId"] == scenario["releaseId"])
        status, _, body = resolve(token, scenario["releaseId"], episode["workId"])
        check(f"season pack resolves {episode['workId']} to the episode file",
              status == 200 and body.get("sizeBytes") == pack["files"][1]["sizeBytes"],
              f"{status} size={body.get('sizeBytes') if isinstance(body, dict) else body}")

    # --- viewer module ---
    status, _, options = http("GET", "/api/v1/viewer/auth/options")
    check("viewer auth options (module enabled)", status == 200 and options.get("passwordLogin"), str(options))
    sessions = {}
    for viewer in manifest["viewers"]:
        status, _, body = http("POST", "/api/v1/viewer/auth/login",
                               {"login": viewer["username"], "password": viewer["password"], "deviceName": "verify", "clientName": "devworld-verify"})
        if viewer.get("totp"):
            if not check(f"viewer {viewer['username']} needs second factor", status == 200 and body.get("status") == "mfa_required", str(body)):
                continue
            for attempt in range(2):
                _, _, totp = http("GET", f"/devworld/totp/{viewer['username']}")
                status, _, second = http("POST", "/api/v1/viewer/auth/login/second-factor",
                                         {"mfaToken": body["mfaToken"], "code": totp["code"], "deviceName": "verify", "clientName": "devworld-verify"})
                if status == 200 or attempt == 1:
                    break
                # The code of this 30 s step was already used (replay protection): wait for the next step.
                time.sleep(totp["secondsRemaining"] + 1)
                _, _, body = http("POST", "/api/v1/viewer/auth/login",
                                  {"login": viewer["username"], "password": viewer["password"], "deviceName": "verify", "clientName": "devworld-verify"})
            body = second
        if check(f"viewer {viewer['username']} signs in", status == 200 and body.get("status") == "authenticated", str(status)):
            sessions[viewer["username"]] = body["session"]["accessToken"]

    if "anna" in sessions:
        anna = sessions["anna"]
        status, _, me = http("GET", "/api/v1/viewer/me", token=anna)
        check("viewer me", status == 200 and me.get("username") == "anna", str(status))
        movie = next(t for t in manifest["titles"] if t["type"] == "movie")
        tick = 10_000_000
        for event, position in (("start", 0), ("progress", 90), ("stop", 95)):
            status, _, _ = http("POST", "/api/v1/viewer/watch/progress",
                                {"event": event, "workId": movie["workId"], "positionTicks": position * tick,
                                 "durationTicks": 180 * tick, "playbackId": "verify-1"}, anna)
        check("watch progress accepted", status == 200, str(status))
        status, _, resume = http("GET", "/api/v1/viewer/watch/resume", token=anna)
        check("continue watching lists the movie", status == 200 and any(s["workId"] == movie["workId"] for s in resume), str(status))
        series = next(t for t in manifest["titles"] if t["type"] == "tv" and len(t["seasons"]) > 1)
        first = series["seasons"][0]["episodes"][0]
        status, _, _ = http("POST", "/api/v1/viewer/watch/played", {"workIds": [first["workId"]]}, anna)
        status, _, nextup = http("GET", "/api/v1/viewer/watch/next-up", token=anna)
        items = (nextup or {}).get("items", [])
        check("next up offers the next episode", status == 200 and any(i["workId"] == series["seasons"][0]["episodes"][1]["workId"] for i in items),
              str([i["workId"] for i in items]))

    if "kind" in sessions:
        gate = manifest["scenarios"]["ageGate"]
        blocked = next(t for t in manifest["titles"] if t["title"] == gate["blocked"][0]["title"])
        allowed = next(t for t in manifest["titles"] if t["title"] == gate["allowed"][0]["title"])
        for title, want in ((blocked, False), (allowed, True)):
            work_id = title.get("workId") or title["seriesWorkId"]
            status, _, access = http("GET", f"/api/v1/viewer/access/{work_id}", token=sessions["kind"])
            check(f"age gate for kind on {title['title']} = {want}", status == 200 and access.get("allowed") is want, str(access))

    if "gast" in sessions:
        status, _, me = http("GET", "/api/v1/viewer/me", token=sessions["gast"])
        perms = (me or {}).get("permissions", {})
        check("gast permissions (no transcoding, 1 stream)", perms.get("allowTranscoding") is False and perms.get("maxConcurrentStreams") == 1, str(perms))

    status, _, _ = http("POST", "/api/v1/viewer/auth/email-code", {"login": "anna@devworld.example"})
    time.sleep(0.5)
    _, _, outbox = http("GET", "/devworld/outbox")
    check("email code lands in the test outbox", status in (200, 202, 204) and any(m["to"] == "anna@devworld.example" for m in outbox or []),
          f"{status} {len(outbox or [])} message(s)")

    print(f"\n{'OK' if not failures else 'FAILED'}: {len(failures)} failure(s)")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
    if failures:
        sys.exit(1)
