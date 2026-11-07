# DL-C-verify3 — final independent client check

**Verdict: fail.** The requested integrated baseline passes **295 suites / 2,998 tests** on Node 24.14.0. The round-2 repros pass **14/14** after adapting their obsolete clock fixtures and failed-task assertion. A fresh audit nevertheless confirms **five new findings: 0 blockers, 4 majors, 1 minor**, with eight failing behavioral assertions. Four older findings remain **partial**: C1-21, C2-03, C2-05, C2-08; the other 32 are fixed in their original scope. New findings are not counted twice as additional old defects.

Work stayed in `/Volumes/DevSSD/Development/local-projects/streamarr-worktrees/dl-verify-client`, branch `fb/dl-verify-client`. No product edits after the integration merge, no pushes, devices, native builds, or real-server mutations. All new/updated tests are under `client/src/__verify__/`; evidence/scripts are under `tools/dl-verify-client/`. No provider prompt refusal occurred.

Requested baseline: **092a2fba962d9679eabaf1ce095a2a85ee81e531**. The branch advanced between the ref check and merge: merge **c44f6920d10021788530d91f0068e6992c6b1da0** has incoming parent **65e1057a12b6864469f4e1e2174c6a5f28b17ac9**. Its only delta from 092a2fba is 17 lines in `docs/client/journal/DL.md`; client code and contracts are identical. Both merge and report commit carry the verifier's requested trailer. Later branch advances were not merged. The TV focus fix after Resume and DL-S 8/per-server resume thresholds are explicitly out of scope; neither is counted as a finding.

## Commands and exact results

All client checks used `source "$HOME/.nvm/nvm.sh"; nvm use 24`, then `source docs/client/env.sh`, then `cd client`: **Node 24.14.0 / npm 11.9.0**. Raw logs remain Git-ignored in the verifier tools directory; compact receipts and the final behavioral failures are committed as `round3-results.txt` and `round3-required-behavior.txt`.

| Command | Result |
|---|---|
| `git merge fb/downloads` with explicit Co-Authored-By trailer | Clean merge c44f6920; incoming parent/delta recorded above. |
| `npm install` | Exit 0; patch-package completed; no tracked dependency changes retained. |
| Untouched old repros: `DL_VERIFY_EXPECT_FIXED=1 npx jest src/__verify__/round2 --runInBand` | **7 suites: 5 passed, 2 failed; 14 tests: 11 passed, 3 failed; 0 snapshots; 5.095 s.** See fixture changes below. |
| Initial `npm run typecheck` / `npm run lint` | Typecheck: 7 errors, all obsolete clock API calls in the verifier file. Lint: exit 0, no warnings. These are not product failures. |
| Baseline `npx jest --testPathIgnorePatterns=src/__verify__/` | Exit 0; **295 passed suites, 2,998 passed tests, 0 snapshots; 51.804 s.** |
| Updated old repros: `DL_VERIFY_EXPECT_FIXED=1 npx jest src/__verify__/round2 --runInBand` | Exit 0; **7 passed suites, 14 passed tests, 0 snapshots; 3.848 s.** Ordinary assertions; no expected-failure wrappers remain on these old cases. |
| Final `npm run typecheck` | Exit 0; **0 diagnostics**. |
| Final `npm run lint` | Exit 0; **0 errors, 0 warnings**. |
| Required behavior, all verifier files: `DL_VERIFY_EXPECT_FIXED=1 npx jest src/__verify__ --runInBand` | Exit 1; **11 suites: 8 passed, 3 failed; 27 tests: 19 passed, 8 failed; 0 snapshots; 4.414 s.** All eight failures are the intended behavioral assertions for C3-01…05, with no fixture exception or timeout. |
| Final full `npx jest` | Exit 0; **306 passed suites, 3,025 passed tests, 0 snapshots; 41.895 s.** Includes eight documented expected-failure assertions. |

Both full runs printed a force-exited-worker teardown warning while exiting 0. This pre-existing baseline warning is retained in the receipts; no individual suite failed.

The untouched old clock test called `noteServerDate(date, at)` and `serverNow(at)`, which now require a server key. It also bypassed the API-client middleware where Date headers are now learned. Those fixtures now use real `createApiClient`, distinct server keys and an injected elapsed clock with a real boot identity. The old Pause test required a failed fake-engine task to become `paused`; the final engine contract permits that already-failed task to remain failed. It now asserts that the **record stays paused and there is no additional engine Resume**, matching the maintained regression. These are explicit contract adaptations, not removed behavioral requirements.

