# TTFF Regression — Root-Cause Report

*Tech-lead synthesis. Every claim below is anchored to code read in the repo (file:line) plus the measured ground-truth run on the live Eweka provider. Where a popular hypothesis did **not** survive code inspection, it is called out explicitly so we don't chase it.*

---

## 1. Executive summary

TTFF went from sub-second to "a couple of minutes" not because any single stage got 100× slower, but because **the resolve critical path serially performs NNTP-bound work (materialize → ffprobe → first read) that all draws from one global 20-connection pool, and that pool is now shared with — and starved by — a second, concurrently-playing library stream.** When the box is only serving one easy file, every stage gets connections instantly and TTFF is ~1.6 s (measured). Add a second untranscoded stream doing continuous read-ahead and the new playback's materialize + ffprobe + startup read-ahead all queue behind it; ffprobe alone can burn its **60 s** timeout, and the stages are sequential, so the delays compound into minutes.

Two things made it un-reproducible locally on Big Buck Bunny 720p:

1. **The only resolvable local content is trivially easy.** BBB's mkv carries `format.duration` in its header, so the fast ffprobe (1 MB / 2 s) returns a complete result and **escalation never fires** — `IsCompleteFastResult` is true (`FfprobeClient.cs:64`). Real GoT-scale 1080p remuxes frequently lack header duration, which forces the escalated 5 MB / 5 s probe that reads much further into the stream over NNTP.
2. **No second stream and no indexer** locally means the 20-connection pool is never contended, so the starvation multiplier is absent. Single-stream numbers look healthy precisely because contention is the regression.

The "stop-and-instantly-replay is slow, as if re-downloading everything up to that point" symptom is a **distinct, Swiftfin-specific amplifier**: the compatibility shim forces Jellyfin to discard the open live stream and open a **fresh** source on resume/track-change, which restarts the HLS remux from byte 0 — so ffmpeg stream-copies (and therefore pulls over NNTP) every byte up to the resume point.

**Ranking of what regressed TTFF, highest contribution first:** (1) ffprobe on the resolve critical path, amplified by escalation on header-less mkv; (2) two global connection gates with no per-stream fairness → starvation under a concurrent stream; (3) Swiftfin shim forcing fresh-source/remux-from-0 on resume; (4) every seek discards read-ahead and re-arms the 8-segment startup burst, each probe draining a full article; (5) seek probes bypass `SegmentCache` so repeated seeks re-download; (6) FIFO materialization cache eviction forcing re-materialize on resume.

---

## 2. Ranked root causes

### RC-1 — ffprobe runs synchronously on the resolve critical path, and escalates on header-less mkv
- **Mechanism.** `ResolveService.ResolveSingleAsync` awaits ffprobe *before returning the 200* — it calls `mediaProbeCache.GetOrCreateAsync(releaseId, media, token => ffprobe.ProbeAsync(localStreamUrlForToken(session.Token), token), ct)` (`ResolveService.cs:304-315`). On a probe-cache miss this spawns a real ffprobe child that reads the **loopback stream URL**, i.e. it pulls media bytes over NNTP during resolve. `FfprobeClient.ProbeAsync` runs a fast tier (1 MB / 2000 ms), and if `IsCompleteFastResult` is false it runs an escalated tier (5 MB / 5000 ms), both under a single shared **`FfprobeTimeoutSeconds = 60 s`** budget (`FfprobeClient.cs:29-62`). `IsCompleteFastResult` is `RunTimeTicks != null && MediaStreams.Count > 0` (`FfprobeClient.cs:64`).
- **File/function.** `FfprobeClient.ProbeAsync` / `IsCompleteFastResult` (`server/src/Streamarr.Server/Services/FfprobeClient.cs:29-65`); called from `ResolveService.cs:304-315`; throttled by `MaxConcurrentFfprobe = 2` (`FfprobeClient.cs:27`).
- **Trigger condition.** Probe-cache miss (new release, or NZB/segment change → new SHA key at `MediaProbeCache.cs:90-107`) **and** an mkv whose header lacks `format.duration`. Then the fast tier returns streams-but-no-runtime → escalates and re-reads 5 MB deeper over NNTP (test `FastProbe_WithStreamsButNoRuntime_Escalates`).
- **Expected TTFF contribution.** Uncontended: 0.1–0.3 s (measured). Contended (pool starved) or header-less-and-escalating: seconds, up to the full **60 s** timeout before it soft-fails (returns null, logs a warning, resolve continues — `FfprobeClient.cs:53-57`). This is the single biggest swing on the path.
- **Resume/stop-replay & under-load.** The probe cache is persistent SQLite keyed by segments, so a genuine resume is a cache **hit** and skips ffprobe — *unless* the release was never probed on this key. Under load it is severe: ffprobe reads are `High`-priority BODY fetches (see RC-2) that queue behind a concurrent stream.

