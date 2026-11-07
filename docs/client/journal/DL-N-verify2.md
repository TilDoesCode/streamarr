# DL-N independent verification 2

**Verdict: fail.** The original failure scenarios now have passing correct-outcome tests, but broader ownership and
callback checks still reproduce corruption and unsafe lifecycle behavior. **New findings: 2 blockers, 6 majors,
2 minors.** Nine N1 findings are fixed within the reviewed scope; eight are partial, listed below.

Verified 2026-11-07 in `dl-verify-native`, branch `fb/dl-verify-native`. Merged `fb/downloads` **97d36070** with the
round-1 verifier commit, producing verifier merge **5a9f95473011d61bf1cddb26085a8f14fb91147a**. Reviewed builder commits
220a0ded, 8aa2cfa6, 5dc806ba, 3035ccad, 5244b174, ae1e63f6, ce1f5b6d, 19854629, aa31636b, 153429ea, a36493d1 and
bec40ef2, and the mapping/device claims in DL-N.md “Fix round 1”. Device claims below are **builder evidence**, not
independently repeated. The announced round-1c notification-cancel tombstone is not in this baseline and is not a
condition for finishing this report.

No product edits, push, devices, Argent, prebuild, app build or other worktree writes. The builder's Gradle wrapper
was read only; all Gradle work used `/Volumes/DevSSD/Caches/Gradle-dl-verify-native`. Node **24.14.0**, Java 17,
Gradle 9.3.1, Swift host via `source docs/client/env.sh`. Range server bound to **127.0.0.1:39321** only.

## Commands and results

Runnable details: [verifier README](../../../tools/dl-verify-native/README.md). Counts and selected exact output:
[results2.json](../../../tools/dl-verify-native/results2.json), [evidence2.txt](../../../tools/dl-verify-native/evidence2.txt).
`V` below means `tools/dl-verify-native`; `M` means `client/modules/offline-downloads`; `A` means
`M/android/src/main/java/expo/modules/offlinedownloads`; `I` means `M/ios`; `T` means `client/src/downloads/engine`.

| Command (from worktree unless noted) | Result |
|---|---|
| `git merge fb/downloads` | Clean merge of 97d36070 into verifier branch. |
| `cd client && npm run typecheck` | Exit 0, zero TypeScript diagnostics. |
| `cd client && CI=1 npm run lint` | Exit 0, zero lint diagnostics. |
| `cd client && npx jest --runInBand` | **238 suites: 237 pass, 1 fails; 2,553 tests: 2,552 pass, 1 fails.** `src/api/__tests__/errors.test.ts` lacks 15 documented download error codes (N2-10). All tests finished in 113.822 s, but Jest retained handles; its own process was terminated after the summary. This is not reported as an exit-0 run. |
| `cd client && npx jest src/api/__tests__/errors.test.ts src/downloads/engine --runInBand --forceExit --json --outputFile=../tools/dl-verify-native/logs/round2/jest-focused.json` | Exit 1; **6 suites, 149 pass / 1 fail of 150 tests**. Same API-code failure. Engine portion alone: **5 suites, 121/121**. |
| `node V/range-fixtures.mjs --host 127.0.0.1 --port 39321` | Repository Range server plus verifier redirect/capture endpoints. Live cases run, no SKIP. |
| `GRADLE_USER_HOME=/Volumes/DevSSD/Caches/Gradle-dl-verify-native bash <builder-read-only>/client/android/gradlew -p V/jvm test --no-daemon --console=plain` | Exit 0, **38/38**: original verifier transfer/engine scenarios 20, module policy JUnit 6, new adversarial checks 8, redirect boundaries 4. Three live scenarios included (Range/hash, child process kill, cross-host redirect). New `REPRO` passes confirm defects; original `BUG_*` passes require correct outcomes. |
| Same Gradle invocation, `-p M/test-harness/jvm` | Exit 0, **45/45**: EngineTest 14, TransferTest 25, module HttpPolicyTest 6. Three live cases, zero skipped. |
| `xcrun swiftc -parse-as-library M/ios/HttpPolicy.swift M/ios/Tests/HttpPolicyCheck.swift -o V/.work/http-policy-v2` then `V/.work/http-policy-v2 M/test-vectors/http-policy.json` | Exit 0, **738/738** policy checks. |
| Builder Swift generator, `swiftc -swift-version 5 -parse-as-library …` and `DL_HARNESS_SWIFT_ROOT=<verifier scratch> <exe>` (commands in module harness README) | Exit 0, **19/19** promoted engine replays. |
| `python3 V/swift/make-host-check.py`, `swiftc -swift-version 5 -parse-as-library …`, `DL_VERIFY_SWIFT_ROOT=<verifier scratch> V/.work/engine-host-v2` | Exit 0, **24/24**: 19 baseline scenarios, four added in-queue repros, one deferred-callback repro off the queue. Stdout prints 23/23 for the queue phase and a separate PASS for the deferred phase. |
| `node M/test-harness/js-check.cjs` | Exit 0, **10/10**. |
| `node V/js-check.cjs` | Exit 0, **10/10**: nine original scenarios with correct outcomes, one new parser repro. |
| `python3 V/before-check.py`, then same Gradle invocation with `-p V/.work/before` | **Expected exit 1, 3/3 correct-outcome tests fail on a38c1ffe**, no compile errors or skips. Confirms “fails before” for N1-01 missing pinned ETag, N1-01 unknown total and N1-09 numeric overflow. Current equivalents pass. Old source obtained only through `git show`, inside verifier scratch. |
| `git diff a38c1ffe 97d36070 -- client/patches/expo-video+57.0.5.patch` | Exactly **3 additions / 3 deletions**: patch index, doc comment, `textStyleRules` assignment gains `?? []`. No other patch content changed. Runtime crash fix requires player/device confirmation; builder supplied simulator evidence. |

