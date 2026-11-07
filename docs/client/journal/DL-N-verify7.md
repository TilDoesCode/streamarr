# DL-N independent verification 7 (final engine check before the main merge)

**Round verdict: pass with findings. Final verdict for the DL-N engine lane: pass with findings — fit for the main
merge from the engine side.** N6-01, N6-02, N6-03 and the builder's N6-04 are fixed: my round-6 repros now assert the 3e
outcomes, and all 8 round-7 guard mutants are caught by the builder's own suite (including the generation guard I
promoted in round 6). I could not make N6-04 accept wrong bytes from a conforming server. **New findings: 0 blockers,
0 majors, 1 minor, 1 nit.** Both cost bytes or a failed edge-case download; neither lets wrong bytes be published.

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. `git merge fb/downloads` brought in
**e73d6c48** (fix round 3e: cedc06e2 N6-01..03 + promoted generation guard, f60e3bc0 N6-04, eccbfc04 journal; plus
client merges). Verifier merge **80cb7eea**. Engine diff since round 6: 6 files, +198/−13. Device claims in `DL-N.md`
§ "Fix round 3e" are the builder's evidence, not repeated here.

Not done: product edits, push, devices, emulators, simulators, Argent, prebuild, app builds, writes to other
worktrees. Gradle home `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`, Node 24.14.0, Java 17, Swift via
`source docs/client/env.sh`, Range server on **127.0.0.1:39321** only (stopped afterwards).

## Commands and results

`V` = `tools/dl-verify-native`, `M` = `client/modules/offline-downloads`, `A` = `M/android/src/main/java/expo/modules/offlinedownloads`,
`I` = `M/ios`. `DL_VERIFY_ROUND=7 bash V/run-round3.sh all` and `… jest-full` run every suite (logs in the ignored
`V/logs/round7/`); `python3 V/collect-round7.py` asserts every count below and writes
[results7.json](../../../tools/dl-verify-native/results7.json) and [evidence7.txt](../../../tools/dl-verify-native/evidence7.txt).