> **Correction to the working hypothesis:** there is **no "extreme 50 MB / 90 s" third tier in the code.** Only two tiers exist (fast 1 MB/2 s, escalated 5 MB/5 s), both capped by the single 60 s budget; the validator even rejects escalated budgets > 64 MB / 60 000 ms (`StreamarrOptionsValidator.cs:85-90`). The "EXTREME(50 MB/90 s)=307–326 ms" figure in the brief was a **manual `ffprobe` invocation**, not a code path this service can take.

### RC-2 — Two global connection gates, High-priority for all reads, no per-stream fairness → starvation under a concurrent stream
- **Mechanism.** All NNTP work passes through **two nested `PrioritizedSemaphore` gates**, and neither reserves anything per stream:
  1. **Global budget gate** — `GatedNntpClient` wraps the whole stack with `new PrioritizedSemaphore(budget, budget, HighPriorityOdds = 90)`, `budget = ConnectionBudget = 20` (`GatedNntpClient.cs:29-42`, wired at `StreamarrServerBootstrap.cs:244-251`, `StreamarrOptions.cs:63`).
  2. **Per-provider pool gate** — `ConnectionPool<T>._gate = new PrioritizedSemaphore(maxConnections, maxConnections)` with **default `HighPriorityOdds = 100`** (`ConnectionPool.cs:74`), per-provider `MaxConnections` default 10.
  Every data read — playback body, read-ahead, **interpolation-search seek probes, and ffprobe's stream reads** — is a `DecodedBodyAsync`/`DecodedArticleAsync` at **`SemaphorePriority.High`** at *both* gates (`MultiConnectionNntpClient.cs:81-148`, `GatedNntpClient.cs:105,140`); health STAT/HEAD are `Low` (`MultiConnectionNntpClient.cs:59-79`, `GatedNntpClient.cs:87-90`). There is exactly one priority axis (High/Low) and **no notion of "stream A vs stream B"** — High waiters are strict FIFO with no per-stream accounting (`PrioritizedSemaphore.cs:66-68,175-190`). A BODY permit is held until the whole article has left the wire, so one stream's 8-way startup burst can pin many permits while another stream's reads wait behind it in the same High FIFO. At the per-provider gate (odds=100) the `Low`-priority health STAT/HEAD can be **fully starved** by playback.
