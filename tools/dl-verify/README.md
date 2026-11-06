# DL-S verifier scripts

Run from the `fb/dl-verify` worktree root. Every new shell must first run
`source docs/client/env.sh`. Dev World uses **39311 only**. Product sources are
never patched. Logs, databases, keys, compiler output and raw results are ignored.
The committed journal contains the conclusions and sanitized evidence.

The worktree needs the usual solution build and generated Dev World media. During
verification the published snapshot's media was cloned into this worktree's own
`server/tests/Streamarr.DevWorld/cache/media`; no builder state was reused or changed.

```bash
source docs/client/env.sh
python3 tools/dl-verify/world.py start
python3 server/tests/Streamarr.DevWorld/tools/downloads_check.py http://127.0.0.1:39311
python3 tools/dl-verify/world.py restart
python3 tools/dl-verify/adversarial.py
python3 tools/dl-verify/priority.py
python3 tools/dl-verify/world.py restart --keep-data
python3 tools/dl-verify/extras.py
dotnet run --project tools/dl-verify/probe/Probe.csproj
dotnet run --project tools/dl-verify/catalog-probe/CatalogProbe.csproj
python3 tools/dl-verify/world.py stop
```

`adversarial.py` deliberately expires one of its own runtime database rows, holds
a SQLite writer transaction for 1.5 seconds without changing rows to expose the
idempotency race, and restarts its owned Dev World process. All auth calls use
seeded test credentials. No tokens/capabilities are printed by the verifier scripts.
The round-1 server leaked capabilities into its raw log; later fixes are expected
to redact them. Keep runtime logs ignored and private.