New defect tests default to `it.failing` so the full suite stays useful: a green expected-failure case means **defect reproduced**, not fixed. `DL_VERIFY_EXPECT_FIXED=1` switches them to ordinary assertions. The five positive new checks cover duplicate/mixed-case/other-device adoption, an in-flight POST at launch, elapsed clocks/reboot/process ids, the local recovery limit, and streaming C31 behavior. The four older positive checks still cover owner tokens, cleanup accounting, offline deep links and clock persistence.

## Status of every previous finding

Paths are relative to `client/src/` unless stated otherwise. “Fixed” refers to the original scenario; broader failures in adjacent paths are cross-referenced. All cited maintained tests ran in the baseline/full suite.

| ID | Status | Evidence / remaining limit |
|---|---|---|
| C1-01 | fixed | `downloads/__tests__/races.test.ts`, Pause during prepare; `manager.ts` prepare keeps a paused record. New restart/Resume races are C3-01. |
| C1-02 | fixed | `races.test.ts`, removal during enqueue and late artwork; `removing.test.ts` drain/path ownership. Removal records reject late writes. |
| C1-03 | fixed | `races.test.ts`, two starts replacing one failed work; serialized `startNow`, stable clientRef. |
| C1-04 | fixed | `connectivity/__tests__/monitor.test.ts` C1-04, 502/503/504 after successful probe. |
| C1-05 | fixed | Monitor C1-05, new server probed while old probe is pending; generation/server checks. |
| C1-06 | fixed | `downloads/__tests__/local-play.test.tsx` play-start stat/fallback; `races.test.ts` missing/short files and retry; local failure card tests. |
| C1-07 | fixed | `downloads/__tests__/storage.test.tsx` sampled free/written accounting and unknown space; round2-storage positive check. Cleanup concurrency now fails C3-02, independently of fit arithmetic. |
| C1-08 | fixed | `player/__tests__/progress-sync.test.ts` acknowledgement targets entry ID, preserving a same-time replacement. |
| C1-09 | fixed | `screens/downloads/__tests__/sheet-regressions.test.tsx` picked version loses fit; confirm validates current space at press time. |
| C1-10 | fixed | Sheet/model failed-row replacement and reason; detail/list tests expose Other version rather than treating failure as in progress. |
| C1-11 | fixed | Sheet regressions arbitrary anchor episode/version, fitting default, wrap, none-fits and Back. |
| C1-12 | fixed | `downloads/__tests__/manager.test.ts` expired/revoked/source gone; GET authoritative, renew sends deviceId and preserves bytes. `transfer-intent.test.ts` covers delayed revoked GET. |
| C1-13 | fixed | `races.test.ts` delete-watched after player releases hold, and on enabling setting; defaults off. |
| C1-14 | fixed | `player/__tests__/local-tracks.test.ts`; saved VLC-only subtitles restored on local VLC switch. |
| C1-15 | fixed | `downloads/__tests__/local-play.test.tsx` offline next, gaps/seasons/deletion; play-screen selects offline branch without server fallback. |
| C1-16 | fixed | Sheet/model partial and non-contiguous pack, retained subset, exact/share sizes and existing episodes. |
| C1-17 | fixed | `races.test.ts` 200-record progress notification test; per-record subscriptions, throttled global notifications. No device frame-time claim. |
| C1-18 | fixed | `races.test.ts` rejected completion stays pending; 404 and download_not_ready cases; complete sends bytesReceived. |
| C1-19 | fixed | Abortable polling-delay tests in `races.test.ts`; listeners removed on timeout/abort. |
| C1-20 | fixed | Sheet regressions stream-only footer in row/anchor pickers. |
| C1-21 | partial | Unknown/expired verdict locks and persisted age rules are covered by `age-verdict.test.ts`, `policy.test.tsx`, `local-play.test.tsx` and UI age tests. **C3-04** still allows a successful unknown-rating refusal offline. PIN remains unsupported app-wide; no existing PIN protection was bypassed. |
| C1-22 | fixed | Independent 295/2,998 green baseline on Node 24; download-detail/navigation suites pass; final typecheck/lint clean after verifier fixture adaptation. |
| C1-23 | fixed | `coverage.test.ts`, `races.test.ts`, 24-episode edited-plan model, sign-out/keep/remove, notification tombstone and Retry-After/concurrency tests close the original enumerated gaps. New races have C3 IDs. |
| C1-24 | fixed | `offline-shell-change-password[-launch].test.tsx`, `change-password-cold-start.test.tsx`, profile-sync and query-client tests: no password-change frame before probe, offline shell/no account fetch, playback retained, automatic return. Online query pause is confined to account keys; web/tvOS retain error-card behavior. |
| C1-25 | fixed | Four-way sheet focus trap/Back/opener-return and hidden-tab/deep-link tests; cold/warm offline Downloads repro passes. In-flight TV row focus after Resume explicitly excluded. |
| C1-26 | fixed | Static scan found no multiline block comments in reviewed DL-C1/DL-C2 product directories (downloads excluding native-owned engine interface, connectivity, download screens/components and server-clock). Engine/native documentation is DL-N's frozen interface. |
| C2-01 | fixed | `server-housekeeping.test.ts` and round2-removal: orphan DELETE uses outbox; 401 parks scan, one request across repeated scans. |
| C2-02 | fixed | Same suites: old-session 401 cannot park new session; `sessions`/generation guards, owner-bound clients. Round2 actual-token isolation passes. |
| C2-03 | partial | Single-file persistent cleanup, mount return and live-engine ownership pass `cleanup-jobs.test.ts` and old repro. **Concurrent failed removals can erase a cleanup job (C3-02).** |
| C2-04 | fixed | `reconcile.test.ts` adoption by clientRef/deviceId, case/trim matching, other device ignored, timeout/idempotent fallback; server-housekeeping POST/list race. Fresh duplicate-entry and in-flight-POST checks also pass. |
| C2-05 | partial | Old revoked-GET/removal-during-renew cases now pass; `transfer-intent.test.ts` sign-out mid-refusal parks correctly. **Intent checks remain missing around enqueue/start, engine Resume and validator restart (C3-01).** |
| C2-06 | fixed | API middleware keys Date learning by normalized serverKey; old keyed-clock repro, `lib/__tests__/server-clock.test.ts` ±2 h and path-prefix tests, fresh elapsed-clock/server-switch check pass. |
| C2-07 | fixed | Native `clock()` anchor, real boot identity across process restart, wall correction both directions; reboot/process ids estimated with uncertainty. Old repro and fresh 3-day elapsed/boot check pass. Per-server resume thresholds are excluded. |
| C2-08 | partial | Failed access lookup is independently revalidated and locks unknown metadata; old repro passes. **Successful rating_unavailable is treated as verified (C3-04)** and **one transient failure is not retried during a continuously open session (C3-03)**. UI correctly labels the actual unverified state. |
| C2-09 | fixed | `components/downloads/__tests__/series-play.test.tsx` all locked, mixed, missing volume, TV focus stops; round2-library now passes. |
| C2-10 | fixed | Queued local work begins before owner housekeeping; server-housekeeping and old hung-profile repro pass. Adoption timeout bounds unsaved-post waiting. |

