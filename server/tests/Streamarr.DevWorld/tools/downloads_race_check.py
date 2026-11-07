#!/usr/bin/env python3
"""Live race checks of download access (verification rounds 2 and 3) against a running Dev World.

A security sign-out while a download is still preparing (V2-01), renewals racing a sign-out and each other under a held
database writer (V2-02), device/clientRef tuples that only a delimiter would confuse (V2-03), an expiring transfer while the
database writer is held (V2-05), admin sign-outs whose request the client aborts at varying points (V3-01) and one device
identity across sessions and letter case (V3-03). Ports of the verifier's round-2/3 probes to any instance.

usage: downloads_race_check.py [base_url] [state_db]   (state db: <cache>/state-<port>/streamarr.db of that instance)
"""
import concurrent.futures as cf
import hashlib
import os
import socket
import struct
import sqlite3
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(__file__))
import downloads_check as d  # noqa: E402

if len(sys.argv) > 1:
    d.BASE = sys.argv[1].rstrip("/")
STATE_DB = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "cache", "state-39310", "streamarr.db")
BASE = "/api/v1/viewer/downloads"


class Reader:
    def __init__(self, url):
        self.got, self.error = 0, None
        self.done = threading.Event()
        self.response = d.call("GET", url, raw=True, timeout=600)
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        try:
            while data := self.response.read(16 * 1024):
                self.got += len(data)
        except Exception as e:
            self.error = type(e).__name__
        finally:
            self.done.set()

    def abort(self):
        try:
            self.response.fp.raw._sock.shutdown(2)
        except Exception:
            pass
        self.done.wait(3)


def record(token, download_id, device="race-device"):
    return d.call("GET", f"{BASE}/{download_id}?deviceId={device}", token=token)[1]


def wait(token, download_id, device="race-device"):
    deadline = time.time() + 60
    while True:
        body = d.call("GET", f"{BASE}/{download_id}?deviceId={device}&waitMs=2000", token=token)[1]
        if body["state"] in ("ready", "failed") or time.time() > deadline:
            return body


def prepare(token, release, client_ref=None, device="race-device", work="tmdb-movie-10378"):
    body = {"workId": work, "releaseId": release, "device": d.ANDROID_TV, "deviceId": device}
    if client_ref:
        body["clientRef"] = client_ref
    status, data, _ = d.call("POST", BASE, body, token)
    assert status == 202, (status, data)
    return data


def aborted_sign_out(admin, viewer_id, after_seconds):
    """Sends the admin sign-out-all and resets the connection after the given time, before reading the answer."""
    host, port = d.BASE.split("//", 1)[1].split(":")
    sock = socket.create_connection((host, int(port)))
    sock.sendall((f"DELETE /api/v1/config/viewers/{viewer_id}/sessions HTTP/1.1\r\nHost: {host}:{port}\r\n"
                  f"Authorization: Bearer {admin}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").encode())
    time.sleep(after_seconds)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
    sock.close()


def sign_out_all(admin, viewer_id):
    return d.call("DELETE", f"/api/v1/config/viewers/{viewer_id}/sessions", token=admin)[0]


def settings(admin, **downloads):
    status, body, _ = d.call("PUT", "/api/v1/config/viewers/settings", {"downloads": downloads}, admin)
    assert status == 200, (status, body)


def activity(admin):
    return d.call("GET", "/api/v1/config/viewers/downloads?activeOnly=true", token=admin)[1]