The first unchanged old JS characterization intentionally stopped on the newly corrected outcome, then its assertions
were inverted. Kotlin constructor/Outcome changes required an adapter and moving the old cancel/ownership/move
scenarios through `DownloadEngine`; all 20 original JVM scenarios are preserved. Swift now uses the promoted
TaskRef/generation fixture, which extends the original 14 replays to 19; new tests exercise uncovered branches.
A first N2 drain test expected overwrite at byte 4; actual `O_APPEND` behavior appended four bytes instead. The corrected
characterization proves a **12-byte** published file against an 8-byte completed record. Historical round-1 counts
remain in `results.json` / `evidence.txt`; round-2 counts are separate.

## N1 status (original scenarios plus broader audit)

“Fixed” is bounded by host evidence and code reading; it does not claim a new device pass. “Partial” means the original
repro is fixed but an uncovered case still violates the same area. No original correct-outcome test regressed.

| ID | Status | Evidence and remaining scope |
|---|---|---|
| N1-01 | fixed | All malformed Android 206 cases reject/drop; pinned mismatch gives `validator_changed`, unpinned invalid response is an ordinary retry from zero. Original and promoted suites pass; missing pinned ETag / unknown total fail before. iOS's remaining start-offset hole is tracked under N1-06 / N2-07. |
| N1-02 | fixed | Original child-JVM kill at the 200 restart callback now sees a zero-length synced part before the new validator is persisted; resumed file equals the entire new server version, SHA-256 `0144cd5da145873afac3597ef0ee2542f581854db736a8b9e6f030e4bd48f6bb`. Android truncation precedes `onResponse`. |
| N1-03 | partial | Exact canonical/case-insensitive duplicate paths reject. `.part` aliases still bypass claims (N2-01); failed-record removal releases a stopping worker's path (N2-02). |
| N1-04 | fixed | Every 416 fails and drops the partial. Full-length parts make a last-byte Range request; Publisher checks size/validator under the engine lock. Original and promoted tests pass. |
| N1-05 | partial | Session identifier + task identifier + generation fix the original stale delegate cases, including relaunched completion. Resume-data completion closures carry only the logical id (N2-03); not all asynchronous work has the generation guard. |
| N1-06 | partial | Pinned/missing validators, final-size checks and adoption validation pass. A numeric range with the wrong start is still accepted and published by the iOS engine boundary (N2-07). |
| N1-07 | partial | Last-byte cancellation and live move/delete reject correctly in both test sets. Android cancel can resolve without cleanup (N2-06); removal of a volume-failed record can expose a still-writing path (N2-02); stale iOS resume completion survives cancel/restart (N2-03). |
| N1-08 | partial | Floor 2 s, cap 1 h, eight ordinary attempts, 12 h server wait and network cooldown preservation pass in the corpus/native replays. Real time comes from wall clocks; rollback defeats the elapsed bounds (N2-04). |
| N1-09 | partial | Overflow / garbage date failures are fixed, including the fails-before spot check. All three parsers mistake long zero-padded small delta-seconds for huge values (N2-09). |
| N1-10 | fixed | Successful HEAD followed by GET 503 retains the resume blob; HEAD 416 drops it. Assertion-to-GET handoff exists; builder supplied background suspension evidence. Actual daemon retention/expiry remains a device matter. |
| N1-11 | fixed | All original fake defects now assert correct behavior; promoted conformance/engine Jest 121/121. Final ordering is completed then exactly one progress. Async native race coverage remains outside the fake's synchronous controls. |
| N1-12 | fixed | Both bridges/native APIs reject headers outside Accept-Language/User-Agent. Android manual redirects strip on scheme/host/port changes, retain default-port equivalents, and refuse downgrade; live dummy secret is absent at the target. iOS deliberately uses the allowlist because background redirects are OS-managed; downgrade behavior is a remaining device check below. |
| N1-13 | fixed | Exit-history recovery and host USER stop pause tasks and suppress reschedule in promoted tests. Pause/Cancel use explicit immutable intents to a nonexported receiver. Builder supplied Task Manager and notification evidence. Round-1c JS-off tombstones are outside this baseline. |
| N1-14 | partial | UUID identity and absence/return/replacement-volume checks pass. Existing `external-N` records are never migrated and cannot find the same mounted medium (N2-05). |
| N1-15 | fixed | `fd.sync` precedes durable checkpoint advancement, 200 truncation precedes metadata, and registry uses synced temp + rename + directory sync. Recovery truncates an uncheckpointed tail; shorter actual files clamp reported bytes. Host tests cover ordering/process death, not power loss or swallowed directory-sync failures. |
| N1-16 | partial | Space ledger/reserve and before/during-transfer checks added; baseline tests pass. iOS final-file callback discards a pending failure/requeue and can complete anyway (N2-08). |
| N1-17 | fixed | Original unknown-message case keeps `io: disk unavailable`; JS native-code fallback tests pass. Swift exception exposes code/reason; builder supplied iOS bridge evidence. |

