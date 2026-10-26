# USPEED — server ↔ Usenet speed test, streaming path overview, bandwidth fit per version

Status: done

Intent: worktree /Volumes/DevSSD/Development/streamarr-worktrees/usenet-speedtest (branch feat/usenet-speedtest, from 0.19.0).
User request: start a speed test from the server to the primary Usenet provider (fallback to the next one), for every
viewer (permission `AllowUsenetSpeedTest`, default on); a small "Streamarr path" overview (Usenet → server → this device)
in the app and the web admin; the Versions sheet marks versions whose bitrate does not fit the measured connection, and
the server ranks/auto-picks with that fit. Dev World 39350, Expo web 39351.

## Log
- Finding: `Config/ProviderSpeedTester` (admin) opens `MaxConnections` connections of its own on top of the live pool
  (warm-up keeps idle pool connections open), so provider-side it can exceed the account's connection limit and it
  ignores active streams.
- Server: `UsenetSpeedTestService` borrows the provider pool's *own* connections through a new non-blocking
  `ConnectionPool.TryBorrowAsync` (only permits free right now; idle pooled connections are reused first), so the test
  never exceeds `maxConnections` together with streams and never queues ahead of them. Target: up to 8 when idle; with
  active streams (sessions read in the last minute) or a busy pool at most 2 and a quarter of the maximum stays free;
  nothing free on the primary → `503 usenet_speedtest_no_free_connections`, no test.
- Fallback: providers in pool order (priority, pooled before backup-only); next one on connect_failed/auth_failed/
  no_article/timeout/no_data/error, at most 3. Article discovery GROUP/OVER (as the admin tester) on the borrowed
  connection, cached per provider 30 min; a stale reused idle connection is replaced and retried, not counted.
- Single flight (callers join), shared result 2 min (30 s after failure), 3 starts per viewer per 10 min, 8 s / 256 MiB,
  the current article is drained so connections go back clean. Result in memory only.
- Permission `AllowUsenetSpeedTest` (migration `ViewerUsenetSpeedTestPermission`, column default true → existing viewers
  allowed); Dev World `gast` has it off.
- Bitrate fit: needed = estimatedBitrateKbps × 1.3; ok when needed ≤ slower leg, tight when only the bitrate fits,
  tooHigh otherwise; Usenet leg skipped for `local: ready`, device leg skipped for predicted transcodes
  (`bandwidthViaTranscode`). `DeviceOrder`: playable → not tooHigh → local ready → score… (tooHigh now outranks local).
  Client headroom for the tier verdict unified to 1.3 (was 1.25).
- Decision: Usenet result as `measuredBandwidthKbps` only from the server's last ok test ≤ 7 days; the client sends its
  own device measurement only while ≤ 7 days old and shows markers only then (else the "Verbindung messen" hint).
- Web (sub-agent): Diagnostics "Streaming path" card + viewer toggle; English only like the rest of web/.
- Dev World: speed article in the mock groups, `POST/DELETE /devworld/usenet-speed` (shared line speed, failing primary +
  backup-only provider). Media generated fresh in this worktree (no shared cache).
- Live (Dev World 39350 `--tree`, Expo web 39351, Vite 39352, Playwright Chromium de-DE): staged 40 Mbit/s → measured
  38.8; 300 → 283; 24 → 23; primary failing (`no_article`) → backup-only provider measured at 172 (staged 180).
  `/devworld/usenet-speed` needed `.AllowAnonymous()` (the API auth middleware guards unknown routes).
- Problem: Expo web started with CI=1 does not watch files (as in STATUS) — restarted after the card fixes.
- Headless Chromium has no HEVC, so 4K predicts a transcode (shown as "Wird für dein Gerät umgewandelt – passt");
  the main sheet screenshot uses an init script that reports HEVC/HDR decode (a 4K HDR TV), like VERSIONS did.
- Phone fix found by the screenshots: the fit line wraps (pill, then "braucht ~X, gemessen ~Y"), and the sheet's
  "Empfohlen … – passt zu deiner Verbindung" wraps instead of running out of the header.

## Summary
Server ↔ Usenet speed test for every viewer (permission, default on) that respects the provider's connection limit and
active streams, falls back to the next provider and is shared; a "Streaming-Strecke" overview (Usenet → Server → Gerät)
in the app and the web admin; the server marks every version's bitrate fit (×1.3 headroom) against the device's own
measurement and the Usenet result, ranks `tooHigh` versions below fitting ones for Recommended and Play, and the app
shows markers or a "Verbindung messen" hint.

Endpoints: `GET/POST /api/v1/viewer/diagnostics/usenet-speed` (redacted) and `/api/v1/diagnostics/usenet-speed`
(names, errors); `measuredBandwidthKbps` on `GET …/versions` and in `POST /viewer/playback`; `VersionDto.bandwidthFit`,
`bandwidthLeg`, `bandwidthNeededKbps`, `bandwidthAvailableKbps`, `bandwidthViaTranscode`;
`ViewerPermissionsDto.allowUsenetSpeedTest`.

Commits: cb83331 server, 47adb22 web, 5fa9ea3 client, da12989 devworld, + fixes/docs.

## Verification
- dotnet test Streamarr.sln: Usenet 247/0, Core 512/0, DevWorld 92/0, Server 1681 passed / 13 failed (the known
  ffmpeg 9.0.1 Transcoding/Remux integration tests). New: UsenetSpeedTestServiceTests 18 (connection target theory,
  warm pool never above max, few connections next to streams, busy → no test, auth/no-article fallback, all failing,
  single flight, shared result, per-caller limit, bandwidth age, simulated line, redaction), UsenetSpeedEndpointTests 2
  (default allowed + redacted + shared + admin names; coded 403 until the admin allows), migration default true,
  BandwidthFitTests 9, ViewerVersionRankingTests +2 (fit + ranking via the endpoint, auto-pick with bandwidth).
- OpenAPI frozen; web `generate:api`, client `gen:api`.
- client: tsc ok, expo lint ok, prettier ok, jest 2231/2233 (the 2 known tab-guard failures). New: streaming-path
  (verdict + device storage), streaming-path-card (device/Usenet bottleneck, fallback + streams notes, permission off,
  failed), streaming-path-measure-all (Usenet POST before the device ping), version-fit (markers, request param, why,
  stale hint, hint → Connection), version-fit-tv (German markers + a11y label, hint focusable in the TV list).
- web: typecheck ok, vitest 291/291, build ok.
- Screenshots: docs/client/screenshots/USPEED/ (web-tv-1920-*, web-phone-390-*, web-admin-*).

## Open / follow-ups
- Not run on an Android TV emulator / real TV (TV layout verified on the web large shell and in jest; D-pad pending-device).
- Usenet results live in memory (a restart forgets them; the fit then uses only the device leg until a new test).
- The test uses at most 8 connections: a gigabit line with slow per-connection providers may read low.
- The admin's `POST /config/providers/{id}/speedtest` still opens its own connections on top of the pool (documented).
- Version lists are cached client-side 5 min; a new Usenet result invalidates them, a new device result changes the key.
