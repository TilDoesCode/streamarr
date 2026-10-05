# Streamarr Dev World

A one-command local world for developing and testing the viewer client without real Usenet:
the **real Core Server** (`AddStreamarrServer`/`UseStreamarrServer`) against

- a mock Usenet (`MockNntpServer`) whose articles are yEnc-encoded **on demand** from generated
  media files (nothing is held in memory),
- a canned Newznab indexer and a canned TMDB, both fed from [`fixtures/catalog.json`](fixtures/catalog.json),
- the viewer module enabled with seeded accounts.

Test/dev launcher only, never shipped. Every boot starts from a fresh state (DB, watch state,
sessions) in `cache/state-<port>/` unless `--keep-data` is given; generated media is cached in `cache/media/` and shared.

## Use it

```bash
scripts/devworld.sh start            # published snapshot on 39300 (client work)
scripts/devworld.sh start 39310 --tree   # the working tree on 39310 (backend self-tests)
scripts/devworld.sh status | stop [port] | verify [port] | totp [port]
scripts/devworld.sh restart 39300 --keep-data   # after publish: new build, same accounts/sessions/watch state
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

Generated artwork: a catalog URL `devworld:/t/p/{size}/{file}.jpg` is drawn once (SkiaSharp, `DevWorldArtwork`) into
`cache/art/v<version>/{size}/` in the TMDB size classes the server hands out (posters `w185`/`w342`/`w780`, backdrops
and stills `w300`/`w780`/`w1280`) and served anonymously at `GET /devworld/art/t/p/{size}/{file}.jpg`. JSON answers
under `/api` name these images by the origin the caller used (`http://10.0.2.2:<port>` on the Android emulator,
`localhost` in a browser), so the URLs work from every client; palettes (`tint`) are only computed for TMDB images, so
these titles have none.

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

`lighthouse-logs` ("The Lighthouse Logs", TMDB id 990001, work ids `tmdb-tv-990001-s01e01` … `s01e26`) is a
fictional series with one long season of 26 episodes, one 480p H.264/AAC release each (variant `mp4-h264-aac-480p`,
60 s clips), for long episode strips (TV second-position snap, scrolling). Its artwork is generated (a lighthouse at
sea: poster with the English or German title, a backdrop, one still per episode in a changing mood); it is the last
title of the `popular-series` row. Its tagline exists in English only, so German viewers get `tagline: null`. The harness raises
`Streamarr:MaxSessions` to 256 so every release keeps a live stream session at once.

`discover` lists the work ids of the viewer home rows (`GET /api/v1/viewer/catalog/discover`)
in order, and `scenarios.noVersions` the titles that exist only as metadata (Agent 327:
Operation Barbershop and Wing It!: no releases, so their versions list is empty). Titles carry
`logoUrl` when TMDB has a logo (Pioneer One and Wing It! have none).

## Catalog and media matrix

`fixtures/catalog.json` holds titles (TMDB/IMDb ids, EN/DE texts, genres, certifications,
artwork URLs, episodes) captured from public TMDB web pages with `tools/capture_tmdb.py`,
the `variants` (container, codecs, tracks, bitrates) and per title the releases
(`name`, `variant`, `grabs`, `ageDays`, `health`: `ready|dead|degraded`, optional
`nominalMbps`). To extend: add a variant and/or releases, keep names honest — boot fails when a
release name does not parse to its variant's resolution/codec/audio/HDR/languages or when the
generated file does not probe as the variant.

`discover` holds the title keys of the canned TMDB trending/popular lists behind the viewer home
rows (`trendingMovies`, `trendingSeries`, `popularMovies`, `popularSeries`). They must name catalog
titles of the right type, and at most two listed titles may have no release (the build fails
otherwise), so the rows only show what the Dev World can play plus the empty-versions case. Like
real TMDB list results, the canned lists carry card fields only, so the viewer age gate has to look
up each certification.

