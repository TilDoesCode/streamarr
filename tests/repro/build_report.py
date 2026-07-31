#!/usr/bin/env python3
"""Builds the final HTML incident report from the repro logs."""
import json, re, sys

def series(path):
    pts = []
    for line in open(path):
        m = re.match(r'\s*([\d.]+)\t\s*([\d.]+)\t\s*([\d.]+)\t(-?\d+)\t(-?\d+)', line)
        if m:
            pts.append({
                "t": float(m.group(1)),
                "mib": float(m.group(2)),
                "rate": float(m.group(3)) / 1024.0,
                "cmds": int(m.group(4)),
                "inflight": int(m.group(5)),
            })
    return pts

def done_line(path):
    for line in open(path):
        if "DONE" in line:
            return line.strip()
    return ""

soak = series("/tmp/repro-soak2.log")
resume = series("/tmp/repro-resume.log")
baseline = series("/tmp/repro-baseline-bbb.log")
fixed = series("/tmp/repro-fixed-bbb.log")

data = {
    "soak": soak, "resume": resume, "baseline": baseline, "fixed": fixed,
    "soakDone": done_line("/tmp/repro-soak2.log"),
    "resumeDone": done_line("/tmp/repro-resume.log"),
}
json.dump(data, open("/tmp/report-data.json", "w"))
s_last = soak[-1] if soak else {}
r_last = resume[-1] if resume else {}
print("soak:", data["soakDone"])
print("soak last sample:", s_last)
print("soak cmds/seg ratio:", (s_last.get("cmds", 0)) / max(1, s_last.get("mib", 1) * 1.048576 / 1.048))
print("resume:", data["resumeDone"])
print("resume last:", r_last)
