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

**Fix round 1 (f76055ed, announced to the parent the same turn), additive only:**
- `DownloadResponse.fileUrlRevoked` and `DownloadAdminItemDto.fileUrlRevoked` (bool): a security sign-out revoked the file
  URL; `fileUrl` is null until a renew, the state stays `ready`.
- `POST /viewer/downloads/{id}/renew?deviceId=` (new optional query): after a revocation it issues a **new** file URL
  (same ETag/size/bytes) and binds the download to the calling session and `deviceId`; otherwise unchanged (extends).
- File URL `GET|HEAD /api/v1/offline/{capability}`: new `410 download_revoked`, `403 age_restricted` (params as § 13),
  `412 precondition_failed` (If-Match) and `304` (If-None-Match); OpenAPI declares 304/412.
- Semantics (docs only): prepare idempotency key = viewer + `deviceId` (trimmed, case-insensitive; else the session) +
  `clientRef`, unique; open transfers end within 2 s on revocation/expiry/permission/age changes; disabling an account
  blocks (403) instead of rotating; CORS allows `If-Range`/`If-Match`/`If-None-Match`; `recommended` and the plan's
  fallback stay in the viewer's best audio language.

## Fix round 1

Verifier report `DL-S-verify1.md` (fb/dl-verify fd867464): 0 blockers, 10 majors, 7 minors — all 17 fixed. Commits:
f76055ed (code + contract), 0857ebb7 (regression tests), 2052ea31 (docs + web), c6c4ff9d (live checks), 1e9ffd3a
(test). Regression proof: the new tests that compile against the pre-fix API were run on a `git archive` copy of
9898774a — **34 failed there** (list below marked ✗-before); every one passes on the branch.

