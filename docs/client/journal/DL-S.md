# DL-S — offline downloads, server

Status: done

Branch `fb/dl-server` (worktree `../streamarr-worktrees/dl-server`, off `fb/downloads` be6f1978). Spec: PLAN.md § "DL —
offline downloads", `downloads-plan.html` § 6. Dev World for self-tests: 39310.

## Intent

Viewer API `/api/v1/viewer/downloads` (candidates, season candidates, similarity plan, async prepare with a hard
direct-play check, list/renew/complete/delete), a long-lived resumable file capability `/api/v1/offline/{capability}`,
persisted `ViewerDownloads`, `allowDownloads` + limits, download priority below live streams, `occurredAt` on watch
progress, web admin, Dev World fixtures, OpenAPI, docs, tests. Slice 1 freezes the contract.

## Decisions

- **Candidates are POST** (`/candidates`, `/candidates/season`) with a body `{ workId, device: DeviceProfileDto, … }`:
  the full engine profile (per-codec limits, subtitle formats, VLC caps) does not fit a query string. Read-only, no
  state change; documented as such.
- **Offline playability** = the playback decider (`PlaybackDecider.Decide`, the same as a start) restricted to direct
  candidates: native direct, else VLC direct; never remux/transcode. Bandwidth caps and `maxHeight` preferences are
  ignored (nothing is streamed live). Reason codes are the decider's skipped-direct reasons (i18n like
  `predictionReasons`) plus the predictor's assumption notes.
- **Order** = the versions list's `MapVersions` + `MergeCopies` + `DeviceOrder`, with the play class replaced by the
  offline class (direct / vlc / unplayable), so downloadable first, same score/affinity/penalty rules.
- **Size**: `sizeSource` `resolved` (exact, from a stream session or the resolved-file store of an earlier resolve of
  this release + work), `indexer` (the release's indexer size: an upper bound incl. PAR2/NFO, not exact), `estimate`
  (pack size ÷ episodes it covers). `sizeExact` is true only for `resolved` (deviation from the brief, which called a
  single-file release exact: the indexer size includes recovery data, 5–15 %).
- **File endpoint outside `/viewer`**: `GET|HEAD /api/v1/offline/{capability}` — anonymous like `/stream`, the capability
  is the credential, so it cannot carry the viewer gate's 401 (contract test: every `/viewer/*` op declares 401).
- **Pack coverage** comes from the season fan-out itself: a release id listed under several episodes of the cached
  season list covers exactly those episodes (full and partial packs, no extra parsing).
- Download stream sessions use their own client label `streamarr-download`, so a playback of another release never
  supersedes them and they never show as a server pre-download (`local`).

## Contract frozen

Commit **c029ac09** (`feat(viewer-downloads): freeze the offline download contract`). Routes:
`POST /api/v1/viewer/downloads/candidates`, `POST …/candidates/season`, `POST …/plan`, `POST /api/v1/viewer/downloads`
(202), `GET /api/v1/viewer/downloads?device=this|all&deviceId=`, `GET …/{downloadId}?waitMs=&deviceId=`,
`POST …/{downloadId}/renew`, `POST …/{downloadId}/complete`, `DELETE …/{downloadId}`, `GET|HEAD /api/v1/offline/{capability}`,
admin `GET /api/v1/config/viewers/downloads?viewerId=&activeOnly=`, `DELETE …/{downloadId}`; additive:
`ViewerPermissionsDto.allowDownloads/maxConcurrentDownloads`, `ViewerSettings{Response,Write}.downloads`,
`WatchProgressRequest.occurredAt`, `PlaybackSubtitleTrackDto.vlcOnly`. Services answered 501 at that commit.
Semantics: docs/api.md § 14.

## Contract changes after freeze

No schema change (OpenAPI re-frozen at the end: no drift). Semantics made precise in docs/api.md § 14 while
implementing: `renew`/`complete` answer `409 download_not_ready` unless ready, `complete` with a wrong `bytesReceived`
answers `409 size_mismatch`; the file URL answers `404 unknown_download` also for a not-yet-ready download; candidates'
`version.predictedMethod` (& reasons/height/hdr) carry how the version would stream with the full profile; the ready
`version` is ranked like the versions list (streaming order, `rank: 0` when not cached).

## Summary

Server side of offline downloads, end to end:

- **Candidates** (`POST /viewer/downloads/candidates`, `…/season`) reuse the catalog's own pipeline (a partial of
  `ViewerCatalogService`: same cache, ranking profile, audio languages, copy merge, series affinity, `DeviceOrder`) with
  the play class replaced by **offline playability** (`OfflinePlayback`: the playback decider restricted to native
  direct, else VLC direct; no connection cap, no subtitle selected). Reasons are the decider's codes + the predictor's
  assumptions; `streamingMethod` + the version's prediction say how it would stream. Sizes: `resolved` (exact, new
  `ResolvedFileStore` filled by every stream session), `indexer` (upper bound), `estimate` (pack ÷ covered episodes).
  Pack coverage comes from the season fan-out (a release listed under several episodes covers exactly those).