def main():
    admin, _ = d.admin_token()
    d.call("DELETE", "/devworld/faults", token=admin)
    viewer_id = next(v["id"] for v in d.call("GET", "/api/v1/config/viewers", token=admin)[1] if v["username"] == "anna")
    token = d.login("anna")
    movie = d.call("POST", f"{BASE}/candidates", {"workId": "tmdb-movie-10378", "device": d.ANDROID_TV}, token)[1]
    big = next(c["version"]["releaseId"] for c in movie["candidates"] if "BluRay.DDP5.1" in c["version"]["name"])
    run = str(int(time.time()))

    # --- V2-01: a security sign-out while the download is still preparing --------------------------------------------------
    status, fault, _ = d.call("POST", "/devworld/faults", {"fault": "resolve_hang", "scope": {"viewer": "anna"}, "mode": "once", "params": {"seconds": 4}}, admin)
    assert status == 201, fault
    pending = prepare(token, big, client_ref=f"prep-{run}")
    state = None
    for _ in range(100):
        state = record(token, pending["downloadId"])["state"]
        if state == "resolving":
            break
        time.sleep(0.02)
    poll = cf.ThreadPoolExecutor(1).submit(d.call, "GET", f"{BASE}/{pending['downloadId']}?waitMs=10000&deviceId=race-device", None, token)
    time.sleep(0.2)
    sign_out_all(admin, viewer_id)
    poll_status, poll_body, _ = poll.result(timeout=30)
    token = d.login("anna")
    done = wait(token, pending["downloadId"])
    d.check("V2-01 a sign-out during preparation: the pending poll gets 401, the download becomes ready with a revoked URL",
            poll_status == 401 and done["state"] == "ready" and done["fileUrl"] is None and done["fileUrlRevoked"] is True,
            {"before": state, "poll": poll_status, "pollHasUrl": isinstance(poll_body, dict) and bool(poll_body.get("fileUrl")),
             "after": done["state"], "fileUrlRevoked": done.get("fileUrlRevoked")})
    d.call("DELETE", f"/devworld/faults/{fault['id']}", token=admin)
    status, renewed, _ = d.call("POST", f"{BASE}/{pending['downloadId']}/renew?deviceId=race-device", {}, token)
    d.check("V2-01 after sign-in the revoked preparation renews to a working URL",
            status == 200 and renewed.get("fileUrl") and d.call("HEAD", renewed["fileUrl"])[0] == 200, status)

    # --- V1-04: a real rotation resumes the same bytes with the original If-Range ------------------------------------------------
    ready = wait(token, prepare(token, big, client_ref=f"rotate-{run}")["downloadId"])
    _, full, _ = d.call("GET", ready["fileUrl"])
    sign_out_all(admin, viewer_id)
    token = d.login("anna")
    old = d.call("GET", ready["fileUrl"], headers={"Range": "bytes=100-"})
    status, renewed, _ = d.call("POST", f"{BASE}/{ready['downloadId']}/renew?deviceId=race-device", {}, token)
    s2, part, h2 = d.call("GET", renewed["fileUrl"], headers={"Range": "bytes=100-", "If-Range": ready["eTag"]})
    d.check("V1-04 a rotated URL resumes identical bytes with the original If-Range",
            old[0] == 410 and old[1]["error"]["code"] == "download_revoked" and status == 200 and renewed["fileUrl"] != ready["fileUrl"]
            and s2 == 206 and part == full[100:] and h2.get("ETag") == ready["eTag"],
            {"old": old[0], "renew": status, "resume": s2, "sha256": hashlib.sha256(full[:100] + part).hexdigest()[:16]})

    # --- V2-02: ten renewals of a revoked download while the database writer is held ------------------------------------------
    sign_out_all(admin, viewer_id)
    token = d.login("anna")
    barrier = threading.Barrier(10)

    def renew(_):
        barrier.wait()
        return d.call("POST", f"{BASE}/{ready['downloadId']}/renew?deviceId=race-device", {}, token)[:2]

    with cf.ThreadPoolExecutor(max_workers=10) as pool:
        with sqlite3.connect(STATE_DB, timeout=30) as db:
            db.execute("BEGIN IMMEDIATE")
            jobs = [pool.submit(renew, n) for n in range(10)]
            time.sleep(1)
            db.rollback()
        answers = [job.result() for job in jobs]
    urls = {body["fileUrl"] for status, body in answers if status == 200}
    heads = [d.call("HEAD", u)[0] for u in urls]
    d.check("V2-02 ten concurrent renewals under writer contention: all 200, one URL, and it works",
            all(status == 200 for status, _ in answers) and len(urls) == 1 and heads == [200],
            {"statuses": sorted({status for status, _ in answers}), "distinctUrls": len(urls), "fileStatuses": heads})

    # --- V2-02: renewals racing a security sign-out ----------------------------------------------------------------------------
    rows = []
    for _ in range(20):
        sign_out_all(admin, viewer_id)
        token = d.login("anna")
        gate = threading.Barrier(2)

        def renew_once():
            gate.wait()
            return d.call("POST", f"{BASE}/{ready['downloadId']}/renew?deviceId=race-device", {}, token)

        def revoke_once():
            gate.wait()
            return sign_out_all(admin, viewer_id)

        with cf.ThreadPoolExecutor(max_workers=2) as pool:
            renewed, revoked = pool.submit(renew_once), pool.submit(revoke_once)
            renewed, revoked = renewed.result(), revoked.result()
        file_status = d.call("HEAD", renewed[1]["fileUrl"])[0] if renewed[0] == 200 and renewed[1].get("fileUrl") else None
        rows.append((renewed[0], revoked, file_status))
    usable = sum(1 for _, _, f in rows if f == 200)
    d.check("V2-02 a renewal racing a security sign-out never leaves a usable URL (20 trials)", usable == 0,
            {"usable": usable, "renewStatuses": sorted({r for r, _, _ in rows}), "fileStatuses": sorted({str(f) for _, _, f in rows})})
    token = d.login("anna")

    # --- V2-03: tuples a delimiter would confuse ------------------------------------------------------------------------------
    first = prepare(token, big, client_ref="gamma", device=f"alpha|beta-{run}")
    second = prepare(token, big, client_ref=f"beta-{run}|gamma", device="alpha")
    retry = prepare(token, big, client_ref="gamma", device=f"ALPHA|Beta-{run}")
    d.check("V2-03 distinct device/clientRef tuples stay distinct, a case-only retry is the same download",
            first["downloadId"] != second["downloadId"] and first["downloadId"] == retry["downloadId"],
            {"first": first["downloadId"][:8], "second": second["downloadId"][:8], "retry": retry["downloadId"][:8]})

    # --- V1-13: preparations leave no live hold ---------------------------------------------------------------------------------
    deadline = time.time() + 30
    while (now := activity(admin))["throttled"] and time.time() < deadline:
        time.sleep(1)
    d.check("V1-13 preparations leave no live hold", not now["throttled"] and now["liveStreams"] == 0,
            {"liveStreams": now["liveStreams"], "throttled": now["throttled"]})

    # --- V2-05: an expiring transfer ends within 2 s while the database writer is held -------------------------------------------
    expiring = wait(token, prepare(token, big, client_ref=f"expiry-{run}")["downloadId"])
    settings(admin, bandwidthKbps=8000)
    try:
        expires_at = time.time() + 4
        with sqlite3.connect(STATE_DB, timeout=30) as db:
            db.execute('UPDATE ViewerDownloads SET ExpiresAt = ? WHERE Id = ?', (int(expires_at * 1000), expiring["downloadId"]))
        reader = Reader(expiring["fileUrl"])
        db = sqlite3.connect(STATE_DB, timeout=30)
        db.execute("BEGIN IMMEDIATE")
        try:
            time.sleep(max(0, expires_at + 2.2 - time.time()))
            ended, got, active = reader.done.is_set(), reader.got, activity(admin)["activeTransfers"]
        finally:
            db.rollback()
            db.close()
        d.check("V2-05 an expiring transfer ends within 2 s and frees its slot while the database writer is held",
                ended and active == 0, {"secondsAfterExpiry": 2.2, "ended": ended, "bytes": got, "activeTransfers": active})
        reader.abort()
        status, code = d.call("HEAD", expiring["fileUrl"])[0], d.call("GET", expiring["fileUrl"])[1]["error"]["code"]
        d.check("V2-05 the expired URL then answers 410 download_expired", status == 410 and code == "download_expired", (status, code))
    finally:
        settings(admin, bandwidthKbps=0)

    # --- V3-01: admin sign-outs whose request the client aborts; every committed one revokes the old URL ---------------------
    token = d.login("anna")
    current = wait(token, prepare(token, big, client_ref=f"abort-{run}")["downloadId"])
    download_id, url, trials = current["downloadId"], current["fileUrl"], []
    for step in range(26):
        old_token, old_url = token, url
        aborted_sign_out(admin, viewer_id, step / 1000)
        time.sleep(0.3)
        committed = d.call("GET", BASE, token=old_token)[0] == 401
        status = d.call("HEAD", old_url)[0]
        trials.append((step, committed, status))
        if not committed:
            sign_out_all(admin, viewer_id)
        token = d.login("anna")
        renewed = d.call("POST", f"{BASE}/{download_id}/renew?deviceId=race-device", {}, token)[1]
        url = renewed["fileUrl"]
    committed = [t for t in trials if t[1]]
    usable = [t for t in committed if t[2] == 200]
    d.check("V3-01 every committed sign-out whose request the client aborted revoked the old URL (26 abort points, 0-25 ms)",
            committed and not usable,
            {"committed": len(committed), "notCommitted": len(trials) - len(committed), "usableAfterCommit": len(usable),
             "oldUrlStatuses": sorted({t[2] for t in committed})})

    # --- V3-03: one device identity across sessions and letter case --------------------------------------------------------------
    first = prepare(token, big, client_ref=f"case-{run}", device=f"Phone-{run}")
    wait(token, first["downloadId"], device=f"Phone-{run}")
    other = d.login("anna")
    retry = prepare(other, big, client_ref=f"case-{run}", device=f" PHONE-{run} ")
    record_body = record(other, first["downloadId"], device=f"phone-{run}")
    listed = [i for i in d.call("GET", f"{BASE}?device=this&deviceId=pHoNe-{run}", token=other)[1]["items"] if i["downloadId"] == first["downloadId"]]
    d.check("V3-03 a case-only different deviceId from another session is the same device and gets its URL",
            retry["downloadId"] == first["downloadId"] and retry["thisDevice"] and retry["fileUrl"] and record_body["fileUrl"]
            and listed and listed[0]["fileUrl"],
            {"sameId": retry["downloadId"] == first["downloadId"], "retryUrl": bool(retry["fileUrl"]), "getUrl": bool(record_body["fileUrl"]),
             "listed": bool(listed and listed[0]["fileUrl"])})

    for item in d.call("GET", BASE, token=token)[1]["items"]:
        d.call("DELETE", f"{BASE}/{item['downloadId']}", token=token)
    passed = sum(1 for _, ok in d.RESULTS if ok)
    print(f"\n{passed}/{len(d.RESULTS)} checks passed")
    return 0 if passed == len(d.RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
