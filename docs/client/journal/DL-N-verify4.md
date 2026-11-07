# DL-N independent verification 4

**Verdict: pass with findings.** Every finding raised in rounds 1–3 (N1-01…17, N2-01…12, N3-01…11) is now fixed
within host evidence and code reading. Each former repro asserts the decided outcome and passes. Reverting each
round-3 guard alone makes the builder's promoted test for it fail (7/7 mutants, 6/6 controls pass). N2-10 is closed:
`errors.test.ts` passes and the whole client suite is green. **New findings: 0 blockers, 0 majors, 2 minors, 1 nit.**
None of them is a data-integrity defect.

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. `git merge fb/downloads` brought in **44fa38ad**
(DL-N fix round 3: acca869f, cb107891, 87411d06, a23bc812, journal efd0572a; plus fb/dl-core). Verifier merge
**418ef027**. The Android and iOS module sources at 44fa38ad are byte-identical to a23bc812 (`git diff --stat` empty),
so the builder's APK `dl-native-a23bc812` was used, read only, for the dex audit. Fix round 3b (iOS early identity) is
not in this baseline and is not a condition for this report.

Not done: product edits, push, devices, emulators, simulators, Argent, prebuild, app builds, and writes to other
worktrees. Gradle home `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`, Node 24.14.0, Java 17, Swift via
`source docs/client/env.sh`, Range server on **127.0.0.1:39321** only (stopped afterwards).

## Commands and results

`V` = `tools/dl-verify-native`, `M` = `client/modules/offline-downloads`, `A` = `M/android/src/main/java/expo/modules/offlinedownloads`,
`I` = `M/ios`, `T` = `client/src/downloads/engine`. `DL_VERIFY_ROUND=4 bash V/run-round3.sh all` and `… jest-full` run
every suite (logs and exit codes in the ignored `V/logs/round4/`). `python3 V/collect-round4.py` asserts each count
below and writes [results4.json](../../../tools/dl-verify-native/results4.json) and
[evidence4.txt](../../../tools/dl-verify-native/evidence4.txt).

| Command | Result |
|---|---|
| `git merge fb/downloads` | 44fa38ad → verifier merge 418ef027. Module diff since round 3: 19 files, +989/−150. |
| `node V/range-fixtures.mjs --host 127.0.0.1 --port 39321` | Range server + redirect/capture routes; all live JVM cases ran, none skipped. |
| Gradle `-p V/jvm cleanTest test` (verifier) | Exit 0, **59/59**: Transfer 20 (original `BUG_*`), RedirectBoundary 4, module HttpPolicy 8, Round2 8, Round3 11 (the 7 former `REPRO_N3_*` now assert the decided outcome), **Round4 8** (3 `REPRO_N4_*` observed + 5 acceptance). |
| Gradle `-p M/test-harness/jvm cleanTest test` (builder) | Exit 0, **76/76**: EngineTest 43, TransferTest 25, HttpPolicyTest 8; zero skipped. |
| `swiftc … I/HttpPolicy.swift I/Tests/HttpPolicyCheck.swift` + corpus | Exit 0, **767/767**. |
| Builder generator + `swiftc` + engine host | Exit 0, **67/67**. |
| `V/swift/make-host-check.py` + `swiftc` + engine host (verifier) | Exit 0: **23/23** baseline, round 3 **8/8** (the 5 former N3 repros now decided outcomes), round 4 **15/15** + **3/3** N4 repros. |
| `node M/test-harness/js-check.cjs` / `node V/js-check.cjs` | Exit 0, **11/11** / **11/11** (new: fake rejects dot/space segments and protects paused tasks; 0 fake-vs-native path differences). |
| `npm run typecheck` / `CI=1 npm run lint` | Exit 0 / exit 0. |
| `npx jest src/downloads/engine src/api/__tests__/errors.test.ts --runInBand --forceExit` | Exit 0, **6 suites, 177/177**; engine suites alone **5 suites, 148/148**; `errors.test.ts` passes (N2-10). |
| `npx jest --runInBand --forceExit` (whole client) | Exit 0, **271/271 suites, 2,775/2,775 tests**. |
| `python3 V/mutants.py --round 4` | **7/7 mutants fail exactly their targeted builder test; 6/6 unmutated controls pass.** Writes only `V/.work/mutants/`. |
| `python3 V/newapi-audit.py <apk a23bc812> 24` | **18** framework/JDK references above API 24 in the module's dex; each one is behind a matching `SDK_INT` check (list in evidence4.txt). Two built-in canaries prove the scan sees both a direct and an inherited call. |

