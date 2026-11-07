# DL-N independent verification 8 (last engine check)

**Round verdict: pass with findings. Final verdict for the DL-N engine lane: pass with findings — merge-ready once the
two-line fix for N8-01 lands.** N7-01 and N7-02 are fixed: my round-7 repros now assert the 3f outcomes and pass. The
new trust holds against every probe, and so does the new pruning. One of the guards the builder removed as redundant was
not: without it, a rare chain (a failed final move, then a retry, then a fallback) publishes a **completed file with
bytes from the wrong offset** (N8-01). The fix is two lines; re-run against the builder's suite in a scratch copy,
it keeps 93/93. **New findings: 0 blockers, 1 major, 1 minor, 1 nit.**

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. `git merge fb/downloads` brought in
**77bd17ef** (fix round 3f: ca88b62e N7-01, 6ed69002 N7-02, 4c149297 journal; plus client merges). Verifier merge
**4ec6e8c5**. Engine diff since round 7: 5 files, +493/−46. Device claims in `DL-N.md` § "Fix round 3f" are the
builder's evidence, not repeated here.

Not done: product edits, push, devices, emulators, simulators, Argent, prebuild, app builds, writes to other
worktrees. Gradle home `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`, Node 24.14.0, Java 17, Swift via
`source docs/client/env.sh`, Range server on **127.0.0.1:39321** only (stopped afterwards).

## Commands and results

`V` = `tools/dl-verify-native`, `M` = `client/modules/offline-downloads`, `A` = `M/android/src/main/java/expo/modules/offlinedownloads`,
`I` = `M/ios/OfflineDownloadEngine.swift`. `DL_VERIFY_ROUND=8 bash V/run-round3.sh all` and `… jest-full` run every
suite (logs in the ignored `V/logs/round8/`); `python3 V/guards8.py` runs the removed-guard variants;
`python3 V/collect-round8.py` asserts every count below and writes
[results8.json](../../../tools/dl-verify-native/results8.json) and [evidence8.txt](../../../tools/dl-verify-native/evidence8.txt).