| Finding | Fix | Regression tests (✗-before = fails on 9898774a) |
|---|---|---|
| V1-01 capability in logs | `/offline` + `/download` in `RedactRequestPath`, `offline\|download\|transcode` in the core sanitizer (boundary: any non-token char), `/offline` treated as streaming for the request-log level | `CoreLogStoreTests.SanitizerRedactsDownloadAndTranscodeCapabilities` ✗, `RequestPathRedaction_HidesTheDownloadCapability` ✗, `RequestLogPolicy_UsesSignalBasedLevels(/api/v1/offline…)` ✗×2; live `downloads_security_check` V1-01 (no 64-hex `/offline/` in the server log after a 429 + transfers). An in-process log-feed test was dropped: Serilog's request middleware logs to the static global logger, so with several test hosts per process the line lands in another host's store. |
| V1-02 permission off / disabled | `ViewerAccessEvents` from `ViewerAccountService.UpdateAsync`/`DeleteAsync` → `ViewerDownloadService.AccessChangedAsync`: viewer generation bump, open transfers aborted, running preparations failed | `DownloadAccessTests.TurningDownloadsOff_EndsTheOpenTransfer_AndRefusesTheUrl` ✗, `DisablingTheAccount_EndsTheOpenTransfer_AndRefusesTheUrl` ✗, `TurningDownloadsOff_CancelsAPreparationInFlight`, `AnUnrelatedPermissionChange_KeepsTheTransferRunning` (no over-revocation); live V1-02 |
| V1-03 age gate on the file URL | `ViewerContentPolicy` on every file request; access change re-evaluates the works of open transfers | `ATightenedAgeLimit_AppliesToTheExistingFileUrl_AndItsOpenTransfer` ✗; live V1-03 |
| V1-04 security sign-out | `ViewerSessionService` publishes revocations (all reasons but `logout`/`account_disabled`) → rotation: hash → `RevokedCapabilityHash`, `410 download_revoked`, transfers aborted; renew issues a new capability | `SigningOutAllSessions_RevokesTheFileUrl_AndRenewAfterSignInIssuesANewOne` ✗, `AnAdminPasswordReset_RevokesTheFileUrl` ✗, `SigningOutOneDevice_RevokesOnlyThatDevicesDownloads` ✗, `AnOrdinaryLogout_KeepsTheFileUrl`; live V1-04 (×5) |
| V1-05 idempotency | `IdempotencyKey` unique index (migration `ViewerDownloadsHardening` dedupes old rows), per-viewer lock around lookup + quota + insert, unique-violation → load the winner | `ConcurrentRetriesOfOnePrepare_CreateOneDownload` ✗ (held SQLite writer lock like the verifier), `TheStoredQuota_HoldsUnderConcurrentPrepares` ✗; live V1-05 |
| V1-06 language (plan part superseded by fix round 1b) | plan fallback = first download in the best language on offer; episode/pack `recommended` = first playable in the best language (packs ordered by it) | `DownloadLanguageGateTests.*` ✗×3 (instance fixtures: affinity show season 2, English 2160p vs German 720p) |
| V1-07 live eviction | a transfer admission may only evict idle transfer sessions, else `ResourceCapacityException` | `DownloadPriorityTests.ATransferAdmission_NeverEvictsAPlaybackSession` ✗, `…MayReplaceAnIdleTransferSession_APlaybackOneMayToo` |
| V1-08 throttle debt | token bucket charging only granted bytes, rate re-read every ≤ 250 ms | `ACancelledThrottleWait_CostsNothing` ✗, `ARateChange_ReachesARequestThatIsAlreadyWaiting` ✗ |
| V1-09 completions | `CountedPlaybackIds` (last 32) for live and stale reports; stale completion judged on the report's own duration | `OfflineProgressTests.InterleavedReplays_*` ✗×2, `AStaleCompletion_IsJudgedAgainstItsOwnDuration` ✗, `ManyCompletions_KeepABoundedMemory…` |
| V1-10 preconditions | If-Match → 412 (envelope), If-None-Match → 304 (weak, lists, `*`), GET and HEAD, before admission | `Preconditions_AreEvaluatedBeforeAnyTransfer` ×11 (8 ✗); live V1-10 |
| V1-11 CORS | `AllowedHeaders` + `If-Range, If-Match, If-None-Match` on the production middleware | `ViewerCorsMiddlewareTests.APreflightForAResumableDownload_AllowsTheConditionalHeaders` ✗, `AFileAnswer_ExposesTheHeadersADownloaderReads` |
| V1-12 expiry in flight | lease deadlines + a 500 ms sweep that also re-reads the open downloads' records | `AnExpiringCapability_EndsTheOpenTransfer_AndRenewRestoresTheSameUrl` ✗ (DB change like the verifier), `TheExpirySweep_EndsTransfersWhoseDeadlinePassed` ✗; live V1-12 |
| V1-13 self-throttling | `SessionManager.OpenStream` reads transfer sessions through the transfer path (not paced, not live, no stream slot) | `DownloadTransferIntegrationTests.ATransferSessionsOwnStreamReads_AreNeverLive_AndSkipTheArticleCache` ✗, `DownloadPriorityTests.ATransferSessionsOwnReads_AreNeverLive_AndTakeNoStreamSlot`; live V1-13 |
| V1-14 revoke vs admission | `AccessStamp` generations read before the authoritative read, checked in `TryAdmit` under the governor lock; revocations commit then bump; re-authorization before the body | `ADeleteBetweenAuthorizationAndAdmission_IsNeverServed`, `ARevocationBetweenAuthorizationAndAdmission_AnswersTheRevocation` (test seam `BeforeAdmit`), `ACompleteWhileTheSourceOpens_IsAnsweredAsGone_NotServed` ✗ |
| V1-15 pin vs eviction | `ActiveSession.TryMarkClosedUnlessPinned` under the lifecycle lock; eviction closes before removing | `ClosingForEviction_AndPinning_DecideAtomically` (new API); `UnderContention_APinnedSessionIsNeverClosedByAnEviction` stress — **did not reproduce** the narrow race on 9898774a (passes before and after) |
| V1-16 preparation policy | `DownloadPreparation` scope + `PreparationAwareNntpClient` (shared `INntpClient`) route resolve/health/materialization to the download share at low priority; `ResolveAdmission` keeps ≥ 1 resolve slot for playback; probe via V1-13 | `DownloadPreparations_LeaveOneResolveSlotForPlayback`, `InsideAPreparation_NntpCommandsGoToTheDownloadClient`, `APreparationsResolve_UsesTheDownloadShare_AndItsProbeIsNeverLive` (new APIs; code-reading finding) |
| V1-17 close on last unpin | `SessionDownloadFileSource` marks released sessions; the last lease's dispose closes them | `AReleasedSession_ClosesWhenItsLastTransferEnds` ✗ |

Results: `dotnet build Streamarr.sln` 0 errors; `dotnet test`: Server 1933/1947 — the 13 known ffmpeg remux/transcoding
failures plus `TunnelRoutingE2ETests.ProviderIndexerAndSearch_GoThroughTheTunnel_AndFailClosedWhenItDrops` (timing flake
under full-suite load: "tunnel did not become down"; passes 3/3 alone), Usenet 256/256, Core 535/535, Dev World 94/94.
Web typecheck clean, 329/329. OpenAPI freeze: no drift after f76055ed. Live Dev World 39310: `downloads_check.py`
27/27, `downloads_security_check.py` 16/16 (V1-01…05, 10, 12, 13). Dev World snapshot re-published at 1e9ffd3a
(90/90 release checks). The verifier's own `adversarial.py` was not run (it writes into the verifier's worktree and
targets 39311).

## Fix round 1b

