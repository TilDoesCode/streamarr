# Streamarr Dev World

A one-command local world for developing and testing the viewer client without real Usenet:
the **real Core Server** (`AddStreamarrServer`/`UseStreamarrServer`) against

- a mock Usenet (`MockNntpServer`) whose articles are yEnc-encoded **on demand** from generated
  media files (nothing is held in memory),
- a canned Newznab indexer and a canned TMDB, both fed from [`fixtures/catalog.json`](fixtures/catalog.json),
- the viewer module enabled with seeded accounts.

Test/dev launcher only, never shipped. Every boot starts from a fresh state (DB, watch state,
sessions) in `cache/state-<port>/`; generated media is cached in `cache/media/` and shared.

## Use it

```bash
scripts/devworld.sh start            # published snapshot on 39300 (client work)
scripts/devworld.sh start 39310 --tree   # the working tree on 39310 (backend self-tests)
scripts/devworld.sh status | stop [port] | verify [port] | totp [port]
scripts/devworld.sh publish          # backend agents, only when build + tests are green
```

`start` waits until `/devworld/ready` answers and prints the banner (log `/tmp/devworld-<port>.log`).
Android emulator: `http://10.0.2.2:39300`. The harness binds `0.0.0.0` (`DEVWORLD_HOST` to change).

`publish` builds the working tree in Release into a staging dir, generates/validates the media,
then boots the staged build on `127.0.0.1:39319` (`DEVWORLD_PUBLISH_PORT`) and waits for
`/devworld/ready`. That includes the warm-up checks (no fixture release rejected, a dead release
ranked first) and, with `DEVWORLD_CHECK_RELEASES=1`, a resolve of every release/work pair without
fallback: each must end as its designed health (`ready`, `degraded` or `dead`), otherwise the boot
fails and lists the offenders (about 10 s for the full world). Only then does it swap `current`. It
keeps the three newest snapshots plus any snapshot a running instance was started from. `publish`
and `start --tree` build with `--disable-build-servers`, so no MSBuild worker nodes or compiler
server stay behind.

> **Security (dev only):** `/devworld.json`, `/devworld/totp/ben` and `/devworld/outbox` are
> anonymous. The manifest contains the admin password, the API key, the viewer passwords and
> ben's TOTP secret. With the default `0.0.0.0` bind, anyone on your LAN or tailnet can read them.
> On an untrusted network, start with `DEVWORLD_HOST=127.0.0.1 scripts/devworld.sh start`. The
> Android emulator docs define `10.0.2.2` as an alias for the host's loopback, so emulators should
> still reach it. Physical devices need the wildcard bind.

| Account | Password | Purpose |
|---|---|---|
| `admin` (admin UI / admin API) | `streamarr-dev` | API key `devworld-api-key-0123456789abcdef` |
| `anna` | `streamarr` | adult, unrestricted, transcoding allowed |
| `ben` | `streamarr` | TOTP enabled, secret `STREAMARRDEVWORLDBENTOTPSECRET23`, recovery codes `ben-recovery-01..10` |
| `kind` | `streamarr` | max age 12, unrated blocked |
| `gast` | `streamarr` | transcoding not allowed, max 1 concurrent stream |

Viewer emails are `<user>@devworld.example`; email mode is the test outbox. Minimum resumable
length is 60 s. Dead classifications are remembered for 120 s (not 30 min) so the fallback
scenario can be replayed.

Helper endpoints (anonymous, harness only): `GET /devworld/ready`, `GET /devworld.json`
(same as `cache/devworld.json`), `GET /devworld/totp/ben` (current + next code; the server
rejects a reused 30 s step), `GET /devworld/outbox` (email codes). CORS allows any origin for
`/api/v1/viewer`, `/api/v1/stream`, `/api/v1/transcode`, `/api/v1/health`, `/openapi`, `/devworld/*` and `/devworld.json`.

## devworld.json

Written to `cache/devworld-<port>.json` (and `cache/devworld.json` for port 39300 or
`DEVWORLD_PRIMARY=1`): URLs, accounts, every title with work ids, releases (release id, name,
variant, designed health, rank/score as the real ranker ordered them, file streams from
ffprobe), and `scenarios` (dead-release fallback with the expected fallback id, degraded
release, legacy transcode releases, season pack, `missingArtwork`, age gate for `kind`). Release
ids are stable (sha256 of indexer id + guid), so ids from one instance are valid on the other.
`urls.lan` is only filled when the harness binds all interfaces.

