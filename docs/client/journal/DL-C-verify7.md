# DL-C-verify7 — closing restart check

**Final client-lane verdict: pass with a minor finding.** The completed-record restart and C6-01 handover are fixed. All **77 earlier checks across 27 suites** pass as ordinary correct-outcome assertions. The focused audit finds **0 blockers, 0 majors, 1 minor (C7-01)** concerning a disposed manager replaced in the same JavaScript process; cold process restarts and normal live handovers pass. No previously reported client finding remains open in its original scenario.

Reviewed only `/Volumes/DevSSD/Development/local-projects/streamarr-worktrees/dl-verify-client`, branch `fb/dl-verify-client`. Requested baseline **1edd616b920fcefed5e7cf5802ef856dea4716f3**. Merge **5126072929a052da5e245f47f696952a59c46b78** has incoming parent **ea9ef9adf426dda916d9e13f9627aa26fb2e1928**: five lines in `docs/client/journal/DL.md` are its only addition beyond 1edd616b. Client product code matches the requested baseline. No later integration, product edits after merge, push, devices, native builds, or real-server mutation. Both commits carry the verifier trailer.

## Commands and counts

Client commands used `source "$HOME/.nvm/nvm.sh"; nvm use 24`, `source docs/client/env.sh`, then `cd client`: **Node 24.14.0 / npm 11.9.0**. Receipts: `tools/dl-verify-client/round7-results.txt`; ordinary assertion diagnostics: `round7-required-behavior.txt`. Raw logs remain Git-ignored locally.

| Check | Result |
|---|---|
| `git merge fb/downloads`; `npm install` | Both exit 0; no dependency/lockfile change retained. |
| Initial `npm run typecheck`; `npm run lint` | Both exit 0, zero diagnostics/errors/warnings. |
| Unchanged prior repros: `DL_VERIFY_EXPECT_FIXED=1 npx jest src/__verify__ --runInBand` | Exit 0; **27 suites / 77 tests pass; 0 snapshots; 8.059 s.** |
| Maintained default-worker `npx jest --testPathIgnorePatterns=src/__verify__/` | Exit 0; **302 suites / 3,158 tests pass; 0 snapshots; 27.261 s.** Matches supplied counts. |
| Final prior-only `DL_VERIFY_EXPECT_FIXED=1 npx jest 'src/__verify__/round[1-6]' --runInBand` | Exit 0; **27 suites / 77 tests pass; 0 snapshots; 7.587 s.** |
| Final typecheck / lint | Both exit 0; **zero diagnostics/errors/warnings**. |
| Final ordinary `DL_VERIFY_EXPECT_FIXED=1 npx jest src/__verify__ --runInBand` | Exit 1; **29 suites: 28 passed, 1 failed; 92 tests: 90 passed, 2 failed; 0 snapshots; 9.122 s.** Only C7-01 fails. |
| Full default-worker `npx jest` | Exit 0; **331 suites / 3,250 tests pass; 0 snapshots; 28.194 s.** Includes the two C7-01 expected-failure cases. |

The fixed C6-01 wrapper was promoted to ordinary `it` without changing its assertions. Only the two C7-01 cases use expected-failure mode in the default full run: green there means reproduced, not corrected. No default parallel failure has been substituted by an isolated/reduced-worker result. Both full runs printed the existing force-exited-worker teardown warning despite exit 0.

## Final statuses

Paths below are relative to `client/src/`.

| Item | Final status | Evidence |
|---|---|---|
| C3-01 | **fixed** | All historical prepare/Resume/restart intent checks pass. `round7-handover.test.ts` repeats Resume/Retry, then another Pause/Resume while DELETE is held, and gets one fresh transfer; a later Pause, sign-out or owner removal prevents the queued rerun. C7-01 is a separate teardown-lifetime case. |
| C4-02 | **fixed** | Historical success/rejection/Retry/prepare cases pass. Modified `downloads/__tests__/transfer-intent.test.ts:612` retains Pause → no fresh prepare → Resume → eventual transfer assertions; the changed persisted-ID expectation is appropriate, as explained below. |
| C6-01 | **fixed** | Unchanged `round6-restart.test.ts` confirms that the **first** Resume is applied; its saved pre-second-Resume snapshot is asserted. New checks cover replacement of a queued request by a newer intent, cancellation, account removal, sign-out and cold relaunch for both validator and completed-record restarts. |
| Server-completed path excluded in round 6 | **verified, exclusion closed** | `manager.ts:1194` persists `server_completed` and calls `finishRestart`; `runRestart` waits for outbox acknowledgement before reset. Maintained completed-record tests cover failure/reconnect, old reply/lifecycle and relaunch. New independent tests cover completed handover, 404 acknowledgement, per-profile 401 parking and sign-in. Fresh transfer has a new server ID, `restarts: 0`, and no error. |

Other historical statuses remain fixed as recorded in round 6 and confirmed by rerunning every repro. The two partial historical statuses from that report are closed above.

**The changed C4-02 test was not weakened in its behavioral purpose.** Previously it expected `downloadId: null` after the DELETE returned while paused. Now it expects `restartReason: server_completed`, preserves the old ID until restart cleanup completes, still asserts paused state and **one** prepare, and then asserts **two** prepares and downloading only after Resume. The old ID remains useful to retry a failed DELETE; clearing it early would defeat the new outbox guarantee. `round7-ui.test.tsx` independently verifies the intervening `paused → queued` state: the TV primary is the same mounted control, the badge stays 1, the summary stays one download, the row says Queued, and the relabelled Pause cancels the pending handover.

## New finding — reproduced, minor

| ID / severity / package | Evidence | Expected vs. actual | Suggested fix |
|---|---|---|---|
| **C7-01 · minor · core** | `round7-handover.test.ts`, “a disposed manager must not replay its handover against a replacement in the same process”, validator and completed variants. `manager.ts:314`, `:1927`, `:1944`, `:1952`. | Hold the old restart DELETE, Pause/Resume to queue a handover, dispose that manager, and attach a replacement over the same engine/storage. The replacement starts its fresh task. Delivering the old response then lets the disposed manager replay its handover and call `cancelTask` **before** its next stale/disposed check. The fixture's replacement record still says downloading, but the native-task fake now has **zero** tasks instead of one. Teardown should issue no new task commands against the replacement. | Clear queued handovers on disposal and guard against disposed state before recording/replaying one and before the first restart engine command. Preserve the existing live-intent and cold-relaunch cases. |

**Severity limit:** this reproduces an in-process manager replacement with both old/new JavaScript instances alive long enough to deliver a late callback. It is **not** evidence of a failure on a genuine cold process restart: the dead runtime cannot deliver that callback, and the independent persisted-state relaunch checks pass. No device reproduction or normal navigation/account-switch path recreating the root manager was established. This is teardown robustness, not a major or blocker.

No extra code-reading-only finding is counted. Scope stayed on the restart handover: repeated requests, cold relaunch, owner removal, later Pause/sign-out, UI counts, completed-record outbox/401 and the modified C4-02 test. Historical real-client token-isolation checks also pass; no cross-profile DELETE or record leak was observed. This report does not extend native/device certification.