### "Fails before the fix" (mutation, round-3 guards)

| Mutant (one guard reverted in a scratch copy) | Targeted builder test | Result |
|---|---|---|
| N3-01: `osFile` falls back to guessing a `CFNetworkDownload_*` file (`I/OfflineDownloadEngine.swift:1636`) | Swift "ambiguous OS files … give no clone (N3-01)" | first failing check is exactly that one |
| N3-02 Android: `liveOwnerTouching` back to `isActive \|\| transfers` (`A/DownloadEngine.kt:868`) | `EngineTest.pausedRetryingFailedAndQueuedTasksKeepTheirPaths` | fails; control passes |
| N3-02 iOS: `liveOwner` back to `isActive \|\| urlTasks` (`I/OfflineDownloadEngine.swift:693`) | Swift "every registered task but a completed one … (N3-02)" | first failing check is exactly that one |
| N3-05: `dispose` queues nothing (`A/DownloadEngine.kt:879`) | `EngineTest.aProcessDeathDuringCancelPendingStillDeletesThePartial` | fails; control passes |
| N3-05: same mutant | `EngineTest.removeOrCancelWhileTheVolumeIsMissingDeletesThePartialOnItsReturn` | fails; control passes |
| N3-05: `processDisposals` ignores a newer owner (`if (newer == null)` → `if (true)`) | `EngineTest.aDisposalNeverDeletesTheBytesOfANewerTask` | fails; control passes |
| N3-06: tombstone `cancel` returns no latches (`A/DownloadEngine.kt:253`) | `EngineTest.cancellingADrainingTombstoneWaitsForItsWorker` | fails; control passes |

The historical before/after for every N3 item also comes from this verifier's own round-3 repros: they asserted the
defect on 0144e7db and assert the decided outcome on 44fa38ad (same test names).

## Status of every finding

"Fixed" is bounded by host evidence and code reading; device behaviour is the builder's evidence.

