# DL-N independent verification 3

**Verdict: pass with findings.** Both round-2 blockers (N2-01, N2-02) and all six round-2 majors are fixed: each former
repro now asserts the decided outcome and passes, and reverting the guard behind five of them makes the builder's
promoted test fail. No new blocker was found. **New findings: 0 blockers, 1 major, 8 minors, 2 nits.** The major (N3-01,
iOS) is a silent-corruption path inside the N2-12 fix. It should be fixed before release. Its trigger timing needs a
device. N2-10 (client error registry, DL-C1's lane) is still open.

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. `git merge fb/downloads` brought in
**60fa6a07** (docs only: `docs/client/journal/DL.md` +13). The engine sources are those of the DL-N merge **0144e7db**.
Verifier merge: **cac1114f**. Reviewed the builder's "Fix round 1c", "Fix round 2" (commits af135dd5 … 1d2afddf, incl.
N2-11 f40e9757 / b1340937 and N2-12 18a4d9c9, 0f151f4b, 799b4668, 1d77c7ca, 8574a70e, 86a52014), "Interface changes
after freeze" and "Known limitations" in `DL-N.md`. Device claims there are **builder evidence**, not repeated here.

Not done: product edits, push, devices, emulators, simulators, Argent, prebuild, app builds, and writes to other
worktrees. The builder's Gradle wrapper was only read. Gradle home `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`,
Node 24.14.0, Java 17, Swift via `source docs/client/env.sh`, Range server on **127.0.0.1:39321** only.

**Previous verifier's uncommitted round-3 edits** (its session ended before a report):
- **Kept:** the Kotlin conversion of the round-2 `REPRO_*` tests to decided outcomes (`invalid_argument` for `.part`,
  `remove_pending` / `cancel_pending`, elapsed-clock cooldown, zero-padded Retry-After), the `VerifierRig` port to the
  N2-11 platform API, the JS assertion change, the Swift fixture/generator updates (kept/OS dirs, `resumeOffset`,
  `.replace` intent) and the three iOS repro ideas.
- **Fixed:**
  - two timing-fragile waits in `Round2AdversarialTest`, which kept a 25 ms drain timeout for the second wait;
  - the legacy-volume test, which still asserted the round-2 symptom (empty URI) and now asserts the decided
    `failed` / `volume_unavailable`;
  - `Round3Check.swift`, which did not compile (`try` inside `precondition`, a missing `try`, writes to a `let`). It
    also ran off the engine queue; the bodies now run on it. Its first repro removed A's OS file outright; it now
    models the two concrete triggers described under N3-01.
- **Discarded:** nothing.

## Commands and results

`V` = `tools/dl-verify-native`, `M` = `client/modules/offline-downloads`, `A` = `M/android/src/main/java/expo/modules/offlinedownloads`,
`I` = `M/ios`, `T` = `client/src/downloads/engine`. Every suite is run by `bash V/run-round3.sh all` and
`bash V/run-round3.sh jest-full` (logs + exit codes in ignored `V/logs/round3/`). `python3 V/collect-round3.py`
asserts each count below and writes [results3.json](../../../tools/dl-verify-native/results3.json) and
[evidence3.txt](../../../tools/dl-verify-native/evidence3.txt).

