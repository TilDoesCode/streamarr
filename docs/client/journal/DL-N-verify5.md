# DL-N independent verification 5 (short, focused)

**Verdict: pass with findings.** N4-01, N4-02 and N4-03 are fixed: my round-4 repros now assert the 3b outcomes and pass
on Android and iOS. Every earlier finding stays fixed except N1-15, which is partial again because of N5-01. The
identity cycle resisted every race I could build (cancel + restart, finish first, replace, foreign-ETag blob, transient
503). Neither adapted older test was weakened: reverting each one's original guard still makes it fail.
**New findings: 0 blockers, 0 majors, 1 minor, 2 nits.** The minor (N5-01) is the one path I found where the same boot
id does not mean the page cache survived: a removable card pulled and re-inserted without a reboot.

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. `git merge fb/downloads` brought in
**ddd27fd0** (DL-N fix rounds 3b/3c via 7977908c, plus later client merges). Verifier merge **2e84748b**. Reviewed
567385fe (identity cycle), 35e07e7f / e2520225 (`clock()`), c71ce7fa / d51d7b66 (N4-01), 88b4da87 (N4-02/03),
256f2c51 (D-01), 5410255b (D-02) and `DL-N.md` §§ "Fix round 3b", "Fix round 3c". Device claims are the builder's
evidence, not repeated here.

Not done: product edits, push, devices, emulators, simulators, Argent, prebuild, app builds, and writes to other
worktrees. Gradle home `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`, Node 24.14.0, Java 17, Swift via
`source docs/client/env.sh`, Range server on **127.0.0.1:39321** only (stopped afterwards).

## Commands and results

`V` = `tools/dl-verify-native`, `M` = `client/modules/offline-downloads`, `A` = `M/android/src/main/java/expo/modules/offlinedownloads`,
`I` = `M/ios`. `DL_VERIFY_ROUND=5 bash V/run-round3.sh all` and `… jest-full` run every suite (logs in the ignored
`V/logs/round5/`); `python3 V/collect-round5.py` asserts every count below and writes
[results5.json](../../../tools/dl-verify-native/results5.json) and [evidence5.txt](../../../tools/dl-verify-native/evidence5.txt).

| Command | Result |
|---|---|
| `git merge fb/downloads` | ddd27fd0 → verifier merge 2e84748b. Engine diff since round 4: 31 files, +1,972/−141. |
| Gradle `-p V/jvm cleanTest test` (verifier) | Exit 0, **67/67**: Transfer 20, RedirectBoundary 4, module HttpPolicy 9, Round2 8, Round3 11, Round4 8 (the 3 former `REPRO_N4_*` now assert the 3b outcome), **Round5 7** (2 `REPRO_N5_*` observed + 5 acceptance). |
| Gradle `-p M/test-harness/jvm cleanTest test` (builder) | Exit 0, **92/92**: EngineTest 53, TransferTest 25, HttpPolicyTest 9, RedactionFuzzTest 3, ClockTest 2; zero skipped. |
| `swiftc … I/HttpPolicy.swift I/Tests/HttpPolicyCheck.swift` + corpus | Exit 0, **773/773**. |
| Builder generator + `swiftc` + engine host | Exit 0, **81/81**. |
| `V/swift/make-host-check.py` + `swiftc` + engine host (verifier) | Exit 0: **23/23** baseline, round 3 **8/8**, round 4 **18/18** (former N4 repros now outcomes; Kotlin = Swift on 3,000 redaction fuzz cases, 0 leaks incl. 1–3 char queries), round 5 **6/6** + **1/1** N5 repro. |
| `node M/test-harness/js-check.cjs` / `node V/js-check.cjs` | Exit 0, **11/11** / **11/11**. |
| `npm run typecheck` / `CI=1 npm run lint` | Exit 0 / exit 0. |
| `npx jest src/downloads/engine src/api/__tests__/errors.test.ts --runInBand --forceExit` | Exit 0, **6 suites, 198/198**; engine suites alone **5 suites, 169/169**; `errors.test.ts` passes. |
| `npx jest --runInBand --forceExit` (whole client) | Exit 0, **293/293 suites, 2,979/2,979 tests** (N2-10 stays fixed). |
| `python3 V/mutants.py --round 5` | **6/6 mutants caught, 5/5 controls pass** (table below). Writes only `V/.work/mutants/`. |

### Were the two adapted older tests weakened? (mutation)

Round-5 Swift mutants run every check instead of stopping at the first failure, so the adapted check is shown to fail
on its own rather than hidden behind an earlier one.

