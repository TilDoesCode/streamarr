# DL-N independent verification 6 (short, focused on fix round 3d)

**Verdict: pass with findings.** N5-01, N5-02 and N5-03 are fixed: my round-5 repros now assert the 3d outcomes and
pass. N1-15 is fixed again. I could not make D-03 accept wrong bytes: a report ahead of the OS file, an OS reset of
its file, a rewinding retry, a stale generation and a pause are all rejected or caught by the final size check. D-03
does have two gaps where it falls back to a restart it was meant to avoid. **New findings: 0 blockers, 0 majors,
2 minors, 1 nit.** None of them can publish wrong bytes.

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. `git merge fb/downloads` brought in
**ad8cccb8** (fix round 3d: e01adde6 N5-01..03, bd8911dc D-03, b8109a6e journal; plus client merges). Verifier merge
**b32f51e8**. Engine diff since round 5: 6 files, +335/−43. Device claims in `DL-N.md` § "Fix round 3d" are the
builder's evidence, not repeated here.

Not done: product edits, push, devices, emulators, simulators, Argent, prebuild, app builds, writes to other
worktrees. Gradle home `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`, Node 24.14.0, Java 17, Swift via
`source docs/client/env.sh`, Range server on **127.0.0.1:39321** only (stopped afterwards).

## Commands and results

`V` = `tools/dl-verify-native`, `M` = `client/modules/offline-downloads`, `A` = `M/android/src/main/java/expo/modules/offlinedownloads`,
`I` = `M/ios`. `DL_VERIFY_ROUND=6 bash V/run-round3.sh all` and `… jest-full` run every suite (logs in the ignored
`V/logs/round6/`); `python3 V/collect-round6.py` asserts every count below and writes
[results6.json](../../../tools/dl-verify-native/results6.json) and [evidence6.txt](../../../tools/dl-verify-native/evidence6.txt).

