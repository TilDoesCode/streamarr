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

**Fix round 2 (4cd9ea7d), semantics only, no shape change (OpenAPI unchanged; announced to the parent):** a download still
preparing when its session is security-signed-out becomes `ready` with `fileUrlRevoked: true` (renewed like any revoked
row); prepare / get (incl. long-poll) / list / renew answer `401 unauthorized` when the caller's session was signed out
meanwhile; concurrent renewals return the same new `fileUrl`; prepare idempotency compares `deviceId` trimmed and ASCII
case-insensitively (non-ASCII letters now case-sensitive).

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

## Fix round 2

Verifier report `DL-S-verify2.md` (fb/dl-verify 1fa83667, on fb/downloads cdd6a6b8): 14/17 round-1 findings fixed; V1-04,
V1-05, V1-12 partial; 5 new findings V2-01…V2-05 (3 major, 2 minor). All fixed in **4cd9ea7d** (code, tests, docs), live
race check **29cc913d**. Decisions (parent): security generation per viewer/record (V2-01), per-download lock + DB predicate
(V2-02), compound unique index with one normalization in runtime and migration, the unshipped hardening migration may be
edited (V2-03), stable bucket + FIFO (V2-04), accounting off the body loop (V2-05).

Regression proof: the new tests that compile against the old API were ported into a `git archive` of **a48a0755** (fix
round 1b, the pre-round-2 code): **8 failed / 2 passed** — the 2 are deliberate guards that must pass before and after
(ordinary logout and another device's sign-out keep the URL). Seam/new-API tests (`ASignOutCommittingDuringARenewal…`,
`TheKey_IsUnique…`, `TheBucket_Holds…`) only exist after the fix. ✗ = failed on the pre-fix copy.