- **File/function.** `PrioritizedSemaphore` (`server/src/Streamarr.Usenet/Concurrency/PrioritizedSemaphore.cs`); `GatedNntpClient` (`server/src/Streamarr.Usenet/Nntp/Pooling/GatedNntpClient.cs`); `ConnectionPool.GetConnectionLockAsync` (`ConnectionPool.cs:83-95`); priorities in `MultiConnectionNntpClient.RunWithConnection`.
- **Trigger condition.** A second concurrent playback (esp. an untranscoded/direct library stream doing continuous read-ahead) holds a large share of the 20 High permits. A new resolve then needs, at High: materialize's article reads + ffprobe's stream reads + the 8-segment startup burst — all queue FIFO behind the incumbent stream. `MaxConcurrentResolves = 4` caps concurrent resolves but **reserves no connections** (`ResolveService.cs:30`).
- **Expected TTFF contribution.** This is the **primary multiplier** that turns single-digit-second stages into minutes. It doesn't add a fixed number; it inflates every High-priority NNTP round trip on the path simultaneously, and because the resolve stages are sequential the inflation compounds.
- **Resume/stop-replay & under-load.** This is the "worst when the box is also serving another (untranscoded) library stream" symptom, verbatim. It hits resume too, because the resume path (RC-3/RC-4) issues fresh High reads into the same contended pool.

### RC-3 — Swiftfin compatibility shim forces a fresh source open (and remux-from-0) on resume/track-change
- **Mechanism.** `StreamarrPlaybackCompatibilityFilter` rewrites `POST /Items/{itemId}/PlaybackInfo` to `AutoOpenLiveStream = true`, `EnableDirectPlay = false`, and — in the **uncommitted** change — `LiveStreamId = string.Empty` (`plugin/Streamarr.Plugin/Playback/StreamarrPlaybackCompatibilityFilter.cs:122-124`). Empty-string beats Jellyfin's `liveStreamId ??= dto.LiveStreamId` merge, so Jellyfin **ignores the already-open live stream and discovers/opens a fresh source** → the plugin's `OpenMediaSource` runs again → a **new Core resolve + new session token + new HLS remux**. A fresh remux starts ffmpeg stream-copy from **byte 0**, so resuming at minute 40 makes ffmpeg read every byte up to minute 40 over NNTP — literally "re-downloading everything up to that point."
- **File/function.** `StreamarrPlaybackCompatibilityFilter.ApplyCompatibility` (`plugin/.../StreamarrPlaybackCompatibilityFilter.cs:79-131`); downstream `StreamarrMediaSourceProvider.OpenMediaSource` (each open mints a new `liveStreamId = Guid.NewGuid()` and Core token).
- **Trigger condition.** Swiftfin client, resume/replay/track-change (Swiftfin stops the current HLS item then re-POSTs PlaybackInfo). Guards: `SwiftfinCompatibilityEnabled`, exact route, `Jellyfin-Client` claim starts with "Swiftfin", `projection.Owns(itemId)`.
- **Expected TTFF contribution.** On resume: a **full second resolve** (RC-1 + RC-2 costs again) **plus** an O(minutes) remux-from-0 read if the player can't range-seek the remux. This is the dominant cause of the *resume-specific* slowness.
- **Resume/stop-replay & under-load.** Directly the resume/stop-replay symptom for Swiftfin. Note this shim only touches Swiftfin, so it does **not** explain the "general (not only Swiftfin)" report — that part is RC-1/RC-2/RC-4. The uncommitted empty-`LiveStreamId` fixed a track-change bug but *increased* how often a fresh open (and remux-from-0) happens.