| ID | Status | Evidence / remaining scope |
|---|---|---|
| N1-01 Resume response integrity | fixed | Original `BUG_*` Transfer cases pass with correct outcomes; iOS numeric start (N2-07). |
| N1-02 Crash consistency of restart | fixed | Child-JVM kill after the 200 restart: resumed file is the new version (live). |
| N1-03 Target ownership / two writers | fixed | `.part` alias (N2-01), still-writing path (N2-02), FAT/exFAT dot/space aliases (N3-03) closed on all platforms. Legacy residual: N4-03 (nit). |
| N1-04 Early completion / 416 | fixed | Unchanged; tests pass. |
| N1-05 Stale callbacks / identity | fixed | N2-03 and N3-09 (per-generation tails) fixed; mutation-checked. |
| N1-06 Response checks at finalization | fixed | Kept bytes only from the file the task's own resume data names (N3-01, mutation-checked); three former triggers now clone nothing. Decided consequence: a never-paused iOS download restarts from 0 after an in-task drop (round 3b pending). |
| N1-07 Cancel / move / delete races | fixed | N3-02 (paused/failed own their paths, Android + iOS + fake) and N3-06 (tombstone cancel waits) fixed; own churn test (450 random ops, 3 threads) shows no deadlock, no leftover partial, exact bytes. |
| N1-08 Unbounded retry / battery | fixed | Corpus 767/767, elapsed clock; iOS sleep still device-only. |
| N1-09 Retry-After parity | fixed | Unchanged; all three parsers + corpus. |
| N1-10 HEAD probe / resume-data cleanup | fixed | Unchanged; plus resume data whose named partial is gone from both directories is dropped (own check). |
| N1-11 Fake fidelity | fixed | Fake mirrors round-3 rules (own JS check, conformance 148 engine tests). |
| N1-12 Redirect credential scope | fixed | Unchanged; RedirectBoundary 4/4 live. |
| N1-13 User stop / UIDT lifecycle | fixed | Plus the Android 7 `NotificationChannel` crash fixed (dex audit: guarded). |
| N1-14 Removable volume identity | fixed | Honest v1 migration (N3-10). |
| N1-15 Durable checkpoints | fixed | N3-04: the old part is synced before the checkpoint covers it; a failing sync keeps 0 (own former repro, both branches). Power loss: device. |
| N1-16 Storage pressure | fixed | Unchanged. |
| N1-17 Bridge diagnostics | fixed | Unchanged. |
| N2-01 `.part` alias | fixed | Former repro passes as decided outcome. |
| N2-02 Removal of a still-writing path | fixed | Former repro passes. |
| N2-03 Late resume data | fixed | Former repro passes; mutation (round 3). |
| N2-04 Elapsed clock | fixed | Former repro + reboot test pass. Sleep: device. |
| N2-05 v1 volume ids | fixed | `volume_unavailable`, honest v1 seed (N3-10). |
| N2-06 Cancel resolves before cleanup | fixed | Former repro passes; plus tombstone variant (N3-06). |
| N2-07 iOS numeric Content-Range start | fixed | Former replay passes. |
| N2-08 Final callback vs pending stop | fixed | Former replays pass. |
| N2-09 Zero-padded Retry-After | fixed | Kotlin, Swift, TS. |
| N2-10 Client error registry | **fixed** | `errors.test.ts` passes; full client suite 2,775/2,775. |
| N2-11 Host race | fixed | Unchanged; own watchdog checks pass. |
| N2-12 iOS in-task 4xx truncation | fixed | Kept bytes survive by exact identity only (N3-01); a paused partial moved to `tmp/` is found by its blob name (a23bc812, own check). Limitation as N1-06. |
| N3-01 Guessed OS file (major) | fixed | Own former Swift repros (both triggers, stale clone) now give no clone; with the blob name the clone is cut to the reported bytes. Mutation fails the builder check. |
| N3-02 Paused/failed partials unprotected | fixed | Own former JVM repro: `move`/`deletePath` onto the paused `.part` or its directory → `invalid_state`; resumed file is exactly the server bytes; completed file deletable. iOS own check same. Mutation ×2. |
| N3-03 FAT/exFAT dot/space aliases | fixed | Own former repro: 8 dot/space paths rejected on SD and internal; a dot inside a name is fine. iOS 6 paths rejected. Legacy residual: N4-03. |
| N3-04 Unsynced checkpoint | fixed | Own former repro with a `Transfer.sync` seam: failing sync → checkpoint 0; working sync → 4, after ≥ 1 sync. |
| N3-05 Orphaned partials | fixed | Own former repros: process death during `cancel_pending` → deleted at load, retried `cancel` resolves once then `not_found`; remove on a missing card → deleted on return. Own: a disposal yields to the next task on its path (new and reused id). Mutation ×3. UX residual: N4-02. |
| N3-06 Tombstone cancel | fixed | Own former repro: `cancel` of a draining tombstone → `cancel_pending`, a retry waits (thread still blocked after 150 ms) and resolves once the worker ends; path claimed until then. Mutation. |
| N3-07 Capability in logs | fixed | Own former repros (Android 5 body shapes, iOS 1): `[redacted]`, no 12-char capability window. Fuzz: 1,500 Streamarr-shaped cases, 0 leaks, Kotlin = Swift byte for byte (3,000 cases). Residual for URLs with a 1–3 char query: N4-01. |
| N3-08 API 33 call | fixed | `read(buf, off, len)` loop; dex audit: 18 refs > 24, all guarded; lint `NewApi` error in `android/build.gradle`. |
| N3-09 Stale tail deletion | fixed | Own former repro: the current generation's tail survives a stale completion. |
| N3-10 Legacy test fidelity | fixed | Builder test seeds genuine v1 fields; dead `/storage/<UUID>/` branch removed. |
| N3-11 Stop vs connect / hung write | fixed | Own: a write hung inside the write lock blocks no engine call (`pause`, `list`, `resume`, `pump` return; `cancel` → `cancel_pending` in 200 ms, then resolves). Lock order reviewed: nothing inside `writeLock` takes the engine lock; the engine never takes `writeLock`. |

