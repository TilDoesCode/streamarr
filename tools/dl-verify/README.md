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
The server's own raw log does leak capabilities; keep that ignored log private.

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