### RC-4 — Every seek discards all read-ahead and re-arms the 8-segment startup burst; each interpolation probe drains a full article to read one header
- **Mechanism.** `NzbFileStream.Seek` disposes the inner `MultiSegmentStream` (`NzbFileStream.cs:101-107`), which drains and discards **all** queued/in-flight read-ahead (`MultiSegmentStream.Dispose`, `MultiSegmentStream.cs:393-420`) — there is no "seek within already-buffered range" fast path; even a tiny forward seek re-opens from scratch. The next read calls `GetFileStream` → `GetMultiSegmentStream(...)`, which **always** passes `startupArticleBufferSize`/`startupReadAheadSegments` (`NzbFileStream.cs:193-213`); the startup window is keyed on segment index *within the new stream instance* (`i < _startupReadAheadSegments`, `MultiSegmentStream.cs:130`), so the 8-segment startup burst (`ArticleStartupReadAheadCount = 8`, `ArticleStartupReadAheadSegments = 8`, `StreamarrOptions.cs:110-113`) fires again on **every** seek/resume, dumping 8 concurrent High reads into the contended pool. The interpolation search itself runs **serial** probes, and — critically — **each probe holds a High permit for the full article body even though only the yEnc header is needed**: early-dispose does not short-circuit the transfer; `NntpConnection.ReadBodyToPipeAsync` keeps draining to the terminating `.` to stay protocol-synchronized (`NntpConnection.cs:607-621`). ~log₂(580) ≈ 9 full-segment drains worst case, each pinning a connection.
- **File/function.** `NzbFileStream.Seek`/`GetFileStream`/`SeekSegment`/`GetMultiSegmentStream` (`server/src/Streamarr.Usenet/Streams/NzbFileStream.cs:80-213`); `MultiSegmentStream.cs:103-167,393-420`; `NntpConnection.cs:607-621`. (RAR-wrapped media seeks the same way via `RarStoredFileStream` — also no re-read from 0.)
- **Trigger condition.** Any non-zero seek (scrub, resume-to-offset). Measured: 70 % seek = 3.33 s vs 95 % seek = 0.42 s — the 70 % case is slower because interpolation search drained more full-body articles.
- **Expected TTFF contribution.** 0.4–3.3 s uncontended (measured); multiplied under RC-2 contention because every probe + the 8-segment burst are High reads holding permits for full-article drains while the other stream waits.
- **Resume/stop-replay & under-load.** Directly worsens resume; a self-inflicted burst that intensifies exactly the pool contention of RC-2.

> **Note (not a re-download-from-0 bug):** the byte-offset seek path does **not** re-read from 0 — it interpolation-searches to the target segment and `DiscardBytesAsync` only *within* that one segment (`NzbFileStream.cs:174-181`), and `StreamController` uses `enableRangeProcessing: true` so ASP.NET issues a real `Seek` on Range requests. The "re-download everything" symptom is the ffmpeg-remux-from-0 of RC-3, not a Core seek bug.

### RC-5 — Interpolation seek probes bypass `SegmentCache`, so repeated seeks re-download the same articles
- **Mechanism.** `SeekSegment` calls `usenetClient.DecodedBodyAsync(...)` **directly** (`NzbFileStream.cs:121-123`), not through `SegmentCache.GetOrAddAsync`. The cache is only consulted inside `MultiSegmentStream.GetSegmentBytes` (`MultiSegmentStream.cs:246-277`). So seek probes neither hit nor populate the 512 MB `SegmentCache` — re-seeking near the same spot pays the same full-article drains every time.
- **File/function.** `NzbFileStream.SeekSegment` (`NzbFileStream.cs:110-155`) vs cache path `MultiSegmentStream.cs:246-277`; `SegmentCacheSizeMb = 512` (`StreamarrOptions.cs:128`).
- **Trigger condition.** Any repeated seek/scrub/resume in the same region (very common in real playback).
- **Expected TTFF contribution.** Turns what should be a warm-cache sub-second seek into a repeat cold seek (seconds), and adds avoidable High-priority load under RC-2.
- **Resume/stop-replay & under-load.** Directly worsens repeated resume; interacts with RC-2 by re-issuing avoidable High reads.

### RC-6 — FIFO materialization cache can evict a still-relevant release, forcing re-materialize on resume
- **Mechanism.** `MediaMaterializationCache` is process-local, bounded to **32 entries / 64 MB**, and evicts **FIFO — explicitly not LRU** (`MediaMaterializationCache.cs:55-95`; bounds `StreamarrOptions.cs:122,125`). A cache miss forces synchronous re-materialization (NNTP size probe + RAR volume-header reads) on the resolve path (`MediaMaterializationCache.cs:28-53`, `MediaFileMaterializer`).
- **Trigger condition.** Enough distinct releases resolved/browsed between play and resume (≥ 32, or 64 MB of weight) to evict the entry. Because it's FIFO, a hot release that's being resumed gets evicted the same as a cold one.
- **Expected TTFF contribution.** On an evicted resume: the full materialize cost again (RAR header reads over NNTP), amplified by RC-2. Lower-probability than RC-1/2/3 but real on a busy box.
- **Resume/stop-replay & under-load.** Hits resume specifically, and worse under load (more browsing + contention).

