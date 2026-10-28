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
- ~~The admin's `POST /config/providers/{id}/speedtest` still opens its own connections on top of the pool~~ — fixed in
  the follow-up below.
- Version lists are cached client-side 5 min; a new Usenet result invalidates them, a new device result changes the key.

## Follow-up (coordinator): header reason per fit, one button per action
- Sheet header reason follows the recommended version's own fit: ok → "passt zu deiner Verbindung", tight → "knapp
  für deine Verbindung", unknown/none → no fit reason (local/affinity as before). Ranking unchanged: tight and unknown
  rank like ok (server test `TightAndUnknown_RankLikeOk_TheScoreDecides`); jest `version-fit-reason` + sheet test.
- Diagnostics screen: every action once. The verdict's button is "Alles messen" (same action and label as the card;
  "Gerät messen" without the Usenet permission) and shows only while nothing was measured on this visit; then the card
  shows it and takes TV focus (handoff + scroll). The card holds the single legs (and Cancel while the device test
  runs); the old "Speedtest" section is now "Letzte Gerätemessung" (ping, jitter, down/up, tiers, stored result) with
  no button. TV initial focus: the verdict's button; without a verdict the card's first button.
- Web: the browser speed card is a detail view without Start/Run again (Cancel only while running); measuring starts
  in the Streaming path card. The web verdict banner has no speed button.
- Dev World: a kept world drops a leftover `devworld-nntp-backup` provider at boot (it pointed at the previous boot's
  second mock and showed a Usenet outage).
- Still two "Erneut prüfen" during an outage (verdict + server section; both refresh the report) — pre-existing STATUS
  design, left as is.
- Checks: client tsc/lint/prettier ok, jest 2238/2240 (2 known tab-guard); server BandwidthFit/UsenetSpeed/ranking
  120/120, DevWorld 92/92; web vitest 291/291, build ok. Screenshots retaken (same names) +
  web-tv-1920-diagnostics-whole-de.png.

## Follow-up (coordinator): admin provider speed test on the safe path
- `Config/ProviderSpeedTester` (own `NntpConnection`s on top of the live pool, `MaxConnections` of them, its own gate)
  is deleted; `ProviderSpeedTestResult` moved to `Config/ProviderSpeedTestResult.cs` and gained `connectionsGranted`,
  `connectionsInUse`, `activeStreams` and `notice` (old fields unchanged).
- `UsenetSpeedTestService.TestProviderAsync` measures the admin's chosen provider through the same
  `MeasureProviderAsync`/`TransferAsync` as the viewer test (borrow via `TryBorrowAsync`, stale idle connection retry,
  article cache, drain). `ConnectionTarget` got an `idleLimit`: the admin gets all `maxConnections` when idle (the viewer
  stays at 8), next to streams/busy pool the same ≤ 2 with a quarter kept free; nothing free → `success: false`,
  `error` = `notice` ("No free connection of N (…); try again when playback has stopped."), no transfer.
  Admin and viewer tests share one gate (admin gets "already running", the viewer test waits for the admin's).
  Manual message-id, duration 1–15 s, 512 MiB bound and the 30 % headroom stay. Throughput is now counted on decoded
  bytes like the viewer test (a few % lower than the old raw-yEnc count).
- Draft case: the endpoint only tests *stored* providers (`/{id}/speedtest`, web dialog on a saved row); there is no
  draft-from-form test. The pool-less case that exists is a saved but **disabled** provider:
  `ProviderConfigService.SpeedTargetAsync` finds the live pool entry (entries mirror enabled rows by name, priority,
  type, max) — none → the test builds a throwaway pool capped at `maxConnections` minus what enabled entries on the
  same account (host + username) hold open (busy ones also trigger the streams rule), disposed afterwards.
- Web: dialog text says it uses the connections free right now; the result shows `notice`. OpenAPI frozen, web
  `generate:api`, client `gen:api` (types only).
- Tests: ProviderSpeedTestTests 13 (target theory incl. admin limit, idle → all from a warm pool never above max,
  next to streams 2 + notice, none free → no transfer, no pool → own capped, same account subtracted, one test at a
  time, notice texts); ConfigApiTests +1 (SpeedTargetAsync live/disabled matching + disabled endpoint run); the old
  ProviderSpeedTesterTests became the idle case. Server 1698 passed / 13 failed (known ffmpeg 9.0.1), Usenet 247,
  Core 512, DevWorld 92; web typecheck ok, vitest 292/292, build ok; client tsc ok.