`probe` invokes production components in process: production CORS (without Dev
World's permissive wrapper), session admission/LRU, validation, an existing-viewer
migration, and bandwidth cancellation. `catalog-probe` reuses the server test host
and changes only its process-local fake indexer arrays to test partial packs and
an English 2160p/German 720p language conflict. Neither opens an additional port.

These are diagnostic probes, not product tests: failures are emitted as evidence
and are expected on the reviewed commit. The main scripts' assertions are counted
individually; multiple assertions may describe one report finding.

## Round 2

Use Node 24 for web validation:

```bash
source docs/client/env.sh
source "$HOME/.nvm/nvm.sh"
nvm use 24
```

After merging/building the integration tree, repeat the original recipe above.
`adversarial.py` is unchanged; `probe` now treats the expected transfer-capacity
refusal as evidence and continues. `catalog-probe` verifies recommendations in both
languages and deliberately excludes plan-language semantics pending round 1b.

The extra cases are:

```bash
source docs/client/env.sh
python3 tools/dl-verify/world.py restart
python3 tools/dl-verify/round2_probe.py
python3 tools/dl-verify/round2_races.py
dotnet run --project tools/dl-verify/access-probe/AccessProbe.csproj
dotnet run --project tools/dl-verify/probe/Probe.csproj
python3 tools/dl-verify/world.py stop
```

`round2_probe.py` demonstrates preparing-session revocation, rotated ETag/Range
resumption, simultaneous renewals, delimiter keys and no probe-induced live hold.
`round2_races.py` runs twenty renew/security-sign-out races and a four-second expiry
with a held SQLite writer. It stores sanitized status evidence only; the precise
race hit count varies. `access-probe` holds the fake media probe, showing that an
already-authorized poll can receive a fresh capability after security sign-out;
it also exercises queue progress after finite capacity contention clears.

The component probe seeds ordinary legacy duplicates and then valid distinct
pipe-containing tuples, invokes the hardening migration, tests mixed-size throttle
progress and forces 400 actual eviction attempts at `MaxSessions=1`. Runtime
artifacts remain ignored.

To independently test builder regressions against the old implementation:

```bash
source docs/client/env.sh
python3 tools/dl-verify/pre_fix_proof.py
cd tools/dl-verify/pre-fix/server
dotnet test tests/Streamarr.Server.Tests/Streamarr.Server.Tests.csproj --filter 'FullyQualifiedName~DownloadAccessTests|FullyQualifiedName~OfflineProgressTests|FullyQualifiedName~CoreLogStoreTests|FullyQualifiedName~ViewerCorsMiddlewareTests|FullyQualifiedName~ATransferAdmission_|FullyQualifiedName~ACancelledThrottleWait_CostsNothing|FullyQualifiedName~ARateChange_ReachesARequestThatIsAlreadyWaiting'
dotnet test tests/Streamarr.Server.Tests/Streamarr.Server.Tests.csproj --filter 'FullyQualifiedName~AReleasedSession_ClosesWhenItsLastTransferEnds|FullyQualifiedName~ATransferSessionsOwnStreamReads_AreNeverLive_AndSkipTheArticleCache'
```

The archive is created from git objects in this checkout; it never modifies another
worktree. Compatible test methods are copied unchanged, while new-API tests and a
negative test that leaves the old resolver permanently blocked are omitted. The
clean run had 30 failing/27 passing cases, plus two failing transfer integration
cases. These expected failures are regression evidence, not passing product tests.

## Round 2b — plan language

From this worktree root, after building the merged solution:

```bash
source docs/client/env.sh
python3 tools/dl-verify/round2b_live.py --write-catalog
DEVWORLD_PORT=39311 DEVWORLD_CATALOG="$PWD/tools/dl-verify/round2b-catalog.json" dotnet server/tests/Streamarr.DevWorld/bin/Debug/net8.0/Streamarr.DevWorld.dll --generate-only
DEVWORLD_CATALOG="$PWD/tools/dl-verify/round2b-catalog.json" python3 tools/dl-verify/world.py start
python3 tools/dl-verify/round2b_live.py
python3 tools/dl-verify/world.py stop
dotnet run --project tools/dl-verify/plan-language-probe/PlanLanguageProbe.csproj
dotnet test server/tests/Streamarr.Server.Tests/Streamarr.Server.Tests.csproj --filter 'FullyQualifiedName~DownloadLanguageGateTests'
python3 tools/dl-verify/round2b_before.py
cd tools/dl-verify/pre-1b/server
dotnet test tests/Streamarr.Server.Tests/Streamarr.Server.Tests.csproj --filter 'FullyQualifiedName~DownloadLanguageGateTests'
```

The runtime catalog keeps the stock Sherlock releases and adds German AAC 720p /
English TrueHD HDR10 2160p singles to its first two season-2 episodes. The broad
live device profile explicitly declares TrueHD support; the limited profile accepts
AAC only. Media generation can exceed the helper's 60-second readiness timeout,
so the recipe generates new media before starting the listener. Catalog JSON,
TRX, logs and the pre-1b archive are ignored. Only the fixture generator is committed.

Results: live 15/15, independent component assertions 19/19, builder language tests
14/14; pre-1b integration cases 4 failed / 4 passed. The archive omits six unit
cases that directly call the new helper unavailable on the pre-fix source.

## Round 3

Use Node 24 as above for the full web suite. Run the solution build/tests before
starting the live checks. The ordinary replay remains `adversarial.py`, `priority.py`,
`extras.py`, `round2_probe.py`, `round2_races.py`, plus the access/component probes.
The old probes now use `DeviceKey` and a named legacy migration. The pending-poll
probe accepts the expected 401 without trying to read missing DTO properties.
The original HTTP probe normalizes .NET fractional timestamps for Python 3.9 and
waits for previous request cleanup before isolated range checks; concurrency and
disconnect tests still assert their own limits/slot release.

New evidence, all from this worktree root:

```bash
source docs/client/env.sh
python3 tools/dl-verify/world.py start
python3 tools/dl-verify/adversarial.py
python3 tools/dl-verify/priority.py
python3 tools/dl-verify/world.py restart --keep-data
python3 tools/dl-verify/extras.py
python3 tools/dl-verify/round2_probe.py
python3 tools/dl-verify/round2_races.py
python3 server/tests/Streamarr.DevWorld/tools/downloads_check.py http://127.0.0.1:39311
python3 server/tests/Streamarr.DevWorld/tools/downloads_security_check.py http://127.0.0.1:39311 tools/dl-verify/devworld.log tools/dl-verify/state/streamarr.db
python3 server/tests/Streamarr.DevWorld/tools/downloads_race_check.py http://127.0.0.1:39311 tools/dl-verify/state/streamarr.db
python3 tools/dl-verify/round3_accounting.py
python3 tools/dl-verify/world.py stop
dotnet run --project tools/dl-verify/lifecycle-probe/LifecycleProbe.csproj
dotnet run --project tools/dl-verify/accounting-probe/AccountingProbe.csproj
python3 tools/dl-verify/round3_before.py
dotnet run --project tools/dl-verify/seed-legacy/SeedLegacy.csproj -- --seed-old
dotnet run --project tools/dl-verify/migration-probe/MigrationProbe.csproj
```

`round3_accounting.py` deliberately SIGKILLs only the PID recorded by `world.py`
after checking its DLL command line. It restarts with persisted state and measures
unflushed telemetry loss and Range byte identity. Finish with the owned-PID stop.

The lifecycle probe injects scheduling at actual EF boundaries: cancellation after
the security transaction commits; a list reader paused across sign-out; a lifecycle
exception, then 30 cancelled lock waiters and 30 successful renewals. It also tests
device ownership after a case-normalized retry from another session. The accounting
probe cancels an in-progress SQL operation during an orderly hosted-service stop.
Its expected byte totals are known before the operation; it changes no product source.

`round3_before.py` archives **a48a0755** and ports compatible builder regressions.
Run selected access cases and the FIFO case in `pre-round2/server`, as listed in the
report. The original-hardening migration regression can be run with:

```bash
source docs/client/env.sh
cd tools/dl-verify/pre-round2/server
dotnet test tests/Streamarr.Server.Tests/Streamarr.Server.Tests.csproj --filter 'FullyQualifiedName~DistinctTuples_KeepTheirOwnKeys_AndTrueDuplicates_LeaveItToTheOldest'
```

The seed project references that archived assembly, so its database really applied
the original migration. The current migration probe upgrades it and independently
exercises pre-DL upgrade with duplicate/pipe/non-ASCII tuples. The archive, databases,
keys and results stay ignored.

After building both trees and finishing other verifier work, run
`python3 tools/dl-verify/round3_latency.py` from the root. It interleaves the same
unmodified versions-latency test on current and a48a0755, three times per tree/mode,
first without added workers, then with two CPU workers it owns and stops. The host
may still have unrelated load; the JSON records `uptime` for each case. No other
session's processes are changed.