### Explicitly refuted / off-path (so we don't chase them)
- **ArtworkBadgeService retry & TmdbClient retry (uncommitted).** Metadata/library-population path only (`EphemeralLibraryService`, `CachingTmdbClient`); never called from `ResolveService` or the plugin's `OpenMediaSource`. Bounded retries under their own semaphores. **Cannot stall a playback/resolve request.**
- **NNTP connection warmup.** One-time `BackgroundService` at host start (`NntpConnectionWarmupService.cs`), not on any per-resolve path. Improves cold start; irrelevant to steady-state TTFF.
- **"50 MB / 90 s extreme ffprobe tier."** Does not exist in code (see RC-1 correction).

---

## 3. Concrete, minimal, safe fixes (ranked by expected ms saved)

Priorities as requested: **(a)** take slow work off the resolve critical path, **(b)** make resume/stop-replay reuse cached work, **(c)** avoid connection starvation under a concurrent stream.

| # | Fix | Category | Expected saving | Correctness risk |
|---|-----|----------|-----------------|------------------|
| F-1 | **Take ffprobe off the resolve critical path.** Return the 200 as soon as `media` + session exist; run `mediaProbeCache.GetOrCreateAsync(...)` on a background task and let the session expose probe results when ready (Jellyfin already tolerates a probe-less open — ffprobe failure is *already* soft at `FfprobeClient.cs:53-57`). | (a) | Removes 0.1 s–**60 s** from the path; largest single win, especially under load. | Low–medium. Must confirm no downstream consumer *requires* `RunTimeTicks` synchronously in the resolve response; if some client needs duration, keep a short (≤ fast-tier) synchronous probe and background only the escalation. |
| F-2 | **Reserve connection headroom per active stream / give resolve+ffprobe a distinct priority band.** Either (i) cap any one stream's in-flight read-ahead so it can't consume the whole 20-permit pool, or (ii) add a middle priority so a *new* resolve's first reads aren't strictly FIFO-behind an incumbent stream's steady read-ahead. `PrioritizedSemaphore` already supports odds and `UpdatePriorityOdds`. | (c) | Removes the minutes-scale multiplier under a concurrent stream; the highest-impact fix for the reported worst case. | Medium. Changing scheduling fairness can slightly slow a lone stream's read-ahead; tune odds, don't starve. Keep health STAT/HEAD from being starved (raise Low odds above 0). |
| F-3 | **Stop forcing a fresh source open on Swiftfin resume/track-change; reuse the open live stream when the id is merely stale, and range-seek instead of remux-from-0.** Narrow the empty-`LiveStreamId` override to the genuine track-change case only, or map the stale id to the still-open session instead of discarding it. | (b) | Eliminates a whole second resolve **and** the O(minutes) remux-from-0 on Swiftfin resume. | Medium–high. This is exactly the bug the uncommitted change was fixing; must preserve the track-change fix while not forcing a fresh open on plain resume. Needs a Swiftfin track-change + resume regression test. |
| F-4 | **Don't re-arm the 8-segment startup burst on seek,** and add a "seek within already-buffered range" fast path. In `GetMultiSegmentStream`, pass the *steady* read-ahead (not startup) when the open is a re-open after a seek (`firstSegmentIndex > 0`). | (a)+(c) | Saves ~0.4–3.3 s per seek and removes up to 8 High reads/seek from the contended pool. | Low. Startup burst is a cold-start optimization; a mid-file seek already has a warm pipeline. |
| F-5 | **Route interpolation seek probes through `SegmentCache`** (call `SegmentCache.GetOrAddAsync` in `SeekSegment` instead of raw `DecodedBodyAsync`). | (b)+(c) | Makes repeated/near seeks warm-cache hits instead of re-downloads; cuts avoidable High load. | Low–medium. Cache is already sized 512 MB; just wire the seek path to it and confirm keying matches. |
| F-6 | **Make the materialization cache LRU (touch-on-hit) instead of FIFO,** or pin actively-resumed releases so they aren't evicted. `AddAndTrim` already tracks insertion order; add access-order. | (b) | Avoids a full re-materialize (RAR header reads) on busy-box resume. | Low. Pure eviction-policy change; bounds unchanged. |
| F-7 | **Header-only seek probe:** give the NNTP layer a bounded/early-terminating body read so an interpolation probe stops after the yEnc header instead of draining the whole article. Today early-dispose still drains to `.` to stay protocol-synchronized (`NntpConnection.cs:607-621`), so each probe pins a permit for a full article. | (a)+(c) | Cuts ~9 full-article drains per mid-file seek to header-sized reads, freeing permits far sooner. | Medium–high. Must preserve protocol sync — likely means abandoning+reopening the connection rather than draining, or a server-side range. Needs careful NNTP-layer testing. |