| Command | Result |
|---|---|
| `git merge fb/downloads` | e73d6c48 → verifier merge 80cb7eea. |
| Gradle `-p V/jvm cleanTest test` (verifier) | Exit 0, **75/75**: Transfer 20, RedirectBoundary 4, module HttpPolicy 9, Round2 8, Round3 11, Round4 8, Round5 7, Round6 4 (the former `REPRO_N6_*` now asserts the 3e outcome), **Round7 4** (1 `REPRO_N7_*` observed + 3 acceptance). |
| Gradle `-p M/test-harness/jvm cleanTest test` (builder) | Exit 0, **98/98**: EngineTest 59, TransferTest 25, HttpPolicyTest 9, RedactionFuzzTest 3, ClockTest 2; zero skipped. |
| `swiftc … I/HttpPolicy.swift I/Tests/HttpPolicyCheck.swift` + corpus | Exit 0, **773/773**. |
| Builder generator + `swiftc` + engine host | Exit 0, **87/87**. |
| `V/swift/make-host-check.py` + `swiftc` + engine host (verifier) | Exit 0: **23/23** baseline, round 3 **8/8**, round 4 **18/18**, round 5 **7/7**, round 6 **11/11** (both former N6 repros are now outcomes), round 7 **8/8** + **1/1** N7 repro. |
| `node M/test-harness/js-check.cjs` / `node V/js-check.cjs` | Exit 0, **11/11** / **11/11**. |
| `npm run typecheck` / `CI=1 npm run lint` | Exit 0 / exit 0. |
| `npx jest src/downloads/engine src/api/__tests__/errors.test.ts --runInBand --forceExit` | Exit 0, **6 suites, 198/198**; engine suites alone **5, 169/169**. |
| `npx jest --runInBand --forceExit` (whole client) | Exit 0, **296/296 suites, 3,002/3,002 tests** (the builder's 2,998 predates the later client merges). |
| `python3 V/mutants.py --round 7` | 8 mutants of the 3e guards against the builder's harness: **8 caught**; 4/4 controls pass. |

### "Fails before the fix": 3e guards reverted one at a time (scratch copies, builder's harness)

| Mutant | Builder test | Result |
|---|---|---|
| N6-03: no `processDisposals()` in `start` (`A/DownloadEngine.kt:204`) | `aNewDownloadNeverInheritsAQueuedPartial` | fails; control passes |
| N6-03: `countRestart` ignores `ownBytes` | `aStrayPartANewTaskTruncatesIsNoRestart` | fails; control passes |
| N6-03: `ownBytes` never set (stays `true`) | same | fails; control passes |
| N6-01: the report is not carried into the finish validation (`I/OfflineDownloadEngine.swift`, `didFinishDownloadingTo`) | Swift "a file finishing before any report of its in-task 206 …" | fails |
| N6-02: the cycle accepts a 200 only again | Swift "a fresh GET continued in-task (D-03) is still cycled past 256 KiB …" | fails |
| N6-04: the stale visible Range decides again | Swift "a task from resume data keeps its blob's stale Range …" | fails |
| N6-04: the report decides even when the visible Range is ahead | same | fails |
| D-03: a report of another generation accepted (promoted from verify 6) | same | fails (was not caught in round 6) |

## Status of every finding

"Fixed" is bounded by host evidence and code reading; device behaviour is the builder's evidence.

| ID | Status | Evidence / remaining scope |
|---|---|---|
| N1-01 … N1-17 | fixed | Original `BUG_*` cases and the live child-JVM kill pass; corpus 773/773, RedirectBoundary 4/4. N1-06 (response checks) holds against every N6-04 attempt below. N1-15 unchanged since round 6. |
| N2-01 … N2-12 | fixed | Former repros pass as outcomes. N2-10: full client 3,002/3,002. |
| N3-01 … N3-11 | fixed | Former repros pass as outcomes. |
| N4-01 … N4-03 | fixed | Former repros pass; Kotlin = Swift on 3,000 redaction fuzz cases, 0 leaks. |
| N5-01 … N5-03 | fixed | Former repros pass as outcomes (`bytes=4-`, one restart for a vanished part, assertions balanced). |
| N6-01 Proof cleared before the finish | **fixed** | Former repro now: a file finishing before any report of its in-task 206 publishes, `restarts` 0, proof line logged. Own round 7 check 4 combines it with N6-04 (resumed task, stale Range, finish right after the cut): published. Mutation caught. |
| N6-02 No cycle after a D-03 continuation | **fixed** | Former repro now: the download is cycled past 256 KiB after a proven in-task 206. Builder: a 200 without `Accept-Ranges` still never cycles. Mutation caught. |
| N6-03 Inherited partial counted as a restart | **fixed** | Former repro now: `restarts` 0, no disposal left, file is the new download's. Own round 7: another volume, a missing card and a descendant path all behave; the ancestor path hits N7-02 (pre-existing directory issue). Mutations ×3 caught. |
| N6-04 (builder device finding) | **fixed** | Hunted below: refused or caught in every case with a conforming server. Mutations ×2 caught. |
| D-01, D-02, D-03 (builder device findings) | fixed | Unchanged in 3e; round-5 and round-6 checks pass. |
| N7-01, N7-02 | **open** | New, below. |

## N6-04 hunt (it widens what the engine trusts)

Labels refer to `V/swift/Round7Check.swift` checks 1–6. A resumed task's fixture carries kept bytes equal to its blob's
offset, as `begin()` clones them (`keepFromResumeData`).

- **A visible Range ≤ report that is not stale.** On a resumed task the visible Range can be genuine only if the OS
  re-sends that very request in-task.
  - Check 5a: the visible Range belongs to an older blob (the builder's device case: `bytes=262144-` after a later
    resume elsewhere). A 206 there is refused as *unverifiable*: the kept bytes stay, no restart. This is decision A,
    and it costs only the OS file.
  - Check 5b: the visible Range equals the task's own first 206. A repeat of that answer has the same response key
    (status, Content-Range, ETag), so the engine sees no switch at all. It runs on and follows the OS counter (1 MiB +
    64 KiB). With a conforming server this is right: the OS rewound and its file matches. This behaviour predates N6-04.
- **The engine's own Range continuation after a truncate.** N6-04 cannot reach it (`reported` is nil for `ownRange`,
  `I/OfflineDownloadEngine.swift:1232`). Its relative report never proves a 206, and its visible Range still does
  (check 6). The cost side of this exclusion is **N7-01**.
