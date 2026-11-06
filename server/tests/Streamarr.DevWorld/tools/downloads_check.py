#!/usr/bin/env python3
"""End-to-end check of viewer device downloads against a running Dev World.

candidates -> season packs (direct + RAR) -> similarity plan -> prepare -> full file with a forced reset and a
Range/If-Range resume -> sha256 equal to a straight read and to the generated media -> complete/delete; limits,
permission off, age gate, the hard check of a mislabeled release, and a live stream's rate while a download runs.

usage: downloads_check.py [base_url]   (default http://127.0.0.1:39310)
"""
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:39310").rstrip("/")
RESULTS = []

ANDROID_TV = {"platform": "androidtv", "vlcAvailable": False, "engines": [{
    "engine": "native", "hls": True, "maxAudioChannels": 6, "containers": ["mp4", "mkv", "webm"],
    "videoCodecs": [{"codec": "h264"}, {"codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10", "hlg"]}],
    "audioCodecs": [{"codec": c} for c in ["aac", "ac3", "eac3", "opus"]], "subtitleFormats": ["srt", "ass", "webvtt"]}]}
IPHONE = {"platform": "ios", "vlcAvailable": True, "engines": [{
    "engine": "native", "hls": True, "maxAudioChannels": 2, "containers": ["mp4"],
    "videoCodecs": [{"codec": "h264"}, {"codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10", "hlg"]}],
    "audioCodecs": [{"codec": c} for c in ["aac", "ac3", "eac3"]], "subtitleFormats": ["webvtt", "mov_text"]}]}
IPHONE_NO_VLC = dict(IPHONE, vlcAvailable=False)


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)


def call(method, path, body=None, token=None, headers=None, raw=False, timeout=120):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode())
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e
    if raw:
        return resp
    data = resp.read()
    return resp.status, (json.loads(data) if data and resp.headers.get_content_type() == "application/json" else data), resp.headers


def login(username):
    status, body, _ = call("POST", "/api/v1/viewer/auth/login", {"login": username, "password": "streamarr", "deviceName": "downloads-check"})
    assert status == 200, (status, body)
    return body["session"]["accessToken"]


def admin_token():
    manifest = call("GET", "/devworld.json")[1]
    status, body, _ = call("POST", "/api/v1/auth/login", {"username": manifest["admin"]["username"], "password": manifest["admin"]["password"]})
    assert status == 200, (status, body)
    return body.get("accessToken") or body.get("token"), manifest


def wait_ready(token, download_id):
    deadline = time.time() + 120
    while True:
        status, body, _ = call("GET", f"/api/v1/viewer/downloads/{download_id}?waitMs=5000", token=token)
        if body["state"] in ("ready", "failed") or time.time() > deadline:
            return body


def prepare(token, work_id, release_id, device):
    status, body, _ = call("POST", "/api/v1/viewer/downloads", {"workId": work_id, "releaseId": release_id, "device": device, "deviceName": "downloads-check"}, token)
    assert status == 202, (status, body)
    return wait_ready(token, body["downloadId"])


def read_all(url, headers=None, chunk=256 * 1024):
    resp = call("GET", url, headers=headers, raw=True, timeout=600)
    out = bytearray()
    try:
        while True:
            part = resp.read(chunk)
            if not part:
                break
            out += part
    except Exception as e:  # a reset mid-body
        return resp.status, bytes(out), resp.headers, e
    return resp.status, bytes(out), resp.headers, None


def fault(admin, body):
    status, data, _ = call("POST", "/devworld/faults", body, admin)
    assert status == 201, (status, data)
    return data["id"]


