#!/usr/bin/env python3
"""Jellyfin-player-pattern repro: realtime-paced consumption with buffer top-ups,
optional long pauses, and rebuffer-style reopen — the patterns a fast drain never hits.

Modes:
  topup: repeated ranged GETs, each fetching `window` bytes at full speed, then
         sleeping so overall consumption matches `--bitrate-kbs` (player buffer top-ups).
  pause: one long GET; read `--pre-mb`, hold the response open with NO reads for
         `--pause-secs`, then resume reading and measure the resume behavior.

Both log per-cycle: TTFB, fetch time, achieved rate, session NNTP counters delta.
"""
import argparse, json, sys, time, urllib.request, threading

def api(base, path, jwt, timeout=30):
    req = urllib.request.Request(base + path)
    req.add_header("Authorization", "Bearer " + jwt)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def counters(base, jwt, token):
    try:
        for s in api(base, "/api/v1/sessions", jwt):
            if s.get("token") == token:
                return s.get("nntpCommandsTotal"), s.get("nntpConnectionsInFlight")
    except Exception:
        pass
    return -1, -1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8080")
    ap.add_argument("--jwt-file", default="/tmp/streamarr-jwt")
    ap.add_argument("--stream-url", required=True, help="/api/v1/stream/<token> path")
    ap.add_argument("--size", type=int, required=True)
    ap.add_argument("--mode", choices=["topup", "pause"], default="topup")
    ap.add_argument("--bitrate-kbs", type=float, default=525, help="consumption rate KB/s")
    ap.add_argument("--window-mb", type=float, default=16)
    ap.add_argument("--start-frac", type=float, default=0.0)
    ap.add_argument("--end-frac", type=float, default=1.0)
    ap.add_argument("--pre-mb", type=float, default=10)
    ap.add_argument("--pause-secs", type=float, default=180)
    ap.add_argument("--label", default="player")
    args = ap.parse_args()
    jwt = open(args.jwt_file).read().strip()
    token = args.stream_url.rstrip("/").split("/")[-1]
    url = args.base + args.stream_url

    def ranged(pos, count=None):
        req = urllib.request.Request(url)
        req.add_header("Authorization", "Bearer " + jwt)
        end = "" if count is None else str(pos + count - 1)
        req.add_header("Range", f"bytes={pos}-{end}")
        return urllib.request.urlopen(req, timeout=300)

    if args.mode == "topup":
        pos = int(args.size * args.start_frac)
        end = int(args.size * args.end_frac)
        window = int(args.window_mb * 1048576)
        print(f"[{args.label}] topup: {pos}..{end} window={window} bitrate={args.bitrate_kbs}KB/s", flush=True)
        print("cycle\tpos_frac\tttfb_ms\tfetch_s\trate_KBs\tlag_s\tcmds\tinflight", flush=True)
        cycle = 0
        behind = 0.0  # accumulated realtime deficit
        while pos < end:
            want = min(window, end - pos)
            t0 = time.time()
            try:
                r = ranged(pos, want)
                first = r.read(65536)
                ttfb = time.time() - t0
                got = len(first)
                while got < want:
                    b = r.read(min(1048576, want - got))
                    if not b: break
                    got += len(b)
                r.close()
            except Exception as e:
                print(f"[{args.label}] cycle {cycle} ERROR {e!r}", flush=True)
                break
            fetch = time.time() - t0
            play_time = got / (args.bitrate_kbs * 1024)  # seconds this window lasts
            lag = fetch - play_time  # >0 => cannot keep realtime => stutter
            behind = max(0.0, behind + lag)
            cmds, inflight = counters(args.base, jwt, token)
            print(f"{cycle}\t{(pos+got)/args.size:.3f}\t{ttfb*1000:7.0f}\t{fetch:7.2f}\t{got/1024/max(fetch,1e-9):8.1f}\t{behind:6.1f}\t{cmds}\t{inflight}", flush=True)
            pos += got
            sleep = max(0.0, play_time - fetch)
            time.sleep(sleep)
            cycle += 1
        print(f"[{args.label}] topup DONE behind={behind:.1f}s", flush=True)

    else:  # pause mode
        pos = int(args.size * args.start_frac)
        pre = int(args.pre_mb * 1048576)
        print(f"[{args.label}] pause-mode: open at {pos}, read {pre} bytes, hold {args.pause_secs}s, resume", flush=True)
        r = ranged(pos)
        got = 0
        t0 = time.time()
        while got < pre:
            b = r.read(min(1048576, pre - got))
            if not b: break
            got += len(b)
        c0, i0 = counters(args.base, jwt, token)
        print(f"[{args.label}] pre-read {got} bytes in {time.time()-t0:.1f}s cmds={c0} inflight={i0}; pausing...", flush=True)
        time.sleep(args.pause_secs)
        c1, i1 = counters(args.base, jwt, token)
        print(f"[{args.label}] pause over (cmds={c1} inflight={i1}, +{c1-c0} during pause); resuming reads", flush=True)
        t1 = time.time()
        resumed = 0
        first_ms = None
        try:
            while resumed < 64 * 1048576:
                b = r.read(1048576)
                if first_ms is None:
                    first_ms = (time.time() - t1) * 1000
                if not b:
                    print(f"[{args.label}] EOF/CLOSED after {resumed} resumed bytes", flush=True)
                    break
                resumed += len(b)
                if resumed % (16 * 1048576) < 1048576:
                    c2, i2 = counters(args.base, jwt, token)
                    print(f"[{args.label}] resumed {resumed/1048576:.0f}MiB rate={resumed/1024/(time.time()-t1):.0f}KB/s cmds={c2} inflight={i2}", flush=True)
        except Exception as e:
            print(f"[{args.label}] RESUME ERROR after {resumed} bytes: {e!r}", flush=True)
        c3, i3 = counters(args.base, jwt, token)
        dt = time.time() - t1
        print(f"[{args.label}] resume: first-byte {first_ms and round(first_ms)}ms, {resumed/1048576:.1f}MiB in {dt:.1f}s ({resumed/1024/max(dt,1e-9):.0f}KB/s) cmds={c3} (+{c3-c1} since resume)", flush=True)
        r.close()

if __name__ == "__main__":
    main()
