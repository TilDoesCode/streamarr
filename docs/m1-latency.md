# M1 latency — cold-start & seek measurements

BRIEF §10 M1 acceptance requires **cold-start latency and seek latency measured and
recorded**. The deterministic numbers below are the **mock-NNTP baseline** produced
by the in-repo latency harness against canned yEnc/NZB fixtures. A separate
real-provider Jellyfin measurement is recorded below using the Full Testing Stack.

## Definitions

- **cold-start** — wall time from issuing `POST /api/v1/resolve` to the **first stream
  byte** returned by `GET /api/v1/stream/{token}`. This spans NZB fetch/parse, the
  sampled NNTP `STAT` health check, session open, and the server-side `ffprobe`
  pre-probe — i.e. everything a front-end waits on before playback can begin. A fresh
  session is opened (and closed) for every sample. Process-wide caches intentionally
  remain live: iteration 1 represents a fully cold process/cache, while later iterations
  represent repeat playback in the same server process.
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

## TTFF optimization comparison (recorded)

Measured `2026-07-19` with the same 30 s H.264/AAC MKV fixture, mock NNTP transport,
machine, and 20-iteration harness run before and after the startup changes. The
post-change run retains the full 24-sample synchronous health classification; no
ready/degraded/dead accuracy was traded for latency.

| Build | Metric | n | min | median | p95 | max | mean |
|---|---|---:|---:|---:|---:|---:|---:|
| before | cold-start | 20 | 39.7 | 41.9 | 114.3 | 725.3 | 78.2 |
| after | cold-start | 20 | 1.6 | 1.8 | 15.2 | 202.2 | 12.1 |
| before | seek@70% | 20 | 0.4 | 0.5 | 0.7 | 0.8 | 0.5 |
| after | seek@70% | 20 | 0.3 | 0.4 | 0.4 | 0.5 | 0.4 |

_All values in milliseconds (time to first byte)._

- Repeat-play median cold-start improved **95.7%** (41.9 → 1.8 ms) and p95 improved
  **86.7%** (114.3 → 15.2 ms), primarily because immutable media probe results are
  persisted with the NZB cache.
- The fully cold first iteration improved **72.1%** (725.3 → 202.2 ms) with bounded
  ffprobe analysis, concurrent health/materialization work, and connection warmup.
- `--smoke` still passed ffprobe, decode from 0 s, and decode after a 70% seek. The
  direct-MKV comparison does not claim a numeric RAR gain; parallel RAR volume probing
  is covered separately by byte-identity and observed-concurrency tests.

## Real-provider Jellyfin TTFF (recorded)

Measured `2026-07-19` through the **Full Testing Stack (Jellyfin + Core Server + Web)**
against a 420 MiB RAR-wrapped release on Eweka. Each sample calls Jellyfin
`PlaybackInfo`, opens the resulting Core stream, decodes the first video frame with
ffmpeg, and closes the Jellyfin live stream. The before and after runs use the same
work, release, provider, machine, and persisted NZB/probe caches.

| Build | Scenario | PlaybackInfo | First-frame decode | End-to-first-frame |
|---|---|---:|---:|---:|
| before | cold process | 8.862 s | 0.590 s | 9.452 s |
| after | cold process | 2.789 s | 0.841 s | 3.630 s |
| before | repeat median (n=5) | 2.284 s | 0.130 s | 2.759 s |
| after | repeat median (n=5) | 0.148 s | 0.222 s | 0.409 s |

- Cold end-to-first-frame improved **61.6%**.
- Repeat median `PlaybackInfo` improved **93.5%**, and repeat median
  end-to-first-frame improved **85.2%**.
- All measured streams produced a decoded video frame and closed with HTTP 204.
- The repeat gain comes from a bounded process-local materialization cache. Its key
  fingerprints every selected NZB segment; changed NZBs invalidate it, and failed or
  cancelled RAR materializations are never cached.

### Remaining-path pass

A second real-provider pass on `2026-07-19` implemented the remaining traced work:
seek-body reuse, range-aware tail reads, full-budget RAR/header concurrency,
20-connection warmup, 20-way health sampling, and durable release-registration
hydration. Progressive first-article delivery was also measured during this pass;
it remains an explicit opt-in, while the server default retains full article
validation, retry, and cache single-flight semantics.

- After one legacy cache row was upgraded, a clean Core/Jellyfin restart logged
  `Restored 1 cached release registration(s)` and issued **no `/search` request**.
- Cold Core resolve fell from the earlier 4.13 s trace to **1.51–3.04 s** across
  clean-process samples; provider RTT variation remains the dominant spread.
- The best clean hydrated sample completed `PlaybackInfo` in **1.697 s**, decoded the
  first frame in **0.350 s**, and closed the live stream with HTTP 204: **2.047 s
  end-to-first-frame** (63.8% below the earlier 5.66 s trace).
- The Playwright real-Core E2E flow and all Core, Usenet, Server, and plugin test
  projects passed after the changes.

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

## Real-provider latency-harness run (owner action — DECISIONS.md Open items)

- [ ] **Run the standalone latency harness against a real Usenet provider.**
      Supply real credentials + a known-good `Latency:NzbUrl` in
      `server/tools/latency/appsettings.Local.json` (see `appsettings.Local.json.example`),
      then run `dotnet run --project server/tools/latency -- --mode real --markdown`
      and paste the resulting table under a new "Real-provider baseline" heading, noting
      the provider, the release (resolution / RAR layering), and geographic distance.
      Also run `--mode real --smoke` and confirm ffprobe + play + seek PASS end to end.