## New findings: confirmed by host repro

All line numbers refer to product source at 97d36070. Host fixtures replace platform inventory/HTTP delivery, not
engine decisions. A passing `REPRO` asserts the observed defect; it is not a passing acceptance test.

| ID | Severity / platform | Evidence | Expected → actual; suggested fix |
|---|---|---|---|
| N2-01 | **blocker / android** | `A/DownloadEngine.kt:100`, `:615`; `A/Storage.kt:55`; `V/jvm/src/test/kotlin/Round2AdversarialTest.kt` `REPRO_partAliasPublishesAnotherTasksBytes` | A downloads to `movie.bin`, B downloads to `movie.bin.part`. They must conflict because A writes that path. Exact final-name claims allow both. With A paused in a read, B publishes `BBBBBBBB` to A's partial; A then publishes that path as its own file. **Both report completed; A contains B's bytes and B's final path disappears.** Reserve both final and staging paths (including aliases/ancestor conflicts) for the full ownership lifetime. |
| N2-02 | **blocker / android** | `A/DownloadEngine.kt:197`, `:335`, `:615`, `:619`; `A/Transfer.kt:136`, `:144`; `REPRO_failedTaskRemovalReleasesAStillWritingPath` | Missing volume marks A failed while moving its worker to `stopping`. `remove(A)` is allowed and removes the only record carrying its claim; `ownerOf` checks tasks/draining, not stopping. Re-expose the same volume root and start B on that path. **B completes as 8 bytes, then A's blocked read returns and appends four bytes to B's renamed file: `BBBBBBBBAAAA`, length 12, record still completed/8.** Keep a full path-owning drain record through every stop reason and reject/defer remove until the worker ends. Recheck stop before a write as an additional guard. The host toggles volume inventory while retaining a valid open descriptor; physical unmount/remount timing needs a device. |
| N2-03 | **major / ios** | `I/OfflineDownloadEngine.swift:431`, `:775`, `:778`; Swift `deferredResumeCheck()` in verifier | Pause schedules `cancel(byProducingResumeData:)`; cancel removes the record; start a **new URL and path with the same id**; deliver the old completion. Expected stale data ignored. Actual closure checks only `records[id] != nil`, writes the old request/partial blob under the new id and pumps. Verified through the real public pause/cancel/start APIs and queued closure. The blob can drive the replacement through the old request. Capture/check generation + task/session identity in this closure and all probe completions; cancel must invalidate their pending bookkeeping. No daemon execution of the stale blob was attempted. |
| N2-04 | **major / all** | `A/AndroidPlatform.kt:43`; `A/DownloadEngine.kt:375`; `I/OfflineDownloadEngine.swift:207`, `:634`; `T/http-policy.ts:98`; JVM `REPRO_wallRollbackExtendsAnHourCooldownByADay` | Expected elapsed waits/budget survive clock changes. Start a 1 h 429 cooldown, roll wall time back 24 h, pump: `retryAt - now` becomes **25 h**. The same wall timestamps drive the 12 h no-progress budget in all implementations. Clock-forward can exhaust it prematurely; repeated rollback can keep it alive. Use continuous/elapsed time including sleep for in-process deadlines and budget, plus bounded persisted/reboot reconciliation. Keep epoch timestamps for display and HTTP-date interpretation. Android documents [wall clock jumps versus elapsedRealtime including sleep](https://developer.android.com/reference/android/os/SystemClock). The host injects wall time; OS clock/sleep behavior needs device confirmation. |
| N2-05 | **major / android** | `A/AndroidPlatform.kt:76`, `:84`; `A/Model.kt:112`; `A/DownloadEngine.kt:49`, `:335`; `REPRO_oldExternalVolumeIdNeverFindsItsMountedMedium` | Expected existing app-private SD files remain locatable after UUID IDs replace positional IDs. Version-1 state with `external-0` loads unchanged; only `volume-ABCD` is enumerated for that same root. Completed record remains `completed` with **empty URI**; unfinished record remains `failed/volume_unavailable` through repeated pumps. No migration or explicit upgrade handling exists; version is not consulted. Introduce an explicit, safe migration using previously recorded root/medium identity, or surface a one-time recovery path when historical positional identity is ambiguous. Never blindly rebind by current list order. |
| N2-06 | **major / android** | `A/DownloadEngine.kt:173`, `:179`, `:721`; `REPRO_cancelResolvesBeforeCleanupAfterTenSecondTimeout` | Contract says cancel resolves after worker cleanup. `CountDownLatch.await(10 s)`'s boolean is ignored. An in-flight read still blocked at 10 s makes **cancel return successfully with the part present and its claim still busy**; immediate restart gets `invalid_state`. The configured read timeout is 30 s, so the gap is feasible without an indefinitely hung worker. Resolve only on real drain completion, or reject a timeout and keep the pending cancellation explicit. Do not clear the claim on timeout. Also bound notification receiver work without falsely signalling cancellation completion. |
| N2-07 | **major / ios** | `I/OfflineDownloadEngine.swift:837`, `:850`; Swift “numeric Content-Range start different from saved offset” replay | Expected fully valid continuation with proven start and same recorded strong ETag. `validate` checks numeric shape/end/total/ETag but **never compares `range.start`**; a missing recorded validator is also accepted via `?? true`. Saved offset 4 plus `bytes 3-7/8` is accepted and the replay publishes an 8-byte wrong file as completed. Preserve the actual OS resume offset and require it to match, with an existing matching strong validator. The [resume-offset delegate](https://developer.apple.com/documentation/foundation/urlsessiondownloaddelegate/urlsession(_:downloadtask:didresumeatoffset:expectedtotalbytes:)) reports actual reuse and may rewind, so comparing only last JS progress is insufficient. Engine-boundary defect confirmed; whether nsurlsessiond rejects this response first needs a device/protocol test. |
| N2-08 | **major / ios** | `I/OfflineDownloadEngine.swift:918`, `:921`, `:927`, versus intent switch `:1012`; Swift “final callback overrides … failure” and “… request replacement” | Completion should honor pending stop intent. `didFinishDownloadingTo` removes the intent and recognizes only `.pause`. A queued `.failure(disk_full)` is silently discarded; a `.requeue` caused by URL/header replacement can publish the **old request's file under the new record URL**. Both replays reach completed. Handle failure/requeue/cancel consistently in the final-file delegate before publication, retaining only the bytes allowed by that intent. Device confirmation is required for actual cancel-versus-final-callback ordering. |
| N2-09 | **minor / all** | `T/http-policy.ts:64`; `A/HttpPolicy.kt:29`; `I/HttpPolicy.swift:28`; JVM, Swift and JS parser repros | Delta-seconds is numeric regardless of leading zeroes. Expected `0000000000` → 2 s floor and `0000000030` → 30 s. All three return **1 h** because raw string length > 7 is treated as numeric overflow. Strip leading zeroes before length/cap logic and add corpus vectors. Parity is preserved but the common answer is wrong. |
| N2-10 | **minor / ts (integration)** | `client/src/api/__tests__/errors.test.ts:265`, client error translation registry; full + focused Jest | New documented download errors must be recognized/translated. The full-client suite has one repeatable failure listing **15 missing codes**. This is an integration issue outside the native engine, not a failed transfer regression. Add codes/translations in the owning client lane. Missing list preserved in evidence2.txt. |

## Source review and device-only questions

- **Checkpoint ordering:** Android syncs the file before advancing `durableBytes` (`Transfer.kt:149`, `:164`), and
  persists `checkpoint` separately from live progress (`DownloadEngine.kt:662`). New-validator truncation is synced
  before metadata (`Transfer.kt:113`, engine `:486`). Recovery reads actual file length and cuts an uncheckpointed tail.
  State writes sync the temporary file and attempt directory sync. Directory-sync errors are swallowed; physical
  power-loss durability and failure injection remain unverified. iOS state/resume writes use the durable helper;
  payload staging relies on URLSession's finished-file guarantees. No device locked-write test was performed.
- **Owners after crashes/terminal paths:** registry-derived exact claims survive restart, and completed/failed paths
  remain owned until remove. Cancel drains retain their claim normally. The two new alias/removal cases prove that
  this lifetime is not complete; an old process death clears in-memory drains, so stale partial recovery also still
  needs real process tests after those fixes. UUID replacement-medium control passed; migration did not.
- **Notifications/security:** receiver is explicitly `android:exported="false"` (`AndroidManifest.xml:26`); action
  intents name the receiver class and use `FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT` (`Notifications.kt:67`). No path for
  an ordinary app to send an arbitrary direct cancel was found. The media observer explicitly passes
  `RECEIVER_EXPORTED` for protected system MEDIA_* broadcasts (`AndroidPlatform.kt:56`); this is separate from the
  private action receiver and specifies the Android 14 flag. Validate action delivery/security and long-running
  `goAsync` cancellation on a device. [Android receiver access guidance](https://developer.android.com/privacy-and-security/risks/insecure-broadcast-receiver).
- **iOS identity/session recreation:** ordinary delegates check logical generation, background session identifier and
  task identifier. Generation survives persistence; start seeds it from epoch milliseconds and begin increments it.
  Recreated sessions intentionally reattach the persisted generation. No separate reproduced task-id reuse failure
  was found for those delegates. This does not cover the unguarded closure in N2-03. Probe callbacks also key by id
  and deserve the same generation audit. Stress cancel/restart/relaunch with reused identifiers on a device.
- **Redirects:** independent Android tests cover implicit/explicit default port, different port, HTTP→HTTPS stripping
  and HTTPS→HTTP refusal; the original live cross-host dummy secret is stripped. The app allows arbitrary HTTP for
  LAN use (`client/app.config.ts:53`); iOS has no module redirect delegate/explicit downgrade check and relies on
  URLSession. Its actual background redirect/downgrade policy needs a device/protocol check; no iOS downgrade leak is
  claimed as reproduced. Accept-Language/User-Agent may cross origins by the documented allowlist decision.
- **12 h budget/sleep:** policy corpus proves the boundary for a stable clock; it cannot prove elapsed time because
  the supplied timestamp is a wall clock. Repeat N2-04 with sleep, network outages, automatic clock corrections,
  manual backward/forward changes and reboot. Do not infer monotonic behavior from passing arithmetic vectors.
- **expo-video patch:** exactly the advertised three patch-file line replacements; only one changes executable Swift,
  supplying `[]` when `line`/rule is absent. No independent playback/device run was done. No product patch was edited.

The new defects above remain open. Report/repro commit only; round-1c can be verified separately when its follow-up arrives.