| Finding | Fix | Regression tests |
|---|---|---|
| **V2-01** preparing downloads escape sign-out (V1-04 rest) | `Viewers.SecurityGeneration` bumped in the **same transaction** as a security session revoke (`ViewerSessionService.RevokeWhereAsync`; sign-out-all/others bump even with no live session); records store it at prepare (inside the prepare's write transaction, with the session check) and renewal. `PublishReadyAsync` (download lock + write transaction): marked by the rotation, or generation moved on while the preparing session is gone → `ready` + revoked, no capability. The rotation now also marks covered preparing rows. Prepare / get (after the long-poll wait) / list / renew check the caller's session at answer time → `401`. | `DownloadAccessTests.ASecuritySignOutDuringPreparation_PublishesARevokedUrl_AndThePendingPollGets401` ✗ (pending poll 200 with URL before), `ASecuritySignOutAfterALogout_StillRevokesThePreparation` ✗ (generation-only case), guards `AnOrdinaryLogoutDuringPreparation_KeepsTheFileUrl`, `SigningOutAnotherDeviceDuringPreparation_KeepsThisDevicesUrl`; live `downloads_race_check.py` V2-01 ×2 |
| **V2-02** renewal vs sign-out / concurrent renewals (V1-04 rest) | `LifecycleAsync`: every record change in a SQLite write transaction (`BEGIN IMMEDIATE`, verified in Microsoft.Data.Sqlite 8.0.30: default transactions are immediate) saved against `ViewerDownloads.Revision` (EF concurrency token, retry on conflict); renew/publish/rotate/complete/delete also hold a per-download `KeyedAsyncLock`. Renewal checks the caller's session and stores the generation inside the transaction; a second renewal reloads and returns the first one's URL. Rotation candidates = ready **and** preparing rows of covered sessions, each re-read under its lock. | `ConcurrentRenewals_OfARevokedDownload_ShareOneUsableUrl_UnderWriterContention` ✗ (10 distinct URLs before), `RenewalsRacingASecuritySignOut_NeverLeaveAUsableUrl` ✗ (in-process 20 trials, usable > 0 before), `ASignOutCommittingDuringARenewal_RevokesTheRenewedUrl` (seam `BeforeLifecycleCommit`); live: 10 renewals under a held writer → 1 URL, all 200; 20 races → 0 usable (both outcomes seen: 200→410, 401) |
| **V2-03** ambiguous idempotency key (V1-05 rest) | No concatenated key: `DeviceKey` (`d:` + ASCII-lowercased trimmed `deviceId`, else `s:` + session) + unique index (`ViewerId`, `DeviceKey`, `ClientRef`). Hardening migration `20261106213923` edited: transitional key hex-encodes each field (no collision); new migration `20261106231635_ViewerDownloadsLifecycle` renames the column, recomputes the key with SQLite's ASCII-only `lower()` (= runtime), oldest of a true duplicate keeps it, adds `SecurityGeneration` (viewer + download) and `Revision`. Lookup/insert by the three columns; a unique violation reloads that tuple only. | `DistinctDeviceAndClientReferences_NeverShareADownload` ✗ (same id before), `ViewerDownloadsLifecycleMigrationTests.DistinctTuples_KeepTheirOwnKeys_AndTrueDuplicates_LeaveItToTheOldest` ✗ (`UNIQUE constraint failed: ViewerDownloads.IdempotencyKey` before; pre-hardening DB with `("alpha\|beta","gamma")`/`("alpha","beta\|gamma")`, three case variants of one tuple, a session-keyed and a clientRef-less row), `TheKey_IsUniquePerViewerDeviceAndClientReference`; existing `ConcurrentRetriesOfOnePrepare_CreateOneDownload` green; live V2-03 |
| **V2-04** small requests starve a large one | Bucket capacity = max(64 KiB transfer chunk, 1 s of rate), stable for all callers; FIFO queue of reservations (head waits for its tokens, later arrivals queue behind, cancellation leaves the queue without charge, the head's departure wakes the next, rate re-read every ≤ 250 ms). | `DownloadPriorityTests.ALargeRequest_IsServedInItsTurn_WhileSmallOnesKeepArriving` ✗ (8 kbit/s, 1000-byte waiter + 1-byte calls every 10 ms: served in 0.8–1.6 s, no small call before it), `TheBucket_HoldsATransferChunk_OrASecondOfTheRate`; V1-08 tests kept (`ACancelledThrottleWait_CostsNothing`, `ARateChange_…` now drain the larger bucket first); `WhileALiveStreamPlays_…StayAtTheCap` re-dimensioned for the 1 s bucket (800 kB at 200 kB/s ≥ 2.7 s) |
| **V2-05** expiry blocked on accounting (V1-12 rest) | `DownloadAccounting` (hosted): the body loop only adds bytes in memory; a background writer flushes every 2 s and when a request ends, 5 s timeout per write, failed bytes kept for the next round, last flush on shutdown. `CopyAsync` registers `HttpContext.Abort()` on the lease token, so revocation/expiry ends the response wherever the loop waits; the slot is released when it returns. | `AnExpiringTransfer_EndsWithinTwoSeconds_WhileTheDatabaseWriterIsBusy` ✗ ("the open transfer kept going" before; also asserts slot freed and bytes recorded after the writer is released); live V2-05 ×2 (ended at expiry + 2.2 s with the writer held, 5.2 MB read, `activeTransfers: 0`, then `410 download_expired`) |

Docs: api.md § 14 (idempotency tuple + ASCII case folding, preparing downloads and concurrent renewals under the security
sign-out rules, "Signed-out callers" 401 rule, access ending also while the database is busy), architecture.md § 5.4
(FIFO bucket, background accounting, "Lifecycle and security"), viewers.md (preparing downloads, concurrent renewals),
Dev World README (`downloads_race_check.py`). The verifier's `round2_probe.py` / `round2_races.py` hard-code port 39311
and their own state DB, so they were ported into `server/tests/Streamarr.DevWorld/tools/downloads_race_check.py [url] [db]`.

Evidence (commits 4cd9ea7d, 29cc913d, c3e8b14d = one-line comments): affected suites (`Viewers|Integration|Services|
Persistence` without transcoding) **1435/1435**; `DownloadAccessTests` 36/36, `DownloadPriorityTests` 24/24, migration
tests 4/4. Full `dotnet build` 0 errors; full `dotnet test`: Usenet 256/256, Core 535/535, Dev World 94/94, **Server
1956/1970** — the 13 known ffmpeg transcode/remux failures plus `ViewerVersionsLatencyTests.ACachedListOf150Versions…`
(warm median 364 ms against 250 ms at a load average of ~45 from other lanes; **3/3 alone**, no catalog code changed in
this round). Pre-existing, not ours: `TranscodingIntegrationTests.OnePlayerSeekingFarAndStraightBack_GetsItsSegmentAtOnce_
WhileAnotherPlayerStillWaits` (the verifier measured 3.97–4.49 s against 3 s, also on 9898774a; it passed in this run).
OpenAPI: no drift; web and client untouched (no schema change). Live Dev World 39310: `downloads_race_check.py` **9/9**
(V2-01 ×2, V1-04 rotation resume — sha256 prefix 0374de6231bf136b as the verifier's —, V2-02 ×2, V2-03, V1-13, V2-05 ×2),
`downloads_check.py` **28/28**, `downloads_security_check.py` **16/16**. Dev World snapshot re-published
(`releases/20261106T233658Z-34447`, commit c3e8b14d, 0 uncommitted files, 90/90 release/work pairs).

## Fix round 3

Verifier report `DL-S-verify3.md` (fb/dl-verify 3595a4e0, on fb/downloads d9f040a2): V2-01…V2-05 fixed, the V1-05/V1-12
remainders fixed, versions latency 12/12 (machine load, no regression), 0/20 usable URLs after sign-out races. Remaining:
V3-01 (major, the last piece of V1-04), V3-02 and V3-03 (minor). All fixed in **2621d4c8** (code, tests, docs); live checks
**6be29f29**. Decisions (parent): capability invalidation inside the security transaction with the exact session scope (no
blanket generation comparison); post-commit work never uses the request token; startup + periodic reconciliation of open
leases; requeue + cursor + fresh final timeout for accounting; one device-identity helper used everywhere.

Regression proof: the new tests, copied into a `git archive` of **591724de** (the pre-round-3 code), give **10 failed / 5
passed**. The 5 are deliberate guards that pass before and after: ordinary logout, another device's sign-out, the
admission race, a cancelled sign-out during preparation (the round-2 generation check already covered that) and a failed
accounting write kept for the next round. The governor unit test needs the new API and runs only after the fix. ✗ = failed
on the pre-fix copy.

| Finding | Fix | Regression tests |
|---|---|---|
| **V3-01** committed sign-out, request cancelled after commit, old URL usable | `ViewerSessionService.RevokeWhereAsync` now does session revoke + `SecurityGeneration` bump + `DownloadCapabilityRetirement.RetireAsync` (ready rows: hash → `RevokedCapabilityHash`, capability cleared, `CapabilityRevokedAt`, `Revision+1`; preparing rows marked) in **one** transaction, scoped like `ViewerSessionRevocation.Covers` (one session / all but one / all). After the commit the follow-up (`NotifyAsync`) runs with `CancellationToken.None`, never fails the request and only aborts the leases of the retired downloads. The listener no longer writes rows. Post-commit revokes/access events of password set/change/reset, 2FA reset, disable and delete also use `CancellationToken.None`. Leases record the capability hash they were admitted with; `SweepTransfersAsync` (at start, then every 0.5 s) ends leases whose hash is no longer the row's, whose download left ready/expired/was deleted, or whose viewer is disabled or may not download. | `DownloadAccessTests.ASignOutCancelledRightAfterItsCommit_StillRetiresTheFileUrl_AndEndsTheTransfer` ✗ (EF interceptor cancels the request token in `TransactionCommittedAsync`; before: full file sent, URL 200), `ASignOutWhoseFollowUpNeverRuns_StillRetiresTheUrl_AndTheSweepEndsTheTransfer` ✗ (interceptor throws after commit = process stops), `ATransferOfARetiredUrl_Ends_AlsoWhenTheDownloadWasRenewedMeanwhile` ✗, `AfterAStopRightAfterTheSignOutCommits_TheOldUrlIsRevokedOnTheNextStart` ✗ (second host on the same database directory → 410 `download_revoked`), `ACancelledSignOutOfOneDevice_RetiresOnlyThatDevicesUrl` ✗ (other device stays 200), `ASignOutCancelledRightAfterItsCommit_DuringPreparation_StillPublishesARevokedUrl` (guard); unchanged guards `AnOrdinaryLogout_KeepsTheFileUrl`, `SigningOutOneDevice_RevokesOnlyThatDevicesDownloads`; `ARevocationBetweenAuthorizationAndAdmission_AnswersTheRevocation` now signs out through the session service; `DownloadPriorityTests.ALeaseAdmittedWithARetiredCapability_IsEnded_OneWithTheCurrentOneIsNot`; live V3-01 (below) |
| **V3-02** graceful shutdown loses queued accounting | `DownloadAccounting.FlushAsync` takes a snapshot list and a cursor; a failed write requeues its entry and continues; on shutdown cancellation the current and every unwritten entry go back before rethrowing, so written ones are never replayed. Flushes are serialized (`_flushGate`), so `StopAsync`'s final flush (own 5 s timeout, a timeout only logged) runs after the loop has requeued. | `DownloadAccountingTests.AStopWhileTheFirstWriteIsHeld_StillWritesEveryQueuedByte` ✗ (the verifier's 111/222 case: saved [111, 222]), `AStopAfterOneWriteCommitted_NeverWritesItAgain` ✗ (cursor: second write held, first committed once), `AFailedWrite_KeepsItsBytesForTheNextRound` (guard) |
| **V3-03** device normalization mismatch | `ViewerDownloadService.DeviceIdOf` (trimmed, ASCII letters folded, other letters kept) is the only device identity: idempotency key (`DeviceKey`), stored `DeviceId` (prepare, renew rebinding), `device=this` filter, `GET ?deviceId=`, `thisDevice`/`fileUrl`. Data migration `20261107000657_ViewerDownloadsDeviceIdentity` lowercases stored `DeviceId`s with SQLite's ASCII-only `lower()`. | `ACaseOnlyDifferentDeviceId_FromAnotherSession_IsTheSameDevice_AndGetsItsUrl` ✗ (created `"Phone"`, retried `" PHONE "`, list/get with other casings return the URL), `NonAsciiLettersOfADeviceId_StayCaseSensitive` ✗ (`"Äpfel"` ≠ `"äpfel"`, `"ÄPFEL"` = `"Äpfel"`), `ViewerDownloadsLifecycleMigrationTests.StoredDeviceIds_TakeTheFormEveryComparisonUses` ✗; live V3-03 |

Docs: api.md § 14 (URLs retired in the sign-out's own transaction, also when its request is cancelled or the server stops,
transfer check every 0.5 s and at start; one `deviceId` identity everywhere), architecture.md § 5.4 "Lifecycle and
security", viewers.md, Dev World README. No contract change; OpenAPI no drift.

Evidence (commits 2621d4c8, 6be29f29): affected suites (`Viewers.Downloads`, transfer integration, persistence, viewer API,
sessions, rules) **253/253**; the five sweep/restart/accounting tests 3× in a row green. Full `dotnet build` 0 errors (26
warnings, as before); full `dotnet test`: Usenet 256/256, Core 535/535, Dev World 94/94, **Server 1970/1983 — exactly the
13 known ffmpeg transcode/remux failures** (the versions-latency and `OnePlayerSeekingFarAndStraightBack…` tests passed this
run). OpenAPI: no drift; web and client untouched. Live Dev World 39310: `downloads_race_check.py` **11/11** — V3-01: the
admin sign-out connection reset at 26 points 0–25 ms after sending, **25 committed, all 25 old URLs `410`, 0 usable** (the
0 ms abort did not commit); whether a reset fell exactly between commit and follow-up cannot be seen from outside, so the
interceptor tests are the deterministic proof — V3-03 mixed-case retry from another session returns the URL on retry,
get and list; plus V2-01/02/03/05, V1-04, V1-13 — `downloads_check.py` **28/28**, `downloads_security_check.py` **16/16**.
Dev World snapshot re-published (`releases/20261107T001952Z-24516`, commit 6be29f29, 0 uncommitted files, 90/90
release/work pairs).

## Fix round 4

Verifier report `DL-S-verify4.md` (fb/dl-verify a0f95ea2, on fb/downloads 319cc2dc): **pass with findings — all 25 earlier
findings fixed**; one minor finding open. **V4-01**: stale cancellation hit a valid transfer on a newly renewed capability —
(a) the sweep read the old hash, awaited its viewers query, then `AbortStale(id, oldHash)` applied to every lease present
by then; (b) the post-commit follow-up called `governor.Abort(id)` by download id. Either truncated a fresh response on the
renewed URL (65,536 / 1,000,000 bytes, then IOException). Fixed in **3c776497**; live check **464a7952**; test timing fix
**d0c74a18** (see below).
Decision (parent): cancellation targets lease instances / capability identity, never a download id alone.

| Part | Fix (commit 3c776497) | Regression tests |
|---|---|---|
| Lease identity | `TransferLease.Ref` = `LeaseRef(Id, DownloadId, ViewerId, WorkId, CapabilityHash, AdmittedRevision)`, immutable, set at admission (the file service passes the capability hash and the record revision it read). `AccessStamp` gained a per-capability generation, so a retirement refuses authorizations in flight with that capability only. | `RetiringACapability_RefusesAuthorizationsInFlightWithIt_ButNotWithTheRenewedOne` |
| Post-commit follow-up | `DownloadCapabilityRetirement.RetireAsync` returns `RetiredCapability(DownloadId, CapabilityHash)` read inside the sign-out transaction; `ViewerSessionRevocation.RetiredCapabilities` carries them; `SessionsRevokedAsync` calls `RetireCapability(id, hash)` (ends only that capability's requests). | `DownloadAccessTests.ADelayedSignOutFollowUp_NeverEndsATransferOfTheRenewedUrl` ✗ (schedule b: delayed notification → renew → fresh GET → release); `RetiringACapability_EndsOnlyItsRequests_ARenewedUrlKeepsTransferring` |
| Sweep | Snapshots `ActiveLeases()`, reads rows and blocked viewers after it, then per captured lease: capability no longer the row's (revoked or replaced) → `RetireCapability` (it never comes back); row missing / not ready / expired / viewer blocked → that **instance** goes into `Cancel(stale)`. Requests admitted after the snapshot are never touched; the sweep no longer moves deadlines from a stale row. | `ASweepWithAStaleSnapshot_NeverEndsATransferOfTheRenewedUrl` ✗ (schedule a: held viewers query → sign-out → renew → fresh GET → release); `CancellingASnapshot_NeverHitsARequestAdmittedAfterIt` |
| Other paths | Access changes: `RevokeViewer` bumps the viewer generation and returns the requests open at that moment; only those are judged and `Cancel`led (permission off / disable / age policy). Terminal changes: delete and admin revoke read the final revision inside their deleting transaction, complete uses the revision its transaction wrote → `EndDownload(id, revision)` ends every request admitted at or before it. Renewal: `SetDeadline(id, hash, expiry)` moves only the renewed capability's deadlines. `Abort`, `AbortAll`, `AbortStale`, `ActiveOf` are gone. | `EndingADownload_EndsEveryOpenRequestOfIt(delete/complete/admin)` (two parallel requests each); `EndDownload_EndsEveryOpenRequestOfTheDownload_AndRefusesAuthorizationsInFlight`; `RevokingAViewer_…`; `ARenewalMovesTheDeadline_OnlyOfTheRenewedCapabilitysRequests` |

Regression proof: the access-test file copied into a `git archive` of **f6af73fd** (pre-round-4 code) — both schedule tests
**fail twice in a row** with `Expected: 1000000, Actual: 65536` (exactly the verifier's numbers); the guards pass there
(sign-out ends the old transfer, retired URL ends after a renewal, delete/complete/admin end every request). The governor
unit tests need the new API and run only after the fix. On the branch both schedules and the guard theory passed **3 runs
in a row**. In the first full-suite run, schedule (b) failed once on its *old*-transfer bound (ended after 3.2 s against
2.5 s at a load average of ~35). Not a product failure: that test holds the follow-up across a login, a renewal and a new
GET, so only the background sweep can end the old transfer. **d0c74a18** drops the 2 s bound there (it still requires the
renewed transfer complete and the old one ended short of the file; the 2 s guard for a normal sign-out stays in
`SigningOutAllSessions…` and schedule (a)). Afterwards 5/5 runs green, and re-checked on f6af73fd: still fails there with
65,536 bytes. No contract change; OpenAPI no drift; web/client untouched. Docs: architecture.md § 5.4 ("Cancellation never
targets a download id alone"), api.md § 14 (a URL renewed in the meantime keeps transferring), Dev World README.

Evidence (commits 3c776497, 464a7952, d0c74a18): affected suites (`Viewers.Downloads`, transfer integration, persistence,
viewer API/sessions/rules, contract) **286/286**. Full `dotnet build` 0 errors (26 warnings, as before). Full `dotnet test`
(rerun after d0c74a18): Usenet 256/256, Core 535/535, Dev World 94/94, **Server 1979/1992 — exactly the 13 known ffmpeg
transcode/remux failures**. OpenAPI: no drift; web and client untouched. Live Dev World 39310: `downloads_race_check.py`
**12/12** — new V4-01 case: throttled transfer on URL A, security sign-out, immediate renewal, ranged 1 MB transfer on URL B
across the follow-up and ~8 sweeps → B **206 with all 1,000,000 bytes, no error**, A ended (131,072 bytes) and answers
`410 download_revoked`; V3-01 24 committed / 2 uncommitted aborted sign-outs, 0 usable — `downloads_check.py` **28/28**,
`downloads_security_check.py` **16/16**. The exact stale-snapshot interleaving cannot be forced from outside; the two
component schedules are the deterministic proof. Dev World snapshot re-published at the final HEAD (see Log).

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

- 2026-11-07 fix round 4: V4-01 (cancellation by lease instance / capability identity, never by download id) fixed in
  3c776497 (+ live check 464a7952, test timing d0c74a18); both verifier schedules fail on f6af73fd with 65,536 / 1,000,000
  bytes and pass on the branch; Server 1979/1992 (13 known ffmpeg only), live 12/12 + 28/28 + 16/16, Dev World re-published.

- 2026-11-07 fix round 3: V3-01 (capabilities retired in the sign-out transaction, post-commit work request-independent,
  lease reconciliation), V3-02 (lossless accounting stop), V3-03 (one device identity) fixed (2621d4c8, 6be29f29); 10 new
  tests proven failing on 591724de; Server 1970/1983 (13 known ffmpeg only), live 11/11 + 28/28 + 16/16, Dev World re-published.

- 2026-11-07 fix round 2: V2-01…V2-05 and the rest of V1-04/05/12 fixed (4cd9ea7d, 29cc913d, c3e8b14d); 8 new tests proven
  failing on a48a0755, live 9/9 + 28/28 + 16/16, Dev World re-published (c3e8b14d).

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
