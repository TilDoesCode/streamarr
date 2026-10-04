# B12 — Dev World fault injection (spec for the backend agent)

Source: F10a research (`F10-research.md` in this folder). PLAN § 5 "I": "arm faults per playback or globally (Dev
World only, never in the product build)". Everything below lives in `server/tests/Streamarr.DevWorld/Faults/**`
(plus one wrapper script in `server/tests/Streamarr.DevWorld/tools/`). **No file under `server/src/` changes.**
The product server must not reference, register or ship any of it.

## 1. Goals

- Reproduce every delivery/API/auth failure of the F10 state matrix on demand, on a running Dev World, for **one
  playback** at a time, so several agents can share a Dev World without hitting each other's sessions.
- Each fault is armed over HTTP, observable (hit counter + log + response header) and removable.
- Each fault has an automated check (§ 6) proving it produces exactly the documented wire behaviour.

## 2. API (Dev World only)

Anonymous like the other `/devworld/*` routes (`DevWorldHttp.cs:53-90`), CORS through `UseDevWorldCors`
(add `/devworld/faults` under the existing `/devworld` prefix — already covered). Hidden from OpenAPI.

| Method / path | Body / result |
|---|---|
| `POST /devworld/faults` | `FaultRequest` → `201 { id, fault, scope, expiresAt }`; `400 invalid_fault` with the reason |
| `GET /devworld/faults` | `[{ id, fault, scope, target, params, mode, hits, remaining, armedAt, expiresAt }]` |
| `GET /devworld/faults/{id}` | One fault incl. the last 20 hits `{ at, method, path (tokens redacted), status }` |
| `DELETE /devworld/faults/{id}` | `204` |
| `DELETE /devworld/faults` | `204`, clears all (optional `?scope=playbackId:…` to clear one playback) |
| `GET /devworld/playbacks` | Known playbacks learned by the fault layer: `[{ playbackId, workId, viewer, method, engine, hlsToken?, streamToken?, revision, lastSeen }]` (tokens shown, it is Dev World) |

```jsonc
// FaultRequest
{
  "fault": "seg_status",                 // § 4
  "scope": { "playbackId": "…" },        // or { "workId": "…" } | { "viewer": "anna" } | { "next": "anna" } | { "global": true }
  "target": "video",                     // media faults: master | media | init | video | audio | subtitle | direct | api:<name>
  "rendition": "2",                      // optional: audio rendition id / subtitle stream index
  "params": { "status": 500, "code": "transcode_failed" },
  "mode": "once",                        // once | always | { "count": 3 }
  "after": { "segment": 20 },            // optional: { "segment": N } | { "requests": N } | { "secondsAfterReady": N } | { "bytes": N }
  "ttlSeconds": 900                      // safety expiry, default 900, max 7200
}
```

Scopes: `playbackId` (the normal case), `workId` (any playback of that title, resolved at its first `ready`), `viewer`
(every request of that viewer: auth faults), `next` (the next playback the viewer starts: start/API faults before a
playbackId exists, becomes a `playbackId` scope on the first answer), `global` (every request; refused while another
fault with `global` is armed, to keep runs one-fault-at-a-time).

Every faulted response carries `X-DevWorld-Fault: <id>`; every hit logs one Information line
`DevWorld fault <id> <fault> hit <METHOD> <path-with-tokens-redacted> → <status|action>`.

## 3. Where the hooks sit