The canned TMDB also answers discover (`discover/movie`, `discover/tv`, behind the viewer Movies and
Series pages) and the genre lists from the catalog: a title matches a genre id when one of its
`genres` names maps to that TMDB id; the genre list holds only genres some title of that type has.
`popular` follows the popular row, then the trending row, then the rest; `top_rated` orders by
`communityRating`, `newest` by `year`. Pages hold 4 titles (`CannedTmdbClient.DiscoverPageSize`),
so the 9 movies span 3 pages.

Viewer language: with `Accept-Language: de` the canned TMDB answers like TMDB with `language=de` — the fixture's
`titleDe`, `overviewDe`, `taglineDe`, `genresDe` and episode `titleDe`/`overviewDe`, "Staffel N" and German genre-list
names — and English where a fixture has no German text (Sprite Fright, Wing It!, Pioneer One have no German overview).

- `dead`: every second article is missing (health check finds 430s) -> auto-fallback.
- `degraded`: small parts (> 80 articles); STAT of the last article drops the connection, so
  the health check counts one indeterminate probe -> `degraded`, still playable.
- Indexer sizes are nominal (`nominalMbps` x TMDB runtime) so the size-sanity/sample rules
  accept them; the real clips are short (movies 180 s, episodes 120 s, the 2160p and 480p samples 60 s).
- Media: testsrc2 background, a coloured title bar on the right edge, and a bottom panel with
  title, variant label and a running `HH:MM:SS` timecode (built-in 5x7 bitmap font; the Homebrew
  ffmpeg has no `drawtext`). testsrc2 also shows a frame-accurate counter top-left. Audio is
  short per-channel beeps (distinct pitch per channel, lower pitch for German tracks).

Bump `MediaGenerator.GeneratorVersion` when the generated bytes change. Each boot touches the probe
sidecars of the files it uses. Files that no plan has used for 30 days are pruned from
`cache/media`, and so are `.tmp` leftovers older than a day. A process waiting for another
process's generation lock gives up after 30 minutes.

## Fault injection (player)

Dev World can break any delivery, API or session path on demand, for one playback at a time, so the player's
handling of every state (PLAN § 5 I, `docs/client/player/b12-fault-spec.md`) can be reproduced without touching the
product. Everything lives in `Faults/` and `tools/ffmpeg-fault.sh`. The product build never references it.
`DEVWORLD_FAULTS=0` registers nothing (no middleware, no decorators, no ffmpeg wrapper).

| Method / path | Result |
|---|---|
| `POST /devworld/faults` | arm: `201 { id, fault, scope, expiresAt, action }`; `400 invalid_fault` with the reason |
| `GET /devworld/faults` | `[{ id, fault, scope, target, rendition, params, mode, after, hits, remaining, armedAt, expiresAt }]` |
| `GET /devworld/faults/{id}` | `{ fault, lastHits: [{ at, method, path (tokens redacted), status }] }` (last 20) |
| `DELETE /devworld/faults/{id}` | `204` (undoes state faults: password flag, Usenet scripts, slow-down files) |
| `DELETE /devworld/faults[?scope=playbackId:…]` | `204`, clears all (or one scope: `playbackId:…`, `workId:…`, `viewer:…`, `next:…`, `global`) |
| `GET /devworld/playbacks` | playbacks the fault layer learned: `[{ playbackId, workId, viewer, method, engine, state, releaseId, hlsToken, streamToken, revision, lastSeen, readyAt }]` |

```jsonc
{
  "fault": "seg_status",
  "scope": { "playbackId": "…" },   // or { "workId" } | { "viewer": "anna" } | { "next": "anna" } | { "global": true }
  "target": "video",                // master | media | init | video | audio | subtitle | direct | api:start|poll|switch|stop|progress
  "rendition": "2",                 // audio rendition id / subtitle stream index (optional)
  "params": { "status": 503, "code": "segment_evicted" },
  "mode": "once",                   // once | always | { "count": 3 }; default once, always for state-like faults (see below)
  "after": { "segment": 20 },       // { segment } | { requests } | { secondsAfterReady } | { bytes } (optional)
  "ttlSeconds": 900                 // default 900, max 7200
}
```