| Command | Result |
|---|---|
| `git merge fb/downloads` | ad8cccb8 → verifier merge b32f51e8. |
| Gradle `-p V/jvm cleanTest test` (verifier) | Exit 0, **71/71**: Transfer 20, RedirectBoundary 4, module HttpPolicy 9, Round2 8, Round3 11, Round4 8, Round5 7 (the 2 former `REPRO_N5_*` now assert the 3d outcome), **Round6 4** (1 `REPRO_N6_*` observed + 3 acceptance). |
| Gradle `-p M/test-harness/jvm cleanTest test` (builder) | Exit 0, **96/96**: EngineTest 57, TransferTest 25, HttpPolicyTest 9, RedactionFuzzTest 3, ClockTest 2; zero skipped. |
| `swiftc … I/HttpPolicy.swift I/Tests/HttpPolicyCheck.swift` + corpus | Exit 0, **773/773**. |
| Builder generator + `swiftc` + engine host | Exit 0, **83/83**. |
| `V/swift/make-host-check.py` + `swiftc` + engine host (verifier) | Exit 0: **23/23** baseline, round 3 **8/8**, round 4 **18/18**, round 5 **7/7** (the former N5-03 repro is now an outcome), round 6 **9/9** + **2/2** N6 repros. |
| `node M/test-harness/js-check.cjs` / `node V/js-check.cjs` | Exit 0, **11/11** / **11/11**. |
| `npm run typecheck` / `CI=1 npm run lint` | Exit 0 / exit 0. |
| `npx jest src/downloads/engine src/api/__tests__/errors.test.ts --runInBand --forceExit` | Exit 0, **6 suites, 198/198**; engine suites alone **5, 169/169**. |
| `npx jest --runInBand --forceExit` (whole client) | Exit 0, **294/294 suites, 2,985/2,985 tests** (the builder's 2,979 predates the later client merges). |
| `python3 V/mutants.py --round 6` | 8 mutants of the 3d guards against the builder's harness: **6 caught, 2 not** (table below); 4/4 controls pass. |

### "Fails before the fix": 3d guards reverted one at a time (scratch copies, builder's harness)

| Mutant | Builder test | Result |
|---|---|---|
| N5-01: removable cards adopt on the same boot again (`A/DownloadEngine.kt:96`) | `aRemovableCardNeverAdoptsBytesPastItsCheckpoint` | fails; control passes |
| N5-01: no `untrimmed` entry when a card goes missing (`:582`) | `aCardThatReturnsInTheSameProcessTrimsBeforeTheNextRequest` | fails; control passes |
| N5-02: a vanished part counts no restart (`:157`) | `aVanishedPartCountsOneRestart` | fails; control passes |
| N5-03: `dropCycle` does not end the assertion (`I/OfflineDownloadEngine.swift:1023`) | Swift "every identity cycle ends its background time exactly once …" | fails |
| D-03: the cycle threshold back to 1 MiB (`:301`) | Swift "a fresh GET is cycled once: validated and >= 256 KiB in …" | fails |
| D-03: a report of another *task* accepted (`:1848`) | Swift "an in-task 206 is this task's continuation only when …" | fails |
| D-03: a report of another *generation* accepted (`:1848`) | same | **not caught** by the builder's suite. My round-6 check 6 catches it (`logs/round6/mut-verifier.log`). The guard is redundant today, because `begin()` clears the report for every new generation. |
| D-03 also for the engine's own Range continuation (`:1226`) | — | **not caught**. This is an equivalent mutant: an own-Range task's `currentRequest` always carries the engine's Range, and its reports are relative to the kept bytes, so the fallback can never match. |

## Status of every finding

"Fixed" is bounded by host evidence and code reading; device behaviour is the builder's evidence.

| ID | Status | Evidence / remaining scope |
|---|---|---|
| N1-01, N1-02 | fixed | Original `BUG_*` cases and the live child-JVM kill pass. N1-02 ordering unchanged in 3d. |
| N1-03, N1-04 | fixed | Unchanged. |
| N1-05, N1-06 | fixed | D-03 widens what an in-task 206 may prove. Every attempt to break it was rejected or caught (§ D-03 below). Gaps N6-01/N6-02 only cost bytes. |
| N1-07 … N1-14 | fixed | Unchanged; corpus 773/773, RedirectBoundary 4/4. |
| N1-15 Durable checkpoints | **fixed** (was partial via N5-01) | Removable volumes trim to the checkpoint at load and on return in-process. Same-boot whole-part adoption remains on `internal` only, which is never on adoptable storage (below). |
| N1-16, N1-17 | fixed | Unchanged. |
| N2-01 … N2-12 | fixed | Former repros pass as outcomes. N2-10: full client 2,985/2,985. |
| N3-01 … N3-11 | fixed | Former repros pass as outcomes. |
| N4-01 … N4-03 | fixed | Former repros pass as outcomes; Kotlin = Swift on 3,000 redaction fuzz cases, 0 leaks. |
| N5-01 Removable same-boot adoption | **fixed** | My former repro now: the removable card adopts 4 bytes (not 8), requests `bytes=4-` and publishes `AAAABBBBCCCC` (was `AAAA0000CCCC`). Own round 6: a card leaving and returning in one process trims to the checkpoint before the next request (`bytes=4-`). A worker still ending on the returned card holds the trim and the restart back. Internal storage still adopts 8. Mutations ×2 caught. |
| N5-02 Vanished part not counted | **fixed** | Former repro now: `restarts` 1 at load, still 1 after the fresh download completes, and 1 after a second relaunch. Mutation caught. |
| N5-03 Cycle assertion held after a race | **fixed** | Former Swift repro now: no assertion held after the file finishes inside the cycle. Round 6: 1 begun = 1 ended. Mutation caught. |
| D-01, D-02 (builder device findings, round 5) | fixed | Unchanged in 3d; the round-5 checks pass. |
| D-03 (builder device finding) | **fixed, with gaps** | Accepted exactly at the reported bytes. Gaps: **N6-01** (not applied at finish) and **N6-02** (no identity cycle afterwards). |

## D-03 and the 3d hunt

Labels refer to `V/swift/Round6Check.swift` checks (1–7) and `V/jvm/.../Round6AdversarialTest.kt`.

1. **Can the reported counter be ahead of or behind the OS file?**
   - **Ahead** (the OS kept fewer bytes than it reported): the OS retries at its own file length, which is below the
     report, so it is never accepted. Own check 3: stopped, nothing kept, one restart.
   - **Behind** (coalesced reports): the retry starts past the report, so it is unverifiable (builder check, +1 byte).
   - **A pause or URL change between the report and the retry:** a new generation, and `begin()` clears the report.
     Own check 7: no report survives a pause.
   - **Across a relaunch:** the report lives in memory only, so D-03 can prove only switches seen after the relaunch.
     This is a pre-existing point, not widened by D-03: an adopted task whose current response already changed
     before the relaunch is not re-validated mid-transfer (`responseKeys` is empty). At finish, its ETag, range and
     size are checked. Code reading.
   - **Two consecutive in-task retries** at the reported bytes are both accepted. One that rewinds to an older start
     is not (own check 5).
2. **A 206 at the reported offset on a file the OS reset:** caught at publish by the size check. Own check 4:
   `size_mismatch`, nothing published, one restart. Snapshots need the OS file to be at least the reported bytes, so
   none is taken from such a file (code reading). A 206 with the same start and the same strong ETag but a different
   body cannot be detected without a content hash. That is the decided trust model (append only with the same strong
   ETag and a valid Content-Range), same as Android.
3. **Task identifier reuse:** the proof needs identifier and generation. Generations strictly increase (persisted
   clock), and the two sessions' identifier spaces are separated by `current()`, which matches the session first.
   Own check 6 (same identifier, other generation → unverifiable) passes and catches the mutant the builder's suite
   misses.
4. **The 256 KiB cycle:**
   - At most two failed cycles per task (builder) and one per fresh generation.
   - Cycle vs completion: fixed (N5-03).
   - Cycle vs D-03: **N6-02**.
   - Background accounting balances (own: 1 begun = 1 ended across round 6).
5. **N5-01:**
   - **A new start on the same path:** `start` refuses a missing volume. Starting after the card returned but before
     any pump (the builder saw Android 14 defer the mount broadcast) yields to the new task: **N6-03**. No byte
     reaches the new file, because a new task has no validator and truncates.
   - **A task moved between volumes:** not possible. `volumeId` is immutable, and `move` refuses unfinished tasks'
     paths.
   - **Adoptable storage as internal:** `internal` is the app-private `filesDir`. The app config sets no
     `android:installLocation`, so the app cannot be moved to adoptable storage. The emulated external dirs (the only
     ones that can be migrated to an adopted card) are skipped by `isExternalStorageEmulated`. The engine never writes
     to adoptable storage, so nothing can be misclassified. If `installLocation` ever allows external, revisit.
     Non-removable secondary volumes are trimmed too (conservative).

## New findings

| ID | Severity / platform | Evidence | Expected vs actual | Suggested fix |
|---|---|---|---|---|
| N6-01 | **minor / ios** | `I/OfflineDownloadEngine.swift:1350-1351` (`didFinishDownloadingTo` reads `responseKeys` and then calls `clearTaskTracking`, which removes `lastReport`, `:707`), then `validate` at `:1388` → `:1226` `reportedStart` → nil. Swift round 6 check 1 (with a control that adds one report and publishes). | **Expected** (D-03 rule): an in-task 206 of the same task and generation, with the recorded strong ETag, a consistent range and a start equal to the bytes the task reported before the cut, is its own continuation, including when the file finishes. **Actual:** if the 206's bytes are not reported before `didFinishDownloadingTo`, the proof can never apply. This happens with a short tail after a late reset, or coalesced progress. The complete file is discarded as "unverifiable" (state `retrying`, `restarts` 1, nothing published) and fetched again from 0. For a large file reset near its end, that is the whole file again. | Read the report before `clearTaskTracking` (capture it with `validatedKey`), or clear tracking after `validate`. At finish, the size check additionally proves the last segment's alignment. |
| N6-02 | **minor / ios** | `I/OfflineDownloadEngine.swift:1664` (`maybeCycleIdentity` requires the task's current response to be a 200). Swift round 6 check 2: the control cycles at 512 KiB; after an accepted in-task 206 at 100 KiB the same download is never cycled and gets no identity. | **Expected** (3b/3d): a validated fresh GET gets its identity cycle after 256 KiB. **Actual:** once D-03 accepted an in-task continuation, the current response is a 206 and the download never cycles. It then keeps no engine copy for the rest of the transfer. A later in-task 4xx (N2-12), or a retry the counter cannot prove, restarts it from 0 instead of continuing from kept bytes. The builder's own device run with a reset at 100,000 B ends in exactly this state. | Allow the cycle when the generation's first response was a validated 200 with `Accept-Ranges: bytes` and the current one is its D-03-proven continuation. Record that per generation at validation time. |
| N6-03 | **nit / android** | `A/DownloadEngine.kt:217` (the new task is registered before `pumpLocked`), `:955` (a queued disposal yields to any task on its path), `A/Transfer.kt:116`, `:292` (`droppedAll` from the file), `A/DownloadEngine.kt:748`. JVM `REPRO_N6_aNewDownloadCountsARestartForAQueuedPartialItInherits`. | **Expected** (D-02): only a loss of the task's own bytes counts a restart. iOS `dropBytes` requires `bytesWritten > 0`. **Actual:** a download cancelled while its card was out queues its partial. If a new download starts on the same path after the card returned but before a pump, the disposal yields and the new task's first attempt truncates the foreign bytes. It completes correctly but with `restarts` 1. No data effect, and the manager does not read the engine's `restarts`. | Count a `droppedAll` restart only if the task had bytes (`bytesWritten > 0 \|\| checkpoint > 0` at the attempt's start), matching iOS. Or run `processDisposals` before registering the new task in `start`. |

## Harness changes (round 6)

- **Ported to the 3d outcomes:**
  - `Round5AdversarialTest` and `swift/Round5Check.swift`.
  - The Swift fixture's response is now mutable, for in-task switches.
  - `seed()` ends cycles through `dropCycle` instead of discarding them.
- **New:**
  - `Round6AdversarialTest` (4 tests) and `swift/Round6Check.swift` (9 outcomes + 2 repros).
  - `TransferAdversarialTest.ranges` records each fixture's request Range.
  - `mutants.py --round 6`, `collect-round6.py`, `results6.json`, `evidence6.txt`.

## Needs a device

1. **N6-01:** a reset within the last ~64 KiB of a file on an iPhone. Expect a full refetch today.
2. **N6-02:** the builder's 100,000 B reset run, then an in-task 410 later in the same download. Expect a restart
   from 0 today.
3. **N5-01:**
   - The "missed removal" race: a card pulled and re-inserted between two pumps without the process dying. Vold
     normally kills a process holding the file open. Code reading only.
   - The Android 14 deferred mount broadcast with a user-initiated start (N6-03's trigger).
4. Unchanged from earlier rounds: power loss on vfat, iOS sleep, nsurlsessiond's own URL logging.

## Confirmed by repro vs code reading

- **Repro (host):**
  - N6-01, N6-02 and N6-03, each with a passing control.
  - Every ported N5 outcome, the D-03 checks 3–7 and the 8 mutants.
- **Code reading only:**
  - The relaunch/adoption argument.
  - The snapshot condition after an OS reset.
  - Session identifier spaces.
  - Adoptable storage and `installLocation`, and the missed-removal race.
  - Everything under "Needs a device".
