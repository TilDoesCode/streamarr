# DL-N independent verification 9 (last engine check before the main merge)

**Round verdict: pass with findings (nits only). Final verdict for the DL-N engine lane: pass with findings —
merge-ready.** N8-01, N8-02 and N8-03 are fixed, and my round-8 repros now assert the 3g outcomes. All the builder's
claims about the five N8-01 guards hold when checked independently. I could not break the binding, the cut-back or the
directory rule. **New findings: 0 blockers, 0 majors, 0 minors, 2 nits.** Neither nit can publish wrong bytes. Both can
follow the merge.

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. `git merge fb/downloads` brought in **4f0ea1c1**
(fix round 3g: 21328fcc N8-01/N8-02, 31409153 N8-03, e33c2b20 with core bfd6f240, journal 1de432de + a56ba9a8) and
one docs-only commit on top (cb6423e9, `DL.md` +8). Verifier merge **c6dbde1c**. Engine diff since round 8: iOS engine
+122/−30, README, builder Swift checks (+404). Android and TS engine sources are unchanged. Device claims in `DL-N.md`
§ "Fix round 3g" are the builder's evidence, not repeated here.

Not done: product edits, push, devices, emulators, simulators, Argent, prebuild, app builds, and writes to other
worktrees. Gradle home `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`, Node 24.14.0, Java 17, Swift via
`source docs/client/env.sh`, Range server on **127.0.0.1:39321** only (stopped afterwards).

## Commands and results

`V` = `tools/dl-verify-native`, `M` = `client/modules/offline-downloads`, `A` = `M/android/src/main/java/expo/modules/offlinedownloads`,
`I` = `M/ios/OfflineDownloadEngine.swift`.
- `DL_VERIFY_ROUND=9 bash V/run-round3.sh all` and `… jest-full` run every suite (logs in the ignored `V/logs/round9/`).
- `python3 V/guards9.py` runs the twelve guard variants.
- `python3 V/collect-round9.py` asserts every count below and writes [results9.json](../../../tools/dl-verify-native/results9.json)
  and [evidence9.txt](../../../tools/dl-verify-native/evidence9.txt).