`stillOpen` in the final JSON lists the four partial **previous** IDs. The five new open findings are counted separately below.

## New findings — confirmed by repro

All eight assertions fail in ordinary required-behavior mode. These tests drive documented asynchronous APIs with deferred promises/fake engines; they do not claim a native implementation defect.

| ID | Severity | Package | Evidence | Expected vs actual | Suggested fix |
|---|---|---|---|---|---|
| C3-01 | major | core | `downloads/manager.ts:1215`, `:1239`, `:1260`, `:1403`, `:1769`; `__verify__/round3-manager.test.ts`, three C3-01 tests | Latest user/session intent must survive every await. (1) Sign-out during enqueue's storage wait still calls engine.start, then overwrites signed_out parking with **downloading/error=null**. (2) Resume queued in the engine, followed by Pause, resumes anyway when its await resolves: **paused → downloading**. (3) Validator-change restart waits on server DELETE; Pause during that wait is replaced by queued/new prepare/downloading. Existing checks cover refused links but not these branches. | Carry intent/session generations through enqueue, engine Resume and restart. Recheck before starting/resuming and after every await; park sign-out and compensate a stale native Resume/Start by stopping/pausing it. Engine events must not overwrite a newer paused intent. Do not clear bytes or schedule fresh prepare on a stale restart. |
| C3-02 | major | core | `downloads/manager.ts:623`, `:629`, `:638`; `round3-manager.test.ts`, “concurrent failed cleanup jobs must both survive persistence” | Failed removals must retain every file/job. `settleCleanup` snapshots `others` **before** await volumes. A waits there; B adds/persists its cleanup; A returns and writes its old list, deleting B. Repro has **two 1 GiB files and two jobs, then only cleanup-a**. The removed B record and engine task are already gone; its remaining file has lost durable ownership and used-byte accounting. | Re-read jobs after the await and atomically update just this job (or serialize all job mutations). Add interleaved-failure/removal and crash/relaunch regressions; never replace the whole collection from an old snapshot. |
| C3-03 | minor | both | `downloads/manager.ts:894`, `:1999`, `:2017`, `:2106`; `round3-manager.test.ts`, “a failed age check must retry after backoff…” | An unknown-age file should leave “Checking the age rating…” once a transient failure clears. Backoff records nextAt but nothing schedules it; only a launch/reconnect/explicit reconcileServers calls revalidateAccess. After **two backoff periods plus wake, only one access call** occurred and the allowed title remains locked. The fake server is reachable and would answer the next request. | Schedule due verdict retries while online, or include them in an existing bounded wake/foreground loop. Keep per-owner guards/backoff and avoid an offline retry storm. A displayed checking state needs a live route to completion. |
| C3-04 | major | both | `downloads/server.ts:67`, `:70–75`; `downloads/library.ts:37–40`; `round3-age.test.ts`; server decision reference `server/src/Streamarr.Server/Viewers/Access/ViewerContentPolicy.cs:36` | `GET /access` may return **allowed=false, reason=rating_unavailable, minimumAge=null** for a restricted profile (documented §13; title absent in TMDB). The adapter marks it **rated=true, accessVerified=true**. A maxAge=12/blockUnrated profile then gets **lock=null**, so its downloaded file is playable offline despite the server's refusal; revalidation skips it for up to 90 days. This is a successful unknown verdict, distinct from the fixed rejected-request case. | Preserve the access reason/verification state. Treat rating_unavailable as unverified/locked for restricted profiles, retry separately, and retain the file. Do not infer a known rating merely because a 200 response arrived. Pin every documented access reason, not only known-age/unrated cases. |
| C3-05 | major | core | `player/controller.ts:1303`, `:1462`, `:2568`; engine `expo-video-engine.tsx:194`; `round3-player.test.ts`, two C3-05 tests | Progress must wait for the requested local start/seek to land within its tolerance. The start gate checks only **position ≥ target−3**, so target=100 accepts a pre-seek 400 and immediately records it. An explicit seek sets explicitStart, which bypasses all report gating: seek to 50, transient time=0, then stop saves **0**, losing the chosen position. No explicit request to restart at zero occurred. | Use a pending local target/seek generation and a symmetric landing check, as StartSeek itself does. Preserve the last valid/chosen position until that seek lands; explicitStart should allow intentional backward progress only after landing. Apply the same criterion to uncover/report paths and test both engines with stale events. |