| Mutant (one guard reverted in a scratch copy) | Targeted builder test | Result |
|---|---|---|
| **N3-04 adapted test:** `durableBytes = offset` (no sync of the old part, `A/Transfer.kt:122`) | `EngineTest.aNewAttemptSyncsTheOldPartBeforeItsCheckpointCoversIt` | fails; control passes → **not weakened** |
| **N2-07 adapted check:** any 206 start accepted (`range.start == offset` → `>= 0`, `I/OfflineDownloadEngine.swift:1192`) | Swift "an in-task 206 starting elsewhere than its requested Range restarts from 0 (N2-07)" | fails (one of 4 failing checks) → **not weakened**; the re-seed (4 reported bytes) is the precondition D-02 needs, not a relaxation |
| D-01: no sync on the way out (`A/Transfer.kt` `finally`) | `EngineTest.aPauseSyncsThePartAndPersistsItsCheckpoint` | fails; control passes |
| D-01: same boot without `elapsed >= saved` (`A/DownloadEngine.kt:70`) | `EngineTest.aProcessDeathKeepsTheWrittenBytesOnTheSameBootOnly` | fails; control passes |
| D-02: `restartCounted` guard removed (`A/DownloadEngine.kt:837`) | `EngineTest.everyDropOfTheBytesOnDiskCountsOneRestart` | fails; control passes |
| D-02 iOS: `dropBytes` counts without lost bytes (`I/OfflineDownloadEngine.swift:1723`) | Swift "bytes that cannot continue count one restart on every path, never two (D-02)" | fails (one of 2 failing checks) |

My own adapted former N3-04 repro (`REPRO_N3_checkpointCoversBytesThatWereNeverSynced`) needed the same premise change
as the builder's. Since D-01, a broken-off attempt syncs on its way out, so the premise now needs a failing sync. The
test also asserts the D-01 outcome: with a working sync, the checkpoint covers the 4 bytes.

## Status of every finding

"Fixed" is bounded by host evidence and code reading; device behaviour is the builder's evidence.

| ID | Status | Evidence / remaining scope |
|---|---|---|
| N1-01 Resume response integrity | fixed | Original `BUG_*` Transfer cases pass; iOS: an in-task OS retry is proven only by its own Range, else "unverifiable" (kept bytes stay, OS bytes dropped). |
| N1-02 Crash consistency of restart | fixed | Live child-JVM kill passes; the builder's new `aDeathBetweenTruncateAndPersistNeverMixesValidators` pins truncate + sync → persist → write under D-01. |
| N1-03 Target ownership | fixed | Unchanged rules; legacy dot segments now own their folder (N4-03). |
| N1-04 Early completion / 416 | fixed | Unchanged; 416 now also counts one restart (D-02). |
| N1-05 Stale callbacks / identity | fixed | Cycle callbacks are gated by generation: own checks 1 and 3 (late blob and completion after cancel + restart, or after replace) change nothing. |
| N1-06 Response checks at finalization | fixed | Identity only from the task's own blob, confirmed by a 206 with the same ETag; a blob of another ETag gives no identity (own check 4). |
| N1-07 Cancel / move / delete races | fixed | Unchanged; cycle + cancel race covered (own check 1). |
| N1-08 Unbounded retry | fixed | Corpus 773/773. |
| N1-09 Retry-After parity | fixed | Unchanged. |
| N1-10 HEAD probe / resume-data cleanup | fixed | The cycle's resume skips the probe by design (the blob is seconds old). |
| N1-11 Fake fidelity | fixed | Fake gains `clock()`; engine jest 169/169. |
| N1-12 Redirect credential scope | fixed | RedirectBoundary 4/4 live. |
| N1-13 User stop / UIDT lifecycle | fixed | Unchanged. |
| N1-14 Removable volume identity | fixed | Unchanged. |
| N1-15 Durable checkpoints | **partial** | D-01: syncs on every way out and every 5 s / 8 MiB, all on the worker (own: 2 worker syncs, 0 under the engine lock, checkpoint persisted mid-transfer). Adoption is capped at the total (own check). Residual: **N5-01** (same boot ≠ surviving page cache on a removable card). |
| N1-16 Storage pressure | fixed | Unchanged. |
| N1-17 Bridge diagnostics | fixed | Unchanged. |
| N2-01 … N2-03 | fixed | Former repros pass as outcomes. |
| N2-04 Elapsed clock | fixed | Boot id now from the kernel / `kern.bootsessionuuid` (an old persisted id reads as a reboot: waits only shorten, parts trim). Own `BootClock` check: never throws, one id per process, fallbacks in order. |
| N2-05 … N2-09 | fixed | Former repros/replays pass. |
| N2-10 Client error registry | fixed | `errors.test.ts` passes; full client 2,979/2,979. |
| N2-11 Host race | fixed | Unchanged; own watchdog checks pass. |
| N2-12 iOS in-task 4xx truncation | fixed | Fresh downloads now gain an exact identity through the cycle (≥ 1 MiB, ≥ 2 s, foreground); limits as documented. |
| N3-01 … N3-11 | fixed | All former N3 repros pass as outcomes (Kotlin 7, Swift 5); N3-04's premise adapted for D-01 as described above. |
| N4-01 Short query shreds the capability | **fixed** | Former `REPRO_N4_shortQueryPieceShredsTheCapabilityPastTheTokenRule` now: 0 leaks in 1,500 short-query cases (was 558), the glued URL logs `see [redacted]`, `?1` logs `unknown download [redacted]`; Swift identical on both corpora (3,000 cases). |
| N4-02 Pending disposal suppresses the summary | **fixed** | Former repro now: summary `[(1,0)]` before and after the relaunch, the card stays watched, the disposal stays queued; a download whose card is missing gives one plain storage note (`waitingForStorage(1)`) and no failure count. |
| N4-03 Legacy dot segments own nothing | **fixed** | Former repro now: both records `failed` `invalid_legacy_path`; `deletePath`/`move` of the folder `invalid_state`; `resume` `invalid_argument`; after both `remove`s the partial is gone and the folder deletable. iOS: folder owned. |