- **A second resume from a smaller blob after a pause** (check 1). The first task reported 3 MiB; the second resumed
  at 2.5 MiB and reported 2.75 MiB. A 206 at the old 3 MiB is refused; one at 2.75 MiB continues with no restart. A
  report never crosses generations, because `begin()` clears it and the proof needs the task identifier and generation.
- **A report from before a pause vs. a later blob:** the pause's completion clears the report (round-6 check 7, still
  passing), and the later blob's task reports afresh.
- **Two consecutive resumes from different blobs** (check 2): in the second, a 206 at the first blob's start is refused.
- **A 206 at the report with another strong ETag** (check 3): *invalid* (the builder's documented deviation). The task
  stops, nothing is kept, and it counts exactly one restart.
- **What still guards a non-conforming server.** Suppose the OS re-sends the visible `bytes=R-` and the server answers
  a 206 that starts at the report Y instead. N6-04 accepts it, and the OS file is misaligned. The final size check
  catches that file at finish (`R + (total − Y) ≠ total`). Snapshots taken from it in the meantime are not checked.
  This needs a server that violates the request's Range, so it is outside the decided trust model (same strong ETag
  plus a valid Content-Range). Code reading only.

## N6-03 hunt (disposals before the first attempt)

`V/jvm/.../Round7AdversarialTest.kt`. Each case starts from a card task cancelled while the card was out, with the card
back but not yet pumped.

- **Another volume:** a new download on the card's `m.bin` deletes only the card's queued partial. A paused internal
  task on the same relative path keeps its partial (`KEEP`). `restarts` 0, no disposal left.
- **The card missing again:** a new internal download completes, and the card's disposal stays queued with its partial.
- **Descendant:** the old partial is a *file* `show.part`, and the new download is `show.part/x.bin`. The disposal
  removes the file before the first attempt, so the directory can be created and the download completes. Without
  N6-03 that `mkdirs` would fail.
- **Ancestor:** the old partial is `show/m.bin.part`, and the new download is `show`. The partial goes, but its empty
  directory stays, so the download fails at publish → **N7-02**.

## New findings

| ID | Severity / platform | Evidence | Expected vs actual | Suggested fix |
|---|---|---|---|---|
| N7-01 | **minor / ios** | `I/OfflineDownloadEngine.swift:1232` (`reported` is nil for `ownRange`), `:1906` (no snapshots while `rangeGeneration == generation`), `:1681` (no identity cycle), `:1083-1084` (Range continuation). Swift round 7 "PASS REPRO N7 an in-task 206 at the end of the engine's own Range continuation is refused …", with a passing control. | **Expected:** D-03/N6-04 keep a plain connection reset from costing the bytes received so far, and the device evidence says the request keeps its original Range during in-task retries. That premise holds for the engine's own `Range: bytes=K-` request too. **Actual:** an own Range continuation (after a URL renewal, an in-task 4xx or sign-out with kept bytes) that the OS continues in-task at its end is refused as unverifiable. Repro: 1 MiB kept, 3 MiB reached, the in-task 206 at 3 MiB is refused, and the task falls back to 1 MiB (`retrying`, `restarts` 0). A resumed task with the same numbers continues. The README documents that a pause or failure during a continuation keeps only the kept bytes; a mere reset now has the same cost, which D-03 removed everywhere else. In Streamarr, every download renewed after a `410 download_expired` runs its remainder this way. My round-6 report called this exclusion an "equivalent mutant" on the premise that the request "always carries its Range"; N6-04's evidence shows that premise is wrong. | Prove own continuations with `rangeOffset + report` (the same rule, shifted by the kept bytes). Optionally, append the remainder into the kept copy periodically so a pause or failure also keeps it. A device check should confirm the OS continues (rather than restarts) a Range request in-task. |
| N7-02 | **nit / android** | `A/DownloadEngine.kt:961` (a disposal deletes only the `.part`), `A/Storage.kt:91-99` (`Files.move` refuses a directory target), `:153` (publish failure → `file_system`). JVM `REPRO_N7_aDisposalLeavesItsDirectoryAndTheAncestorDownloadCannotPublish`. | **Expected:** a new download whose path is free can complete. **Actual:** after a disposal of `show/m.bin`, the empty directory `show/` stays. A new download at `show` is accepted, fetches the whole file, then fails with `file_system: io: rename show.part -> show failed`. As a failed task it now owns `show`, so `deletePath("show")` is refused until it is removed. The same happens with any leftover empty directory (this predates 3e; N6-03 only exposes it). Streamarr's own paths (`acc/work/Movie.mkv`) don't reuse a directory name as a file name, so the app does not reach this today. | In `start`, refuse a final path that is an existing directory (`invalid_state`) before downloading; or prune emptied parent directories after a disposal; or let `Files.move` replace an *empty* directory. |

