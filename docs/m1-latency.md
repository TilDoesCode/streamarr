# M1 latency — cold-start & seek measurements

BRIEF §10 M1 acceptance requires **cold-start latency and seek latency measured and
recorded**. Per `docs/DECISIONS.md` (Open items), no real Usenet provider credentials
exist yet, so the numbers below are the **mock-NNTP baseline** produced by the
in-repo latency harness against canned yEnc/NZB fixtures. The real-provider run is
tracked as an explicit checklist item at the bottom and stays **unchecked** until the
owner supplies credentials.

## Definitions

- **cold-start** — wall time from issuing `POST /api/v1/resolve` to the **first stream
  byte** returned by `GET /api/v1/stream/{token}`. This spans NZB fetch/parse, the
  sampled NNTP `STAT` health check, session open, and the server-side `ffprobe`
  pre-probe — i.e. everything a front-end waits on before playback can begin. A fresh
  session is opened (and closed) for every sample so nothing is cached between runs.
- **seek** — wall time from a **new `Range` request at the configured offset (70 % of
  the file by default)** to the first byte, on an already-resolved (warm) session.
  Measured as a single-byte range request (`Range: bytes=N-N`) read to completion, so
  it is a clean time-to-first-byte with no abandoned full-range copy.

## The harness

`server/tools/latency` — a console project (`Streamarr.Tools.Latency`). It boots the
real Core Server on a loopback Kestrel port and measures against a **configurable
target**:

```bash
# mock NNTP baseline (default; CI-safe, no credentials)
dotnet run --project server/tools/latency -- --mode mock --iterations 12 --markdown

# end-to-end smoke: ffprobe + scripted play + seek
dotnet run --project server/tools/latency -- --mode mock --smoke

# real provider (once the owner supplies credentials — see below)
dotnet run --project server/tools/latency -- --mode real
```

Options: `--iterations/-n`, `--seek-warmup`, `--seek-offset <0..1>`, `--markdown`,
`--smoke`, `--help`. In `--mode real` the harness reads provider credentials and a
known-good `Latency:NzbUrl` from `server/tools/latency/appsettings.Local.json`
(git-ignored). Copy `appsettings.Local.json.example` to get started.

## Mock baseline (recorded)

Measured `2026-07-12` on: Apple M4 Pro · macOS 26.5.1 · .NET 8.0.422 · ffmpeg 8.0.1,
loopback (no network), mock NNTP server + canned fixtures, 30 s 320×240 H.264/AAC mkv.

| Metric | n | min | median | p95 | max | mean |
|---|---|---|---|---|---|---|
| cold-start | 12 | 33.4 | 34.5 | 73.7 | 117.6 | 41.5 |
| seek@70% | 12 | 0.7 | 0.9 | 1.0 | 1.0 | 0.9 |

_All values in milliseconds (time to first byte)._

Reading these numbers:

- **cold-start** is dominated by the server-side `ffprobe` pre-probe (BRIEF §11
  "pre-probe media info server-side"), not by NNTP transfer — the mock NNTP server has
  no network latency, so this is effectively the harness/probe floor. The `max`
  reflects first-iteration JIT/connection warm-up; `median` is the steady-state cost.
- **seek** is sub-millisecond because the covering segment is already warm in the
  segment cache after resolve. Against a real provider this becomes the true cost of
  fetching + yEnc-decoding one article on demand — the number that matters for scrub
  responsiveness, and the one the real-provider run below will replace.

The mock baseline is a **floor and a regression guard**, not a UX prediction: real
cold-start and seek latency are set by the provider's article-fetch round-trip, the
release's RAR layering, and segment-cache warmth (README "Known limitations").

## End-to-end smoke (recorded)

`--smoke` on the same machine (`2026-07-12`):

- **ffprobe** reads the short-lived capability URL directly (without a reusable bearer): container
  `matroska,webm`, video `h264` 320×240, audio `aac`, duration 30.02 s → **PASS**.
- **play + seek** — `mpv` is not installed on this machine; `ffplay` is a realtime GUI
  player whose headless seek does not exit cleanly, so the harness uses **ffmpeg** (the
  decode engine mpv/ffplay both wrap) for a frame-accurate, always-exits decode: play
  from 0 s → **PASS**, seek to 21.0 s (70 %) and decode → **PASS**.

This is in addition to the `StreamingIntegrationTests` in the server test suite, which
already exercise resolve→ffprobe, full-body byte-identity, arbitrary `Range` reads
(including across RAR volume boundaries), and health classification on every
`dotnet test`.

## Real-provider run (owner action — DECISIONS.md Open items)

- [ ] **Run the harness against a real Usenet provider and record the numbers here.**
      Supply real credentials + a known-good `Latency:NzbUrl` in
      `server/tools/latency/appsettings.Local.json` (see `appsettings.Local.json.example`),
      then run `dotnet run --project server/tools/latency -- --mode real --markdown`
      and paste the resulting table under a new "Real-provider baseline" heading, noting
      the provider, the release (resolution / RAR layering), and geographic distance.
      Also run `--mode real --smoke` and confirm ffprobe + play + seek PASS end to end.