## New findings

`A`/`I` paths as above. Severity: blocker / major / minor / nit.

| ID | Severity / platform | Evidence | Expected vs actual | Suggested fix |
|---|---|---|---|---|
| N5-01 | **minor / android (removable volumes)** | `A/DownloadEngine.kt:70` (`sameBoot` = same boot id and elapsed not reset), `:159` (same boot keeps the whole part), `A/Storage.kt:16` (`Volume.removable` known but unused there). JVM `REPRO_N5_sameBootAdoptsUnsyncedBytesOnARemovableCard`: an SD part of `AAAA` + 4 never-written bytes, checkpoint 4, same boot → adopted 8, Range `bytes=8-`, published **`AAAA0000CCCC`**; the same state from another boot → trimmed to 4, published `AAAABBBBCCCC`. | **Expected** (D-01's own premise): bytes past the checkpoint are trusted only where the kernel still holds them. **Actual:** on the same boot every byte is adopted, also on a removable card. A surprise removal (card pulled mid-download; vold kills the app) loses the card's dirty pages, but the boot id stays. On re-insertion the job restarts the app, and on vfat the directory entry's size may have reached the card before the data clusters (writeback has no ordering; exFAT reads past its valid length as zeros). The engine then adopts up to 5 s / 8 MiB of garbage or zeros and appends a valid 206 behind it. ETag and size match, so the file is published as completed. The trigger part (writeback ordering, FUSE daemon crash on Android 11+) is code reading plus kernel behaviour; the engine part is the repro. | Adopt past the checkpoint only on non-removable volumes; removable ones always trim to the checkpoint (cost: ≤ 5 s / 8 MiB re-fetched). Or persist a per-volume mount identity (mount id from `/proc/self/mountinfo`, or a vold mount-state counter) with the clock and treat a change as a reboot for that volume. |
| N5-02 | **nit / android** | `A/DownloadEngine.kt:151-153` (`recoverPart`: missing part → `bytesWritten = 0`, nothing counted); a following fresh GET has nothing to truncate, so `droppedAll` stays false. iOS counts this case (`dropBytes` in `begin()`, `I/OfflineDownloadEngine.swift:1046`). JVM `REPRO_N5_aVanishedPartLosesItsBytesWithoutARestart`: recorded 4 → loaded 0, completed with `restarts` **0**. | **Expected** (D-02: "every loss of all bytes counts exactly one restart on both platforms"): `restarts` 1. **Actual:** 0 on Android when the part vanished between launches (deleted through a PC or file manager on the card's `Android/data`, a storage cleaner). Display/bookkeeping only. | In `recoverPart`, count one restart when the part is missing and recorded bytes were > 0 (or let `onResponse` count when `fromZero` and the record still held bytes). |
| N5-03 | **nit / ios** | `I/OfflineDownloadEngine.swift:1629` (the cycle takes a background-task assertion), `:1312` (the file finished before the cancel took effect: published normally), `:1637` (the late resume-data completion returns at the guard without `endAssertion`). Swift "a cycle that loses the race to the finished file leaves its background assertion held until expiry": `assertions[id]` still set after the completed state. | **Expected:** the cycle's assertion ends with the cycle. **Actual:** it stays until its expiry handler ends it (the dictionary keeps the object, so no termination). After a download finished inside the cycle window (≥ 1 MiB left, about 10 ms at LAN speed), the app keeps ~30 s of background time it does not need once it is backgrounded. | `endAssertion(id)` where `didFinishDownloadingTo` drops the cycle (`:1312`), or in `finishIdentityCycle` when the cycle is gone. |

### Checked without a new finding

- **Identity cycle:**
  - **Cancel + new start during the cycle:** the old blob and completion never reach the new download (generation guard in `finishIdentityCycle` and `current()`; `cancel` deletes the blob and kept bytes).
  - **Finished first:** the file is published once, nothing new starts, no blob is kept.
  - **Replace during the cycle with the old-URL blob arriving last:** the next task uses the new URL with `Range: bytes=1572864-` + If-Range from the kept clone; it never resumes the old URL's blob.
  - **Blob of another ETag:** no identity, nothing kept, exactly one restart, `identityFailures` 1.
  - **Transient 503 on the cycled request:** the blob is kept for the retry. My hypothesis that this counts as an identity failure was **refuted** (`identityFailures` 0).
  - **Covered by the builder** (I read their checks): retry cap, background deferral, pause during the cycle, no event flicker, identity across a relaunch. The relaunch guard (`osFileGeneration == generation` and the file exists) cannot give another task's file: names are the daemon's random temp names, set only from this id's own blob.
- **D-01:**
  - The N1-02 ordering holds in code: `truncate(0)` + sync before `onResponse` persists, and `onResponse` runs before the first write.
  - The truncate-death test exists and passes.
  - Adoption is capped at the total (own check: a 10-byte part with total 8 is adopted as 8, the last byte is re-validated, and the published file is exact).
  - Checkpoint syncs run on the worker; only the state save takes the engine lock, as before.
  - Internal storage: the app's files dir cannot move to adoptable storage unless `android:installLocation` allows it; the app config sets none, so Android's default (internal only) applies, so the same-boot premise holds there.
  - An app updated from a build with the old boot-id format reads as rebooted, which is the safe direction.
- **D-02:**
  - All six Android drop paths are preceded by `truncate(0)` (code reading).
  - One attempt that drops twice (a 200 restart, then an oversized body) counts once, with `bytesWritten` 0 at the failure; a later fresh start counts nothing more.
  - A 410 keeps the 4 bytes with `restarts` 0, and the renewed URL continues with a 206 (own); the builder covers 403 the same way.
  - iOS `dropBytes` cannot double count (mutation above).
- **`clock()`:**
  - Android `BootClock` reads the kernel id, then the boot count, then a process id. It is lazy (one id per process even if the source changes later) and never throws (own check with throwing sources; a null context only loses the boot-count fallback).
  - iOS uses `kern.bootsessionuuid`.
  - TS falls back per call. A malformed native answer then alternates ids, which the contract handles ("compare `elapsedMs` only under the same `bootId`").
  - Its documented "never with the wall clock" does not hold for the iOS `kern.boottime` fallback, which exists only where the session UUID is missing. Doc only, not raised.

## Harness changes (tools only)

- **Ported, my round-4 repros:**
  - `Round4AdversarialTest` and `Round4Check.swift`: the N4 repros now assert the 3b outcomes.
  - `Round3AdversarialTest`: the N3-04 premise moved to a failing sync, as D-01 requires.
  - `VerifierRig` implements `waitingForStorage`.
  - The verifier JVM build includes `BootClock.kt`.
- **New:**
  - `Round5AdversarialTest` (7 tests) and `swift/Round5Check.swift` (6 outcomes + 1 repro).
  - `FixtureTask` gains the request Range, produced resume data and a cancel count.
  - `mutants.py --round 5` runs Swift in keep-going mode.
  - `collect-round5.py` asserts every count and writes `results5.json` and `evidence5.txt`.

## Needs a device

1. N5-01: an Android phone with a vfat SD card. Pull the card during a download (within 5 s of a checkpoint), re-insert
   it without a reboot, let the job resume, then compare the sha256 against the server.
2. The identity cycle at LAN speed, where the file can finish inside the cycle window (N5-03's trigger).
3. Earlier device-only items unchanged: power loss after a sync on vfat, iOS sleep, the notification Cancel broadcast
   budget, and nsurlsessiond's own URL logging (builder's known limitation).

## Confirmed by repro vs code reading

- **Repro (host):**
  - N5-01's engine behaviour, N5-02 and N5-03.
  - Every check under "Checked without a new finding" marked "own".
  - The six mutants and the ported N4 outcomes.
- **Code reading / external behaviour only:**
  - N5-01's trigger (vfat writeback ordering, FUSE).
  - The N1-02 ordering argument, the Android drop-path enumeration, and the adoptable-storage premise.
  - Everything under "Needs a device".