`missingArtwork` covers Pioneer One S01, which has no season poster and no episode stills on
TMDB (`null`, kept on purpose as a client edge case). Sherlock has both.

## Catalog and media matrix

`fixtures/catalog.json` holds titles (TMDB/IMDb ids, EN/DE texts, genres, certifications,
artwork URLs, episodes) captured from public TMDB web pages with `tools/capture_tmdb.py`,
the `variants` (container, codecs, tracks, bitrates) and per title the releases
(`name`, `variant`, `grabs`, `ageDays`, `health`: `ready|dead|degraded`, optional
`nominalMbps`). To extend: add a variant and/or releases, keep names honest — boot fails when a
release name does not parse to its variant's resolution/codec/audio/HDR/languages or when the
generated file does not probe as the variant.

- `dead`: every second article is missing (health check finds 430s) -> auto-fallback.
- `degraded`: small parts (> 80 articles); STAT of the last article drops the connection, so
  the health check counts one indeterminate probe -> `degraded`, still playable.
- Indexer sizes are nominal (`nominalMbps` x TMDB runtime) so the size-sanity/sample rules
  accept them; the real clips are short (movies 180 s, episodes 120 s, the 2160p sample 60 s).
- Media: testsrc2 background, a coloured title bar on the right edge, and a bottom panel with
  title, variant label and a running `HH:MM:SS` timecode (built-in 5x7 bitmap font; the Homebrew
  ffmpeg has no `drawtext`). testsrc2 also shows a frame-accurate counter top-left. Audio is
  short per-channel beeps (distinct pitch per channel, lower pitch for German tracks).

Bump `MediaGenerator.GeneratorVersion` when the generated bytes change. Each boot touches the probe
sidecars of the files it uses. Files that no plan has used for 30 days are pruned from
`cache/media`, and so are `.tmp` leftovers older than a day. A process waiting for another
process's generation lock gives up after 30 minutes.

## Tests

`dotnet test tests/Streamarr.DevWorld.Tests` (part of the solution) checks the harness without
ffmpeg, using synthetic media files. It covers:

- the fixture catalog builds and covers the specified matrix;
- a release name that contradicts its variant fails the build;
- the dead and degraded article layouts, and NZB sizes that match the served articles;
- canned indexer and TMDB matching;
- a boot of the real Core Server. That boot seeds the viewers, runs the warm-up (dead releases
  ranked first, nothing rejected), and checks the helper endpoints and CORS;
- a second boot that resolves every release/work pair as designed and streams each live one,
  byte for byte against its file.

A backend change that would break the Dev World therefore fails `dotnet test`.

## Resources

Two instances (39300 + 39310) take up to about 1 GB together. After a full `verify` flow the
physical footprint (`footprint -p <pid>`) measured 0.34–0.51 GB per instance. `ps` RSS reads
lower under memory pressure. `publish` briefly boots a third instance (~0.2 GB) for its check.
The published payload is 403,128,067 bytes (384.5 MiB). The mock Usenet encodes articles on
demand, so the payload costs no RAM.

## Environment

| Variable | Default |
|---|---|
| `DEVWORLD_PORT` / `DEVWORLD_HOST` | `39300` / `0.0.0.0` (a specific IP is also used for the script's probes and `LocalSourceBaseUrl`) |
| `DEVWORLD_CACHE_DIR` | `cache/` next to the project (the script always passes the repo cache) |
| `DEVWORLD_STATE_DIR` | `<cache>/state-<port>` (wiped on boot) |
| `DEVWORLD_CATALOG` | `fixtures/catalog.json` in the build output |
| `DEVWORLD_GEN_JOBS` | `2` parallel ffmpeg jobs |
| `DEVWORLD_LOG_LEVEL` | `Warning` |
| `DEVWORLD_CHECK_RELEASES` | `1` resolves every release at boot and fails unless each matches its designed health (set by `publish`) |
| `DEVWORLD_PRIMARY` | `1` also writes `cache/devworld.json` on a non-39300 port |
| `DEVWORLD_SNAPSHOT_ROOT` | `~/.cache/streamarr-devworld` (script: where `publish` puts snapshots) |
| `DEVWORLD_PUBLISH_PORT` | `39319` (script: scratch port for the publish boot check) |

`--generate-only` generates/validates the media and exits (used by `publish`).