| Hook | What it does | Faults |
|---|---|---|
| **H1 `DevWorldFaultMiddleware`** registered in `DevWorldHost.Build` between `UseDevWorldCors()` and `UseStreamarrServer()` (`DevWorldHost.cs:84-88`), i.e. before routing and before the product's request logging (`StreamarrServerBootstrap.cs:414`) | Matches by path, delays, short-circuits with a status/envelope, or wraps `Response.Body` (truncate, corrupt, throttle, reset via `HttpContext.Abort()`), rewrites playlists and `Content-Type` | all media and API faults |
| **H2 playback map** inside H1 | Learns `playbackId → workId, viewer, method, url token, revision` by tee-reading the JSON of `POST /api/v1/viewer/playback`, `GET …/playback/{id}`, `POST …/switch` (same buffering technique as `DevWorldArtwork.JsonBuffer`, `DevWorldArtwork.cs:66-115`); `viewer` from the bearer token via the product's auth result after `next()` (or the session table) | scoping |
| **H3 `IPlaybackMedia` decorator** (`RemoveAll` + decorate the registration at `ViewersServiceCollectionExtensions.cs:59`; port in `PlaybackPorts.cs:24-42`) | `StartHlsAsync` throws `TranscodeException(code, msg, status)` or hangs; `ProbeAsync` fails; `StreamAlive` false | `transcode_never_start`, `start_hang`, `probe_fail`, `stream_dead` |
| **H4 `IPlaybackResolver` decorator** (`ViewersServiceCollectionExtensions.cs:58`) | Resolve hangs / returns dead | `resolve_hang`, `resolve_dead` |
| **H5 ffmpeg wrapper** `tools/ffmpeg-fault.sh`, set as `Streamarr:Transcoding:FfmpegPath` in Dev World's in-memory config (`TranscodingOptions.cs:8`; Dev World overrides config at `DevWorldHost.cs:35-75`) | Pass-through `exec` of the real ffmpeg by default (capability probe untouched). Writes `pid → output dir` to `$DEVWORLD_STATE/ffmpeg-pids/`; reads `$DEVWORLD_STATE/ffmpeg-faults/<session-dir-name>` to add `-readrate <x>` before `-i` (slow) | `transcode_kill`, `transcode_slow` |
| **H6 session store** (Dev World resolves `StreamarrDbContext` from DI) | Sets `AccessExpiresAt = now` or `RevokedAt/RevokedReason` on the viewer's session row (the same columns `ViewerSessionService` reads, `ViewerSessionService.cs:94-106,152-153`) | `token_expire`, `session_revoke` |
| **H7 product endpoints** (no new code) | `DELETE /api/v1/transcode/{token}` (anonymous, `TranscodeStreamController.cs:223-233`) and `POST /api/v1/sessions/{token}/close` (`SessionsController.cs:20-28`) to kill a playback's HLS or direct capability | `playback_gone` |
| **H8 `MockNntpServer` knobs** (instance created at `Program.cs:41`; `RejectBodies`, `BodyScripts`, `BodyGates`, `StatScripts`, `MockNntpServer.cs:44-92`) | Usenet holes and stalls under a direct play / remux | `usenet_hole`, `usenet_stall` |

