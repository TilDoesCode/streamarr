#!/usr/bin/env python3
"""Live streaming-engine repro driver.

Resolves a release on a running Streamarr Core Server, then reads the capability
stream like Jellyfin's ffmpeg remux would (sequential fast read), while sampling
delivery throughput and the session's NNTP telemetry every interval.

Usage:
  python3 stream_repro.py --base http://127.0.0.1:39080 --jwt-file /tmp/streamarr-jwt \
      --release <releaseId> --work <workId> [--minutes 30] [--label baseline]
"""
import argparse, json, sys, time, urllib.request, threading, datetime

def api(base, path, jwt, body=None, timeout=180):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET")
    req.add_header("Authorization", "Bearer " + jwt)
    data = None
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
        return json.loads(r.read().decode())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:39080")
    ap.add_argument("--jwt-file", default="/tmp/streamarr-jwt")
    ap.add_argument("--release", default=None)
    ap.add_argument("--work", default=None)
    ap.add_argument("--query", default=None, help="search first and pick a release by --pick substring or first")
    ap.add_argument("--pick", default=None)
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--label", default="run")
    ap.add_argument("--sample-secs", type=float, default=5)
    ap.add_argument("--start-offset", type=float, default=0.0, help="fraction of file to start at")
    args = ap.parse_args()
    jwt = open(args.jwt_file).read().strip()

    if args.query:
        import urllib.parse
        d = api(args.base, "/api/v1/search?q=" + urllib.parse.quote(args.query), jwt, timeout=120)
        found = None
        for w in d.get("results", []):
            for r in w.get("releases", []):
                if r.get("rejected"):
                    continue
                if args.pick and args.pick.lower() not in (r.get("title") or "").lower():
                    continue
                found = (r, w)
                break
            if found:
                break
        if not found:
            print(f"[{args.label}] no release matched query={args.query} pick={args.pick}"); sys.exit(1)
        args.release = found[0]["releaseId"]
        args.work = found[1]["workId"]
        print(f"[{args.label}] picked {found[0]['title']} ({(found[0].get('sizeBytes') or 0)/1e9:.2f} GB) release={args.release} work={args.work}", flush=True)

    print(f"[{args.label}] resolving {args.release} ...", flush=True)
    t0 = time.time()
    res = api(args.base, "/api/v1/resolve", jwt, body={
        "releaseId": args.release, "workId": args.work,
        "client": "repro-harness", "requestedById": "repro-user", "requestedByName": "repro",
    }, timeout=600)
    print(f"[{args.label}] resolve took {time.time()-t0:.1f}s status={res.get('status')} size={res.get('sizeBytes')} url={res.get('streamUrl')}", flush=True)
    if not res.get("streamUrl"):
        print(json.dumps(res)[:2000]); sys.exit(1)

    token = res["streamUrl"].rstrip("/").split("/")[-1]
    size = res.get("sizeBytes") or 0
    stream_url = args.base + res["streamUrl"]

    stats = {"bytes": 0, "reads": 0, "done": False, "error": None, "reopens": 0}
    lock = threading.Lock()

    def reader():
        offset = int(size * args.start_offset)
        deadline = time.time() + args.minutes * 60
        while time.time() < deadline and not stats["done"]:
            req = urllib.request.Request(stream_url)
            req.add_header("Range", f"bytes={offset}-")
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    while time.time() < deadline:
                        chunk = r.read(256 * 1024)
                        if not chunk:
                            with lock:
                                stats["done"] = True
                            return
                        with lock:
                            stats["bytes"] += len(chunk)
                            stats["reads"] += 1
                        offset += len(chunk)
            except Exception as e:
                with lock:
                    stats["error"] = repr(e)
                    stats["reopens"] += 1
                print(f"[{args.label}] reader error at offset {offset}: {e!r} — reopening in 1s", flush=True)
                time.sleep(1)
        with lock:
            stats["done"] = True

    th = threading.Thread(target=reader, daemon=True)
    th.start()

    print("t_s\tMBs_total\trate_KBs\tnntp_total\tnntp_inflight\tchunks\treopens", flush=True)
    last_bytes, last_t = 0, time.time()
    start = time.time()
    while True:
        time.sleep(args.sample_secs)
        now = time.time()
        with lock:
            b = stats["bytes"]; done = stats["done"]; reopens = stats["reopens"]
        rate = (b - last_bytes) / (now - last_t) / 1024.0
        last_bytes, last_t = b, now
        nntp_total = nntp_if = chunks = -1
        try:
            sessions = api(args.base, "/api/v1/sessions", jwt, timeout=10)
            items = sessions if isinstance(sessions, list) else sessions.get("sessions") or sessions.get("items") or []
            for s in items:
                if token.startswith((s.get("token") or "")[:8]) or (s.get("token") or "") == token:
                    nntp_total = s.get("nntpCommandsTotal"); nntp_if = s.get("nntpConnectionsInFlight")
                    f = s.get("file") or {}
                    chunks = f.get("chunksQueried", s.get("chunksQueried", -1))
        except Exception as e:
            pass
        print(f"{now-start:7.1f}\t{b/1048576:9.2f}\t{rate:9.1f}\t{nntp_total}\t{nntp_if}\t{chunks}\t{reopens}", flush=True)
        if done or (now - start) > args.minutes * 60 + 30:
            break
    with lock:
        print(f"[{args.label}] DONE bytes={stats['bytes']} ({stats['bytes']/1048576:.1f} MiB) in {time.time()-start:.0f}s avg={(stats['bytes']/1024)/(time.time()-start):.0f} KB/s err={stats['error']} reopens={stats['reopens']}", flush=True)

if __name__ == "__main__":
    main()