- `next` applies to the viewer's next start and becomes a `playbackId` scope on the first start answer. Start, resolve,
  probe and HLS-start faults use it before a playbackId exists.
- Only one `global` fault at a time (a second one is refused).
- State-like faults default to `always`: `playback_gone`, `playback_stuck`, `captive_portal`, `playlist_endless`,
  `playlist_event_stale`, `early_end`, `direct_truncate`, `throttle`. All others default to `once`.
- Every faulted response carries `X-DevWorld-Fault: <id>`. Every hit logs
  `DevWorld fault <id> <fault> hit <METHOD> <path> → <outcome>` at Information (capability tokens redacted).
- `direct_*` and direct `throttle` skip the server's own loopback reads (`Streamarr-Transcoder/1`) unless `params.internal: true`.
- `GET /devworld/playbacks` gives the playbackId and tokens to scope with. The default target is the first one listed per fault.

Shorthand below: `arm '<json>'` = `curl -s -XPOST localhost:39310/devworld/faults -H 'Content-Type: application/json' -d '<json>'`,
`P` = `"scope":{"playbackId":"<id>"}`.

| Fault | Example | Wire behaviour |
|---|---|---|
| `seg_delay` | `{"fault":"seg_delay",P,"target":"video","params":{"ms":1500}}` | waits, then the real answer |
| `seg_stall` | `{"fault":"seg_stall",P,"params":{"seconds":20,"respond":true}}` | no byte until the client gives up (no `seconds`), or `504 segment_timeout` after `seconds` with `respond` |
| `seg_status` | `{"fault":"seg_status",P,"target":"video","params":{"status":503,"code":"segment_evicted"}}` | product envelope; `retryAfter` adds `Retry-After`. Defaults by status: 404 `unknown_segment`, 410 `session_closed`, 500 `transcode_failed`, 503 `segment_unavailable`, 504 `segment_timeout` |
| `seg_reset` | `{"fault":"seg_reset",P,"params":{"afterBytes":1000}}` | full `Content-Length`, connection reset after N bytes |
| `seg_truncate` | `{"fault":"seg_truncate",P,"params":{"percent":50}}` | real `Content-Length`, only 50 % of the body, then the connection ends |
| `seg_corrupt` | `{"fault":"seg_corrupt",P,"target":"init","params":{"mode":"box"}}` | same length; `mdat` flips payload bytes, `box` breaks the first box size, `garbage` random bytes |
| `rendition_status` | `{"fault":"rendition_status",P,"rendition":"2","params":{"status":404}}` | that audio rendition's playlist/segments: 404 `unknown_audio_rendition` / 500 `rendition_split_failed` |
| `split_abort` | `{"fault":"split_abort",P,"rendition":"1","params":{"afterBytes":500}}` | 200 headers, then abort (the product's split-failure path) |
| `subtitle_status` | `{"fault":"subtitle_status",P,"rendition":"3","params":{"status":404}}` | 404 `unknown_subtitle_stream` for subtitle stream 3 |
| `subtitle_corrupt` | `{"fault":"subtitle_corrupt",P,"params":{"mode":"timing"}}` | `header` drops `WEBVTT`, `timing` writes invalid cue times |
| `content_type` | `{"fault":"content_type",P,"target":"master","params":{"value":"text/html"}}` | replaces `Content-Type` (master, media, video, subtitle) |
| `playlist_endless` | `{"fault":"playlist_endless",P,"params":{"segments":3},"mode":"always"}` | media (or `audio`) playlist without `ENDLIST`/`VOD`, first N segments, never grows |
| `playlist_event_stale` | `{"fault":"playlist_event_stale",P,"params":{"segments":4},"mode":"always"}` | `PLAYLIST-TYPE:EVENT`, first N segments, no growth |
| `early_end` | `{"fault":"early_end",P,"target":"video","params":{"atSeconds":12},"mode":"always"}` | HLS: segments starting at/after 12 s answer 404 `end_of_stream`; `direct`: the body ends at the byte offset of 12 s, later ranges 416 |
| `throttle` | `{"fault":"throttle",P,"target":"direct","params":{"kbps":800},"mode":"always"}` | paced body (video, audio, direct) |
| `direct_status` | `{"fault":"direct_status",P,"params":{"status":429}}` | 429 `stream_capacity` + `Retry-After: 1`; 404 `unknown_stream`; 416 with `Content-Range: bytes */<size>`; 500 |
| `direct_reset` | `{"fault":"direct_reset",P,"params":{"afterBytes":100000}}` | reset after N bytes of that response |
| `direct_truncate` | `{"fault":"direct_truncate",P,"params":{"percent":50},"mode":"always"}` | never a byte past 50 %; a range starting beyond answers 416 |
| `usenet_hole` | `{"fault":"usenet_hole",P,"params":{"fromPercent":40,"toPercent":60}}` | mock Usenet answers 430 for those articles of the largest file. Before the start (scope `workId`) the server's health check finds it (`release_dead`). Mid-play it hits only bytes the server has not read ahead yet (Dev World files are small, so mostly before the start) |
| `usenet_stall` | `{"fault":"usenet_stall","scope":{"workId":"…"},"params":{"ms":1500}}` | holds article bodies for `ms` (until cleared without `ms`) |
| `transcode_kill` | `{"fault":"transcode_kill",P,"params":{"signal":"KILL"},"after":{"segment":5}}` | kills the playback's ffmpeg (now, or on the first segment request matching `after`). The product restarts it or answers 500 `transcode_failed` |
| `transcode_slow` | `{"fault":"transcode_slow","scope":{"next":"anna"},"params":{"readrate":0.5}}` | the next ffmpeg session run of the scope gets `-readrate 0.5` (`always` keeps it for restarts) |
| `transcode_never_start` | `{"fault":"transcode_never_start","scope":{"next":"anna"},"params":{"code":"transcode_capacity"}}` | HLS start throws that code (503 for capacity codes, else 500). The server then falls through or fails |
| `start_hang` | `{"fault":"start_hang","scope":{"next":"anna"},"params":{"seconds":30}}` | the playback stays `starting` |
| `probe_fail` | `{"fault":"probe_fail","scope":{"next":"anna"}}` | the probe reads nothing: `failed probe_failed` (or a VLC direct play when available) |
| `stream_dead` | `{"fault":"stream_dead",P}` | the stream capability reports dead on the next switch: the server re-resolves |
| `resolve_hang` | `{"fault":"resolve_hang","scope":{"next":"anna"},"params":{"seconds":30}}` | the playback stays `resolving` |
| `resolve_dead` | `{"fault":"resolve_dead","scope":{"next":"anna"}}` | the resolve reports the release dead: `failed release_dead` |
| `api_status` | `{"fault":"api_status","scope":{"next":"anna"},"target":"api:start","params":{"status":409,"code":"too_many_streams","params":{"device":"Wohnzimmer-TV","limit":"1"}}}` | short-circuit with the envelope; `retryAfter`; `"body":"html"` for a non-JSON answer |
| `api_delay` | `{"fault":"api_delay",P,"target":"api:poll","params":{"ms":25000}}` | delays the API call (start timeout: > 20000) |
| `api_drop` | `{"fault":"api_drop",P,"target":"api:poll"}` | connection aborted before any byte |
| `playback_stuck` | `{"fault":"playback_stuck",P,"params":{"state":"starting","seconds":30},"mode":"always"}` | polls report `starting`, `pollAfterMs: 500`, no URL, for 30 s |
| `playback_failed` | `{"fault":"playback_failed",P,"params":{"code":"transcode_failed","suggestedActions":["retry"]}}` | the poll answer becomes `state: failed` with that error |
| `captive_portal` | `{"fault":"captive_portal","scope":{"viewer":"anna"},"mode":"always"}` | `200 text/html` "Hotel Wi-Fi" page for the viewer's API, media and refresh requests |
| `token_expire` | `{"fault":"token_expire","scope":{"viewer":"anna"}}` | the newest session's access token expires (`params.session:"all"` for all). The next call answers 401 and the client refreshes |
| `refresh_fail` | `{"fault":"refresh_fail","scope":{"viewer":"anna"},"params":{"code":"refresh_session_revoked","reason":"session_limit"}}` | refresh answers that 401 (`refresh_token_reused`, `refresh_session_expired`, `refresh_token_unknown`), or `status: 500`, `drop: true`, `delayMs` |
| `session_revoke` | `{"fault":"session_revoke","scope":{"viewer":"anna"},"params":{"reason":"password_changed"}}` | revokes the newest session with that reason. The next call answers 401, and the product's own refresh answers `refresh_session_revoked` with `params.reason` |
| `password_change` | `{"fault":"password_change","scope":{"viewer":"anna"}}` | the account must change its password: `403 password_change_required` (clearing the fault resets it) |
| `playback_gone` | `{"fault":"playback_gone",P,"mode":"always"}` | closes its HLS session and stream capability, and its poll/switch/stop answer 404 `playback_not_found` |

Two scenarios need their own Dev World (never the shared 39300):

- **Server restart:** `scripts/devworld.sh start 39330 --tree`, start a playback, `scripts/devworld.sh restart 39330 --tree --keep-data`.
  Sessions survive; the playback answers 404 `playback_not_found` and its URLs are gone.
- **Short idle expiry:** `DEVWORLD_PLAYBACK_IDLE_SECONDS=60 scripts/devworld.sh start 39330 --tree` (minimum 60 s).
  The server then expires idle playbacks after 60 s instead of 600 s.

`tools/faults_smoke.py [base-url] [--only a,b] [--json out.json]` arms every fault against fresh playbacks of the default
movies (viewers anna, kind, gast) on a fresh Dev World, checks the wire behaviour with plain HTTP and prints one line per
fault. Its helpers (`arm`, `clear`, `start_playback`, `raw`) are meant for reuse by client test scripts.

`tools/playback_robustness_check.py [base-url] [--only a,b]` uses those helpers for the playback robustness checks:
a slowed transcode answers `504 segment_timeout` + `Retry-After` within the 25 s wait budget, a seek back behind the
retained window restarts the run (retention set to 60 s for the check, then restored), `playbackAlive` in progress
answers, and `/switch {audioFallback}` delivering AAC stereo (ffprobe). About 90 s on a fresh instance.

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
  byte for byte against its file;
- the fault layer (`Faults/`): path classification, targets, scopes (`next` binding, isolation), modes, TTL,
  global exclusivity, redaction, body rewrites, and a boot that arms API/auth faults over HTTP. The media faults
  run live in `tools/faults_smoke.py`.

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
| `DEVWORLD_KEEP_DATA` | `1` (script: `--keep-data`) keeps the state dir's database and keys; seeded viewers are reused, scratch dirs (nzb, transcode, repair) are recreated |
| `DEVWORLD_CATALOG` | `fixtures/catalog.json` in the build output |
| `DEVWORLD_GEN_JOBS` | `2` parallel ffmpeg jobs |
| `DEVWORLD_LOG_LEVEL` | `Warning` |
| `DEVWORLD_CHECK_RELEASES` | `1` resolves every release at boot and fails unless each matches its designed health (set by `publish`) |
| `DEVWORLD_PRIMARY` | `1` also writes `cache/devworld.json` on a non-39300 port |
| `DEVWORLD_SNAPSHOT_ROOT` | `~/.cache/streamarr-devworld` (script: where `publish` puts snapshots) |
| `DEVWORLD_FAULTS` | on; `0` registers no fault layer at all |
| `DEVWORLD_PLAYBACK_IDLE_SECONDS` | unset (product default 600); overrides the viewer playback idle expiry, min 60 |
| `DEVWORLD_FFMPEG` | the `ffmpeg` on `PATH`; the real binary the fault wrapper execs |
| `DEVWORLD_PUBLISH_PORT` | `39319` (script: scratch port for the publish boot check) |

`--generate-only` generates/validates the media and exits (used by `publish`).
