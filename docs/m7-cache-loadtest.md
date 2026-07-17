# M7 — Segment streaming load test

BRIEF §10-M7 (f): *load-test the segment cache (a stress test with concurrent range
reads, record findings).*

## What is under test

Each `GET /stream/{token}` opens a fresh view over the resolved media file and streams it
with bounded parallel **read-ahead** (`Streamarr:ArticleReadAheadCount`, default 3 segments)
via `MultiSegmentStream`. Articles are fully downloaded and yEnc-validated before delivery,
with bounded whole-article retries after interrupted transfers. A process-wide,
size-bounded decoded-article LRU (`SegmentCacheSizeMb`, default 512 MiB) deduplicates
overlapping requests for the same message-id and serves later seeks without another NNTP
transfer. The global NNTP connection budget still meters every cache miss.

The stress test lives in
`server/tests/Streamarr.Server.Tests/Integration/SegmentCacheLoadTests.cs` and is part of
the normal `dotnet test` run (it is not gated behind a manual flag).

## Method

- One resolved session over the standard 30-second test MKV (mock NNTP, canned yEnc
  articles — the DECISIONS.md fixture path; no real provider needed).
- **64 concurrent** randomized `Range` reads (seeded RNG → reproducible), each 1 B–96 kB,
  overlapping arbitrarily across the file, all fired with `Task.WhenAll`.
- Every response is asserted **byte-exact** against the source slice.
- After the burst, a follow-up ranged read confirms the session is still healthy.

## Findings (2026-07-13, loopback + mock NNTP)

| Metric | Value |
|---|---|
| Concurrent range reads | 64 |
| Bytes served | ~3.26 MB |
| Wall-clock | ~0.57 s |
| Throughput | ~5.4 MiB/s |
| Byte-exact responses | 64 / 64 |
| Connection-budget breaches | 0 |

Observations:

1. **Correctness holds under contention.** Every one of the 64 overlapping reads returned
   the exact source bytes; the read-ahead channel in `MultiSegmentStream` never bled data
   between concurrent requests, and RAR/yEnc seeking stayed correct.
2. **The budget is the throttle, not a failure mode.** With more in-flight reads than the
   connection budget, excess NNTP commands queue on the `PrioritizedSemaphore` gate
   (BODY/ARTICLE outrank STAT/HEAD) rather than opening unbounded connections. The
   companion test `GlobalBudget_IsNeverExceeded_UnderTwoConcurrentStreams_AndBothProgress`
   asserts the mock never observes more concurrent connections than the budget.
3. **Numbers are floor-not-ceiling.** These run over loopback against an in-memory mock
   NNTP server, so they isolate decode/streaming overhead and exclude real Usenet latency.
   Against a real provider, throughput and time-to-first-byte are dominated by provider
   round-trips and the release's RAR layering — measure per deployment (see
   `docs/m1-latency.md`).

## Cache scope

The cache is in-memory and process-local: a restart drops it. It sits downstream of the
connection budget, so misses still respect the global cap. Entries are evicted by decoded
byte size, while concurrent misses for one message-id share one in-flight transfer.