**Sequencing recommendation:** F-1 and F-2 first — together they address the general (non-Swiftfin) minutes-scale regression with the least behavioral risk. F-3 next for the Swiftfin resume symptom. F-4/F-5/F-6 are cheap, low-risk follow-ups that de-risk resume-under-load. F-7 is the highest-effort item — schedule it only if seek probes remain a measured bottleneck after F-4/F-5.

---

## 4. TTFF instrumentation design (request → first delivered frame, cross-process)

Good news: **the scaffolding already exists in the working tree** and is most of the way there. `TtffTimeline`/`TtffSpan` (`server/src/Streamarr.Server/Services/TtffTimeline.cs`) record ms-from-t0 spans with a `Category` for flamegraph coloring and a `Source` of `"server"`/`"client"`; the ingestion endpoint `POST /sessions/{token}/timeline` (`SessionsController.AppendTimeline`, `SessionsController.cs:41-59`) accepts client spans; and `SessionResponse.Timeline` (`ApiContracts.cs:112-131`) exposes the merged set to the web stream page. The **only missing link is a Jellyfin-side reporter** that POSTs its PlaybackInfo→first-frame spans back to Core.

### 4.1 Ordered spans to record

**t0 = resolve request enters the server.** `TtffTimeline.Start(...)` at `ResolveService.cs:235`. All offsets are ms relative to t0 on the monotonic `Stopwatch` clock, so the set renders directly as a flamegraph.

| Order | Span name | Category | Source | Start / stop location | Status |
|------:|-----------|----------|--------|-----------------------|--------|
| — | *t0 anchor* | — | server | `TtffTimeline.Start` — `ResolveService.cs:235` | ✅ exists |
| 1 | `nzb-fetch` | `nzb` | server | `using (timeline.Measure("nzb-fetch","nzb"))` — `ResolveService.cs:238-249` | ✅ exists |
| 2 | `health-check` | `health` | server | start captured `:248`, recorded `timeline.Add("health-check",...)` `:268-269` (overlaps materialize) | ✅ exists |
| 3 | `materialize` | `materialize` | server | start `:250`, recorded `:291-292` (NNTP size + RAR headers) | ✅ exists |
| 4 | `session-create` | `session` | server | **ADD** — wrap `sessionManager.CreateSession(...)` (`ResolveService.cs:294`) in `using (timeline.Measure("session-create","session"))` | ➕ add (cheap, closes a gap) |
| 5 | `ffprobe` | `probe` | server | `using (timeline.Measure("ffprobe","probe"))` — `ResolveService.cs:308-314`. Add a `Detail` flag for `escalated=true/false` from `FfprobeClient` so the flamegraph shows which tier ran. | ✅ exists (enrich detail) |
| 6 | `resolve-total` | `session` | server | **ADD** — one span from t0 to just before returning the resolve response, so the flamegraph has the server envelope. | ➕ add |
| 7 | `stream-open→first-byte` | `stream` | server | `SessionStream.ReadAsync` first non-zero read — `SessionManager.cs:358-367`; open offset captured at `:248` (`openMs`). This already spans "HTTP stream request opened" → "first delivered byte (NNTP fetch + yEnc decode, or a seek's interpolation search)". | ✅ exists |
| 8 | `connection-wait` | `stream` | server | **ADD (optional, high value under load)** — measure time blocked in `ConnectionPool.GetConnectionLockAsync` / `PrioritizedSemaphore.WaitAsync` for the *first* read, recorded as a sub-span of #7. This is what visualizes RC-2 starvation directly. | ➕ add |