| Command | Result |
|---|---|
| `git merge fb/downloads` | Merge of 60fa6a07 (docs only) → cac1114f. Engine sources unchanged since 0144e7db. |
| `node V/range-fixtures.mjs --host 127.0.0.1 --port 39321` | Repository Range server + verifier redirect/capture routes; all live JVM cases ran, no SKIP. |
| Gradle `-p V/jvm cleanTest test` | Exit 0, **51/51**: TransferAdversarial 20 (original `BUG_*`, correct outcomes), RedirectBoundary 4, module HttpPolicyTest 8, Round2Adversarial 8 (former `REPRO_*`, now decided outcomes), **Round3Adversarial 11** (7 `REPRO_N3_*` observed + 4 acceptance). |
| Gradle `-p M/test-harness/jvm cleanTest test` (builder) | Exit 0, **66/66**: EngineTest 33, TransferTest 25, HttpPolicyTest 8. Three live cases, zero skipped. |
| `xcrun swiftc … I/HttpPolicy.swift I/Tests/HttpPolicyCheck.swift` + run on `M/test-vectors/http-policy.json` | Exit 0, **754/754** corpus checks. |
| Builder generator + `swiftc` + `DL_HARNESS_SWIFT_ROOT=… engine-host` | Exit 0, **57/57** builder engine host checks. |
| `python3 V/swift/make-host-check.py`, `swiftc`, `DL_VERIFY_SWIFT_ROOT=… engine-host-v3` | Exit 0: **23/23** baseline (former BUG/REPRO N2 labels, correct outcomes), the deferred resume-data check (now `nil` for the new id), **4/4** new acceptance checks, **5/5** N3 repro observations. |
| `node M/test-harness/js-check.cjs` / `node V/js-check.cjs` | Exit 0, **11/11** / **10/10** (zero-padded Retry-After now 2 s and 30 s). |
| `cd client && npm run typecheck` / `CI=1 npm run lint` | Exit 0 / exit 0, no diagnostics. |
| `npx jest src/downloads/engine src/api/__tests__/errors.test.ts --runInBand --forceExit` | Exit 1: **6 suites, 173/174**. Engine suites alone **5 suites, 145/145**. The one failure is N2-10. |
| `npx jest --runInBand --forceExit` (whole client) | Exit 1: **238 suites (237 pass), 2,577 tests (2,576 pass, 1 fails)**: same N2-10 test, 15 codes missing. |
| `python3 V/mutants.py` | **5/5 mutants fail exactly their targeted builder test; both unmutated controls pass** (details below). Writes only `V/.work/mutants/`. |

### "Fails before the fix" spot checks (mutation)

Each mutant is a scratch copy of the module with **one** round-2 guard reverted. Then only the builder's test for that
guard is run. This shows the promoted tests detect the regression; it is not a replay of the historical source. The
historical before/after for N2-01, N2-02, N2-04, N2-06, N2-09 (Kotlin), N2-03, N2-07, N2-08 (Swift) and N2-09 (JS)
comes from this verifier's own round-2 repros: they asserted the defect on 97d36070 and now assert the decided outcome.

| Mutant (reverted guard) | Targeted builder test | Result |
|---|---|---|
| N2-01: `claimsOf(key)` without `key + ".part"` (`A/DownloadEngine.kt:832`) | `EngineTest.aTaskOwnsItsStagingPathAndTheDirectoriesAround` | fails (exit 1); control passes |
| N2-11: `detachHost` without the `host !== old` guard (`:414`) | `EngineTest.aReplacedHostsLateStopNeverClearsTheNewHost` | fails; control passes |
| N2-06: `cancel` without `awaitDrains` (`:260`) | `EngineTest.cancelOfAWorkerThatCannotEndRejectsAndKeepsTheClaim` | fails; control passes |
| N2-03: resume-data closure checks only `records[id] != nil` (`I/OfflineDownloadEngine.swift:983`) | Swift "late resume data of a cancelled predecessor …" | first failing check is exactly that one |
| N2-12: no error-body diagnostics line (`:1179`) | Swift "an error answer's body is one truncated log line …" | first failing check is exactly that one |

## Status of every finding

"Fixed" is bounded by host evidence and code reading. Device behaviour is the builder's evidence. "Partial" means the
original scenario is fixed but a new case in the same area still violates the rule; the residual's ID and severity
are given.