| Command | Result |
|---|---|
| `git merge fb/downloads` | 4f0ea1c1 (+ cb6423e9 docs) → verifier merge c6dbde1c. |
| Gradle `-p V/jvm cleanTest test` (verifier) | Exit 0, **82/82**: earlier rounds 80 + **Round9 2**. |
| Gradle `-p M/test-harness/jvm cleanTest test` (builder) | Exit 0, **101/101**: EngineTest 62, TransferTest 25, HttpPolicyTest 9, RedactionFuzzTest 3, ClockTest 2. |
| `swiftc … HttpPolicyCheck.swift` + corpus | Exit 0, **773/773**. |
| Builder generator + `swiftc` + engine host | Exit 0, **117/117** (matches the builder). |
| `V/swift/make-host-check.py` + `swiftc` + engine host (verifier) | Exit 0: baseline 23/23; rounds 3–7 **8/8, 18/18, 7/7, 11/11, 9/9**; round 8 **10/10** (former N8 repros now outcomes); round 9 **11/11** + **1** N9 repro observed. |
| `node M/test-harness/js-check.cjs` / `node V/js-check.cjs` | Exit 0, **11/11** / **11/11**. |
| `npm run typecheck` / `CI=1 npm run lint` | Exit 0 / exit 0. |
| `npx jest src/downloads/engine src/api/__tests__/errors.test.ts` | Exit 0, **6 suites, 198/198**; engine suites alone **5, 169/169**. |
| `npx jest` (whole client) | Exit 0, **297/297 suites, 3,081/3,081** (matches the builder). |
| `python3 V/guards9.py` | 12 iOS variants × (my checks + the builder's 117), keep-going; see "The five N8-01 guards". |

## Status of every finding

| ID | Status | Evidence |
|---|---|---|
| N1-01 … N1-17, N2-01 … N2-12, N3-01 … N3-11, N4-01 … N4-03, N5-01 … N5-03, N6-01 … N6-04, N7-01, N7-02, D-01 … D-03 | fixed | Every former repro passes as an outcome on the merged code; corpus 773/773; full client 3,081/3,081. |
| N8-01 Stale tail snapshot folded after a later fresh GET (iOS) | **fixed** | The former repro passes as an outcome in both chains (same process, relaunch): published exactly the server's bytes, next request `bytes=1500-`. The same holds for the accidental-match attempt below (fresh GET keeps 1,000 bytes with the same ETag). Guard analysis below. |
| N8-02 Crash during a fold drops all kept bytes (iOS) | **fixed** | Former repro, 200 and 500 of 500 appended: a bound 3g record keeps 1,000 + its 500 tail, and the redone fold gives exactly bytes 0..<1500 with `bytes=1500-`. A 3f record keeps 1,000 and drops the unbound tail. A failed Range-continuation append is cut back to exactly the kept bytes. |
| N8-03 Directory at the target replaced at publish (iOS) | **fixed** | `start` refuses a directory path or `.part` (`invalid_state`, nothing registered). `move` onto a non-empty directory is refused and its contents survive. `move` onto a file still replaces it. Residual: N9-01. |
| N9-01, N9-02 | **open** (nits) | New, below. |

## The five N8-01 guards (`guards9.py`)

Four N8-01 chains per variant: same process / relaunch × fresh GET keeping 1,500 or 1,000 bytes.

| Variant | N8-01 chains correct | Builder checks failing | Builder's claim |
|---|---|---|---|
| control | 4/4 | 0 | — |
| binding removed alone (`I:1881-1884`, `tailSnapshot`) | 4/4 | 6 | caught ✔ |
| clone reset removed alone (`cloneKept` prelude) | 4/4 | 2 | caught ✔ |
| assembly reset removed alone (`finishAssembly` `dropTail`) | 4/4 | 3 | caught ✔ |
| load prune removed alone (`I:1674`) | 4/4 | 3 | caught ✔ |
| request-start prune removed alone (`I:1074-1077`) | 4/4 | 4 | caught ✔ |
| binding kept alone | **4/4** | 12 | "keeps both chains" ✔ |
| clone reset kept alone | **4/4** | 10 | ✔ |
| assembly reset kept alone | **4/4** | 9 | ✔ |
| request-start prune kept alone | **4/4** | 12 | ✔ |
| load prune kept alone | **2/4** (both relaunch chains correct, both same-process chains corrupted) | 12 | "relaunch chain only" ✔ |
| all five removed | **0/4** (corruption in every chain) | 14 | "corruption reappears" ✔ |

Each guard is redundant for my chains but caught on its own by the builder's suite. My own checks catch two of the
removals by themselves: binding (3 failing checks) and load prune (4). The 3g fold order (the new length persisted before
the snapshot is deleted), which the builder argued from code only, is now checked too: a crash between the two leaves
kept 1,500 bytes and an orphan `.snap`, which the next load removes; nothing folds twice.

## Hunt

- **Binding (accidental match):**
  - Generations are never recycled. After a relaunch with a stored generation clock of 0, the next generation is above
    the bound one, because `load()` also takes the records' maximum. With a record a billion generations ahead, the next
    is that + 1. A wall-clock rollback cannot lower it, since the clock is the maximum of the persisted value and
    `now × 1000`.
  - A tail whose base no longer matches the record is dropped at load while the kept bytes stay. Covered cases: the
    generation cleared (a fresh GET), the generation moved on, another ETag, another length. A bound tail survives a
    relaunch (control).
  - Same kept length and ETag after a restart from 0: the fresh GET clears `rangeGeneration`, and `cloneKept` drops
    the tail before cloning. Both chains with 1,000 bytes are correct.
  - Code reading: the only rebind is `begin(ownBlob:)` moving the base to the resumed task's generation. That task
    continues the same OS file after the same kept bytes, which is legitimate.
  - An ETag equal but body changed is out of model, as decided.
- **N8-02 cut-back:**
  - A kept file shorter than recorded is dropped with its tail; so is a record whose file is missing.
  - A kept file the record doesn't name, and a `.snap` without tail fields, are never adopted (the `.snap` is deleted).
  - A crash between the cut and its persist is idempotent: the second load gives the same record and bytes.
  - A failed append is cut back to exactly the kept bytes.
  - Code reading: `cloneKept` clears and persists kept bytes of another ETag *before* the new clone replaces the file.
    A cut therefore only ever trusts a prefix of the same entity.
- **`move` vs `types.ts`:**
  - Core never calls `engine.move`; only the engine's own tests do. No production path relies on "replaces the target".
  - The platforms do differ on a directory target, and the builder's journal note about Android is wrong: N9-02.

## New findings

| ID | Severity / platform | Evidence | Expected vs actual, suggested fix |
|---|---|---|---|
| N9-01 | **nit / iOS** | `I:1527-1536` (`publishStaged` catch: `bytesWritten = 0`, `retryable: true`, `error.localizedDescription`) vs the direct publish `I:1497-1504` (non-retryable, `EngineError.message`). Swift round 9 repro: "state retrying, error staged file: The operation couldn't be completed. (main.EngineError error 1.), bytes 0, restarts 0, staged file left true". Code from round 1 (5dc806ba); a directory at the target only became a defined error with 3g. | **Expected:** a file that finished during a pause and can't be published follows the same rule as a direct publish. That means `failed`, a readable `invalid_state` message, and either the staged file kept for a later retry or its loss counted as one restart (D-02). **Actual:** if a directory appears at the target after `start` (which refuses one), the task goes `retrying`. Its 8 bytes are zeroed without a restart, and the staged file stays until cancel/remove. The whole file is fetched again only to fail at the direct publish. Reachable only through something creating that directory later (core's reserved `art` names prevent the known case). **Fix:** in the catch, use `(error as? EngineError)?.message`, keep `staged` (or delete the file and go through `dropBytes`), and make an `invalid_state` failure non-retryable. |
| N9-02 | **nit / contract (all)** | `client/src/downloads/engine/types.ts:207` ("replaces the target"); `I:874` (directory → `invalid_state`); `A/Storage.kt:85-99` (the module's own `Files.move`: `renameTo`, then delete-and-rename a file target); `A/DownloadEngine.kt:388-394`. JVM `Round9AdversarialTest`: a file target is replaced; a file onto a non-empty directory → `io` (contents kept); a directory onto an empty directory → moved. The builder's note `DL-N.md:1207` says Android uses `Files.move` without `REPLACE_EXISTING` and refuses any existing target. | **Expected:** one documented rule. **Actual:** every engine replaces an existing *file* (types.ts holds there). For a directory target, iOS refuses with `invalid_state`, while Android fails with `io` or replaces an empty directory; the fake has no directories. The journal note is wrong on both counts: the `Files` there is the module's object, not `java.nio`, and it replaces a file. No core code calls `move`. **Fix:** correct the note. State in `types.ts` "replaces a file; a directory target is refused with `invalid_state`", and make Android refuse a directory target the same way. |

## Needs a device

1. N8-01/N8-02 real triggers (disk full at the final move, jetsam during a large fold): the builder's device runs cover
   the 3f/3g scenarios; the crash-mid-append path stays host-only, as decided.
2. N9-01: a pause that finishes the file, then a directory created at the target before resume.
3. Unchanged from earlier rounds: power loss on vfat, iOS sleep, the Android 14 deferred mount broadcast with a
   user-initiated start, and nsurlsessiond's own URL logging.

## Confirmed by repro vs code reading

- **Repro (host):**
  - Every N8 outcome (4 chains, 4 fold-crash cases) and round-9 checks 1–7.
  - N9-01 (Swift) and N9-02 (JVM).
  - The 12 guard variants.
- **Code reading only:**
  - The `ownBlob` rebind, and `cloneKept`'s persist-before-replace order.
  - The wall-clock part of the generation argument.
  - Core's non-use of `move`, and N9-01's trigger in practice.
  - Everything under "Needs a device".

## Final verdict for the DL-N engine lane

Nine rounds, 57 numbered findings: N1-01…N1-17, N2-01…N2-12, N3-01…N3-11, N4-01…N4-03, N5-01…N5-03, N6-01…N6-04,
N7-01…N7-02, N8-01…N8-03, N9-01…N9-02, plus the builder's device findings D-01…D-03. All are fixed except the two N9
nits. Every fix since round 3 has been mutation- or variant-checked. The former repros run as outcomes in the harness,
and the full client suite is green. **Pass with findings (nits only): the engine is merge-ready.** N9-01 and N9-02 can
follow the merge.

## Harness changes (round 9)

- `swift/Round9Check.swift` (11 outcomes + 1 repro). `Round8Check.swift`: the N8 repros now assert the 3g outcomes, plus
  the same-length chains and the bound fold-crash cases. The generator includes round 9.
- `jvm/src/test/kotlin/Round9AdversarialTest.kt` (2 tests).
- `guards9.py` (12 variants, keep-going for both harnesses), `collect-round9.py`, `results9.json`, `evidence9.txt`.