def main():
    admin, manifest = admin_token()
    cache = manifest["cacheDir"]
    call("DELETE", "/devworld/faults", token=admin)
    anna = login("anna")

    # --- candidates ---------------------------------------------------------------------------------------------
    status, cands, _ = call("POST", "/api/v1/viewer/downloads/candidates", {"workId": "tmdb-movie-10378", "device": ANDROID_TV}, anna)
    names = [(c["version"]["name"], c["offline"]["playable"], c["offline"]["engine"]) for c in cands["candidates"]]
    check("movie candidates answer 200 with downloadable versions first", status == 200 and cands["candidates"][0]["offline"]["playable"]
          and cands["candidates"][0]["recommended"], names)
    check("Android TV: 2160p TrueHD only streams", any("2160p" in n and not p for n, p, _ in names), f"streamOnly={cands['streamOnlyCount']}")
    status, ios, _ = call("POST", "/api/v1/viewer/downloads/candidates", {"workId": "tmdb-movie-10378", "device": IPHONE}, anna)
    engines = {c["version"]["name"]: c["offline"]["engine"] for c in ios["candidates"]}
    web = next(c for c in ios["candidates"] if c["version"]["name"] == "Big.Buck.Bunny.2008.1080p.WEB-DL.AAC2.0.H.264-DEVWORLD")
    assumed = any(r["code"] == "container_assumed" for r in web["offline"]["reasons"])
    check("iPhone: the MKV plays with VLC; a name without MP4 is assumed MKV until the server opened it",
          engines.get("Big.Buck.Bunny.2008.1080p.BluRay.DDP5.1.x264-DEVWORLD") == "vlc"
          and (assumed and web["offline"]["engine"] == "vlc" or not assumed and web["offline"]["engine"] == "native"), engines)
    real = prepare(anna, "tmdb-movie-10378", web["version"]["releaseId"], IPHONE)
    check("iPhone: the hard check sees the real MP4 and picks the native player", real["state"] == "ready" and real["engine"] == "native"
          and real["container"] == "mp4", {k: real.get(k) for k in ("state", "engine", "container", "error")})
    status, again, _ = call("POST", "/api/v1/viewer/downloads/candidates", {"workId": "tmdb-movie-10378", "device": IPHONE}, anna)
    known = next(c for c in again["candidates"] if c["version"]["releaseId"] == web["version"]["releaseId"])
    check("after that the candidate predicts native with the exact size", known["offline"]["engine"] == "native" and known["sizeSource"] == "resolved"
          and known["sizeBytes"] == real["sizeBytes"], (known["offline"]["engine"], known["sizeSource"], known["sizeBytes"]))
    call("DELETE", f"/api/v1/viewer/downloads/{real['downloadId']}", token=anna)

    # --- season packs + plan ------------------------------------------------------------------------------------
    status, season, _ = call("POST", "/api/v1/viewer/downloads/candidates/season", {"workId": "tmdb-tv-33050-s01", "device": ANDROID_TV}, anna)
    packs = {p["version"]["name"]: p for p in season["packs"]}
    rar = packs.get("Pioneer.One.S01.720p.WEB-DL.AAC2.0.H.264-RARPACK")
    check("season lists the direct and the RAR pack with their six episodes", status == 200 and len(packs) == 2 and rar
          and rar["episodes"] == [1, 2, 3, 4, 5, 6] and rar["complete"], list(packs))
    check("pack sizes: whole pack and per-episode share", rar and rar["perEpisodeSizeBytes"] * 6 <= rar["packSizeBytes"] + 6, rar and (rar["packSizeBytes"], rar["perEpisodeSizeBytes"]))
    e1 = next(c for c in season["episodes"][0]["candidates"] if c["version"]["name"].endswith("1080p.BluRay.DDP5.1.x264-DEVWORLD"))
    status, plan, _ = call("POST", "/api/v1/viewer/downloads/plan", {
        "anchorWorkId": "tmdb-tv-33050-s01e01", "anchorReleaseId": e1["version"]["releaseId"],
        "workIds": [f"tmdb-tv-33050-s01e0{n}" for n in range(1, 7)], "device": ANDROID_TV}, anna)
    matches = [(i["workId"][-3:], i["match"], i["candidate"]["version"]["name"] if i["candidate"] else None) for i in plan["items"]]
    check("plan: every episode gets the anchor's release (same_release)", status == 200 and all(m == "same_release" and n.endswith("-DEVWORLD") for _, m, n in matches), matches)

    # --- prepare a RAR pack episode, reset mid-transfer, resume -----------------------------------------------------
    ready = prepare(anna, "tmdb-tv-33050-s01e02", rar["version"]["releaseId"], ANDROID_TV)
    check("RAR pack episode prepares ready (native, exact size)", ready["state"] == "ready" and ready["engine"] == "native" and ready["sizeBytes"] > 0,
          {k: ready.get(k) for k in ("state", "fileName", "sizeBytes", "engine", "eTag")} | {"error": ready.get("error")})
    url, size, etag = ready["fileUrl"], ready["sizeBytes"], ready["eTag"]
    head = call("HEAD", url, raw=True)
    check("HEAD: length, strong ETag, ranges, attachment", head.status == 200 and int(head.headers["Content-Length"]) == size
          and head.headers["ETag"] == etag and not etag.startswith("W/") and head.headers["Accept-Ranges"] == "bytes"
          and "attachment" in head.headers.get("Content-Disposition", ""), dict(head.headers))
    fid = fault(admin, {"fault": "direct_reset", "target": "offline", "scope": {"playbackId": ready["downloadId"]}, "params": {"afterBytes": 1_500_000}})
    status, first, _, error = read_all(url)
    check("forced reset cuts the first transfer short", error is not None and 0 < len(first) < size, f"got {len(first)} of {size} ({type(error).__name__})")
    status, rest, headers, error = read_all(url, {"Range": f"bytes={len(first)}-", "If-Range": etag})
    check("resume answers 206 with the rest", status == 206 and error is None and headers["Content-Range"] == f"bytes {len(first)}-{size - 1}/{size}", headers.get("Content-Range"))
    call("DELETE", f"/devworld/faults/{fid}", token=admin)
    status, straight, _, _ = read_all(url)
    resumed = hashlib.sha256(first + rest).hexdigest()
    check("resumed bytes are identical to a straight read", resumed == hashlib.sha256(straight).hexdigest() and len(straight) == size, resumed[:16])
    episode = next(e for e in manifest["titles"] if e["key"] == "pioneer-one")["seasons"][0]["episodes"][1]
    media = next(r for r in episode["releases"] if r["name"].endswith("-DEVWORLD") and "720p" in r["name"])["files"][0]["cachePath"]
    with open(os.path.join(cache, media), "rb") as f:
        original = hashlib.sha256(f.read()).hexdigest()
    check("the file inside the RAR set equals the generated episode", original == resumed, media)
    status, stale, _, _ = read_all(url, {"Range": "bytes=0-99", "If-Range": "\"stale\""})
    check("If-Range with another tag sends the whole file", status == 200 and len(stale) == size)
    beyond = call("GET", url, headers={"Range": f"bytes={size}-"}, raw=True)
    check("a range beyond the end answers 416", beyond.status == 416 and beyond.headers["Content-Range"] == f"bytes */{size}")
    status, record, _ = call("GET", f"/api/v1/viewer/downloads/{ready['downloadId']}", token=anna)
    check("bytesServed counts every request", record["bytesServed"] >= size * 3, record["bytesServed"])
    status, done, _ = call("POST", f"/api/v1/viewer/downloads/{ready['downloadId']}/complete", {"bytesReceived": size}, anna)
    check("complete -> completed, the URL stops", done["state"] == "completed" and call("GET", url, raw=True).status == 404)
    status, _, _ = call("DELETE", f"/api/v1/viewer/downloads/{ready['downloadId']}", token=anna)
    check("delete -> 204, then 404", status == 204 and call("GET", f"/api/v1/viewer/downloads/{ready['downloadId']}", token=anna)[0] == 404)

    # --- hard check ---------------------------------------------------------------------------------------------
    mislabel = manifest["scenarios"]["downloads"]["hardCheckFailure"][0]
    failed = prepare(anna, mislabel["workId"], mislabel["releaseId"], IPHONE_NO_VLC)
    check("mislabeled MP4/AAC that is MKV/DTS fails the hard check without VLC", failed["state"] == "failed"
          and failed["error"]["code"] == "not_direct_playable", failed.get("error"))
    vlc = prepare(anna, mislabel["workId"], mislabel["releaseId"], IPHONE)
    check("with VLC the same release is prepared for VLC", vlc["state"] == "ready" and vlc["engine"] == "vlc", vlc.get("engine"))

    # --- limits ---------------------------------------------------------------------------------------------------
    files = [prepare(anna, f"tmdb-tv-33050-s01e0{n}", rar["version"]["releaseId"], ANDROID_TV) for n in (3, 4, 5)]
    slow = fault(admin, {"fault": "throttle", "target": "offline", "scope": {"global": True}, "params": {"kbps": 400}})
    holders = [threading.Thread(target=read_all, args=(f["fileUrl"],), daemon=True) for f in files[:2]]
    for t in holders:
        t.start()
    time.sleep(1.5)
    third = call("GET", files[2]["fileUrl"], raw=True)
    body = json.loads(third.read() or b"{}")
    check("a third parallel download of one viewer answers 429 too_many_downloads", third.status == 429
          and body.get("error", {}).get("code") == "too_many_downloads" and third.headers.get("Retry-After"), body.get("error"))
    status, adminlist, _ = call("GET", "/api/v1/config/viewers/downloads?activeOnly=true", token=admin)
    check("admin activity shows the two transfers with speed", status == 200 and adminlist["activeTransfers"] == 2
          and all(i["transferring"] for i in adminlist["items"]), [(i["title"], i["bytesPerSecond"]) for i in adminlist["items"]])
    call("DELETE", f"/devworld/faults/{slow}", token=admin)
    for f in files:
        call("DELETE", f"/api/v1/viewer/downloads/{f['downloadId']}", token=anna)

    # --- permission + age gate ------------------------------------------------------------------------------------
    viewers = {v["username"]: v["id"] for v in call("GET", "/api/v1/config/viewers", token=admin)[1]}
    gast = login("gast")
    gfile = prepare(gast, "tmdb-movie-10378", cands["candidates"][0]["version"]["releaseId"], ANDROID_TV)
    call("PATCH", f"/api/v1/config/viewers/{viewers['gast']}", {"permissions": {"allowDownloads": False, "allowTranscoding": False, "maxConcurrentStreams": 1}}, admin)
    off = call("GET", gfile["fileUrl"], raw=True)
    status, body, _ = call("POST", "/api/v1/viewer/downloads/candidates", {"workId": "tmdb-movie-10378", "device": ANDROID_TV}, gast)
    check("permission off: 403 downloads_not_allowed on the file and the API", off.status == 403 and status == 403
          and body["error"]["code"] == "downloads_not_allowed")
    call("PATCH", f"/api/v1/config/viewers/{viewers['gast']}", {"permissions": {"allowDownloads": True, "allowTranscoding": False, "maxConcurrentStreams": 1}}, admin)
    kind = login("kind")
    status, body, _ = call("POST", "/api/v1/viewer/downloads/candidates", {"workId": "tmdb-movie-10331", "device": ANDROID_TV}, kind)
    check("age gate: 403 age_restricted for kind", status == 403 and body["error"]["code"] == "age_restricted")

    # --- a live stream keeps its rate while a download runs ----------------------------------------------------
    live_rate(anna, admin, cands)

    failed_checks = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed_checks)}/{len(RESULTS)} checks passed")
    return 1 if failed_checks else 0


