# DIAG — Connection speed test + server diagnostics

Status: done

Intent: worktree /Volumes/DevSSD/Development/streamarr-worktrees/diag-speedtest (branch feat/diag-speedtest, from 0.18.0).
Viewer + admin speed test endpoints (ping, download, upload), a diagnostics report built on DeepHealthDiagnostics
(admin full, viewer redacted) with verdict + hint codes; client "Connection & diagnostics" settings screen (TV + phone);
web admin Diagnostics page with a browser speed test. Dev World port 39300 (--tree), Expo web 39301.

## Log
- Server: DeepHealthDiagnostics keeps /health deep + DependencyOutageMonitor unchanged in shape (providers now carry
  latencyMs), but internally produces a DependencySnapshot (ids, latency, error codes, raw errors, TMDB probe).
  `refresh=true` re-probes only when the snapshot is >= 10 s old (MinRefreshInterval), otherwise the 30 s cache.
- ITmdbClient.ProbeAsync (default null): TmdbClient does one unretried, uncached GET /configuration.
- Newznab caps `<error code=…>` now throws NewznabRequestException("Newznab error 100: …") so a wrong API key reads
  as auth_failed instead of "no <caps> root".
- Speed test: one 4 MiB random buffer, 64 KiB chunks with a rotating offset; max 200 MiB download / 100 MiB upload;
  6 parallel transfers per caller, 16 global (429 speedtest_busy); rate limits per IP: speedtest 240/min,
  diagnostics report 20/min. Upload routes are exempt from the global 1 MiB Content-Length guard and lift Kestrel's
  limit via [RequestSizeLimit].
- Tests: new server tests (Diagnostics/*: endpoint, redaction, refresh throttle, TMDB hints, deep health shape,
  ping/download/upload incl. >1 MiB only on the upload route, rate limits, transfer caps, verdict, provider/indexer
  error classes) + Core TmdbProbeTests and a Newznab `<error>` parser test.
- Full `dotnet test`: Usenet 247/0, Core 512/0 (+5 probe), DevWorld 91/0, Server 1600/13 — the 13 failures are all
  Transcoding/Remux integration tests failing with the machine's ffmpeg 9.0.1 ("Invalid time base: -1" in the
  decode check), reproducible alone and unrelated to this change (environment; recorded, not fixed).
- Client: src/diagnostics/{speed-test,speed-transport,use-diagnostics}.ts, screens/settings/connection-screen.tsx,
  route (settings)/connection.tsx, Settings → Playback row button "Connection & diagnostics". Transfers go through
  the typed API client with a per-request XHR fetch (auth middleware + refresh replay still apply; progress events
  both ways; downloads as native blob, uploads as an ASCII string body so RN needs no base64). 429 with
  `speedtest_busy`/short Retry-After retries, `rate_limited` stops the test.
- Localhost exhausted the first rate limit (240/min) in one run → raised to 600/min; client chunk caps 200 MiB down /
  16 MiB up. Rate-limited error state captured as web-tv-1920-error-ratelimited.png.
- Client jest: 185 suites / 2146 tests, 2 failures in player/__tests__/tab-guard.test.tsx (jest.replaceProperty on
  window.localStorage fails under Node 24) — pre-existing, unrelated.
- Dev World: started from the tree (`devworld.sh start 39300 --tree`); canned Newznab fails caps/search for hosts
  under `.down.invalid` and canned TMDB answers the probe, so a degraded state can be staged via the admin API.
- Screenshots via Playwright (Expo web 39301): 1920×1080 (web large shell; no Android TV emulator run → TV focus
  behaviour on device is `pending-device`), 390×844 phone, degraded + throttled (CDP 18/4 Mbit/s, 60 ms) in German.
- Web (sub-agent): pages/diagnostics/{index,speed-test-card,text}.tsx, lib/speedtest{,-transport}.ts, nav + router,
  queries; English only like the rest of web/; upload cap 64 MiB and a 150-request budget per phase so localhost
  stays under the 600/min limit. web typecheck ok, vitest 36 files / 264 tests passed, build ok (no lint script).

## Summary
Server: GET /api/v1/diagnostics (admin), GET /api/v1/viewer/diagnostics (redacted), and ping, speed/download and
speed/upload under both prefixes. Client: Settings → Connection & diagnostics. Web: Diagnostics page.

## Verification
- dotnet build -c Release: 0 errors. dotnet test: Usenet 247/0, Core 512/0, DevWorld 91/0, Server 1600 passed /
  13 failed (ffmpeg 9.0.1 transcoding env failures, see log); new Diagnostics tests 38/38.
- client: tsc ok, expo lint ok, prettier ok, jest 2144/2146 (2 pre-existing tab-guard failures under Node 24).
- web: typecheck ok, vitest 264/264, build ok.
- Screenshots: docs/client/screenshots/DIAG/ (web-tv-1920-*, web-phone-390-*, web-diagnostics-*).

## Open / follow-ups
- Not run on an Android TV emulator or a real TV (D-pad focus through the component rows is pending-device).
- Two very fast speed tests within one minute from one IP (localhost) can hit the 600/min limit; the test then stops
  with "wait a minute".
- The 13 transcoding test failures with ffmpeg 9.0.1 need a separate fix in the test decode check.