| ID | Status | Evidence / remaining scope |
|---|---|---|
| N1-01 | fixed | All original `BUG_*` Transfer cases pass with correct outcomes; iOS start-offset hole closed by N2-07. |
| N1-02 | fixed | Child-JVM kill after the 200 restart: resumed file equals the new version (live case). |
| N1-03 | **partial** | `.part` alias (N2-01) and removal of a still-writing path (N2-02) fixed. Residual: trailing-dot aliases on FAT/exFAT media (**N3-03**, minor). |
| N1-04 | fixed | Every 416 fails and drops; last-byte revalidation; original + promoted tests pass. |
| N1-05 | **partial** | Resume closure, probe and adoption now carry generation/token (N2-03 fixed, mutation-checked). Residual: a stale assembly completion deletes the current generation's tail before its identity check (**N3-09**, minor). |
| N1-06 | **partial** | Numeric start + recorded strong ETag enforced (N2-07 fixed). Residual: kept bytes can come from another task's OS file, so a "proven" continuation is appended to unproven bytes (**N3-01**, major). |
| N1-07 | **partial** | N2-02/N2-06/N2-08 fixed. Residuals: `move` onto a **paused/failed** task's `.part` is allowed and its bytes are later continued (**N3-02**, minor); `cancel` of a draining tombstone resolves before the path is free (**N3-06**, minor). |
| N1-08 | fixed | Elapsed clock on all three (N2-04); floor/cap/attempts/12 h corpus 754/754 and JS/JUnit. Real sleep/clock change: builder's Android device run; iOS needs a device. |
| N1-09 | fixed | Zero-padded values fixed in all three parsers (N2-09) plus corpus vectors. |
| N1-10 | fixed | Unchanged; promoted Swift checks pass. |
| N1-11 | fixed | Engine jest 145/145; fake mirrors stall/release drains, elapsed `now`, tombstones. |
| N1-12 | fixed | Android redirect boundaries pass; iOS https→http now fails "redirect https → http refused" (builder host check + device). |
| N1-13 | fixed | User stop pauses; notification Pause/Cancel, 1c tombstones (builder tests + own `tombstoneDrainHoldsThePathThenReleasesIt`). |
| N1-14 | fixed | UUID ids; v1 `external-N` records now fail `volume_unavailable` instead of looking completed (N2-05). Test-fidelity nit **N3-10**. |
| N1-15 | **partial** | Fsync-before-checkpoint and recovery truncation unchanged; clamp test passes. Residual: a new attempt declares the existing part durable without a sync (**N3-04**, minor). Power loss is untested (device). |
| N1-16 | fixed | Final callback honours a pending `disk_full` failure (N2-08); space checks unchanged. |
| N1-17 | fixed | Unchanged; JS checks pass. |
| N2-01 | fixed | Own former repro: `movie.bin.part` → `invalid_argument`, A publishes its own `AAAAAAAA`. Builder test; mutation fails it. |
| N2-02 | fixed | Own former repro: `remove` of the failed, still-writing task → `io: remove_pending`; a start on the path → `invalid_state`; after the worker ends B completes with exactly 8 bytes (was `BBBBBBBBAAAA`). |
| N2-03 | fixed | Own deferred check through the real pause/cancel/start APIs: old completion leaves `nil` resume data for the new id. Mutation fails the builder check. |
| N2-04 | fixed | Own former repro: wall −24 h keeps `retryAt − now` at 1 h; completes after one elapsed hour. Own reboot test: a reboot with a wall rollback keeps at most the saved remainder; same boot ignores a +1 h wall jump. iOS uses `mach_continuous_time`, generator bans stopping clocks. Sleep itself: device. |
| N2-05 | fixed | Unresolvable v1 records fail `volume_unavailable` (own updated test + builder). Data was only on pre-release dev installs. See N3-10. |
| N2-06 | fixed | Own former repro: `cancel` → `io: cancel_pending` with the part and the claim kept; after the worker ends, `cancel` again resolves and the part is gone. Mutation fails the builder test. Builder device: 16 ms cancel during a stall. Tombstone variant: N3-06. |
| N2-07 | fixed | Own replay: saved offset 4 + `bytes 3-7/8` → retrying, bytes 0, nothing published. |
| N2-08 | fixed | Own replays: pending `disk_full` → `failed disk_full`, no file; `.replace` → `queued`, old request's file not published. |
| N2-09 | fixed | `0000000000` → 2 s, `0000000030` → 30 s in Kotlin, Swift and TS (own checks) plus corpus. |
| N2-10 | **not fixed** (DL-C1 lane) | `errors.test.ts` still lacks 15 documented download codes (list in evidence3.txt). Not an engine defect; the full client suite stays red. |
| N2-11 | fixed | Host tokens, ignored stale stops, no double scheduling, 15 s watchdog. Builder tests (mutation-checked) plus two own checks: the watchdog never cancels an attached host (5 × 60 s elapsed, `list`/`pump`/`onForeground`). A stuck request is re-asked only while visible, once per 15 s window, never while the network is blocked; one warning. Builder device run 10×. |
| N2-12 | **partial** | Kept bytes survive in-task 4xx, resume-data GET errors and URL renewal (builder 14 Swift checks + device). Own checks: a clone is cut to the reported bytes; ambiguous candidates give no clone; resume data of another ETag is never kept; a continuation with another ETag drops the kept bytes. Residuals: **N3-01** (major, wrong clone), **N3-09** (minor). The diagnostics follow-up has **N3-07** (echoed capability in the log) and **N3-08** (Android ≤ 12 never logs the body). |

