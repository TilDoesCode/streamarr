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