## Code reading only / limits

**No additional code-only C3 finding is counted.** Core outbox scans now use owner/session guards and durable entries; no different-account token substitution was observed. The real AccountStore/AccountsApi/token repro still passes. A server unreachable indefinitely can retain outbox entries by design; no arbitrary deletion/TTL or synthetic unbounded-growth failure is inferred. Successful/404 acknowledgements remove entries; owner removal intentionally drops its pending server work.

Cleanup jobs wait while a record or unfinished task owns the ID; the maintained N3-02 guard test passes. Physical free space is not invented while cleanup is pending, and job bytes remain in the used display in the passing arithmetic tests. C3-02 is a loss of persisted ownership on concurrent mutation, not a claim that JS bypasses native path-claim protection. Device/native I/O, boot identity correctness and transfer continuation remain the native verifier's lane.

The streaming cherry-pick was checked through the complete matrix in the baseline and a fresh engineEnd table: loading playToEnd stays ignored, true subsecond/ready-empty media is still rejected, confirmed early ends and real ends stay distinct. No additional streaming regression was established. Local recovery does at most two reloads, retains the recovery position, tries VLC once then a local card, and sends no playback start/GET/switch/stop call for local IDs. Watch-progress reports with a local ID remain intentional. C3-05 concerns when positions become trusted.

## Requirement trace against the original request and current PLAN § DL