## Final verdict for the DL-N engine lane

Over seven rounds the verifier raised N1 17, N2 12, N3 11, N4 3, N5 3, N6 3 and N7 2 findings. The builder added
device findings D-01, D-02, D-03 and N6-04. Everything is fixed except **N7-01 (minor, cost only)** and **N7-02 (nit,
an edge path the app does not use)**.

On the integrity side, the decided rules hold on both platforms in host repros and code reading:
- appends only with the same strong ETag and a valid Content-Range;
- path claims, including `.part`, case and dot/space aliases;
- draining workers own their paths;
- bounded `cancel` / `remove`, including tombstones;
- the elapsed clock and boot id;
- Retry-After bounds;
- 416 handling;
- redacted diagnostics;
- durable checkpoints and their adoption rules.

Rounds 3–7 reverted 34 guards from fix rounds 2 to 3e against the builder's suite (5 + 7 + 6 + 8 + 8): 32 were caught.
The 2 misses were both in round 6: one guard was then promoted and is caught now; the other was an equivalent mutant,
whose premise N7-01 now overturns.

**Recommendation:** merge the engine. Track N7-01 as a follow-up (it matters for long downloads that get renewed), and
N7-02 as a robustness nit.

## Harness changes (round 7)

- `Round6AdversarialTest` and `swift/Round6Check.swift`: the former N6 repros assert the 3e outcomes.
- New: `jvm/.../Round7AdversarialTest.kt` (4 tests), `swift/Round7Check.swift` (8 outcomes + 1 repro; a resumed-task
  fixture with stale or visible Ranges, kept bytes, and own Range continuations).
- `mutants.py --round 7`, `collect-round7.py`, `results7.json`, `evidence7.txt`.

## Needs a device

1. **N7-01:** a reset during a Range continuation (renew a capability, then drop the connection). Does the OS continue
   at its end (the engine refuses it, today's cost) or restart the request (the OS refetches)?
2. **N6-04 premise:** does the OS ever re-send a resumed task's visible Range in-task? Check 5a/5b behaviour is fine
   either way with a conforming server.
3. Unchanged from earlier rounds: power loss on vfat, iOS sleep, the Android 14 deferred mount broadcast with a
   user-initiated start, and nsurlsessiond's own URL logging.

## Confirmed by repro vs code reading

- **Repro (host):**
  - N7-01 (with a control) and N7-02.
  - Every ported N6 outcome, round-7 Swift checks 1–6 and JVM tests 1–3.
  - The 8 mutants.
- **Code reading only:**
  - The non-conforming-server chain (snapshot of a misaligned OS file).
  - The pause clearing the report (also covered by round-6 check 7).
  - App path shapes for N7-02.
  - Everything under "Needs a device".