## New findings

| ID | Severity / platform | Evidence | Expected vs actual | Suggested fix |
|---|---|---|---|---|
| N4-01 | **minor / all native** | `A/HttpPolicy.kt:33-38` (pieces replaced before `LONG_TOKEN`), `:42-49` (a 1-char query is a piece); `I/HttpPolicy.swift:30-48` (same). JVM `REPRO_N4_shortQueryPieceShredsTheCapabilityPastTheTokenRule`; Swift "iOS shares the short-query shredding". | **Expected** (N3-07): a 24+ char token is redacted whatever else is in the line. **Actual:** request-URL pieces are replaced first, everywhere in the text. A query of 1–3 token characters (`?1`, `?a`, `?ab1`) matches inside the capability and splits it into fragments below 24 chars, which the token rule then misses: `unknown download 0[redacted]23456789abcdef0[redacted]…`. Fuzz: 558 of 1,500 such cases leak a 12-char capability window on both platforms (identically). The same pass order lets an absolute URL glued to a token start at the token's first letter (`see 0123456789[redacted]` keeps the leading digits). Streamarr's own capability URLs carry no query, so the product is not affected today; the test server and any future URL with a short query are. | Run `LONG_TOKEN` (and the absolute-URL rule) on the original printable text first, or ignore URL pieces shorter than ~8 chars, or replace pieces only at token boundaries. Add fuzz vectors with short queries to the corpus. |
| N4-02 | **minor / android** | `A/DownloadEngine.kt:562-575` (`volumeWait` includes `disposals.any { it.volumeId !in mounted }`; that branch finishes the host but never calls `goIdle`), `:508-519` (`goIdle` posts the summary or clears), hosts detach their notification (`A/DownloadService.kt:51`, `A/AndroidPlatform.kt:199`). JVM `REPRO_N4_pendingDisposalOnAMissingCardSuppressesTheSummaryForever` with control `aBatchPostsItsSummaryWhenNothingWaitsForAVolume`. | **Expected:** removing or cancelling a download on a missing SD card leaves nothing visible behind; later batches end as usual (summary, progress notification replaced, watchers off). **Actual:** the queued disposal (persisted) keeps the engine in "volume wait" until that card returns. An internal download that completes afterwards posts no summary and no clear (0 calls; control: `summary(1, 0)`), so the detached progress notification with its Pause/Cancel actions stays; the network/volume watcher stays registered; `finished`/`failed` keep counting. Same after a relaunch. If the card never returns, this is permanent. In round 2 the same `remove` left no wait (the delete was skipped), so this is a round-3 regression of the UX, not of data. | Let a disposal on a missing volume keep only the volume observer: take the `goIdle()` path for host/notification/counters and keep `observe(true)` (or re-register the volume receiver) when only disposals wait. Optionally drop disposals for a volume unseen for a long time. |
| N4-03 | **nit / all native** | `A/DownloadEngine.kt:852-853` (`claimsOf(task)` → empty list when `claimKey` throws), `A/Storage.kt:57-62` (segment that strips to empty → `invalid_argument`), `:866-867` (`liveOwnerTouching` throws for such a path); `I/OfflineDownloadEngine.swift:684-685`, `:690-691` (same). JVM `REPRO_N4_legacyAllDotSegmentTaskOwnsNothing`; Swift two N4 repros. | A record persisted before round 3 whose path has a segment of only dots or spaces (`acc/ /x.bin`, `acc/.../y.bin`, accepted then) still loads (good) but **owns nothing**: `deletePath("acc")` resolves and deletes a paused task's partial (N3-02 rule: `invalid_state`). Its completed file cannot be deleted by its own path (`invalid_argument`), only via a parent directory. Only pre-release dev installs can hold such records. | For persisted records, derive the claim key without the empty-segment check (keep the raw segment), or fail such records at load with `file_system` so the manager removes them; let `deletePath`/`move` of an existing completed path skip the new rule. |