Every original sentence and binding decision is mapped below. Paths are in `client/src/`; test suite names identify maintained `__tests__` files unless marked verifier. “Pass” is limited to inspected JS/Jest behavior; devices and excluded in-flight work are not certified here.

| Requirement / decision | Implementation and executable evidence | Result |
|---|---|---|
| Intelligent “download now” for a movie, one episode or a whole season | `screens/downloads/download-flow.tsx`, manager/server adapter; download-sheet/model/manager tests | Implemented; new intent/cleanup findings prevent acceptance. |
| Original playable versions only, no transcoding/remux; VLC direct counts | candidates/model playable filtering, candidate-card; hooks/model/direct-VLC tests | Pass client selection. Media probing is DL-S. |
| Download opens episode vs season choice | download-flow scope; download-sheet “only this episode”/season switching | Pass. |
| All direct versions shown; oversized stay visible disabled with size/reason; non-direct collapsed | CandidateCard/SpaceLine/StreamOnly footer, model; sheet regressions C1-09/C1-20, oversized TV case | Pass, including press-time fit, unknown space and language_differs/VLC text. |
| Fit uses free minus queued remainder/reserve, exact vs estimated sizes | storage hooks/library verdicts/manager; storage.test and removing-storage, round2-storage | Arithmetic passes; C3-02 can lose pending physical-file ownership. |
| Season pack if present, whole release represented with retained episode files; partial/non-contiguous coverage | packRows/packSelections; sheet/model tests mixed exact/share, retained episodes, existing download | Pass current PLAN: one prepare/file per retained episode from the pack, not NZB/PAR2 payload. |
| Single episodes: choose one release and rest by server similarity | defaultAnchor/useDownloadPlan/review; arbitrary anchor/default wrap/none-fits/markers tests | Pass. |
| Choose every episode manually; change/deselect review rows | eachRows/overrides/requestItems; 24-episode edited-plan/model/sheet tests | Pass; failed items have reasons/replacement; removing work refuses restart. |
| No network, server down or otherwise unreachable automatically shows downloaded media | connectivity monitor/provider/redirect, offline-screen; no-network/server-unreachable/return/expired-auth tests | Pass tested classification, TLS/DNS/5xx/auth distinctions; no cold-start password flash or onboarding redirect. |
| Connected normal view has a separate Downloads screen on the left | navigation tabs/large rail, DownloadsScreen; nav/badge/download-screen tests | Pass. |
| A downloaded episode defaults to local and is visibly marked; explicitly chosen other version streams | title-actions/local-version/detail-download/local-source; detail/version-picker/local-play tests | Selection/markers pass; local position gating fails C3-05. |
| iPhone/iPad/Android phone/tablet/Android TV; exclude Apple TV and web | platform/engine/UI gating; engine-index, native-tab/unsupported-screen tests | Pass code/Jest. No device builds/launches. |
| Phones merge Movies/Series into persisted Library and add Downloads, Android max six NativeTabs | library-tab/tabs/native-tabs-shell; navigation/library preference tests | Pass. |
| Large screens retain Movies/Series + Downloads rail; old routes, titles, notifications and native intents still work | group order/library-link/native-intent; download-links and offline deep-link tests | Pass; title links avoid Downloads stack; warm/cold streamarr://downloads stays owner-scoped offline. |
| Downloads badge visibility: active work; web/tvOS/no-engine suppressed | useDownloadsTab/active count, platform gate; badge/permission/removing tests | Pass; permission-off retains intentionally locked entry/existing files per plan. |
| allowDownloads default on; permission/age refusals hold bytes and auto-resume when allowed | policy store/blocked/recheckBlocked/unblock; blocked/manager/list tests | Core permission cases pass; successful unknown-age response fails C3-04, failed lookup retry C3-03. |
| Profile ownership/age gate offline, profile picker; PIN | account keys/MMKV policies/lockOf/offlineProfiles; policy/local-play/token tests and verifier | Owner separation passes. Age gate partial C3-04. PIN unsupported consistently app-wide; no invented PIN bypass. |
| Wi-Fi only default, change while running, two concurrent | store defaults/engine settings; Wi-Fi/concurrency/coverage/settings tests | Pass JS contract; engine owns transport constraints. |
| Downloads never expire; renew unfinished file capabilities before expiry and after expired/revoked 410 | renewExpiring/renewedUrl/record GET; manager and intent tests, keyed clock | No done-file TTL. Renew/relogin preserves bytes; new unchecked continuation paths are C3-01. |
| Delete-watched default off; safe deletion on completion/release; delete individual/season/all | holds/deleteIfWatched/removal API, settings; races/sign-out/removing tests | Normal paths pass; concurrent cleanup persistence fails C3-02. |
| Sign-out keep/delete, profile removal, bounded ≤5 s/≤4 DELETE flush, account switching | account prompt/provider/session generations/outbox; sign-out/profile/outbox tests, round2-token repro | Outbox owner/session tests pass; enqueue after sign-out fails C3-01. |
| State machine and restart reconciliation, engine reattach/orphans/tombstones/unsolicited paused/cancelled | manager/reconcile/stopTask; engine adapter/conformance, removing/reconcile/coverage tests | Main paths pass. Pause on engine-resume/validator-restart continuation fails C3-01. |
| Preparing polling, idempotency/clientRef, 429/Retry-After, 409/source gone/410, completion bytes/size/ETag | dedicated API/manager/native contract; manager/coverage/reconcile/races | Main error/verification paths pass; no transcoded source is enqueued. Direct path claims enforced natively, JS respects stop drain. |
| Cleanup persists across crash/volume failure, never deletes owned paths; storage full/unavailable volume recovery | cleanup-jobs/pathsReleased/recheckVolumes; cleanup/storage/removing tests | Single-job/ownership tests pass; concurrent jobs fail C3-02. |
| ClientRef adoption, normalized device identity, other device ignored, POST still pending | adopt/checkServerRecords/posting; reconcile/server-housekeeping plus fresh adoption verifier | Pass duplicate list refs, mixed ASCII case/trim, other device, in-flight POST, idempotent timeout fallback. |
| Offline progress uses occurredAt, dedupe/order/30-day retention, launch/reconnect/sign-in flush | progress queue/ProgressSync, per-server clock; progress-sync/progress-queue/mounted sync tests | Common queue/clock behavior passes; C3-05 can feed it an invalid position. No wrong-profile flush observed. |
| Newer local/server resume; server default resume rules | resumeSecondsOf/resumePointOf, uncertainty merge; clock-merge/resume-rules/local-mode | Defaults and timestamp merge pass; DL-S 8 per-server settings excluded. Pending local seek gating fails C3-05. |
| Server clock by serverKey with elapsedMs/bootId; ±skew, reboot, process ids, offline days | server-clock/API middleware/recordPosition/queue; maintained + fresh clock tests | Pass tested cases, including same-boot process restart, three offline days, wall jumps and estimate flags after reboot/process fallback. |
| Local audio/subtitle/mediaInfo, native/VLC only, never Streamybox; no iOS file subtitle lift | localPlayback/controller/local-tracks/expo-video | Local-mode/tracks/subtitle-lift suites pass; automatic fallback is scoped to the playback and bounded. |
| Missing/corrupt local file: stream fallback online, clear error offline; local up-next | async verifyLocalFile/local-source/up-next; missing/short/local-play/streamInstead tests | Pass tested missing/short/fallback boundaries. No native corrupt-media decode performed. |
| Offline queries/cache/mutations; no endless paused skeleton after networkMode online change | account query defaults, onlineManager/Connectivity, persisted cache, offline shell | query-client/profile-sync and forced-change cold-start tests pass; device/other-server/web/tvOS queries keep their prior behavior. |
| Android TV D-pad trap, initial focus, Back, focus return, removing/held/unverified rows | FocusGuide/FocusLayer/row targets, locked aggregate eligibility; sheet/link/series-play/age/removing tests | Pass structural cases. Actual D-pad/device behavior and known Resume focus follow-up excluded. |
| German “Heruntergeladen” / “Auf diesem Gerät”, no device “Sofort/Wird vorbereitet”; de/en parity/ICU plurals | labels/formatters/locales; no-literal-text, locales/i18n suites | Pass for changed keys including age_unverified, held/removing/storage messages. Literal scan includes new product directories. |
| Account storage keys, large lists/progress throttling, listener cleanup, one-line comments | store subscriptions/keys, polling teardown, core/UI scan; 200-record race/model tests | Original quality findings fixed; C3-01/02 expose new async gaps. No new dead-code or measured frame-time claim. |

Fix C3-01…05, then rerun ordinary verifier assertions before accepting the main merge. This report preserves the green maintained baseline while making each new failure executable and distinct from excluded device/server work.
