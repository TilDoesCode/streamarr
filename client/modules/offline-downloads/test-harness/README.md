# offline-downloads test harness

Host-side regression checks for the native download engine. They grew out of the independent verification
`DL-N-verify1` (fb/dl-verify-native @ f5f6c1a5, `tools/dl-verify-native/`): every `BUG_*` repro there reproduced a
defect at a38c1ffe; here the same scenario asserts the **correct** outcome. No device, Expo prebuild, Metro or Argent.
Generated files stay in the ignored `.work/`, `logs/` and `jvm/build/`.

From `client/` (after `source ../docs/client/env.sh`):

```sh
# Range server with redirect fixtures (live JVM cases; they print SKIP without it), in another terminal
node modules/offline-downloads/test-harness/range-fixtures.mjs --host 127.0.0.1 --port 39321

# JVM: the module's pure-Kotlin sources (DownloadEngine, Transfer, Storage, Model, HttpPolicy, EnginePlatform) and its
# own JUnit corpus test, with Uri/StatFs shims. Any Gradle 9 works; the generated client/android wrapper is used here.
GRADLE_USER_HOME=/Volumes/DevSSD/Caches/Gradle-dl-native ./android/gradlew -p modules/offline-downloads/test-harness/jvm test

# Swift: shared-corpus policy check, then the actual iOS engine compiled for macOS with delegate replays
cd modules/offline-downloads
xcrun swiftc -parse-as-library ios/HttpPolicy.swift ios/Tests/HttpPolicyCheck.swift -o /tmp/http-policy
/tmp/http-policy test-vectors/http-policy.json
python3 test-harness/swift/make-host-check.py
xcrun swiftc -swift-version 5 -parse-as-library ios/HttpPolicy.swift test-harness/.work/EngineHostCheck.generated.swift \
  -o test-harness/.work/engine-host
mkdir -p test-harness/.work/swift && DL_HARNESS_SWIFT_ROOT="$PWD/test-harness/.work/swift" test-harness/.work/engine-host
cd ../..

# JS: the actual TS fake/policy/bridge transpiled in memory (jest covers the same in src/downloads/engine/__tests__)
node modules/offline-downloads/test-harness/js-check.cjs
```

What runs where:

- `jvm/src/test/kotlin/TransferTest.kt`: Transfer.kt against scripted `http://<name>.fixture/…` responses (a one-line
  connection seam in Transfer) plus three live cases on the Range server (resume + hash, child-JVM process death after
  a 200 restart, 127.0.0.1 → localhost redirect).
- `jvm/src/test/kotlin/EngineTest.kt`: the actual `DownloadEngine` with a fake `EnginePlatform` (no Android): path
  ownership, cancel vs. publication (a test seam runs right before an outcome is applied), live-path delete/move,
  Retry-After cooldown across network changes, invalid 206, user-stop exit, missing volume, space ledger, final
  progress order, checkpoint recovery, header allowlist, Publisher validation.
- `swift/EngineHostCheck.swift`: generated together with the unchanged `OfflineDownloadEngine.swift` (only the OS guard
  and the Application Support root change); `activate()` is never called, so no background session or daemon runs.
  This proves engine behaviour at the delegate boundary, not daemon timing on a device.
- `../test-vectors/http-policy.json`: the shared policy corpus run by jest, JUnit and the Swift check.

| Verifier repro                                                 | Now                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `BUG_missingEtagAppendsAndPublishesMixedBytes`                 | `missingEtagWithPinnedValidatorFailsAndDrops`, `missingEtagWithoutPinnedValidatorRestartsFromZero` |
| `BUG_unknownRangeTotalAppends`                                 | `unknownRangeTotalIsRejected`                                                                      |
| `BUG_changedKnownTotalAppendsWithoutExpectedBytes`             | `changedTotalIsRejectedEvenWithoutExpectedBytes`                                                   |
| `BUG_invalidRangeEndIgnored`                                   | `invalidRangeEndIsRejected`                                                                        |
| `BUG_weakValidatorWithLastModifiedAppends`                     | `weakValidatorNeverResumes`                                                                        |
| `BUG_416CanCompletePartDespiteExpectedSizeMismatch`            | `every416FailsEvenForAMatchingPart`                                                                |
| `BUG_completePartBypassesExpectedBytesAndValidatorAndNetwork`  | `completePartIsRevalidatedThroughItsLastByte`                                                      |
| `BUG_cancelBetweenRenameAndCallbackLeavesFinal`                | `EngineTest.cancelRacingTheLastByteLeavesNoFile`                                                   |
| `BUG_moveLivePartPublishesIncompleteFileOutsideTask`           | `EngineTest.liveFilesCannotBeMovedOrDeleted`                                                       |
| `BUG_twoWritersOnePathFirstTaskPublishesOtherTasksBytes`       | `EngineTest.aPathBelongsToOneTask`                                                                 |
| `BUG_retryAfterOverflowBecomesZero`                            | `hugeRetryAfterCapsAtOneHour` (+ corpus)                                                           |
| `BUG_dateGarbageSuffixAccepted`                                | `dateWithTrailingGarbageIsRejected` (+ corpus)                                                     |
| `BUG_processDeathAfter200MetadataPersistPublishesMixedFile`    | `processDeathAfter200NeverPublishesMixedBytes`                                                     |
| `BUG_crossHostRedirectForwardsCustomCredentialHeaderOnHostJDK` | `liveCrossHostRedirectDropsCallerHeaders`, `crossOriginRedirectDropsCallerHeaders`                 |
| Swift `BUG …` (9 cases)                                        | same scenario, inverted, in `EngineHostCheck.swift` (labels name the old case)                     |
| `js-check.cjs` `BUG …` (5 cases)                               | inverted in `js-check.cjs` and in `src/downloads/engine/__tests__/conformance.test.ts`             |