**Loopback caveat (must):** ffmpeg, ffprobe and the keyframe reader fetch `/api/v1/stream/{token}` over loopback
with `User-Agent: Streamarr-Transcoder/1` (`FfmpegArgumentBuilder.cs:32,61,117`; `TranscodeSourceResolver.cs:20`).
`direct_*` faults must skip those requests (UA match **and** loopback remote address) unless the fault sets
`params.internal: true` (then it targets the server's own reads, e.g. a source that breaks under a remux).

## 4. Faults

Status/code pairs use the product's real envelope (`{ "error": { "code", "message", "params" } }`) so the client sees
what the server would send.

### 4.1 HLS (remux / transcode, `/api/v1/transcode/{token}/…`)

| Fault | Target(s) | Params | Wire behaviour | Matrix rows |
|---|---|---|---|---|
| `seg_delay` | video, audio, subtitle, init | `ms` | Wait `ms` before passing to the product | C05, C08, D29 |
| `seg_stall` | same | `seconds` (default: until the client disconnects) | Hold the request open without a byte; then `504 segment_timeout` if `respond: true` | C08, C09, D15, D19 |
| `seg_status` | master, media, init, video, audio, subtitle | `status`, `code`, `retryAfter?` | Short-circuit with the envelope (e.g. `404 unknown_transcode`, `404 unknown_segment`, `404 end_of_stream`, `410 session_closed`, `500 transcode_failed`, `503 segment_unavailable`, `503 segment_evicted` without `Retry-After`, `504 segment_timeout`) | C10, C11, C13–C15, C21, D01, B25 |
| `seg_reset` | video, audio, init, subtitle | `afterBytes` | Pass through, `HttpContext.Abort()` after `afterBytes` (connection reset) | C05, C16 |
| `seg_truncate` | video, audio | `percent` | Send the real `Content-Length`, write only `percent` % of the body, then complete | C16 |
| `seg_corrupt` | video, audio, init | `mode`: `mdat` (flip bytes inside `mdat`), `box` (break the first box size), `garbage` (random bytes, same length) | Rewrite the body | C17, D02, D12 |
| `rendition_status` | audio | `rendition`, `status`, `code` (`404 unknown_audio_rendition`, `500 rendition_split_failed`) | As `seg_status` for one rendition's playlist and segments | C19, C20 |
| `split_abort` | audio | `rendition`, `afterBytes` | Abort after headers were sent (the product's own split-failure path, `TranscodeStreamController.cs:157-166`) | C20 |
| `subtitle_status` | subtitle | `rendition` (= stream index), `status`, `code` (`404 unknown_subtitle_stream`) | As `seg_status` | C22 |
| `subtitle_corrupt` | subtitle | `mode`: `header` (drop `WEBVTT`), `timing` (invalid cue times) | Rewrite the `.vtt` | C23 |
| `content_type` | master, media, video, subtitle | `value` (e.g. `text/html`, `application/octet-stream`) | Replace `Content-Type` | C25 |
| `playlist_endless` | media (+ audio) | `segments` (default 10) | Rewrite the media playlist: drop `#EXT-X-ENDLIST` and `#EXT-X-PLAYLIST-TYPE:VOD`, list only the first `segments` entries, never more | C12 |
| `playlist_event_stale` | media | `segments` | `#EXT-X-PLAYLIST-TYPE:EVENT`, first `segments` entries, no growth | C12 |
| `early_end` | media, video, direct | `atSeconds` | HLS: segments at or after `atSeconds` answer `404 end_of_stream`; direct: the body ends at the byte offset of `atSeconds` (from bitrate) | C13, C31, C32, D26 |
| `throttle` | video, audio, direct | `kbps` | Paced body writes (token bucket) | C03, C04, D29 |

### 4.2 Direct play (`/api/v1/stream/{token}`, player requests only)

| Fault | Params | Wire behaviour | Matrix rows |
|---|---|---|---|
| `direct_status` | `status`, `code` (`404 unknown_stream`, `416`, `429 stream_capacity` + `Retry-After: 1`, `500`) | Short-circuit (for `416`: `Content-Range: bytes */<length>`) | C01, C02, B05 |
| `direct_reset` | `afterBytes` (per response) | Abort the connection | C05 |
| `direct_truncate` | `percent` of the file | Responses never deliver bytes past `percent`; a range starting beyond it gets `416` | C02, C31, C32 |
| `throttle` (above) | `kbps` | | C03 |
| `usenet_hole` | `fromPercent`, `toPercent` | H8: `BodyScripts` → `Missing` for the articles of that range (the product then waits on repair up to 90 s, `RepairAwareStream.cs:67-124`) | C04 |
| `usenet_stall` | `ms` | H8: `BodyGates` hold article bodies | C03, C04 |

### 4.3 Transcode process (H3, H5)

| Fault | Params | Behaviour | Matrix rows |
|---|---|---|---|
| `transcode_kill` | `signal` (`KILL` default, `TERM`), `after` (`segment`/`secondsAfterReady`) | Kill the ffmpeg PID(s) recorded for the playback's session dir; the product then answers `500 transcode_failed` / restarts (`TranscodeSessionManager.cs:369-373,498-525`) | C07 |
| `transcode_slow` | `readrate` (e.g. `0.5`) | Next ffmpeg run of the session starts with `-readrate` (output slower than real time); `always` keeps it for restarts | C08, D29 |
| `transcode_never_start` | `code` (`transcode_failed`, `ffmpeg_unavailable`, `transcode_capacity`, `remux_capacity`), `status` | H3 throws on `StartHlsAsync` for the scope (`next`/`workId`) → server falls through or fails with the mapped code | B08, B09, C06 |
| `start_hang` | `seconds` | H3 `StartHlsAsync` awaits before calling the product → playback stays `starting` | B16, D39 |
| `probe_fail` | — | H3 probe throws → `probe_failed` (or VLC direct when available) | B06 |
| `resolve_hang` / `resolve_dead` | `seconds` | H4 | B06, B16 |

### 4.4 Playback API (H1, `target: api:<name>`)

| Fault | Target | Params | Behaviour | Matrix rows |
|---|---|---|---|---|
| `api_status` | `api:start`, `api:poll`, `api:switch`, `api:stop`, `api:progress` | `status`, `code`, `params`, `retryAfter`; `body: "html"` for a non-envelope answer | Short-circuit (e.g. `409 too_many_streams {device:"Wohnzimmer-TV", limit:"1"}`, `429 too_many_playbacks`, `500`, `503 catalog_unavailable`, `404 playback_not_found`, `403 age_restricted`) | B01–B05, B13, B15, B17–B21, B23 |
| `api_delay` | same | `ms` | Delay (start timeout: `ms` > 20000) | B14, B15 |
| `api_drop` | same | — | `HttpContext.Abort()` before any byte (transport error) | A02, B15, B20, B21 |
| `playback_stuck` | `api:poll` | `state` (`resolving`/`planning`/`starting`), `seconds` | Rewrite poll answers to report `state` and `pollAfterMs: 500` for `seconds` | B16 |
| `playback_failed` | `api:poll` (or the first answer after a switch) | `code`, `params`, `suggestedActions` | Rewrite to `state: failed` with that error | B06–B11 |
| `captive_portal` | `global` for the viewer's media + API | — | `200 text/html` "Hotel Wi-Fi" page for every request of the scope | A26 |

### 4.5 Auth and lifecycle (H6, H7)

| Fault | Params | Behaviour | Matrix rows |
|---|---|---|---|
| `token_expire` | `viewer` | H6: `AccessExpiresAt = now` on that viewer's newest session → next API call `401 unauthorized` → client refresh | A01 |
| `refresh_fail` | `code` (`refresh_token_reused`, `refresh_session_expired`, `refresh_session_revoked` + `reason`, `refresh_token_unknown`), or `status: 500`, or `drop: true`, `delayMs` | H1 on `POST /api/v1/viewer/auth/refresh` for the viewer (refresh tokens carry no viewer id: scope by the cookie/body token's session via H2 lookup, or `global`); combine with `token_expire` to trigger at once | A02–A06 |
| `session_revoke` | `viewer`, `reason` (`signed_out`, `revoked_by_viewer`, `session_limit`, `admin`, `password_changed`, `account_disabled`, `token_reused`, `other`) | H6: revoke the session row with that stored reason (+ `token_expire`) → the product's own refresh answers `refresh_session_revoked` with the reason | A04, A06 |
| `password_change` | `viewer` | Set the account's "must change password" flag → `403 password_change_required` | A07 |
| `playback_gone` | `playbackId` | H7: close its HLS session / stream capability **and** answer `404 playback_not_found` for its poll/switch/stop (H1) — simulates idle expiry or a restart for one playback | A09, B17, B24, B25, C10 |
| server restart | — | Real restart: `scripts/devworld.sh restart <port> --keep-data` on a **dedicated port** (e.g. 39330), never on the shared 39300 | B25 |
| short idle expiry | env `DEVWORLD_PLAYBACK_IDLE_SECONDS` (new, Dev World config override of `Streamarr:ViewerPlaybackIdleSeconds`) | Boot a dedicated Dev World with 60 s idle to test A09/E17 in minutes | A09, E17 |

## 5. Implementation notes

- Registry: `FaultRegistry` singleton (thread-safe list, `TimeProvider` for TTL/`secondsAfterReady`), `FaultMatcher`
  (path templates of § 3 of `F10-research.md`/Dev World report: `master.m3u8`, `main.m3u8`, `init.mp4`,
  `{n}.m4s`, `audio/{r}/…`, `subtitles/{s}/…`, `/api/v1/stream/{token}`, `/api/v1/viewer/playback…`,
  `/api/v1/viewer/watch/progress`, `/api/v1/viewer/auth/refresh`).
- Opt-out: `DEVWORLD_FAULTS=0` registers nothing (middleware, decorators and the ffmpeg wrapper are all skipped).
- The ffmpeg wrapper must be POSIX `sh`, `exec` the real binary (resolved from `PATH` or `DEVWORLD_FFMPEG`), and keep
  stdin/stdout untouched (the remux reads ffmpeg's stdout, `RemuxSegmenter`).
- The middleware never logs tokens (redact the path segment after `/stream/` and `/transcode/`).
- Document the API in `server/tests/Streamarr.DevWorld/README.md` (endpoints table + the § 4 tables in short).

## 6. Verification

1. **Unit tests** (`server/tests/Streamarr.DevWorld.Tests/Faults/*`): `FaultMatcher` path cases, scope resolution
   (`next` → `playbackId`), modes (`once`/`count`/`always`), TTL expiry, `global` exclusivity, token redaction.
2. **Boot tests** (pattern of `DevWorldBootTests.cs:126-156`, real server on a free port, `FakeWorld` media where
   ffmpeg is not needed): for every fault in § 4 one test that arms it, performs the triggering request(s) and asserts
   the exact status, envelope code, headers (`Retry-After`, `Content-Type`, `X-DevWorld-Fault`), body change
   (truncated length, corrupted bytes differ, playlist without `ENDLIST`) and that the next request after a `once`
   fault is normal again. ffmpeg-dependent faults (`transcode_kill`, `transcode_slow`) are marked with the existing
   ffmpeg test category and assert: kill → next segment `500 transcode_failed`, after 30 s a restart serves it; slow
   → measured segment production rate < 1× real time.
3. **Isolation test**: two playbacks of two viewers; a fault scoped to playback A never changes B's responses.
4. **Product isolation check**: `git grep -n "DevWorld" server/src` stays empty; the product `Program.cs` build has no
   reference to `Streamarr.DevWorld`.
5. **Live smoke** `tools/fault_check.py <base-url>`: arms each fault against a fresh playback of the Dev World's
   default movie (anna), checks the wire behaviour with plain HTTP (no player), clears, prints one line per fault.
6. Journal `docs/client/journal/B12.md` with the table of faults → test name → live smoke result.