## New findings

Line numbers refer to the sources at cac1114f (= 0144e7db). "Confirmed by repro" means a host test drives the actual
engine code into the defect. The platform part (daemon timing, file system) is listed under device checks.

| ID | Severity / platform | Evidence | Expected → actual; suggested fix |
|---|---|---|---|
| N3-01 | **major / ios** | `I/OfflineDownloadEngine.swift:1616-1630` (`osFile`), `:1598` (`snapshot`), `:1531` (`cloneKept`), continuation `:942`, `:1077-1082`, `:1633`. Swift `V/swift/Round3Check.swift` "OS file heuristic clones a paused neighbour's partial …" + "… published as completed: BBBB + AAAA" + "a stall longer than 10 s …". | **Expected:** kept bytes are only ever this task's bytes ("any ambiguity … means no clone rather than a wrong one"). **Actual:** without a resume-data name, `osFile` picks the only recent `CFNetworkDownload_*` file of the app sized in `[reported, reported + 1 MiB)` that no running task claims. Two cases make A's own file no candidate: its OS file runs ≥ 1 MiB ahead of the reported progress (the engine logs "OS file is … ahead" itself, `:1607`), or A stalled for more than 10 s. Meanwhile a neighbour's partial can be the only candidate: a task paused/requeued moments ago (Wi-Fi-only toggle, concurrency), an adopted task with no progress yet, or one whose own report lags by > 1 MiB. The `close` guard (`:1626`) sees only running tasks with reported bytes. Replay: A has reported 4 bytes; A's OS file is 1 MiB + 4 bytes; paused B's partial is `BBBB`. `snapshot(A)` clones `BBBB` with A's ETag. The Range continuation (`bytes=4-`, If-Range A's ETag) is a valid 206 of A's bytes 4-7, and the engine **publishes `BBBBAAAA` as completed**. Size and ETag checks cannot notice, so the corruption is silent. It needs a later failure, pause-less URL renewal or in-task retry of A to use the kept bytes. **Fix:** never clone by guess while the app has another daemon task or saved resume data whose temp file exists. Add every temp name referenced by saved resume blobs and every task's known file to `taken`. Require A's own file to be identified, e.g. the only candidate whose size tracks A's reported bytes across ≥ 2 consecutive callbacks; otherwise keep nothing. |
| N3-02 | **minor / android (contract: all)** | `A/DownloadEngine.kt:339-345`, `:848-852`; `A/Transfer.kt:91-93`, `:197-203`. JVM `REPRO_N3_moveOntoAPausedPartPublishesForeignBytes`. | **Expected** (`T/types.ts:178-181`): `move`/`deletePath` reject "an unfinished download's file". **Actual:** "unfinished" is implemented as active-or-draining. A paused (or failed, partial kept for renewal) task's `.part` can be replaced: `move("foreign.bin", "movie.bin.part")` succeeds. On resume the engine sends `Range: bytes=4-` + If-Range with the recorded ETag, the 206 passes every check, and **`XXXXAAAA` is published as completed**. iOS keeps paused bytes outside the user root (only the final path is exposed) and the fake has the same active-only rule, so all three agree. The gap is in what the API protects. It needs a caller to target a `.part` path. **Fix:** treat every registered, non-tombstone task as owning its `.part` for `move`/`deletePath` (`liveOwnerTouching` = `ownerOf` for the staging claim). Or record the part's size/mtime at pause and drop it on mismatch. Mirror the rule in the fake. |
| N3-03 | **minor / android (removable FAT/exFAT volumes)** | `A/Storage.kt:55-60` (`claimKey`), `A/DownloadEngine.kt:161`, `:838`. JVM `REPRO_N3_trailingDotAliasesAreSeparateClaims`. Linux [`fs/fat/namei_vfat.c`](https://github.com/torvalds/linux/blob/master/fs/fat/namei_vfat.c) `__vfat_striptail_len` (used by hash, compare, lookup, add) and [`fs/exfat/namei.c`](https://github.com/torvalds/linux/blob/master/fs/exfat/namei.c) `exfat_striptail_len` (strips unless `keep_last_dots`). | **Expected:** a path that the medium resolves to another task's final or `.part` path is a conflict. Claims are already case-insensitive "because SD cards are". **Actual:** next to `show/movie.bin` on a `volume-*` id, the engine accepts `show/movie.bin.`, `show/movie.bin.part.` and `show./movie.bin`. On vfat/exfat these resolve to the same entries, so the N2-01 alias (publishing into another task's partial or final file) is open again on SD/USB media. `.part.` also slips past the `.part` `invalid_argument` rule. App paths are id-based today (`acc-1/work-42/Movie.mkv`), so reaching it needs a title-derived name ending in a dot. **Fix:** in `claimKey` strip trailing dots from every component (and reject names that are empty after stripping), or reject components ending in `.` / space outright. Apply the same in TS and Swift for parity. |
| N3-04 | **minor / android** | `A/Transfer.kt:91-98` (`durableBytes = offset` without a sync), `:151-186` (a reset or stop leaves the loop before `fd.sync()`), `A/DownloadEngine.kt:722`, `:751`, `:888` (checkpoint = `durableBytes`), recovery `:130-141`. JVM `REPRO_N3_checkpointCoversBytesThatWereNeverSynced`. | **Expected** (N1-15): the persisted checkpoint covers only fsynced bytes; recovery after a crash trusts nothing beyond it. **Actual:** an attempt that breaks off (connection reset, stop) skips the final sync, and its checkpoint correctly stays at the last sync (0 in the repro). The next attempt starts with `durableBytes = part.length()` and the engine persists that: the checkpoint jumps **0 → 4 while nothing was written or synced**. Process death keeps the page cache, so nothing is lost there. A power loss or kernel crash within the writeback window can leave a part whose length includes unwritten blocks (non-journaled vfat/exfat SD/USB media in particular). Recovery then keeps them, and the next Range continuation is appended and published with a matching ETag. Up to 16 MiB (`SYNC_BYTES`) per attempt. **Fix:** `fd.sync()` the existing part before trusting it (open, sync, then `durableBytes = offset`), or start from `min(offset, recorded checkpoint)`. |
| N3-05 | **minor / android** | `A/DownloadEngine.kt:29` (drains in memory), `:239-261`, `:301-312`, `:908-909`, load cleanup only for tombstones `:93-96`. JVM `REPRO_N3_processDeathDuringCancelPendingOrphansThePartial`, `REPRO_N3_removeWhileTheVolumeIsMissingOrphansThePartial`. | **Expected:** cancel / remove of a failed task leave no partial ("deletes its partial"). **Actual, two orphan paths:** (1) a process death while `cancel_pending`/`remove_pending` waits loses the drain. The record is already gone from `state.json`, so after relaunch the `.part` has no owner and nothing deletes it. (2) `cancel`/`remove` while the task's volume is missing (`failed volume_unavailable`) cannot resolve `partFile()` (null). When the SD card returns, the `.part` (possibly GBs) stays forever and the engine API can no longer name its volume. After a relaunch, retrying the `cancel` (as `cancel_pending` asks) returns `not_found` instead of resolving. Never published: a later start on the path has no validator and truncates it. **Fix:** persist a "dispose" list (volume id + relative path) until the deletion really happened. Run it at load and whenever a volume (re)appears, skipping paths a newer task owns (same guard as the tombstone cleanup). |
| N3-06 | **minor / android (fake too)** | `A/DownloadEngine.kt:243-248` (tombstone branch returns no latches) vs `remove` `:303-311` (waits). `T/fake.ts` same. JVM `REPRO_N3_cancelOfADrainingTombstoneResolvesWhileThePathIsStillClaimed`. | **Expected** (round-2 rule, `T/types.ts:140-143`): `cancel` resolves once the transfer has ended, "so the path is free afterwards"; `remove` of the same tombstone does wait. **Actual:** after a notification Cancel that timed out (`cancelAll` → false, worker still ending), `cancel(id)` on the tombstone resolves at once (< 1 s). A `start` on the same path then fails `invalid_state` until the worker really ends. A manager that cancels and immediately re-downloads gets a spurious error. **Fix:** return `disposedDrains(id)` from the tombstone branch and await them like `remove` (the claim stays with the drain meanwhile); mirror it in the fake. |
| N3-07 | **minor / all native** | `A/Transfer.kt:106`, `:287-288`; `A/HttpPolicy.kt:9-12`; `I/OfflineDownloadEngine.swift:1177-1180`. JVM `REPRO_N3_errorBodyEchoingTheCapabilityReachesTheLog`; Swift "an error answer echoing the request path …". | **Expected:** no capability URL in device logs. The server redacts `/api/v1/download/{capability}` in its own request logs (`server/src/Streamarr.Server/StreamarrServerBootstrap.cs:675-686`). **Actual:** neither engine logs the request URL, and Streamarr's own error envelope (`ViewerProblem`) contains none. But the first 256 printable bytes of any non-2xx body go to logcat / the unified log verbatim. An intermediary page that echoes the path (e.g. Apache's default 404) puts the capability in the log line. Repro log line: `a: HTTP 404 body: <p>The requested URL /api/v1/download/DUMMY-CAPABILITY-0123456789 was not found …`. **Fix:** before logging, replace the request URL, its path, query and any long URL-safe token (≥ 32 chars) with a placeholder, as the server does. Or log only the status, content type, length and a body hash. |
| N3-08 | **minor / android ≤ 12** | `A/Transfer.kt:287-288` (`errorStream.readNBytes(257)` inside `runCatching`). `InputStream.readNBytes(int)` is [API 33](https://developer.android.com/reference/java/io/InputStream#readNBytes(int)); minSdk is 24 (`client/node_modules/react-native/gradle/libs.versions.toml:3`). The builder's debug APK (`/Volumes/DevSSD/Caches/streamarr-builds/dl-native-86a52014/…apk`, read only) has a direct `invoke-virtual Ljava/io/InputStream;.readNBytes:(I)[B` in `Transfer.errorBody`, i.e. no D8 backport. | **Expected** (N2-12 follow-up decision): every non-2xx answer logs a truncated body line. **Actual:** on Android 7–12 the call throws `NoSuchMethodError`, `runCatching` swallows it, and the line always reads `body: none`. Those are the Android TV boxes on the ≤ 13 foreground-service path. The JVM test runs on JDK 17, where the method exists, and the builder's device runs used API 33/34, so neither can see it. **Fix:** read into a 257-byte buffer with a `read(buf, off, len)` loop. Enable lint `NewApi` for the module. |
| N3-09 | **minor / ios** | `I/OfflineDownloadEngine.swift:1669-1672` (`finishAssembly` deletes `kept/<id>.tail` before `guard assembling[id] == generation`), `:1634-1650`. Swift "a stale assembly completion deletes the current generation's continuation tail". | **Expected:** an outdated completion touches nothing of the current generation (N2-03 rule). **Actual:** generation 19's late completion deletes the `.tail` of generation 20 of the same id. If generation 20's off-queue append has not opened it yet, its append fails, `dropPartial` discards the kept bytes and the download restarts from 0. It needs cancel/remove + a new start of the same id that reaches its own continuation while the old multi-GB append still runs, so it is unlikely; the result is data loss only. **Fix:** check the generation first and use per-generation tail names (`kept/<id>.<generation>.tail`). |
| N3-10 | **nit / android (test fidelity)** | `A/Storage.kt:203-211`; builder `EngineTest.legacyExternalVolumeIdsAreReboundOnlyByTheirMedium` seeds a `uri` field. `git show 48925381:` and `8aa2cfa6^:` … `Model.kt` `toJson` never wrote `uri` or any absolute path. | **Expected:** the regression test uses state a v1 build could have written. **Actual:** real v1 records contain only `relativePath`, `volumeId` and `url`, so the `/storage/<UUID>/` rebind branch can only fire if the URL happens to contain such a segment. Every genuine v1 external record (completed ones too) becomes `failed volume_unavailable`, and its file stays on the card, unreachable through the old id. Acceptable for dev-only data; the journal's "rebound … via a /storage/<UUID>/ segment" overstates it. **Fix:** say so in the journal/README (or drop the dead branch). Seed the test with a real v1 record. |
| N3-11 | **nit / android** | `A/Transfer.kt:99`, `:245` (stop checks) vs `:234` (`connection = conn`); `A/Transfer.kt:70-78` + `A/DownloadEngine.kt:661-666` (`stop` takes `writeLock` while the engine lock is held). Code reading. | **Expected** (N2-06): a stop force-closes the connection, and engine calls never wait on I/O. **Actual:** (1) a stop between the last stop check and `connection = conn` (µs window per connect or redirect hop) disconnects nothing, so a stalled server holds the worker for up to 20 s connect + 30 s read and `cancel` can reach `cancel_pending`. (2) `stopTransfer` calls `Transfer.stop` under the engine lock. `stop` needs `writeLock`, which a worker holds across a blocking `write`/`truncate`. A write hung in the kernel (FUSE, a dying SD card) would block every engine call, including `onStartJob`/`onStopJob` on the main thread (ANR). Speculative; no device evidence. **Fix:** assign `connection` under `writeLock` with a stop check (disconnect at once if stopped). Set the stop flag without the engine lock (volatile, then take `writeLock` outside it), or make the "no write after stop" guarantee asynchronous via the drain. |

## Areas checked without a new finding

- **Claim registry and drains (Android):** every `stopTransfer` adds a drain. `Transfer.run` catches `Throwable`, so
  `onEnded` always runs, and `applyOutcome` removes the drain first. No path was found that adds a drain without a
  worker (`transfers` ⊆ `tasks`, `pool` is never shut down). The force-close gaps are N3-11. `settled` keeps an id until the next `cancel`/`remove` of it: an unknown-id cancel then resolves instead of
  `not_found` (harmless). Own `tombstoneDrainHoldsThePathThenReleasesIt`: a timed-out notification cancel keeps the
  path claimed, frees it when the worker ends, and the tombstone plus the next download's file survive a relaunch.
- **Host token / watchdog (Android):** `attachHost` releases an older start, `detachHost` ignores non-current hosts,
  `requestHost(replace = false)` adopts the system's pending job token, and the token is persisted. The watchdog only
  acts with no host, a request ≥ 15 s old, runnable work, no blocked network and a visible app. It re-arms every
  15.25 s, so it does not loop tightly. A pending job held back by something the engine cannot see (e.g. a constraint
  JobScheduler evaluates differently) is cancelled and re-requested every 15 s while visible: bounded churn, logged
  once. `load()` of an empty registry cancels any job request once (`goIdle`), which is correct.
- **`restoreWait`:** same boot keeps elapsed deadlines. Another boot (or `bootId` null) uses
  `min(saved, saved − wallΔ)`, so a rollback never extends a wait; a null boot id costs at most the elapsed time since
  the last save. The 12 h budget does not count downtime across a reboot (lenient, not unsafe). iOS mirrors this; its
  `kern.boottime` fallback turns a wall change into a "reboot" (only ever shortens).
- **Tombstones:** own no path. `start` with the id returns them, `cancel` only forgets them, `remove` is idempotent, and
  relaunch deletes leftovers only without a newer owner. `pause`/`resume` on a tombstone are silent no-ops
  (unspecified; harmless).
- **iOS kept clones:** `clonefile` + truncate to the reported bytes, only for the validated 2xx response of the current
  generation (`responseKeys` match). Resume data is kept only for the recorded ETag. An If-Range continuation with
  another ETag drops the kept bytes. Kept files go on complete, cancel, remove, tombstone and drop; `load()` removes
  orphans by percent-encoded id prefix. A stale clone after a 200 restart of a resume-data task stays until the next
  clone or a terminal path, but If-Range protects every use of it (storage only). A crash mid-assembly loses the kept
  bytes (`keptLength` mismatch → cleared), never corrupts. Continuations reserve the remainder twice (`:917`).
- **Unicode aliases:** Swift `String` comparison is canonical-equivalence based, so NFC/NFD paths conflict on iOS
  (APFS). Android internal storage and vfat/exfat do not normalise.
- **Logs:** no engine log line contains the request URL or headers on either platform (`grep` of every
  `NSLog` / `platform.log` / `Log.*` call); exception messages are classified by type. Only N3-07 remains.
- **Not reported (speculative, no path found to trigger):** `publish` resolves the target with `canonicalFile`, which can
  throw `IOException` on the worker thread; it is uncaught there, the process crashes and `load()` recovers. `remove`
  does not pump, so observers stay registered until the next pump. A drain of a task on a missing volume shows
  `bytesWritten` 0 until the volume returns (display only).

An independent read-only review agent cross-checked the Android sources against the binding rules. Every item it
raised was re-checked here and is either reported above with its own repro or evidence, listed as not reported, or
was already covered: N3-02, N3-04, N3-05, N3-06, N3-08 and N3-11 overlap with or came from that review.

## Needs a device

1. **N3-01 timing:** how far nsurlsessiond's file runs ahead of `didWriteData` at LAN/Wi-Fi 6 speeds (is ≥ 1 MiB
   common?). Then stall one of two parallel downloads for > 10 s, pause the other, revoke the first's URL and renew it.
   Compare sha256 with the server.
2. **N3-03:** FAT32 and exFAT SD/USB on Android 11+ (FUSE over vfat/exfat). Create `x.bin.` and confirm it opens
   `x.bin`; run two engine tasks on those paths.
3. **N3-07:** a reverse proxy that echoes the path in its 404/502 page; inspect logcat / `log stream`.
   **N3-08:** an Android ≤ 12 device or box with a 4xx answer; the log line is expected to read `body: none`.
   **N3-04:** a power cut on a vfat SD card right after a reset and a retry (part content vs checkpoint).
4. `clonefile` of a file nsurlsessiond is still writing: confirm the clone holds the reported bytes (hash of a kept
   clone against the server's prefix). The builder's continuation sha256 matches suggest yes.
5. N2-04 sleep on a real iPhone (`mach_continuous_time`, timer re-arm ≤ 60 s) and a manual clock rollback on iOS.
   The builder covered the Android clock only.
6. The notification Cancel broadcast budget: if it is a foreground broadcast (10 s), a worker stuck past it ANRs. The
   state stays consistent (tombstones persisted first, leftovers removed at load), but confirm it on a device.
7. The N2-11 watchdog against a job that JobScheduler holds for a constraint the engine considers satisfied
   (captive-portal Wi-Fi, data saver): confirm the churn stays at one re-request per 15 s and stops when backgrounded.

## Confirmed by repro vs code reading

- **Repro (host):** N3-01 (engine part), N3-02, N3-03 (claim part), N3-04 (bookkeeping part), N3-05, N3-06, N3-07,
  N3-09, plus every N2 status above (own former repros now asserting decided outcomes) and the five mutants.
- **Code reading / external source only:** N3-03's file-system aliasing (Linux kernel source), N3-04's power-loss
  consequence, N3-08 (Android API reference + `dexdump` of the builder's APK), N3-10 (git history), N3-11, the
  "checked without a finding" list, and everything under "Needs a device".