## Regression hunt (round-3 code) without a new finding

- **Dispose list:** crash replay (own former repro, and the persisted list is processed at `load`); a disposal never
  deletes a path a newer task owns (own test with a new id and the same id restarted in the call that first sees the
  medium; leftover bytes are truncated because a fresh task has no validator). Entries that never drain: N4-02.
  A disposal whose delete keeps failing stays and is retried on every pump (no growth, no error surfaced).
- **Tombstones:** `cancel` waits like `remove`; a tombstone owns no path; its queued disposal yields to a newer task.
- **Dot/space rule:** `start` only; `move`/`deletePath` use the stripping claim key, so a rename onto `foo.` next to a
  live `foo` is refused. Legacy records: N4-03.
- **Redaction:** all three error-line sources (Android `errorLine`, iOS `didFinishDownloadingTo`) pass request,
  current and final URLs; Android/iOS failure messages carry no URL (exception classes, `localizedDescription`,
  redirect refusals). Fuzz parity Kotlin = Swift on 3,000 cases. Query strings and path segments: N4-01.
- **`writeLock`:** connection hand-over and every part write are under it; `signalStop` is a lock-free CAS and the
  socket closes on the pool, so engine calls never wait for I/O (own hung-write test) and the two locks are never
  nested in opposite order (code reading + 450-op churn without a stuck thread).
- **NewApi gate:** dex audit of the APK above; nothing unguarded remains. `Transfer.stop()` is now unused (harmless).
- **iOS `tmp/` lookup (a23bc812):** a blob naming a partial only in `tmp/` is kept, cut to the blob's bytes;
  resume data whose partial is in neither directory is dropped. `osFiles` is in memory only, so an adopted task after a
  relaunch clones nothing (lenient, never wrong).

## Harness changes this round

- Kept the round-3 names; every `REPRO_N3_*` (Kotlin) and the Swift N3 repros now assert the decided outcome.
- New `jvm/src/main/kotlin/android/os/Build.kt` shim (`verifier.sdkInt`, default 34) for the module's new guards.
- `VerifierRig`: summary/clear counters, observer flag, drain count and persisted-disposal count (read only).
- New `Round4AdversarialTest.kt`, `swift/Round4Check.swift` (generator also maps the new `tmp/` root into the
  sandbox), round-4 mutants in `mutants.py --round 4`, `newapi-audit.py`, `collect-round4.py`; `run-round3.sh` takes
  `DL_VERIFY_ROUND`.

## Needs a device

1. N4-02 on a phone with an SD card: remove a download while the card is out, finish another one; the stale progress
   notification and the missing summary are expected.
2. N3-05 on vold's unmount SIGINT (builder covered it once).
3. iOS restart-from-0 after an in-task drop for never-paused downloads (decided; round 3b will change it).
4. Power loss after N3-04's sync (vfat SD), iOS sleep (N2-04), the notification Cancel broadcast budget.
5. nsurlsessiond's own logs show request URLs (builder's known limitation); outside the app's control.

## Confirmed by repro vs code reading

- **Repro (host):** every status above marked by an own test, N4-01 (both platforms, fuzz + deterministic),
  N4-02 (with control), N4-03 (both platforms), the 7 mutants, the dex audit.
- **Code reading only:** lock-order argument, the notification consequence of N4-02 (detach policy), the N4-03 dev-only
  reachability, and everything under "Needs a device".