def live_rate(anna, admin, cands):
    """A paced /stream read of the 2160p release (a live player) alone and next to an unthrottled download."""
    call("PUT", "/api/v1/config/viewers/settings", {"downloads": {"bandwidthWhileStreamingKbps": 8000}}, admin)
    uhd = next(c for c in cands["candidates"] if "2160p" in c["version"]["name"])
    status, play, _ = call("POST", "/api/v1/viewer/playback", {"workId": "tmdb-movie-10378", "releaseId": uhd["version"]["releaseId"], "device": ANDROID_TV}, anna)
    deadline = time.time() + 60
    while play["state"] not in ("ready", "failed") and time.time() < deadline:
        play = call("GET", f"/api/v1/viewer/playback/{play['playbackId']}?waitMs=5000", token=anna)[1]
    stream = f"/api/v1/stream/{play['streamToken']}"
    big = prepare(anna, "tmdb-movie-10378", next(c for c in cands["candidates"] if "BluRay.DDP5.1" in c["version"]["name"])["version"]["releaseId"], ANDROID_TV)

    def paced(seconds):
        resp = call("GET", stream, raw=True, timeout=120)
        got, start = 0, time.time()
        while time.time() - start < seconds:
            part = resp.read(64 * 1024)
            if not part:
                break
            got += len(part)
        resp.close()
        return got / (time.time() - start)

    alone = paced(6)
    rates = {}

    def download():
        start = time.time()
        _, data, _, _ = read_all(big["fileUrl"])
        rates["download"] = len(data) / (time.time() - start)

    worker = threading.Thread(target=download, daemon=True)
    worker.start()
    time.sleep(0.3)
    together = paced(6)
    status, activity, _ = call("GET", "/api/v1/config/viewers/downloads?activeOnly=true", token=admin)
    worker.join(120)
    size = int(call("HEAD", stream, raw=True).headers["Content-Length"])
    media_rate = size / (play["mediaInfo"]["durationTicks"] / 1e7)
    check("a live stream keeps its rate while a download runs", together >= 4 * media_rate,
          f"needs {media_rate / 1e6:.2f} MB/s; stream alone {alone / 1e6:.2f} MB/s, next to the download {together / 1e6:.2f} MB/s")
    check("the download is held to the live-stream cap meanwhile", activity["throttled"] and rates.get("download", 0) <= 8000 * 1000 / 8 * 1.6,
          f"download {rates.get('download', 0) / 1e6:.2f} MB/s (cap 1.00 MB/s), liveStreams={activity['liveStreams']}")
    call("POST", f"/api/v1/viewer/playback/{play['playbackId']}/stop", {}, anna)
    call("DELETE", f"/api/v1/viewer/downloads/{big['downloadId']}", token=anna)
    call("PUT", "/api/v1/config/viewers/settings", {"downloads": {"bandwidthWhileStreamingKbps": 16000}}, admin)


if __name__ == "__main__":
    sys.exit(main())
