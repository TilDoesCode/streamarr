#!/usr/bin/env python3
"""Measures viewer playback start latency (POST -> ready) per media variant on a running Dev World.

Usage: start_latency.py [base_url] [--probe-log FILE] [--json FILE]
Each variant is started twice (cold: first start of the release since server start, warm: second start) with the
Chrome profile. With --probe-log (the log an ffprobe wrapper appends one line to per run) the ffprobe runs per start
are counted.
"""
import json
import os
import statistics
import sys
import time



def own_option(name):
    if name not in sys.argv:
        return None
    i = sys.argv.index(name)
    value = sys.argv[i + 1]
    del sys.argv[i:i + 2]
    return value


PROBE_LOG = own_option("--probe-log")
OUT = own_option("--json")
import e2e_playback as e2e  # noqa: E402  (reads base_url from the remaining arguments)


def probes():
    if not PROBE_LOG or not os.path.exists(PROBE_LOG):
        return 0
    with open(PROBE_LOG) as handle:
        return sum(1 for _ in handle)


def measure(token, title, release):
    before = probes()
    began = time.monotonic()
    _, created = e2e.start(token, title["workId"], e2e.CHROME, release["releaseId"])
    _, body, _ = e2e.wait(token, created["playbackId"])
    elapsed = (time.monotonic() - began) * 1000
    e2e.stop(token, created["playbackId"])
    return {"ms": round(elapsed), "state": body["state"] if body else None, "method": (body or {}).get("method"), "probes": probes() - before}


def main():
    _, manifest = e2e.http("GET", "/devworld.json")
    token = e2e.login("anna", "Latency probe")
    rows = []
    for variant, (title, release) in sorted(e2e.variant_releases(manifest).items()):
        cold, warm = measure(token, title, release), measure(token, title, release)
        rows.append({"variant": variant, "cold": cold, "warm": warm})
        print(f"{variant:32} cold {cold['ms']:6} ms {cold['probes']} probes  warm {warm['ms']:6} ms {warm['probes']} probes  {cold['state']}/{cold['method']}", flush=True)
    for phase in ("cold", "warm"):
        ms = [r[phase]["ms"] for r in rows]
        print(f"{phase}: median {statistics.median(ms):.0f} ms, mean {statistics.mean(ms):.0f} ms, probes {sum(r[phase]['probes'] for r in rows)}")
    if OUT:
        with open(OUT, "w") as handle:
            json.dump(rows, handle, indent=1)


if __name__ == "__main__":
    main()