**Client side (Jellyfin process), reported via `POST /sessions/{token}/timeline` with `source:"client"`.** These need a new reporter (see 4.3):

| Order | Span name | Category | Where measured (Jellyfin/plugin) |
|------:|-----------|----------|----------------------------------|
| 9 | `playbackinfo→open` | `client` | Plugin `OpenMediaSource` entry → Core resolve issued (brackets the cross-process hop into Core). |
| 10 | `transcode-start` | `transcode` | ffmpeg/HLS remux job launch for the opened source (Jellyfin transcode manager) → first `.ts` segment write. |
| 11 | `first-segment-TTFB` | `transcode` | First byte the client actually pulls of segment 0 (measured server-side of Jellyfin's HLS output). |
| 12 | `first-frame-rendered` | `client` | Player's first decoded/painted frame (if the player exposes it; otherwise first-segment-delivered is the proxy). |

Categories align with the buckets already declared: `nzb, health, materialize, probe, session, stream, client, transcode` (`TtffTimeline.cs:14`).

### 4.2 Alignment across processes
Client spans arrive as ms-from-t0. To place them correctly, align on `TimelineStartedAt` (wall-clock of t0, already exposed on `SessionResponse.TimelineStartedAt`, `ApiContracts.cs`): the Jellyfin reporter timestamps its stage boundaries in wall-clock, subtracts `TimelineStartedAt`, and sends the resulting offsets. Because Core's t0 (resolve entry) precedes Jellyfin's PlaybackInfo handling by the network hop, spans 9–12 will naturally sit to the right of the server spans — correct flamegraph ordering. Guard rails already clamp offsets/durations and cap span count (`TtffTimeline.cs:37-41, 74-96`).

### 4.3 The one missing piece: the Jellyfin → Core reporter
Today `SessionsController.AppendTimeline` exists but has **no plugin caller** (grep of `plugin/Streamarr.Plugin/` for `timeline` returns nothing; `PlaybackEventDispatcher` reports start/progress/stop but no timing spans). Add a small reporter in the plugin that:
1. Captures wall-clock at `OpenMediaSource` entry, at transcode-job start, and at first-segment delivery (hook the same points `PlaybackEventDispatcher` already observes).
2. On first-segment delivery, POSTs a `ClientTimelineRequest` (`ApiContracts.cs:135-149`) of spans 9–12 to `POST /sessions/{token}/timeline`, authorized by the capability **token** (same anonymous-capability model as session close — no machine credential in the player).
3. Fails open (diagnostics must never affect playback), matching the shim's fail-open contract.

With that reporter added, the web stream page renders a single flamegraph spanning **`PlaybackInfo/resolve request` (t0) → `first delivered frame`**, with the server envelope (spans 1–8) and the Jellyfin envelope (spans 9–12) on one aligned axis — and `connection-wait` (span 8) makes RC-2 starvation visible at a glance.