- **Plan** grades each episode's downloadable candidates against the anchor with `ViewerReleaseAffinity.Grades`
  (refactored out of `Points`: identity → `same_release`, ≥ 75 % + same picture → `same_variant`, ≥ 75 % →
  `same_group`, else `best_available`; language gate kept, `language_mismatch` note).
- **Prepare** (async, persisted, resumes after a restart): own prepare slots (default 1), resolve with client
  `streamarr-download` and no fallback, own copy walk (same name within 2 %), probe, **hard check** on the real file,
  mediaInfo with `vlcOnly` image subtitles, capability (64 hex, SHA-256 hash for lookup + Data-Protection copy for the
  owning device), strong ETag of (release, work, file, size).
- **File** `GET|HEAD /api/v1/offline/{capability}`: own Range/If-Range/416 handling, `Content-Disposition`, no-store +
  no-referrer, module gate, permission, expiry; bytes from `SessionDownloadFileSource` (reuse the transfer session or
  re-resolve the same release single-flight, check name + size, pin while read).
- **Priority** (architecture.md § 5.4): `DownloadConnectionGate` (25 % share, resizable `DynamicSemaphore`, then the global
  gate at Low), transfer streams without the `SegmentCache`, `DownloadTransferGovernor` (per download/viewer/server
  admission, one token bucket: 16 Mbit/s while a paced live stream is open or closed < 15 s ago, unlimited otherwise,
  speed meters), transfer sessions outside the byte budget, pinned against LRU and TTL, first to go when idle at the
  session-count limit; downloads never count towards stream limits.
- **Records/admin**: `ViewerDownloads` table (migration `ViewerDownloads`, cascade with the viewer), list per device
  (`deviceId` survives a re-login), renew/complete/delete, admin list/revoke; `allowDownloads` (default on) +
  `maxConcurrentDownloads` permissions; `downloads` block in the viewer settings.
- **occurredAt** on watch progress: clamped [now − 30 d, now]; an older report than the last activity never moves the
  position back but still counts a completion once per playback; old reports are not forwarded to the event stream.
- **Web admin**: viewer dialog toggle + limit, settings Downloads panel (Mbit/s), Viewers → Downloads tab (live
  transfers, speed, throttle badge, revoke). Screenshots `docs/client/screenshots/DL-S/` (light, dark, 420 px).
- **Dev World**: per-episode RAR pack `Pioneer.One.S01.720p.WEB-DL.AAC2.0.H.264-RARPACK` (`rar`), the mislabeled
  `Elephants.Dream.2006.720p.WEB-DL.AAC2.0.H.264.MP4-MISLABEL` (MKV + DTS, `mislabeled`), fault target `offline` for
  `throttle` / `direct_reset` / `direct_status` (scope download id / work / viewer), `scenarios.downloads` in
  devworld.json, README section, `tools/downloads_check.py`.

## Files

Server: `Viewers/Downloads/*` (contracts, service, file service, governor, file source, registration),
`Viewers/Controllers/{ViewerDownloadsController,OfflineFileController,ViewerDownloadsAdminController}.cs`,
`Viewers/Catalog/ViewerCatalogService.Downloads.cs` (+ `WorkReleasesAsync`/offline hook in `ViewerCatalogService.cs`),
`Viewers/Playback/OfflinePlayback.cs`, `Catalog/PlaybackPredictor.cs`, `Catalog/ViewerReleaseAffinity.cs`,
`Services/{ResolvedFileStore,DownloadNntpClient,DynamicSemaphore}.cs`, `Services/SessionManager.cs` (pins, live count,
`OpenTransferStream`), `Services/MediaFileMaterializer.cs` (`OpenTransferStream`), watch rules/service/controller,
permissions/settings/mappings, `ViewerCorsMiddleware` (+ `/api/v1/offline`), migration `20261106194206_ViewerDownloads`.
Tests: `Viewers/Downloads/*` (host, candidates, prepare, file, priority, offline progress),
`Integration/DownloadTransferIntegrationTests.cs`, contract tests. Dev World: catalog, publications, faults, seeder,
README, tests, tool. Web: viewers pages, queries, types, lib + tests. Docs: api.md § 14 (+ `/download/{token}`),
viewers.md, architecture.md § 5.4, configuration.md. Schemas: `server/openapi/v1.json`, `web` + `client` `schema.d.ts`.