DL-C2's device phase: the plan with an untagged anchor (`Sherlock.S02E01.720p.WEB-DL.AAC2.0.H.264-DEVWORLD`) answered
`best_available` score 0 (a German 2160p HDR / 1080p BluRay) for `audioLanguages:["de"]` instead of `same_release`
(V1-06 had restricted the whole plan to the viewer's best language). **Binding decision (parent):** the viewer's explicit
pick defines the plan's language.

| Rule | Implementation (`ViewerCatalogService.DownloadPlanAsync`, commit 6c6c7de6) |
|---|---|
| Reference `L` = the anchor's parsed audio languages; untagged anchor = class "untagged" | `anchorLanguages = ReleaseParser.Parse(anchorTitle).Languages`; `SameLanguage(L, c)` = same primary (first parsed) language, or both untagged |
| `same_*` only among candidates compatible with `L`; language beats picture | affinity grades computed with compatibility as the language gate; incompatible candidates are never a similarity match |
| `best_available` = first compatible in device order, else first in the viewer's best audio language (else first overall) + `language_differs` (`params.languages`, `params.anchorLanguages`, comma list or `untagged`) when the pick is not compatible | `pick = similar ?? compatible.IndexOf(true)`, then the viewer-points fallback; note added whenever `!compatible[pick]` (`language_mismatch` kept for "similar only in another language") |
| `recommended` on candidates and packs keeps V1-06's viewer-language rule | unchanged (`DownloadListAsync`, `SeasonPacks`) |

No contract shape change: OpenAPI descriptions only (`DownloadPlanItemDto.notes`, `DownloadPlanRequest.audioLanguages`);
web and client `schema.d.ts` regenerated. Docs: api.md § 14 (plan section, `best_available` row), viewers.md Downloads
("follows the language of the version you picked"), Dev World README.

Tests (`DownloadLanguageGateTests`, fixture = the verifier's V1-06 shape: affinity show season 2 with English 2160p
`-ENGLISH` and German 720p `-GERMAN` per episode and as packs; ✗ = failed on the pre-fix code, run on a reverted source):
- `AnUntaggedPick_GetsItsOwnReleaseForTheNextEpisode_WhateverTheViewersLanguage(de|en|null)` — the Sherlock case (anchor ALPHA → `same_release` ALPHA, score 100, no notes); ✗ for `de`.
- `AGermanPick_PlansGerman_EvenForAnEnglishViewer_AndOverABetterPicture` — German anchor (same group → `same_release`; other group GAMMA → `best_available`) → German 720p for `["en"]`; ✗.
- `AnEnglishPick_PlansEnglish_EvenForAGermanViewer` — English anchor → English 2160p for `["de"]`; ✗.
- `NothingInThePicksLanguage_FallsBackToTheViewersLanguage_WithALanguageDiffersNote` — untagged anchor, only tagged candidates → German + `language_differs`; ✗.
- `TheLanguageClass_IsThePrimaryLanguage_OrBothUntagged` (6 cases, unit).
- Removed `DownloadCandidatesTests.Plan_NeverPassesOverTheViewersLanguage_ForASimilarRelease` (it pinned the overruled V1-06 plan behaviour; its fixture is now the `de` case above).
- `tools/downloads_check.py`: "plan: an untagged pick gets same_release for any audioLanguages (Sherlock)" (S02E02/E03 for de, en, none).

Evidence (commit 6c6c7de6): pre-fix run of the new tests on a reverted `ViewerCatalogService.Downloads.cs` → 4 failed
(German pick, English pick, untagged/`de`, fallback note), 4 passed (untagged/`en`, untagged/none, both recommendation
tests); with the fix 14/14. Affected suites (`Viewers.Downloads`, version ranking, catalog) 204/204. Full `dotnet test`:
Usenet 256/256, Core 535/535, Dev World 94/94, Server 1943/1957 — the 13 known ffmpeg transcode/remux failures plus
`TunnelSupervisorTests.HelperExit_IsDownWithTheLastErrorLine_AndRestarts` (NullReference under a load average of ~55 from
other lanes; 14/14 three times alone; no tunnel code on this branch). Web typecheck clean; OpenAPI diff = two
descriptions. Live Dev World 39310: `downloads_check.py` 28/28 (Sherlock S02E02/E03 `same_release` 100 for de, en and
none), `downloads_security_check.py` 16/16. Dev World snapshot re-published (`releases/20261106T224331Z-53482`, commit
6c6c7de6, 90/90 release/work pairs).

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

- 2026-11-06 fix round 1b: the similarity plan follows the picked version's language (parent decision), 4 new tests
  proven failing before, live 28/28 + 16/16, Dev World re-published (6c6c7de6).

- 2026-11-06 fix round 1: all 17 verifier findings fixed (f76055ed…1e9ffd3a), contract additions announced, 34 new tests
  proven failing on the pre-fix tree, live checks 27/27 + 16/16, Dev World re-published.

- 2026-11-06: read PLAN/downloads plan/BRIEF/architecture/viewers/api; explored catalog, predictor, decider, playback
  service, sessions, resolve, materializer, NNTP gates, segment cache, test hosts.
- 2026-11-06: slice 1 contract c029ac09 announced to the parent; implementation 9cb3a872; Dev World 5d54f4fc; web
  96d3e1cd; docs f64fcef7; full suites, live check and publish as above. Note: an early `pkill -f Streamarr.DevWorld.dll`
  of my own instance could have hit other instances — none was running (39300 log from Nov 2, nothing listening); later
  stops only by verified PID/cwd.
