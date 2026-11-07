#!/usr/bin/env python3
"""Live checks of download access (verification round 1) against a running Dev World.

Capabilities never reach the log (V1-01); turning downloads off, disabling the account or a tighter age limit end an
open transfer within 2 s (V1-02/03); a security sign-out revokes the file URL and renew issues a new one with the same
bytes, an ordinary logout does not (V1-04); concurrent prepares with one clientRef are one download (V1-05);
preconditions (V1-10); an expiring link ends its open transfer (V1-12); a prepare's own probe never throttles
downloads (V1-13).

usage: downloads_security_check.py [base_url] [server_log] [state_db]
"""
import concurrent.futures
import hashlib
import os
import re
import sqlite3
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(__file__))
import downloads_check as d  # noqa: E402

if len(sys.argv) > 1:
    d.BASE = sys.argv[1].rstrip("/")
LOG = sys.argv[2] if len(sys.argv) > 2 else "/tmp/devworld-39310.log"
STATE_DB = sys.argv[3] if len(sys.argv) > 3 else None
PASSWORD = "streamarr"


class Reader:
    """An open GET that keeps reading in the background; `ended` is set when the body ends or breaks off."""

    def __init__(self, url):
        self.got = 0
        self.ended = threading.Event()
        self.response = d.call("GET", url, raw=True, timeout=600)
        self.status = self.response.status
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        try:
            while data := self.response.read(64 * 1024):
                self.got += len(data)
        except Exception:
            pass
        finally:
            self.ended.set()

    def abort(self):
        try:
            self.response.fp.raw._sock.shutdown(2)
        except Exception:
            pass
        self.ended.wait(3)


def viewer_ids(admin):
    return {v["username"]: v for v in d.call("GET", "/api/v1/config/viewers", token=admin)[1]}


def patch(admin, viewer_id, body):
    status, data, _ = d.call("PATCH", f"/api/v1/config/viewers/{viewer_id}", body, admin)
    assert status == 200, (status, data)


def error_code(url, method="HEAD"):
    status, body, _ = d.call("GET" if method == "GET" else "HEAD", url)
    if method == "HEAD" and status >= 400:
        status, body, _ = d.call("GET", url)
    return status, body["error"]["code"] if isinstance(body, dict) and "error" in body else None


def ends_within(reader, seconds=2.5):
    started = time.time()
    ended = reader.ended.wait(seconds)
    return ended, round(time.time() - started, 2)


def ready_download(token, work, release, device=None, device_id=None):
    body = {"workId": work, "releaseId": release, "device": device or d.ANDROID_TV, "deviceName": "security-check"}
    if device_id:
        body["deviceId"] = device_id
    status, data, _ = d.call("POST", "/api/v1/viewer/downloads", body, token)
    assert status == 202, (status, data)
    ready = d.wait_ready(token, data["downloadId"])
    assert ready["state"] == "ready", ready
    return ready