## Evidence

- `dotnet build Streamarr.sln`: 0 errors. `dotnet test Streamarr.sln`: Server.Tests **1882/1895** (the 13 failures
  are the known transcoding/remux integration tests on the local ffmpeg: RemuxIntegrationTests ×7,
  TranscodingIntegrationTests ×6), Usenet 256/256, Core 535/535, DevWorld 94/94. Download tests: 36 API + 15 prepare +
  13 priority/offline-progress + 6 real-stack transfer (identical bytes across sessions for direct and RAR, pack episode
  file, dead → 410, wrong file → 409, no `SegmentCache` use, pinned) + contract cases.
- Web: `npm run typecheck` clean, `npm test` **329/329**.
- OpenAPI re-frozen at the end: no diff against the contract commit.
- Live Dev World 39310 (`tools/downloads_check.py`): **27/27** — candidates per device (Android TV native, iPhone
  native/VLC, MP4 assumed MKV until opened, then native + exact size), season with direct + RAR pack (6 episodes,
  4.725 GB / 787.5 MB share), plan 6× `same_release`, RAR episode prepared (3 819 976 B, native), HEAD headers, forced
  `direct_reset` after ~1.3 MB, `206` resume with If-Range, sha256 resumed = straight read = generated episode file,
  If-Range mismatch → 200, 416, bytesServed, complete → URL 404, delete → 404, mislabeled → `not_direct_playable`
  without VLC / `vlc` with VLC, third parallel transfer → `429 too_many_downloads` (scope viewer, Retry-After 10),
  admin activity, permission off → 403 on file + API, age gate 403, live stream (needs 0.28 MB/s) kept ≫ its rate
  next to a download while the download was held to 1.04 MB/s at an 8 Mbit/s cap (`throttled`, `liveStreams=1`).
- Dev World published: `~/.cache/streamarr-devworld/current -> releases/20261106T204652Z-8060` (commit f64fcef7, cache
  `…/dl-server/server/tests/Streamarr.DevWorld/cache`, media cloned from the main checkout's cache with `cp -c`), boot
  check 90/90 release/work pairs.

## Follow-ups

- The priority policy is proven structurally (share, priority, cache bypass, throttle) and on the local mock; a
  measurement on a real provider link (real contention) is still open.
- Transfers do not wait for a PAR2 repair at a hole: a missing article breaks the transfer, marks the release dead and
  the link then answers `410 download_source_gone` (prepare another version). Repair-while-downloading is a follow-up.
- `ResolvedFileStore` is in memory: after a restart sizes are `indexer`/`estimate` until the next resolve.
- Dev World media is 487 MiB (+ 23 MB RAR volumes), above the old 450 MB guideline (machine now 48 GB).
- `scripts/devworld.sh start` uses `nohup`, which fails in this agent sandbox ("can't detach from console"); running the
  dll directly works. The published snapshot predates the last tweak of `tools/downloads_check.py` (repo copy current).
- Client hints: send `deviceId`, renew links before `expiresAt`, honour `Retry-After` on 429/503, resume with
  `Range` + `If-Range: <eTag>`, call `complete` with `bytesReceived`, report offline progress with `occurredAt`.

## Log

- 2026-11-06: read PLAN/downloads plan/BRIEF/architecture/viewers/api; explored catalog, predictor, decider, playback
  service, sessions, resolve, materializer, NNTP gates, segment cache, test hosts.
- 2026-11-06: slice 1 contract c029ac09 announced to the parent; implementation 9cb3a872; Dev World 5d54f4fc; web
  96d3e1cd; docs f64fcef7; full suites, live check and publish as above. Note: an early `pkill -f Streamarr.DevWorld.dll`
  of my own instance could have hit other instances — none was running (39300 log from Nov 2, nothing listening); later
  stops only by verified PID/cwd.