| Command | Result |
|---|---|
| `git merge fb/downloads` | 77bd17ef → verifier merge 4ec6e8c5. |
| Gradle `-p V/jvm cleanTest test` (verifier) | Exit 0, **80/80**: earlier rounds 75 (the former `REPRO_N7_*` now asserts the 3f outcome) + **Round8 5**. |
| Gradle `-p M/test-harness/jvm cleanTest test` (builder) | Exit 0, **101/101**: EngineTest 62, TransferTest 25, HttpPolicyTest 9, RedactionFuzzTest 3, ClockTest 2. |
| `swiftc … HttpPolicyCheck.swift` + corpus | Exit 0, **773/773**. |
| Builder generator + `swiftc` + engine host | Exit 0, **93/93**. |
| `V/swift/make-host-check.py` + `swiftc` + engine host (verifier) | Exit 0: 23/23 baseline; rounds 3–7 **8/8, 18/18, 7/7, 11/11, 9/9** (the former N7 repro is now an outcome); round 8 **2/2** + **4** N8 repros observed. |
| `node M/test-harness/js-check.cjs` / `node V/js-check.cjs` | Exit 0, **11/11** / **11/11**. |
| `npm run typecheck` / `CI=1 npm run lint` | Exit 0 / exit 0. |
| `npx jest src/downloads/engine src/api/__tests__/errors.test.ts` | Exit 0, **6 suites, 198/198**; engine suites alone **5, 169/169**. |
| `npx jest` (whole client) | Exit 0, **297/297 suites, 3,074/3,074** (matches the builder's integration count). |
| `python3 V/guards8.py` | 4 iOS variants × (my round-8 checks + builder's 93 checks); see "Removed guards". |

One harness fix of my own: round-6 `aDrainingWorkerOnTheReturnedCardHoldsTheTrimBack` swapped its fixture after the
worker ended, and the engine's own pump could start the next attempt first. The fixture is now swapped before the gate
opens. The engine was not at fault.

## Status of every finding

| ID | Status | Evidence |
|---|---|---|
| N1-01 … N1-17, N2-01 … N2-12, N3-01 … N3-11, N4-01 … N4-03, N5-01 … N5-03, N6-01 … N6-04, D-01 … D-03 | fixed | Former repros pass as outcomes on the merged code; corpus 773/773; full client 3,074/3,074. |
| N7-01 Own Range continuation unprotected (iOS) | **fixed** | Former repro now: an in-task 206 at K + report continues it, `restarts` 0. Round-7 checks 1–6 still pass (N6-04 unchanged). Own round 8: a continuation cycled and finishing inside the window publishes exactly the server's bytes, the late blob starts nothing, assertions balanced; a 200 with another ETag drops kept bytes and tail. |
| N7-02 Disposal leaves its directory (Android) | **fixed** | Former repro now: the ancestor download publishes. Own round 8: directory paths refused before any request; shared folders kept while any task lies in them; card disposals prune only their own volume; a symlink to outside the root is never followed; a 360-op churn over nested folders loses no worker folder. |
| N8-01 … N8-03 | **open** | New, below. |

## Removed guards: were they redundant?

| Guard removed in 3f | Verdict | Evidence |
|---|---|---|
| iOS: tail-snapshot reset after assembly | **not redundant** | Re-added in a scratch copy: N8-01 is not observed in either chain. As merged: observed in both. The builder's suite passes 93/93 either way, so its mutation could not be caught. |
| iOS: tail-snapshot reset at load | **not redundant, not sufficient** | Re-added (drop a tail without kept bytes): blocks only the relaunch chain; the same-process chain still corrupts. |
| iOS: extra ETag check in the snapshot | redundant | An own continuation's response is validated against the kept ETag; a 206 with another ETag is invalid (round-7 check 3), and a 200 clears kept bytes and tail (round-8 check 3). |
| Android: "directory empty" check | redundant | `File.delete()` refuses a non-empty directory; shared folders survive (round-8 test 1). |
| Android: "below root" check | redundant | `claimKey` refuses the root, `..` and anything above it; the root survives, and a symlink out of the root is never followed (round-8 tests 1, 3). |

The `folding.remove` cleanup in `forget()`: a cancel unlinks the kept files while the off-queue append writes to the
old inode, and `finishFold` returns early once the entry is gone. A second fold of a new record with the same id inside
the first fold's window would need a whole new own continuation in that window. Not reachable; code reading only.

## Hunt (round-8 probes)

- **Snapshot append (fold):**
  - An ETag change between the cycle and the fallback: the cycle clones only a blob with the kept ETag; a 200 or a 206
    with another ETag drops kept bytes and tail.
  - A snapshot from a previous continuation: in the normal flow every fallback folds its tail before the next request,
    so a tail never meets other kept bytes. The exception is **N8-01**.
  - A crash during the append: **N8-02**.
  - The append racing a new start, cancel or remove: the handles are opened on the queue, a cancel unlinks the files,
    and a new record never sees the old bytes (code reading).
- **Cycle limits:** a cycle runs once per generation (`!fromResumeData`; the resumed task is from resume data). Each
  later own continuation is a new generation with one cycle; failures stay capped at two per task. A continuation that
  finishes inside the window is published normally (round-8 check 4).
- **Pruning:** as in the status table. Core writes only artwork, into `<download folder>/art/` with intermediates
  created first, and pruning only walks upward from a deleted partial, so it never races core.

## New findings

| ID | Severity / platform | Evidence | Expected vs actual, suggested fix |
|---|---|---|---|
| N8-01 | **major / iOS** (silent corruption, rare trigger) | `I:1939` (`cloneKept` sets new `keptBytes`, leaves `keptTailBytes` and `kept/<id>.snap`); `I:2115-2118` (`finishAssembly` clears `keptBytes`, not the tail); `I:1839` (`tailSnapshot` only checks that *some* kept bytes are valid); `I:1052` (`begin` folds it). Swift round 8 check 1, both chains: "fresh GET kept 1500, stale tail valid true; fallback bytes 2000; fold kept 2000 (tail from offset 1000), next request bytes=2000-; final state completed, published 4000 bytes, wrong bytes at 1500..<2000: true". `guards8.py`: the removed reset (or the fix) stops it; the builder's suite passes 93/93 in all four variants. | **Expected:** a tail snapshot only ever follows the kept bytes it was taken after. **Actual:** an own continuation (after a renewal) takes a tail snapshot and finishes, but its final move fails (`I:2137-2142`: a full volume → `disk_full`, or anything blocking the path). That leaves `keptTailBytes` behind, in memory and across a relaunch. A retry runs a fresh GET from 0. Its first snapshot sets new `keptBytes`, which makes the old tail "valid". A later in-task 4xx (410 expiry, a revoke) falls back to kept + tail. The renewed URL then folds the old tail after the new bytes, continues at `bytes=R+T-`, and publishes a **completed** file that has the right size and ETag but holds bytes from the old offset. **Fix:** in `cloneKept`, set `keptTailBytes = nil` and delete `.snap` (new kept bytes always replace the prefix, so no tail can follow them). Checked in a scratch copy: corruption gone in both chains, builder 93/93. Optional: keep the assembled file as `staged` when the final move fails, so a retry publishes it instead of fetching everything again. |
| N8-02 | **minor / iOS** (cost only) | `I:2033` (`foldTail` appends the tail to `kept/<id>` in place, off the queue); `I:1643` (`load` drops kept bytes whose file length ≠ `keptBytes`). Swift round 8 check 2: "crash in the fold (200 of 500 tail bytes appended): keptBytes nil, keptTailBytes nil, snapshot file left false"; the same with all 500 appended but not yet persisted. | **Expected:** a crash or jetsam during a fold costs at most the fold. **Actual:** the relaunch drops all kept bytes and the snapshot (up to GBs), even though an in-place append never touches the first `keptBytes` bytes. The Range assembly appends in place the same way (pre-existing). **Fix:** at load, a kept file *longer* than `keptBytes` is truncated back to `keptBytes` instead of dropped. The snapshot then folds again. |
| N8-03 | **nit / iOS** (parity with N7-02) | `I:857` (`move` replaces an existing target with `replaceItemAt`); `I:529` (`start` has no directory check). Host run of the same call: "directory with content=true: replaceItemAt succeeded; target is now a file; inside.txt exists=false". Core: `safeFileName("art")` stays `art`, so a media file named `art` (any case on APFS) targets `<folder>/art`, the artwork folder. | **Expected** (Android since 3f): a path that is an existing directory is refused before any request. **Actual (iOS):** the download runs, and the publish replaces the directory and deletes its contents (the posters). Needs a server file literally named `art`. **Fix:** refuse a directory path in iOS `start` and in `move()`, as Android does; or core names the artwork folder `.art` (`safeFileName` strips leading dots, so no media name can collide). |

## Needs a device

1. **N8-01:**
   - A final move that fails with `disk_full` on a nearly full iPhone after a renewed continuation.
   - Then retry, a capability expiry and a renew. Compare the result's sha256.
2. **N8-02:** jetsam during a large fold (the app in the background right after a relaunch).
3. Unchanged from earlier rounds: power loss on vfat, iOS sleep, the Android 14 deferred mount broadcast with a
   user-initiated start, and nsurlsessiond's own URL logging.

## Confirmed by repro vs code reading

- **Repro (host):**
  - N8-01 (two chains, plus four guard variants against both harnesses), N8-02 and N8-03 (`replaceItemAt` behaviour).
  - Every ported N7 outcome, round-8 checks 3–4 and JVM tests 1–5.
- **Code reading only:**
  - The fold racing a cancel or new start, the cycle limits, and the inside-root symlink alias (needs an app-created
    symlink).
  - Real-device triggers for N8-01/N8-02, and everything under "Needs a device".

## Final verdict for the DL-N engine lane

Eight rounds, 55 numbered findings: N1-01…N1-17, N2-01…N2-12, N3-01…N3-11, N4-01…N4-03, N5-01…N5-03, N6-01…N6-04, N7-01…N7-02,
N8-01…N8-03, plus the builder's device findings D-01…D-03. All are fixed except N8-01…N8-03. Every fix since round 3
has been mutation-checked, the former repros run as outcomes in the harness, and the full client suite is green.
**Pass with findings: merge-ready once N8-01's two-line fix lands.** N8-02 and N8-03 can follow the merge.

## Harness changes (round 8)

- `jvm/src/test/kotlin/Round8AdversarialTest.kt` (5 tests); `Round7AdversarialTest` N7-02 repro now asserts the 3f
  outcome; round-6 fixture-swap race fixed.
- `swift/Round8Check.swift` (2 outcomes + 4 repros); `Round7Check.swift` N7-01 repro now an outcome; generator
  includes round 8; `DL_VERIFY_KEEP_GOING=1` for variant runs.
- `guards8.py`, `collect-round8.py`, `results8.json`, `evidence8.txt`.