def main():
    admin, manifest = d.admin_token()
    d.call("DELETE", "/devworld/faults", token=admin)
    viewers = viewer_ids(admin)
    anna = d.login("anna")
    movie = d.call("POST", "/api/v1/viewer/downloads/candidates", {"workId": "tmdb-movie-10378", "device": d.ANDROID_TV}, anna)[1]
    big = next(c["version"]["releaseId"] for c in movie["candidates"] if "BluRay.DDP5.1" in c["version"]["name"])
    anna_permissions = viewers["anna"]["permissions"]
    # Slow transfers so they are still open when the checks act.
    d.fault(admin, {"fault": "throttle", "target": "offline", "scope": {"global": True}, "params": {"kbps": 4000}, "ttlSeconds": 900})

    # --- V1-13: the prepare's own probe does not make downloads throttled -------------------------------------------
    deadline = time.time() + 30
    while (activity := d.call("GET", "/api/v1/config/viewers/downloads?activeOnly=true", token=admin)[1])["throttled"] and time.time() < deadline:
        time.sleep(1)
    season = d.call("POST", "/api/v1/viewer/downloads/candidates/season", {"workId": "tmdb-tv-33050-s01", "device": d.ANDROID_TV}, anna)[1]
    direct_pack = next(p["version"]["releaseId"] for p in season["packs"] if p["version"]["name"].endswith("DEVPACK"))
    fresh_prepare = ready_download(anna, f"tmdb-tv-33050-s01e0{int(time.time()) % 3 + 4}", direct_pack)
    after = d.call("GET", "/api/v1/config/viewers/downloads?activeOnly=true", token=admin)[1]
    d.check("V1-13 a prepare's own probe is no live stream (downloads not throttled)",
            not activity["throttled"] and fresh_prepare["state"] == "ready" and not after["throttled"] and after["liveStreams"] == 0,
            {"before": (activity["liveStreams"], activity["throttled"]), "after": (after["liveStreams"], after["throttled"])})
    probe_check = ready_download(anna, "tmdb-movie-10378", big)

    # --- V1-02: downloads off / account disabled end the open transfer ---------------------------------------------------
    for reason, body, restore in [
        ("allowDownloads=false", {"permissions": dict(anna_permissions, allowDownloads=False)}, {"permissions": anna_permissions}),
        ("account disabled", {"disabled": True}, {"disabled": False}),
    ]:
        reader = Reader(probe_check["fileUrl"])
        time.sleep(0.5)
        patch(admin, viewers["anna"]["id"], body)
        before = reader.got
        ended, after_s = ends_within(reader)
        status, code = error_code(probe_check["fileUrl"])
        d.check(f"V1-02 {reason} ends the open transfer within 2 s and refuses the URL", ended and status == 403 and code == "downloads_not_allowed",
                {"ended": ended, "after": after_s, "bytesAfterChange": reader.got - before, "status": status, "code": code})
        reader.abort()
        patch(admin, viewers["anna"]["id"], restore)
    anna = d.login("anna")
    status, _ = error_code(probe_check["fileUrl"])
    d.check("V1-02 turning downloads on again makes the same URL work", status == 200, status)

    # --- V1-03: a tighter age limit applies to the existing URL and its open transfer --------------------------------------
    horror = d.call("POST", "/api/v1/viewer/downloads/candidates", {"workId": "tmdb-movie-10331", "device": d.ANDROID_TV}, anna)[1]
    rated = next(c["version"]["releaseId"] for c in horror["candidates"] if c["offline"]["playable"])
    restricted = ready_download(anna, "tmdb-movie-10331", rated)
    reader = Reader(restricted["fileUrl"])
    time.sleep(0.5)
    patch(admin, viewers["anna"]["id"], {"permissions": dict(anna_permissions, maxAge=0, blockUnrated=True, allowDownloads=True)})
    ended, after_s = ends_within(reader)
    status, code = error_code(restricted["fileUrl"])
    d.check("V1-03 a tighter age limit ends the open transfer and answers age_restricted", ended and status == 403 and code == "age_restricted",
            {"ended": ended, "after": after_s, "status": status, "code": code})
    reader.abort()
    patch(admin, viewers["anna"]["id"], {"permissions": anna_permissions})
    anna = d.login("anna")

    # --- V1-04: security sign-out revokes, renew issues a new URL; logout does not -------------------------------------------
    gast = d.login("gast")
    signout = ready_download(gast, "tmdb-movie-10378", big, device_id="security-phone")
    reader = Reader(signout["fileUrl"])
    time.sleep(0.5)
    status, _, _ = d.call("DELETE", f"/api/v1/config/viewers/{viewers['gast']['id']}/sessions", token=admin)
    ended, after_s = ends_within(reader)
    old_status, old_code = error_code(signout["fileUrl"])
    d.check("V1-04 admin sign-out-all ends the transfer and the old URL answers 410 download_revoked",
            status == 204 and ended and old_status == 410 and old_code == "download_revoked", {"ended": ended, "after": after_s, "code": old_code})
    reader.abort()
    gast = d.login("gast")
    record = d.call("GET", f"/api/v1/viewer/downloads/{signout['downloadId']}?deviceId=security-phone", token=gast)[1]
    status, renewed, _ = d.call("POST", f"/api/v1/viewer/downloads/{signout['downloadId']}/renew?deviceId=security-phone", {}, gast)
    fresh = renewed.get("fileUrl")
    d.check("V1-04 after sign-in renew issues a new URL for the same file", record["fileUrlRevoked"] and record["fileUrl"] is None
            and status == 200 and fresh and fresh != signout["fileUrl"] and renewed["eTag"] == signout["eTag"],
            {"revokedFlag": record["fileUrlRevoked"], "renew": status, "sameETag": renewed.get("eTag") == signout["eTag"]})
    d.call("DELETE", "/devworld/faults", token=admin)
    head = d.call("GET", fresh, headers={"Range": "bytes=0-1048575"})[1]
    status, tail, headers, _ = d.read_all(fresh, headers={"Range": "bytes=1048576-", "If-Range": signout["eTag"]})
    _, whole, _, _ = d.read_all(fresh)
    d.check("V1-04 resume on the new URL gives the same bytes", status == 206 and hashlib.sha256(head + tail).hexdigest() == hashlib.sha256(whole).hexdigest()
            and len(whole) == signout["sizeBytes"], {"status": status, "bytes": len(head) + len(tail)})
    d.check("V1-04 the old URL stays revoked", error_code(signout["fileUrl"])[1] == "download_revoked")
    status, _, _ = d.call("POST", f"/api/v1/config/viewers/{viewers['gast']['id']}/password", {"password": "Security-Check-1", "mustChangePassword": True}, admin)
    d.check("V1-04 an admin password reset revokes the new URL too", status in (200, 204) and error_code(fresh)[1] == "download_revoked", status)
    d.call("POST", f"/api/v1/config/viewers/{viewers['gast']['id']}/password", {"password": PASSWORD, "mustChangePassword": False}, admin)
    gast = d.login("gast")
    kept = ready_download(gast, "tmdb-movie-10378", big)
    d.call("POST", "/api/v1/viewer/auth/logout", {}, gast)
    d.check("V1-04 an ordinary logout keeps the file URL", error_code(kept["fileUrl"])[0] == 200)

    # --- V1-05: concurrent retries are one download -----------------------------------------------------------------
    req = {"workId": "tmdb-movie-10378", "releaseId": big, "device": d.ANDROID_TV, "deviceId": "race-device", "clientRef": f"race-{time.time()}"}
    barrier = threading.Barrier(10)

    def post(_):
        barrier.wait()
        return d.call("POST", "/api/v1/viewer/downloads", req, anna)

    held = None
    if STATE_DB:
        held = sqlite3.connect(STATE_DB, timeout=5)
        held.execute("BEGIN IMMEDIATE")
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(post, n) for n in range(10)]
        if held:
            time.sleep(1.5)
            held.rollback()
            held.close()
        answers = [f.result() for f in futures]
    ids = {a[1].get("downloadId") for a in answers}
    d.check("V1-05 ten concurrent prepares with one clientRef are one download", all(a[0] == 202 for a in answers) and len(ids) == 1,
            {"statuses": sorted({a[0] for a in answers}), "ids": len(ids), "writerLockHeld": bool(STATE_DB)})

    # --- V1-10: preconditions ----------------------------------------------------------------------------------------
    url, tag = probe_check["fileUrl"], probe_check["eTag"]
    s304 = d.call("GET", url, headers={"If-None-Match": tag})[0]
    s412 = d.call("GET", url, headers={"If-Match": '"wrong"'})[0]
    sok = d.call("HEAD", url, headers={"If-Match": tag})[0]
    d.check("V1-10 If-None-Match → 304, failed If-Match → 412, matching If-Match → 200", (s304, s412, sok) == (304, 412, 200), (s304, s412, sok))

    # --- V1-12: expiry ends the open transfer --------------------------------------------------------------------------
    if STATE_DB:
        d.fault(admin, {"fault": "throttle", "target": "offline", "scope": {"global": True}, "params": {"kbps": 4000}, "ttlSeconds": 900})
        expiring = ready_download(anna, "tmdb-movie-10378", big)
        reader = Reader(expiring["fileUrl"])
        time.sleep(0.5)
        with sqlite3.connect(STATE_DB, timeout=5) as db:
            db.execute("UPDATE ViewerDownloads SET ExpiresAt=? WHERE Id=?", (int(time.time() * 1000) - 1000, expiring["downloadId"]))
        ended, after_s = ends_within(reader)
        status, code = error_code(expiring["fileUrl"])
        d.check("V1-12 an expired link ends its open transfer within 2 s (410 download_expired)", ended and status == 410 and code == "download_expired",
                {"ended": ended, "after": after_s, "code": code})
        reader.abort()
        status, renewed, _ = d.call("POST", f"/api/v1/viewer/downloads/{expiring['downloadId']}/renew", {}, anna)
        d.check("V1-12 renew restores the same URL", status == 200 and error_code(expiring["fileUrl"])[0] == 200, status)
        d.call("DELETE", "/devworld/faults", token=admin)

    # --- V1-01: no capability in the server log ----------------------------------------------------------------------
    first = ready_download(anna, "tmdb-movie-10378", big)
    second = ready_download(anna, "tmdb-movie-10331", rated)
    third = ready_download(anna, "tmdb-tv-33050-s01e01", next(p["version"]["releaseId"] for p in d.call(
        "POST", "/api/v1/viewer/downloads/candidates/season", {"workId": "tmdb-tv-33050-s01", "device": d.ANDROID_TV}, anna)[1]["packs"]))
    d.fault(admin, {"fault": "throttle", "target": "offline", "scope": {"global": True}, "params": {"kbps": 2000}, "ttlSeconds": 300})
    held_readers = [Reader(first["fileUrl"]), Reader(second["fileUrl"])]
    refused = d.call("GET", third["fileUrl"], headers={"Range": "bytes=0-9"})[0]
    for r in held_readers:
        r.abort()
    d.call("DELETE", "/devworld/faults", token=admin)
    time.sleep(1)
    log = open(LOG, encoding="utf-8", errors="replace").read() if os.path.exists(LOG) else ""
    leaks = re.findall(r"/api/v1/offline/[0-9a-f]{64}", log)
    d.check("V1-01 a 429 and transfers leave no capability in the server log", refused == 429 and log and not leaks
            and "/api/v1/offline/{capability}" in log, {"status": refused, "leaks": len(leaks), "logBytes": len(log)})

    for item in d.call("GET", "/api/v1/viewer/downloads", token=anna)[1]["items"]:
        d.call("DELETE", f"/api/v1/viewer/downloads/{item['downloadId']}", token=anna)
    passed = sum(1 for _, ok in d.RESULTS if ok)
    print(f"\n{passed}/{len(d.RESULTS)} checks passed")
    return 0 if passed == len(d.RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
