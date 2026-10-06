# F10a — Player state matrix and design (research, no devices)

Round I, task F10a. Researched 2026-10-05 00:57–01:20 from the code (client `client/src/player/**`,
`client/src/screens/player/**`, `client/src/api/**`, `client/src/accounts/session.ts`; server read-only:
`Viewers/Playback/**`, `Transcoding/**`, `StreamController`, `docs/api.md` §5/§11/§13, `docs/transcoding.md`;
Dev World `server/tests/Streamarr.DevWorld/**`) and the journals M3.1, M4.2, F5, F8, I1, I2, I3, P1, P2, R3, Q1,
B11 and BACKLOG "Player" / "Needs real hardware". No device, Metro, build or dotnet run was used.

Binding requirement (PLAN § 5 "I", 2026-10-05 00:50): the viewer never sees a generic error, a black screen or a
frozen picture. Every state is compensated automatically or explained with a specific hint (what happened, what the
app does, what the viewer can do).

Companion files: `B12-spec.md` (Dev World fault injection), `../../player-states.html` (German overview for the
user), `../../journal/F10.md`.

Engine shorthands: **hls.js** = web engine on MSE (Chrome, Edge, Firefox, Android Chrome); **Safari** = web engine
with native HLS (`WebEngine.mode === 'native'`); **Exo** = expo-video on Android/Google TV (ExoPlayer / media3);
**AVP** = expo-video on iPhone/iPad/Apple TV (AVPlayer); **VLC** = expo-libvlc-player (libVLC on Android, VLCKit 4
on Apple). Severity: **P1** = generic text, black or frozen picture today; **P2** = wrong or unclear message, or a
wrong compensation; **P3** = handled, but improvable; **OK**. Hint keys (`H.*`) are defined in Design § b.4.

---

## 0. The ten findings that matter most

1. **No buffering or loading indicator exists once the server says `ready`.** `attach()` sets `phase = 'playing'`
   before the engine has loaded anything (`controller.ts:315`); the stepper disappears (`play-screen.tsx:283`) and the
   overlay shows over the `Surface`. Engine `loading`/`buffering` states and `buffering` events are only consumed by
   `MetricsRecorder` (`metrics.ts:161-168`) — nothing in `screens/player/**` reads them (grep: no "buffer"). Every
   start, seek into unbuffered media, slow segment and network stall is a black or frozen picture without a word
   (P2:105 measured 12–16 s of black at "0:00" on remux cold starts).
2. **Every engine error is treated as "this method does not work on this device".** `engine 'error' → stepDown()`
   (`controller.ts:276`, `417-432`) moves to the next method (direct → remux → VLC → transcode) even when the cause is
   the network, an expired session or a server restart. A 20 s Wi-Fi gap can turn a direct play into a transcode with
   the notice "Switched to transcoding to keep playing."; offline it ends on "Can't reach the server".
3. **hls.js media errors loop.** Every fatal `MEDIA_ERROR` calls `hls.recoverMediaError()` again, with no budget and
   no `swapAudioCodec()` step (`web-engine.web.tsx:301-304`). A codec the browser cannot decode
   (`bufferAddCodecError`) or a corrupt segment freezes the picture for good, silently.
4. **Early end-of-stream is swallowed.** `onEnded()` ignores an `ended` more than 3 s before the duration
   (`controller.ts:396-403`, a guard against expo-video's `playToEnd` during a source change). A truncated file, a
   remux that stops early, a libVLC `Stopped` (`vlc-engine.tsx:97-103`) or a zero-length file leaves a frozen last
   frame (or black) with the overlay claiming it plays.
5. **System pauses are not adopted on native engines.** Only the web engine reports `userPlayback`
   (`web-engine.web.tsx:384-388`). AVPlayer/ExoPlayer pausing for a phone call, another app's audio, unplugged
   headphones, a closed PiP window or a dropped AirPlay route leaves `controller.paused === false`: the overlay shows
   "Pause", auto-hides after 5 s (`player-overlay.tsx:167-172`) and the viewer looks at a frozen picture.
6. **The frame watchdog exists only for VLC on Android, and misses the black case.** `checkStall` needs
   `displayedPictures > 0` (`vlc-engine.tsx:162`) and `started` (set from the clock, `:136-143`); `getStats` exists only
   in the Android patch. A VLC picture that never appears, every AVPlayer/ExoPlayer/web black or frozen picture, and
   silent audio are undetected.
7. **Server-side session loss is fatal instead of transparent.** The server ends a playback after 600 s without
   activity and on every restart (playbacks are in memory, `ViewerPlaybackService.cs:258-281`, `:305-310`); HLS URLs
   then answer `404 unknown_transcode`. The client steps down, `/switch` answers `404 playback_not_found`, the viewer
   gets "Playback ended — start it again". `POST /watch/progress` with a dead `playbackId` still answers 200
   (`ViewerPlaybackService.cs:240-242`), so the client never notices from heartbeats.
8. **A segment can block 90 s on the server, hls.js gives up after 10 s.** `SegmentWaitTimeoutSeconds = 90`
   (`TranscodingOptions.cs:17`, up to 4 waits) vs hls.js `fragLoadPolicy.maxTimeToFirstByteMs = 10000` with 4 timeout
   retries (hls.js 1.7.3 defaults). A transcode slower than real time becomes a silent ~50 s freeze, then a step-down.
   Probable server bug found on the way: seeking back > 15 min inside one long run waits on a run that will never
   rewrite the deleted segment (`TranscodeSessionManager.cs:358-366`, `:614-633`) → 90 s hang → `504`.
9. **Codes without client text show the generic "Something went wrong".** `describeError` maps every code outside
   `error-codes.ts` to `unknown` (`error-text.ts:16`). Missing today: B11's `refresh_session_revoked` (+ `reason`) and
   `refresh_token_unknown` (the session gate then shows a generic title, `profiles-screen.tsx:117-118`); any future
   server code and `loadDeviceCaps` failures (`play-screen.tsx:128-130`) are generic too.
10. **The step-down chain forgets why.** The notice keys ignore `params.reason` (`overlay-labels.ts:186-189`), and the
    final card says "No more options — every playback method was tried" (`no_more_methods`) without the engine
    errors that led there (I1: `-12927` was only visible through a temporary `console.warn`).

---

## 1. State matrix

Columns: **Detected today** (file:line) · **Compensation today** · **Viewer sees today** · **Gap** · **Target**
(detection → ladder → hint + action; ladder steps are named in Design § b.2) · **Sev**.

### A — App, auth, device and OS

| ID | State | Detected today | Compensation today | Viewer sees today | Gap | Target | Sev |
|---|---|---|---|---|---|---|---|
| A01 | Access token expires mid-play | 401 on the next API call; `createAuthMiddleware` refreshes and replays once (`api/client.ts:41-69`) | Transparent; media URLs are capability paths without auth (`api.md` §13 "url is a capability path"; `StreamController.cs:18-38`) | Nothing (correct) | — | Keep; covered by B12 `token_expire` regression test | OK |
| A02 | Refresh fails transiently (offline, 5xx, timeout) mid-play | `session.ts:120-123,139` keeps the session, rethrows the transport error | Heartbeats queue (`progress-queue.ts:27-30`); a user switch fails → `restore()` | Nothing while playing; a switch shows `switchFailed` or a failure card | Switch during the outage kills a working stream (see B25) | T1 transport ladder; never touch the running source | P3 |
| A03 | Refresh refused: `refresh_session_expired` | `session.ts:142-147` → `store.signOut(id, code)` | Session gate unmounts the player; `stop()` reports `stop` → 401 → dropped (`progress-queue.ts:28-30`, 4xx is final) | Player vanishes; profiles screen shows "Your session has ended" | Abrupt exit, no player-side explanation; last ≤ 10 s of position lost | Player catches `onSessionEnded`: pause, save position locally, card `H.signedOut` with "Sign in again"; queue keeps 401 reports per account and flushes after re-sign-in | P2 |
| A04 | Refresh refused: `refresh_session_revoked` + `reason` (`signed_out`, `revoked_by_viewer`, `session_limit`, `admin`, `password_changed`, `account_disabled`, `token_reused`, `other`) / `refresh_token_unknown` (B11, `ViewerAuthController.cs:136-150`) | Same as A03 | Same as A03 | **Generic** "Something went wrong" title on the profiles screen (codes missing in `error-codes.ts:18-96`; B11:110-113) | Codes and reasons unknown to the client | Add both codes + one text per `reason`; `H.signedOut` names the reason ("Signed out on another device", "Password changed", "Account disabled", "Too many devices") | P1 |
| A05 | Refresh refused: `refresh_token_reused` | Same as A03 | Same as A03 | Player vanishes; "Signed out for your security" | Same as A03 | Same as A03 | P2 |
| A06 | Account disabled mid-play | Access token stays valid up to 60 min; then refresh → `refresh_session_revoked/account_disabled` | As A04 | As A04 (generic) | As A04 | As A04 | P1 |
| A07 | `password_change_required` (403) mid-play | `api/client.ts:54-59` → `session.passwordChangeRequired()` | Gate shows the change-password screen; player unmounts | Player vanishes | No player-side hint, position not reported if the stop call is refused | Pause, save position, `H.signedOut` variant "Change your password to continue" | P2 |
| A08 | App backgrounded, no PiP (TV, web tab, VLC, paused) | `AppState` listener (`controller.ts:187-193`) | `report('progress')` + `setPaused(true)` | Paused overlay on return | OK for short absences; long absences see A09 | Keep | OK |
| A09 | Backgrounded > 600 s (iOS/tvOS suspend JS timers: no heartbeats) | Nothing on return (`state === 'active'` only flushes the queue, `controller.ts:188`) | Server idle sweep ends the playback and closes HLS (`ViewerPlaybackService.cs:258-281`); on Play: segment `404 unknown_transcode` → engine error → `stepDown` → `/switch` `404 playback_not_found` → `fail` | Failure card "Playback ended — start it again" | Server-side end is never revalidated; restart is manual and asks resume again | On foreground: `GET …/playback/{id}`; 404 → ladder step **N** (silent new start at `lastGoodPosition`, same release/tracks) with `H.restarting` | P2 |
| A10 | Backgrounded with PiP (phones, expo-video) | `pip` event (`controller.ts:289-291`), PiP reports from time events (`:287-288`) | Keeps playing, heartbeats from engine time | PiP window | — | Keep | OK |
| A11 | OS kills the app (background or memory) | — | Last report at backgrounding | Next start offers resume | Up to one heartbeat lost | Keep; resume prompt already covers it | OK |
| A12 | Device lock / sleep while playing (phone, no PiP) | AVPlayer/Exo pause natively → `playingChange` → engine `paused` (`expo-video-engine.tsx:93-98`); controller not told | none | After unlock: overlay hidden, frozen picture, play icon says "Pause" | System pause not adopted (no `userPlayback` from expo-video) | Engine emits `userPlayback {paused, cause}` for every pause it did not ask for; hint `H.pausedBySystem` ("Paused — screen locked") + Play | P1 |
| A13 | Audio focus lost (phone call, Siri, alarm, other app plays audio) | Same as A12 (AVAudioSession interruption / Android audio focus pause the player natively) | none; nothing resumes after the call | Frozen picture, overlay auto-hides after 5 s (`player-overlay.tsx:167-172`) | Not adopted, cause unknown, no resume offer | Patch expo-video to forward interruption begin/end (iOS `AVAudioSession.interruptionNotification`, Android `onAudioFocusChange`) → `userPlayback {cause:'interruption'}`; `H.pausedBySystem` ("Paused for a call") + Play; auto-resume when the OS says `shouldResume` | P1 |
| A14 | Headphones / Bluetooth disconnected ("becoming noisy") | Same as A12 (AVPlayer route change, ExoPlayer `handleAudioBecomingNoisy`) | none | Frozen picture, "Pause" icon | As A13 | `cause:'route'` → `H.pausedBySystem` ("Paused — headphones disconnected") | P1 |
| A15 | PiP start / stop via button or leaving the app | `pip` event | Overlay and notices hidden in PiP (`play-screen.tsx:169-171,323`) | PiP window | — | Keep | OK |
| A16 | PiP window closed by the viewer (✕) | iOS pauses the item when PiP closes from the window; only `pip:false` reaches JS | none | On return: frozen picture, "Pause" icon | Pause not adopted | `userPlayback {cause:'pipClosed'}`; return shows paused overlay | P2 |
| A17 | Failure while in PiP | `fail()` pauses the engine (`controller.ts:244-250`) | PiP keeps the last frame | Frozen PiP window, no text until the app is opened | PiP cannot show our card | Stop PiP on a terminal failure (`stopPictureInPicture`), keep the card for the return; Android/iOS PiP placeholder | P2 |
| A18 | AirPlay start (iPhone/iPad) | Nothing (`isExternalPlaybackActiveChange` not subscribed, `expo-video-engine.tsx:78-120`) | — | Local screen: black area under our overlay | No "playing on" state, picture checks would misfire | Subscribe; overlay shows `H.airplay` ("Playing on {device}"); watchdog skips picture checks | P1 |
| A19 | AirPlay receiver lost / turned off | AVPlayer falls back to local and pauses | none | Frozen picture, "Pause" icon | As A12 | `userPlayback {cause:'route'}` + `H.pausedBySystem` ("AirPlay disconnected") | P2 |
| A20 | Chromecast / Remote Playback API | Not offered (no cast button, web `<video>` without controls) | — | — | — | Not offered by design; no row work | OK |
| A21 | Low memory while playing (iOS memory warning, Android `onTrimMemory`) | Nothing | OS may kill the decoder or the app | Exo: decoder error → step-down (D18); app kill → A11 | Decoder reclaim treated as "method unsupported" | Classify `ERROR_CODE_DECODING_RESOURCES_RECLAIMED`/`MediaCodec.CodecException` reclaim as T6 (retry same at position first) | P3 |
| A22 | Rotation (phone) | `lockPlayerLandscape` (`play-screen.tsx:139-144`) | Engine untouched | Normal | — | Keep | OK |
| A23 | Network change Wi-Fi ↔ cellular (LAN-only server URL) | Engine fetch errors | hls.js retries 6× (5xx/offline) then fatal → `stepDown` → `/switch` fails `network_unreachable` → `fail` (`controller.ts:471-473`) | Frozen picture (no indicator) for up to a minute, then "Can't reach the server" card | Wrong ladder (step-down), no reconnect, no indicator | T1: detect via NetInfo + transport error class; `H.reconnecting`; retry same at position with backoff; give up after 2 min with `H.serverDown` card (Retry auto-fires when NetInfo says online) | P1 |
| A24 | Offline mid-play | As A23; AVPlayer can wait in `waitingToPlayAtSpecifiedRate` indefinitely (status `loading` → our `buffering`) | none on AVP; step-down on others | Frozen picture forever (AVP) or after ~1 min the network card | No offline detection in the player (no NetInfo use outside `query-client.ts:60`; `NoticeKind 'offline'` declared, never emitted, `controller.ts:40`) | NetInfo `isConnected === false` → `H.offline` banner at once; keep the engine; resume automatically on `online` | P1 |
| A25 | Back online after a failure | Nothing | Viewer must press Retry; Retry restarts the whole flow and asks resume (`play-screen.tsx:196`) | Card stays | No auto-recover | Online event → automatic ladder step **R**/**N** at `lastGoodPosition` | P2 |
| A26 | Captive portal / proxy answers HTML | Engines get 200 + HTML: hls.js `manifestParsingError`/`fragParsingError`, AVP `-12642`, Exo `ParserException` | step-down; `/switch` gets HTML → `unwrap` → `server_error` (`api/client.ts:106-116`) | "Server error" card | Wrong text | Classify "200 but not ours" (`not_streamarr`, probe `/api/v1/health` shape) → `H.serverDown` variant "The network intercepts the connection (sign-in page?)" | P2 |
| A27 | Device clock skew | `EXPIRY_SKEW_MS` against server `accessExpiresAt` (`session.ts:13`) | Early/late refresh; 401 → refresh fixes it | Nothing | — | Keep | OK |
| A28 | TLS failure mid-play (certificate rotated) | Engine network error | step-down → `/switch` `tls_error` → card | "Secure connection failed" card after a step-down attempt | Step-down useless | T1 classifies TLS as terminal transport: card at once, no step-down | P3 |

### B — Playback API

| ID | State | Detected today | Compensation today | Viewer sees today | Gap | Target | Sev |
|---|---|---|---|---|---|---|---|
| B01 | Start `400 invalid_device_profile` / `invalid_playback_request` / `invalid_work_id` | `start()` catch (`controller.ts:194-198`) | none | Card with the code text + Retry + Back | Retry repeats the same request | T11 (client bug): no Retry, "Report" line with code; log the profile | P3 |
| B02 | Start/switch `403 age_restricted` | catch → `fail(actions:['retry'])` | none | Specific text with reason (`error-text.ts:19-20`) + **Retry** + Back | Retry is pointless | T9 policy: Back (and "Other version" only if the server suggests it) | P2 |
| B03 | `404 title_not_found` / `season_not_found` / `episode_not_found` (failed state, no actions) | `wait()` → `suggestedActions` empty → `['retry']` (`controller.ts:239`) | none | Specific text + Retry | Retry pointless | T9: Back + "Go to details" | P2 |
| B04 | `409 too_many_streams` (`params.device`, `limit`, `releaseName`) | catch | none | "…already watching on Living-room TV" + Retry + Back | Viewer must keep pressing Retry | T9 + auto-poll: retry every 10 s for 2 min while the card shows "Starts as soon as the other device stops"; `releaseName` shown | P3 |
| B05 | `429 too_many_playbacks` (`Retry-After`) | catch | none | Text + Retry | `retryAfter` ignored | T4: auto-retry after `Retry-After`, countdown in the card | P3 |
| B06 | Failed `release_dead`, `repair_failed`, `no_versions`, `release_not_found`, `no_playable_file`, `invalid_release`, `nzb_fetch_failed`, `nzb_host_not_allowed`, `usenet_unreachable`, `resolve_failed`, `stream_expired`, `probe_failed` | `wait()` (`controller.ts:224-242`) | Server already fell back/repaired | Specific text + server actions; stepper with the failed step | `suggestedReleaseId` not used; `stream_expired` could auto-retry | T8 content: "Other version" preselects `suggestedReleaseId`; `stream_expired` → one automatic retry | P3 · S4s decision: `stream_expired` (T2) gets one new start per lost playback, at most 3 per incident (S4l), not one: each new start is a new playback, and an expiry there is a new loss |
| B07 | Failed `transcoding_not_allowed`, `transcoding_unavailable` (`params.reason`), `no_playable_method` | `wait()` | none | Specific text + Other version (+ Play with VLC) | `params.reason` not shown | Show reason line ("The server’s video converter isn’t installed") | P3 |
| B08 | Failed `capacity_reached`, `transcode_capacity`, `remux_capacity` (`params.reason` `too_many_sessions`/`insufficient_disk`) | `wait()` | none | "Server is busy" + Retry | No auto-retry; disk-full reason hidden | T4: auto-retry 3× (5/10/20 s) with countdown; `insufficient_disk` → admin hint, no auto-retry | P3 |
| B09 | Failed `transcode_failed`, `segment_timeout` at start (`params.reason` `init_unavailable`/`segment_unavailable`/`end_of_stream`) | `wait()` | none | Specific text + Lower quality | Mostly unreachable (start never awaits a segment, `TranscodeSessionManager.cs:171-187`) | Keep; the real cases are C08/C07 | OK |
| B10 | Failed `playback_failed` (`params.reason`) | `wait()` | none | "Playback failed — try another version or a lower quality" | Reason dropped | Show reason code in the card ("Code: start_timeout"); T6 ladder | P2 |
| B11 | Failed `no_more_methods` after step-downs | `stepDown` → `serverSwitch(…, false)` → `wait(…, true)` → `fail` (`controller.ts:423`, `461`) | Server excluded every method | "No more options — every playback method was tried" | Why each method failed is lost | Card lists the ladder log ("Direct: picture stayed black · Remux: decoder error -12927 · VLC: not available") + Other version | P2 |
| B12 | An `error.code`/HTTP code the client does not know (future server code, `invalid_event`, `stream_capacity`, `viewer_not_found`) | `describeError` → `unknown` (`error-text.ts:16`) | none | **Generic** "Something went wrong — an unexpected error occurred" | Requirement violated | Unknown codes map by HTTP status and source to a category text + the raw code as "Code: x"; CI test that every server code in `docs/api.md` has client text | P1 |
| B13 | Start returns `5xx` without envelope / HTML | `errorFromResponse` → `server_error` (`errors.ts:61-68`) | none | "Server error — try again in a moment" | No auto-retry | T6: retry 2× with backoff, then card | P3 |
| B14 | Start POST times out (20 s) | `createTimeoutFetch` → `timeout` (`http.ts:22-26`) | none | "The server is taking too long" + Retry | Unknown whether the server created a playback | T1: retry once; the server supersedes same-session playbacks, so no 409 risk | P3 |
| B15 | One poll `GET …/playback/{id}` fails (network/5xx) during start | `waitForPlayback` throws (`playback-api.ts:37-56`) → `fail` | none | Network/server card; the server keeps preparing | One lost poll kills the start | Poll errors retried with backoff for 30 s (T1) before the card | P2 |
| B16 | Playback hangs in one state (server stuck in `starting`/`resolving`) | none (polls forever, `playback-api.ts:45-54`) | none | Stepper spinner forever | No client budget | Budget per state (resolving 60 s, planning 30 s, starting 45 s; repairing follows ETA) → stepper explain line turns into `H.startSlow`, after 2× budget card with Retry / Other version | P2 |
| B17 | `404 playback_not_found` while starting (server restarted) | `waitForPlayback` throws → `fail` | none | "Playback ended — start it again" | Manual | Ladder **N** once (new start), then card | P2 |
| B18 | `/switch` `400 unknown_audio_stream` / `unknown_subtitle_stream` (playback keeps its state) | `serverSwitch` catch → `restore()` (`controller.ts:468-477`) | `restore` **stops** the playback and starts a new one (`:491-509`) | Reload + "Couldn't switch. …" notice | Needless stop/restart: the server says the playback is unchanged | 4xx validation errors of `/switch` → notice only, keep the running source | P3 |
| B19 | `/switch` → `failed` (user switch: quality/version/engine, e.g. `transcode_capacity`) | `wait(…, false)` → `restore()` | New start with the previous choices | Reload + `switchFailed` notice with the code text | Previous URL works for 30 s after a ready switch, but a failed switch never closes it (`ViewerPlaybackService.cs:214-215`) — restore could just re-attach the old URL | Re-attach the previous source at position without a new start; notice | P3 |
| B20 | `/switch` network failure (user switch) | catch → `restore()` → `startPlayback` also fails → `fail` | Stops the old playback (`stopPlayback` error swallowed) | Card "Can't reach the server"; a stream that still played is gone | Compensation destroys a working state | T1: keep the old source playing, notice `H.reconnecting`, retry the switch when online | P2 |
| B21 | `/switch` with `stepDown` fails (network/5xx) | `serverSwitch(…, false)` → `fail` (`controller.ts:471-473`) | none | Network/server card | Combined with D01 this ends playbacks for transient faults | Step-down only for T7/T8; transport → T1 | P2 |
| B22 | Progress heartbeat fails transiently | `progress-queue.ts:51-62` | Persisted queue, backoff 2/5/15/30/60 s | Nothing | — | Keep | OK |
| B23 | Progress `401`/`403`/`404` | `retriable()` false → dropped (`progress-queue.ts:28-30`) | none | Nothing; position silently lost | Final events after a sign-out are lost | Keep 401/403 per account until the account signs in again (max 24 h) | P2 |
| B24 | Heartbeat for a dead `playbackId` (idle-ended, server restarted) | Server answers 200 and ignores the playback (`ViewerPlaybackService.cs:240-242`) | Watch state still saved (work-level) | Nothing until the next HLS request fails | Client cannot tell the playback is gone | Foreground/`online` revalidation via `GET …/playback/{id}` (A09); server: optional `playbackAlive:false` in the progress answer (B-follow-up, not B12) | P3 |
| B25 | Server restart mid-play (or Dev World restart) | HLS: `404 unknown_transcode` (hls.js does not retry 4xx, `retryForHttpStatus`) → fatal → `stepDown`; direct: capability lost (SessionManager in memory) → `404 unknown_stream` | step-down → `/switch` → `404 playback_not_found` → `fail` | Picture runs from buffer, then freezes, then "Playback ended" card | Not transparent | T2 ladder **N**: new start at `lastGoodPosition` with release + tracks, `H.restarting` | P1 |
| B26 | Server unreachable for a while, media still buffered | Heartbeats queue | none | Nothing until the buffer runs dry (then A24) | — | Covered by A23/A24 | OK |
| B27 | Stop call fails | swallowed (`controller.ts:843-844`) | Server idle sweep ends it after 600 s | Nothing | — | Keep | OK |

### C — Delivery (server → engine)

| ID | State | Detected today | Compensation today | Viewer sees today | Gap | Target | Sev |
|---|---|---|---|---|---|---|---|
| C01 | Direct play: capability expired or LRU-evicted mid-play (`404 unknown_stream`; hard 24 h TTL `StreamSession.cs:47`; eviction `SessionManager.cs:117-121`; open body cut mid-response) | Engine network error (web `MEDIA_ERR_NETWORK`, Exo source error, AVP `-1100x`, VLC `EncounteredError`) | step-down to remux (works, but needlessly heavier) | Frozen picture for the remaining buffer, then "Switched to direct stream…" | Expired capability ≠ unsupported method | T2: `/switch` without `stepDown` (same method, server re-resolves: `StreamAlive` false → resolve, `ViewerPlaybackService.cs:352`) | P2 |
| C02 | Direct play `416` / range error / short file (Content-Length larger than the data) | Engine error or early `ended` | step-down or nothing (C17) | Frozen picture | — | T8: reload at position once; then card `H.endedEarly` with Other version | P2 |
| C03 | Direct play throughput below the bitrate (Usenet slow, 6 MiB/s pacing `StreamarrOptions.cs:172-181`, slow Wi-Fi) | Engine `buffering` (web `waiting`, AVP/Exo `loading`, VLC `onBuffering`) → only metrics | none | **Frozen picture**, clock stops, no indicator | No spinner, no reason | Spinner after 1 s; `H.slowNet` with measured vs needed Mbit/s after 4 s; after 3 rebuffers in 2 min or one > 15 s → T5 step "lower quality" (`/switch {maxHeight}` → transcode) with notice | P1 |
| C04 | Direct play stalls on a Usenet hole (repair wait up to 90 s, `RepairAwareStream.cs:67-124`), then the connection aborts | As C03, then engine network error | As C03, then step-down | Frozen up to 90 s, then a step-down notice | Hole looks like a slow network | `H.slowNet` variant "The server is repairing missing data" when the playback reports `release_degraded`/repair; after abort T8 → `/switch` same release (server repair path) then Other version | P1 |
| C05 | Connection reset mid-transfer (progressive or segment) | Engines retry internally (hls.js 6×; Exo `DefaultLoadErrorHandlingPolicy`; AVP internal) | Engine retries | Short freeze (no indicator) | Indicator missing | Spinner rule from C03 | P3 |
| C06 | Remux/transcode fails to start (`TranscodeException` at create) | Server falls through to the next candidate (`ViewerPlaybackService.cs:567-580`) | Server-side | Stepper continues; `decision.skipped` lists it | — | Keep | OK |
| C07 | ffmpeg crashes mid-stream (non-zero exit) | Segment `500 transcode_failed` (`TranscodeSessionManager.cs:498-525`); restart refused for 30 s on the same segment (`:369-373`) | hls.js retries 5xx 6× (1–8 s) → fatal → `stepDown` | Freeze ~30 s, then a step-down notice or `no_more_methods` | Retry-same would work after 30 s (server restarts the run) | T6: retry same segment after 30 s once (`H.recovering`), then step-down | P2 · S4s decision: T6 backoff stays 5 s, 15 s, then a new start (not 30 s): each reload asks the server, a refused restart answers at once, and the new start opens a new session that is not under the 30 s lock |
| C08 | ffmpeg slower than real time (4K, weak server, software tone mapping) | Segment request waits up to 90 s × 4 (`TranscodingOptions.cs:17`); hls.js TTFB timeout 10 s × 4 retries | hls.js fatal `fragLoadTimeOut` after ~50 s → `stepDown` | Repeated freezes with no indicator, then a step-down | Nothing measures the encoder speed; client/server timeouts disagree | Client: hls.js `fragLoadPolicy.maxTimeToFirstByteMs` 30 s, `timeoutRetry 2`; spinner + `H.serverSlow` (speed from rebuffer ratio, or server `speed` if exposed later); T5 lower quality after 2 rebuffers > 4 s | P1 |
| C09 | Seek back > 15 min inside one long transcode run (deleted segment, live run past it) | Server waits on a run that never rewrites it (`TranscodeSessionManager.cs:358-366`, retention `:614-633`) → 90 s → `504 segment_timeout` | As C08 | ~50 s frozen picture after the seek, then step-down | Server bug (inferred from code) | Server fix outside F10 (restart when the file was retained-away); client: seek-stall budget → reload at position (ladder **R**) after 15 s | P1 |
| C10 | Playlist `404 unknown_transcode` (session closed: idle 1800 s, restart, superseded by another start of the same device `ViewerPlaybackService.cs:130-135`) | hls.js `manifestLoadError`/`levelLoadError` (no 4xx retry); AVP/Exo source error | step-down → `/switch` → maybe `playback_not_found` | Freeze, then step-down or "Playback ended" | Session loss treated as format failure | T2 ladder **N** | P1 |
| C11 | Playlist 5xx | hls.js retries (`playlistLoadPolicy`), then fatal | step-down | Freeze then notice | No indicator, wrong ladder | T6 retry same, then **N** | P2 |
| C12 | Endless / stale playlist (no `ENDLIST`, no new segments) | Not produced by the server (VOD playlists, `HlsPlaylist.cs:137-159`) | — | hls.js would treat it as live and start near the "live edge"; AVP shows a live UI | Defensive only (proxies, future live) | Watchdog "clock-frozen while buffering" covers it; B12 fault `playlist_endless` proves it | P3 |
| C13 | Segment `404 unknown_segment` / `end_of_stream` (index outside the timeline, remux exit 0 before the last segment `RemuxSegmenter.cs:59-67`) | hls.js fatal `fragLoadError` | step-down | Freeze near the end, then a step-down notice | Near the end it should simply end | `end_of_stream` within 2 segments of the duration → treat as `ended`; else T8 | P2 |
| C14 | Segment `503 segment_unavailable` / `init_unavailable` / `segment_evicted` (no `Retry-After`) / capacity | hls.js retries 5xx | step-down after 6 retries | Freeze ~30 s | No indicator | Spinner; T6 retry with server `Retry-After`; then **N** | P2 |
| C15 | Segment `410 session_closed` (closed during the request) | hls.js fatal (4xx) | step-down | Freeze, notice | Session loss | T2 **N** | P2 |
| C16 | Segment truncated (connection closes early, wrong Content-Length) | hls.js: network error, retried; AVP/Exo: retry or parse error | Engine retries | Short freeze | — | Spinner; parse error → C17 | P3 |
| C17 | Corrupt segment (bad fMP4 box / bitstream) | hls.js `fragParsingError`/`bufferAppendError` (MEDIA) → `recoverMediaError()` loop (`web-engine.web.tsx:301-304`); AVP decode error `-12909`/`-11821`; Exo `ParserException`/decoder error; VLC artefacts | hls.js: endless recover; others step-down | hls.js: **frozen picture forever**; others: notice | No recover budget | Budget: `recoverMediaError` once, `swapAudioCodec` + recover once, then T7 (step-down); skip-ahead option: seek past the segment (+segment length) once before step-down | P1 |
| C18 | Timestamp discontinuity between ffmpeg runs | Server keeps timestamps (`-copyts`, `docs/transcoding.md` "fMP4 timing") | hls.js gap nudging | Short stall | — | Watchdog "clock-frozen" catches a hard stall | OK |
| C19 | Audio rendition `404 unknown_audio_rendition` / `500 rendition_split_failed` **during an in-session switch** | hls.js `audioErrorCode` (`hls-audio-error.ts:6-16`) → `settleAudio(false)`; native: 8 s timeout (`controller.ts:80`, `683-684`) | `/switch` fallback | Short silence, new source | Native path untested on devices (BACKLOG Player 1) | Keep; B12 `rendition_status` makes it testable | P3 |
| C20 | Audio rendition fails **during normal playback** (split aborted after headers `TranscodeStreamController.cs:157-166`, 5xx) | hls.js: `audioError` ignored when no switch is pending (`controller.ts:277-278`); fatal → `stepDown` | step-down | Picture runs without sound, or a freeze, then a step-down | Silent audio undetected | Watchdog `audio-silent` (where measurable) → ladder: re-select rendition, `/switch` same audio (server re-splits), then step-down; `H.noAudio` | P1 |
| C21 | Video media playlist / init missing (`500`, `503 init_unavailable`) | hls.js `levelLoadError`/`fragLoadError` | step-down | Black start or freeze | — | T6 retry, then step-down | P2 |
| C22 | Subtitle playlist or `.vtt` 404 (`unknown_subtitle_stream`) / 5xx | hls.js `subtitleTrackLoadError`/`subtitleFragLoadError` non-fatal, ignored; AVP may fail the whole item; Exo source error for the merged source | hls.js none; native step-down | hls.js: selected subtitle never appears; native: the whole playback steps down because of a subtitle | Silent loss / overreaction | Classify subtitle-only failures: switch subtitles off, notice `H.subtitleFailed` with "Choose other subtitles"; never step-down for a subtitle | P2 |
| C23 | Subtitle parse error (malformed WebVTT) | hls.js non-fatal; AVP may ignore cues or fail | as C22 | Missing cues | As C22 | As C22 | P2 |
| C24 | Forced/selected subtitle not deliverable (`subtitle_not_deliverable`, `deliveredAs: none`) | Decision reason only (Info panel "Why") | Server plays without it | Nothing; the viewer expects subtitles | Hint hidden in Info | Notice at start: "Subtitles {label} can't be shown on this device — VLC can show them" + action "Play with VLC" when available | P2 |
| C25 | Wrong content type (playlist not `application/vnd.apple.mpegurl`, segment not `video/mp4`) | hls.js tolerant; AVP rejects (`-12642`/`-11850`); Exo uses the explicit `contentType: 'hls'` | AVP: step-down | AVP: notice / failure | Misconfigured proxy is not a device problem | T7 is wrong; classify `-12642` on a playlist as T6 (server/proxy) → card "The server sends an unexpected format (proxy?)" | P2 |
| C26 | HDR → SDR tag mismatch (AVPlayer `-12927`) | statusChange error message (`expo-video-engine.tsx:80-82`) | step-down → `no_more_methods` (I1:128-140); fixed server-side in B6 | Generic `no_more_methods` card | Message lost | Ladder log keeps `-12927`; T7 with `H.decoder` ("This device rejects the HDR format — converting to SDR") | P2 |
| C27 | Audio codec unsupported although declared (E-AC-3 on a browser, DTS passthrough with the AVR off) | hls.js `bufferAddCodecError` (MEDIA) → recover loop; AVP/Exo: video plays, audio track skipped, **no error**; Exo passthrough `AUDIO_TRACK_INIT_FAILED` → error | hls.js loop; native nothing or step-down | hls.js frozen; native: **picture without sound** | Silent audio undetected; profile lies | `audio-silent` watchdog + codec error class → `/switch` with the audio forced to AAC (server: audio fallback flag, see slice S4 note) → `H.noAudio` | P1 |
| C28 | Video codec unsupported although declared (HEVC/AV1/DV profile without decoder) | Exo: decoder init error (good) **or** video track deselected → audio with black; AVP: black picture with audio, no error; hls.js `bufferAddCodecError` loop; VLC software decode or black | Mixed | **Black picture with sound** (AVP, Exo deselect) or frozen (hls.js) | Black undetected | `picture-black` watchdog → T7 step-down with `H.noPicture`; media-caps profile corrected for the session (`stepDown` excludes the method) | P1 |
| C29 | Resolution/level beyond the decoder (4K on a 1080p SoC, H.264 level 5.2) | Exo `FORMAT_EXCEEDS_CAPABILITIES` error; AVP drops frames / black; web stutters | step-down where an error comes | Slideshow or black | Dropped-frame ratio unused | `slideshow` watchdog (> 30 % dropped over 10 s) → `H.deviceSlow` + Lower quality; > 60 % → automatic T5 | P1 |
| C30 | Encrypted content without DRM | hls.js `keyLoadError`/KEY_SYSTEM, Exo `DrmSessionException`, AVP `-42xxx` | step-down → `no_more_methods` | Generic "No more options" | Not a device problem | T8: "This version is encrypted and can't be played" + Other version, no step-down | P2 |
| C31 | Zero-length or very short file (< 1 segment, duration 0) | `ended` with `duration 0` → ignored (`controller.ts:399`) | none | Black/frozen, overlay says playing | Swallowed | `ended` before 1 s of playback → T8 card `H.endedEarly` (Other version) | P1 |
| C32 | Stream ends earlier than the announced duration (truncated file, early remux end, VLC `Stopped`) | `ended` ignored when `position < duration − 3` (`controller.ts:399`) | none | **Frozen last frame**, overlay "playing", no end card | Swallowed | Early `ended` (not during a source change) → reload at position once (T8 **R**); ends again within 5 s → `H.endedEarly` ("The file ends at 1:12:04, 9 minutes before the end") + Other version / Back | P1 |
| C33 | Announced duration shorter than the media | Engine duration wins (`controller.ts:157-161`) | — | Normal | — | Keep | OK |
| C34 | Image subtitle needs burn-in / VLC (`subtitle_burned_in`, `image_subtitle_vlc`) | Decision reasons | Server-side | Normal playback | — | Keep | OK |

### D — Engine and decoder

| ID | State | Detected today | Compensation today | Viewer sees today | Gap | Target | Sev |
|---|---|---|---|---|---|---|---|
| D01 | hls.js fatal `NETWORK_ERROR` (`manifestLoadError`/`TimeOut`, `levelLoadError`, `fragLoadError`/`TimeOut`, `audioTrackLoadError`) | `web-engine.web.tsx:297-307` → `error` reason `networkError:<details>` | `stepDown` | Freeze (no indicator), then a step-down notice | HTTP status ignored; transport vs session vs server mixed | Engine passes `{category, status, details}`: 0/offline → T1, 404/410 → T2, 5xx/504 → T6/T5 | P2 |
| D02 | hls.js fatal `MEDIA_ERROR` (`bufferAppendError`, `fragParsingError`, `bufferStalledError` fatal, `bufferAddCodecError`) | `:301-304` → `recoverMediaError()` every time | Unbounded recovery | **Frozen picture forever** when it keeps failing | No budget | 1× `recoverMediaError`, 1× `swapAudioCodec()+recoverMediaError`, then T7 | P1 |
| D03 | hls.js fatal `MUX_ERROR` / `OTHER_ERROR` / `KEY_SYSTEM_ERROR` | `:305-306` | `stepDown` | Notice | Category unused | T7 (mux/other) / T8 (key) | P2 |
| D04 | hls.js non-fatal `bufferStalledError` / `bufferNudgeOnStall` | ignored (`:300`) | hls.js nudges | Short freeze | No indicator | Spinner rule; repeated nudges feed the watchdog | P2 |
| D05 | MSE `QuotaExceededError` (`bufferFullError`) | non-fatal, hls.js shrinks the buffer | hls.js | Nothing | — | Keep | OK |
| D06 | hls.js chunk fails to load (`hlsjs:load`, stale deploy, offline) | `:262-271` → `error` | `stepDown` (useless: remux and transcode need hls.js too) | Notice, then possibly `no_more_methods` | Wrong ladder | T11: retry the import 2×, then card "Reload the page" with action Reload | P2 |
| D07 | Autoplay blocked (no user gesture) | `autoplay()` retries muted (`web-engine.web.tsx:321-330`) | Muted playback | Video plays **muted, no hint** | Viewer thinks sound is broken | `H.mutedAutoplay` chip "Sound off — tap to unmute" until unmuted | P2 |
| D08 | Muted autoplay also blocked (Safari Low Power, strict policies) | `play().catch(() => undefined)` | none | **Black/first frame**, "Pause" icon | Silent failure | `H.autoplayBlocked` with a big Play action; `controller.paused = true` | P1 |
| D09 | Safari/`<video>` `MediaError` 1–4 (`ABORTED`, `NETWORK`, `DECODE`, `SRC_NOT_SUPPORTED`) | `error` event (`web-engine.web.tsx:133-139`) | `stepDown` | Notice / card | Code → category unused | 2 → T1/T2 by probing the URL (HEAD); 3 → T7; 4 → T7 (or T2 if HEAD says 404) · S4u: 4 with the HEAD unanswered (status 0) or a network message (`PIPELINE_ERROR_READ`, `NS_ERROR_NET_*`, `net::ERR_`) → T1 (Chrome reports any failure before metadata as 4); 4 with an answered HEAD stays T7. A CORS-blocked HEAD is not a case: `ViewerCorsMiddleware` answers `/api/v1/stream` and `/api/v1/viewer` with the same policy, so a blocked HEAD means a blocked API too | P2 |
| D10 | Safari `stalled`/`suspend`/`waiting` | `waiting` → `buffering` (`:107-110`); `stalled` unhandled | none | Frozen picture | No indicator | Spinner rule + watchdog | P1 |
| D11 | Exo source errors (`ERROR_CODE_IO_NETWORK_CONNECTION_FAILED`/`TIMEOUT`, `IO_BAD_HTTP_STATUS`, `IO_FILE_NOT_FOUND`, `IO_CLEARTEXT_NOT_PERMITTED`, `PARSING_*`) | `statusChange error` with message "A playback exception has occurred: Source error … Response code: 404" (`PlaybackError.kt`, `expo-video-engine.tsx:80-82`) | `stepDown` | Notice | Only free text; no code | Patch expo-video: pass `errorCodeName` + HTTP status; classifier maps to T1/T2/T6; message parser as fallback | P2 · S4s: `IO_FILE_NOT_FOUND` → T2 (missing file, new start), `IO_UNSPECIFIED` → T1 `stream_interrupted` |
| D12 | Exo decoder errors (`DECODER_INIT_FAILED`, `DECODER_QUERY_FAILED`, `DECODING_FAILED`, `DECODING_FORMAT_EXCEEDS_CAPABILITIES`, `DECODING_FORMAT_UNSUPPORTED`) | As D11 | `stepDown` (correct direction) | Notice "Switched to … to keep playing" | Reason not said | T7 + `H.decoder` names the codec | P3 |
| D13 | Exo audio sink errors (`AUDIO_TRACK_INIT_FAILED`, `AUDIO_TRACK_WRITE_FAILED`, passthrough refused) | As D11 | `stepDown` | Notice | Audio fallback would suffice | T7-audio: `/switch` with converted audio first | P2 |
| D14 | Exo `BEHIND_LIVE_WINDOW` | n/a (VOD only) | — | — | — | — | OK |
| D15 | Exo stuck in `STATE_BUFFERING` (loader waits on a 90 s segment) | status `loading` → `buffering` (`expo-video-engine.tsx:83-85`) | none | Frozen picture | No indicator, no budget | Spinner rule + budgets (C08) | P1 |
| D16 | Exo renders audio, video renderer has no track (unsupported → deselected) | none | none | **Black picture with sound** | — | `picture-black` via `videoDecoderCounters` / `onRenderedFirstFrame` missing → T7 | P1 |
| D17 | Exo `MediaCodec` reclaimed / released (other app, return from background) | decoder error | `stepDown` | Notice, heavier method | Transient treated as unsupported | T6: reload at position once, then T7 | P2 |
| D18 | AVPlayer item failed (`-11800`, `-11828`, `-11850`, `-12642` playlist parse, `-12660`/`-12938` HTTP, `-1009` offline, `-1001` timeout, `-12927` format) | `statusChange error` with `localizedDescription` only (`VideoPlayerObserver.swift:465`) | `stepDown` | Notice / generic `no_more_methods` | NSError domain/code lost | Patch expo-video iOS to pass `domain`, `code`, `underlyingError` and the last `errorLog()` event (HTTP status, URI); classifier: `-1009`/`-1001`/`NSURLError*` → T1, HTTP 404/410 → T2, 5xx → T6, `-12927`/`-11821`/`-12909` → T7 | P2 |
| D19 | AVPlayer stalled (`playbackStalled`, `timeControlStatus = waitingToPlayAtSpecifiedRate`, `isPlaybackLikelyToKeepUp = false`) | status `loading` → `buffering` | AVPlayer waits forever | Frozen picture | No indicator, no budget | Spinner rule + budgets; `reasonForWaitingToPlay` gives the hint text (`toMinimizeStalls` → `H.slowNet`, `noItem` → T2) | P1 · S4s decision: `reasonForWaitingToPlay` stays unused: expo-video does not expose it, the shared stall timeline (spinner, hint, budgets) covers every engine; native follow-up if a reason ever changes the step |
| D20 | AVPlayer black picture while the clock runs (I1: frame 0 for ~45 s) | none | none | **Black/frame 0** with a running clock | Undetected | `picture-black`: `AVPlayerLayer.isReadyForDisplay` false or `AVPlayerItemVideoOutput` no new pixel buffer for 3 s while the clock moves → ladder: seek nudge, reload, T7 | P1 |
| D21 | AVPlayer picture without sound (unsupported/absent audio, passthrough route) | none | none | Picture, silence | Undetected; AVPlayer offers no audio counter | Heuristic: selected audio track has no enabled `AVPlayerItemTrack` or `errorLog` shows audio decode → `H.noAudio` + action "Other audio track" / Lower quality; full tap-based meter not planned | P1 |
| D22 | VLC `EncounteredError` | `onEncounteredError` (`vlc-engine.tsx:104-107`) | `stepDown` | Notice / `no_more_methods` | libVLC gives no code | T7 with "VLC could not play this file" | P2 |
| D23 | VLC never shows a picture (MediaCodec direct rendering, A1 of M3.1) | `checkStall` returns while `displayedPictures` is 0 (`vlc-engine.tsx:162`) | none | **Black picture**, clock runs | Watchdog gate | Count `decodedVideo` vs `displayedPictures`; 0 displayed for 4 s while the clock moves → reload with `directRendering:false`, then T7 | P1 |
| D24 | VLC frozen picture with a running clock (after seek/load) | `checkStall` (Android only, `vlc-engine.tsx:153-191`) | seek → reload → … ×4 → `vlc_video_stalled` → `stepDown` | Up to ~15 s frozen, then recovered or a notice | No hint while recovering; Apple has no `getStats` | Same detector inside the shared watchdog; `H.recovering` during recovery; VLCKit 4 `VLCMedia.statistics` patch for Apple | P2 |
| D25 | VLC no audio (audio output failed, passthrough) | none | none | Picture, silence | Undetected | `playedAbuffers`/`decodedAudio` counters (extend the patch) → `audio-silent` | P1 |
| D26 | VLC end reached early (`Stopped` before the duration) | `onStopped` → `ended` (`vlc-engine.tsx:97-103`) → controller ignores | none | Frozen last frame | As C32 | As C32 | P1 |
| D27 | VLC dialog request (`onDialogDisplay`: certificate, login, codec question) | not handled | libVLC waits | Possible hang | — | Handle `onDialogDisplay`: dismiss + classify (T1 TLS / T7) | P2 |
| D28 | VLC stop hangs (ANR risk on release) | `shutdown()` 3 s timeout (`vlc-engine.tsx:279-291`) | Release later | Nothing | — | Keep | OK |
| D29 | Seek into unbuffered media (any engine; transcode restarts ffmpeg at the target) | Engine `buffering`; the clock already shows the target (`seek()` emits time at once) | none | **Old frame frozen** under a clock at the new time | No indicator | Spinner during the seek (start immediately, no 1 s delay); after 8 s `H.serverSlow`/`H.slowNet`; after 20 s ladder **R** | P1 |
| D30 | Seek past the end | `seekTo` clamps to `duration − 1` (`controller.ts:817-825`) | — | Normal | — | Keep | OK |
| D31 | Rapid seeks / scrubbing on HLS transcode (each far seek restarts ffmpeg) | Engines | none | Several freezes | Server churn; no debounce | Debounce seeks 300 ms on transcode (commit on release already for scrub); spinner rule | P3 |
| D32 | In-session audio switch never confirms | 8 s timeout → `/switch` (`controller.ts:663-708`) | Fallback | Old audio keeps playing, then a reload | — | Keep; notice on fallback "Audio track switched; playback restarted at the same spot for it" | P3 |
| D33 | Black picture with running clock (generic, all engines) | VLC partial only | — | Black | — | Watchdog `picture-black` (Design § a) | P1 |
| D34 | Frozen picture with running clock (generic) | VLC Android only | VLC only | Frozen | — | Watchdog `picture-frozen` | P1 |
| D35 | Running picture with frozen clock (time events stop; JS thread starved, Q1-25) | none | none | Clock stands; heartbeats report a stale position | Progress wrong | Watchdog `clock-frozen`: frames advance but `time` events stop for 3 s → poll `getSnapshot`/native time; JS lag > 2 s logged; report position from native time | P2 |
| D36 | No audio with running picture (generic) | none | none | Silence | — | Watchdog `audio-silent` where counters exist; else D21 heuristic | P1 |
| D37 | Audio/video drift | none (engines keep A/V sync internally) | — | Lip-sync off | Rare, engine-internal | Log only (dropped-frame ratio); Info panel shows A/V offset where engines expose it | P3 |
| D38 | Heavy frame drops (slideshow) | Stats collected (`web-engine.web.tsx:332-348`, VLC `lostPictures`), not evaluated | none | Slideshow | Undetected | Watchdog `slideshow` → `H.deviceSlow` + Lower quality | P2 |
| D39 | Engine never reaches the first frame (load hangs: `replaceAsync` never settles, manifest never arrives) | none; `phase` already `playing` | none | **Black** under the overlay at 0:00 | No start budget | Start budget (§ c) → `H.startSlow` at 8 s → ladder **R** at 20 s (direct) / 30 s (HLS) → step-down | P1 |
| D40 | `replaceAsync` rejects | `.catch` emits `error` without `setState('error')` (`expo-video-engine.tsx:199`) | `stepDown` | Notice | State stays `loading` | Set `error` state; classify like D11/D18 | P3 |
| D41 | Second engine error while a step-down/switch runs | `stepDown` returns when `phase === 'switching'` (`controller.ts:419`) | The new source replaces the old | Nothing | — | Keep; the new source has its own budget | OK |

### E — Player UI states

| ID | State | Detected today | Compensation today | Viewer sees today | Gap | Target | Sev |
|---|---|---|---|---|---|---|---|
| E01 | Start stepper (`queued → resolving → fallback → repairing → planning → starting`) | `onPlayback` (`controller.ts:252-257`), `start-stepper.tsx` | — | Steps with explanations, repair % and ETA | — | Keep | OK |
| E02 | Stepper stage takes very long | none | none | Spinner on the step | No budget hint | Per-stage budget → explain line becomes `H.startSlow` (B16) | P3 |
| E03 | Between `ready` and the first frame | `phase = 'playing'` at `attach` (`controller.ts:315`) | none | **Black** with overlay controls at 0:00 (12–16 s observed, P2:105) | Stepper gone too early | Keep the card with a 6th step "Loading picture" until `firstFrame` (or the first clock move past the start), then fade to the overlay | P1 |
| E04 | Buffering mid-play | engine `buffering` (metrics only) | none | **Frozen picture**, no indicator | — | `PlayerStatus` spinner centred (after 1 s; at once after a seek), hint line after 4 s (§ c) | P1 |
| E05 | Paused | `controller.paused` | Overlay stays | Paused overlay | — | Keep | OK |
| E06 | Paused by the system (A12–A14, A16, A19) | not adopted | none | "Pause" icon on a frozen picture | — | `H.pausedBySystem` | P1 |
| E07 | Ended → up-next / end card / replay | `endOverlay` (`end-state.ts:15-20`) | — | Countdown, end card, replay | Countdown runs while paused (BACKLOG Player 6) | Pause the countdown while paused | P3 |
| E08 | Closing | `stop()` (`controller.ts:831-849`) | Final report, engine shutdown | Leaves | — | Keep | OK |
| E09 | Terminal failure card | `fail()`; `play-screen.tsx:231-257` | Server actions + Back | Code title/message, stepper, actions | Retry restarts without the current position (asks resume, up to 10 s behind) | Card shows "What was tried" + position; Retry resumes at `lastGoodPosition` without asking | P3 |
| E10 | Failure while a side panel is open | `panel` state is not cleared on `fail()` (`play-screen.tsx:77,358-369`) | none | Panel stays over the card; TV focus may stay in the panel | Card possibly unreachable on TV | Close panels and the version picker on `failed`; focus the card | P2 |
| E11 | Failure / notice while the overlay is hidden | Notices render regardless (`play-screen.tsx:323-345`) | — | Notice for 6 s | 6 s may be too short on TV | Keep; TV 8 s | P3 |
| E12 | Errors on TV | Card `autoFocus`; corner ✕ hidden on TV failure (`play-screen.tsx:300`) | — | Focus in the card | — | Keep; status hints must never take focus (pointerEvents none) | OK |
| E13 | Offline banner | none (`NoticeKind 'offline'` unused, `controller.ts:40`; play-screen would render it with the `switchFailed` text, `play-screen.tsx:338-342`) | none | Nothing | — | `H.offline` banner (A24) with its own key | P1 |
| E14 | Step-down notice | `stepDownKey` (`overlay-labels.ts:186-189`) | — | "Switched to transcoding to keep playing." | No reason | Add the reason: "…because the picture stayed black" / "…because this device can't decode HEVC" | P3 |
| E15 | `switchFailed` notice | `describeError(t, {code})` (`play-screen.tsx:340-342`) | — | "Couldn't switch. {reason}" | Generic reason for unknown codes (B12) | Taxonomy texts | P2 |
| E16 | Device capabilities fail to load (`loadDeviceCaps` throws) | `setCapsError(toAppError(error).code)` (`play-screen.tsx:128-130`) → usually `unknown` | none | **Generic** "Something went wrong" | — | Fall back to a conservative static profile and play; log the error; card only if that fails ("This device's player could not be initialised") | P1 |
| E17 | Resume prompt left open for > 10 min | Polls stopped, playback idle-ended | `attach` on choice → URL 404 → step-down → `playback_not_found` | "Playback ended" card after the choice | — | Revalidate on choice (A09 logic) | P2 |
| E18 | "Switching…" card (`phase === 'switching'`) | `play-screen.tsx:312-322` | — | Card with stepper | Black underneath for remux/transcode reloads (F5:207-208) | Keep the last frame (engines keep the old picture until the new source renders — expo-video `replaceAsync` does, web `teardown` does not: draw a poster of the last frame on web) | P3 |

Row count: 28 (A) + 27 (B) + 34 (C) + 41 (D) + 18 (E) = **148**. Severities: **P1 = 43**, **P2 = 51**, **P3 = 29**,
**OK = 25**.

---

## 2. Design

### a) One health watchdog for every engine

**Where.** `client/src/player/health/watchdog.ts` (pure, timer-injected) fed by one optional engine method
`readHealth(): Promise<EngineHealth>` and by the existing engine events. The controller owns one watchdog per
engine instance; VLC's private `checkStall` moves into it.

```ts
type EngineHealth = {
  framesPresented?: number;   // monotonic; undefined = the platform cannot tell
  framesDropped?: number;
  framesDecoded?: number;
  audioProgress?: number;     // monotonic bytes/buffers rendered; undefined = unknown
  readyForDisplay?: boolean;  // a picture is on screen (AVPlayerLayer / first frame seen)
  hasVideoTrack?: boolean;    // a video track is selected and enabled
  hasAudioTrack?: boolean;
  bandwidthBps?: number;      // engine estimate
  external?: boolean;         // AirPlay / external playback: picture checks off
  nativePosition?: number;    // engine clock read directly (for clock-frozen)
};
type Verdict = 'ok' | 'starting' | 'buffering' | 'clock-frozen' | 'picture-black'
  | 'picture-frozen' | 'audio-silent' | 'slideshow';
```

**Signals per engine.**

| Signal | hls.js / Safari (web) | Exo (Android, Google TV) | AVP (iOS, iPadOS, tvOS) | VLC Android | VLC Apple |
|---|---|---|---|---|---|
| Frames presented | `requestVideoFrameCallback` `metadata.presentedFrames` (Chrome, Safari 15.4+); fallback `getVideoPlaybackQuality().totalVideoFrames − droppedVideoFrames` | expo-video patch: `videoDecoderCounters.renderedOutputBufferCount` | expo-video patch: `AVPlayerItemVideoOutput` attached to the item, count `hasNewPixelBuffer(forItemTime:)` hits per tick (cheap, no copy) | `displayedPictures` (patch exists) | VLCKit 4 `VLCMedia.statistics.displayedPictures` (new patch) |
| Frames dropped | `droppedVideoFrames` | `droppedBufferCount` + `onDroppedVideoFrames` | `accessLog().events.last.numberOfDroppedVideoFrames` | `lostPictures` | `lostPictures` |
| First picture | `requestVideoFrameCallback` / `timeupdate` fallback (`web-engine.web.tsx:178-197`) | `onRenderedFirstFrame` (`onFirstFrameRender` already) | `AVPlayerLayer.isReadyForDisplay` | first `displayedPictures > 0` | same |
| Audio progress | `webkitAudioDecodedByteCount` (Chrome, Safari); Firefox: unknown | `audioDecoderCounters.renderedOutputBufferCount`; `onAudioUnderrun` | none (no counter; heuristic D21) | `playedAbuffers`/`decodedAudio` (extend patch) | `playedAudioBuffers` |
| Bandwidth | `hls.bandwidthEstimate` (already, `:294-296`) / none for native HLS | `bandwidthMeter.bitrateEstimate` | `accessLog().events.last.observedBitrate` | `inputBitrate` stats | same |
| Stall reason | `waiting`/`stalled` | `STATE_BUFFERING` | `reasonForWaitingToPlay` | `onBuffering` % | same |

**Rules** (evaluated every 1 s while the controller wants playback; thresholds are constants in one file):

| Verdict | Condition | Default threshold |
|---|---|---|
| `starting` | No first picture since `load()` | hint at 8 s, ladder at 20 s (direct) / 30 s (HLS) |
| `buffering` | Engine `buffering`/`loading` after the first picture | spinner at 1 s (0 s after a seek), hint at 4 s, ladder at 15 s or 3 stalls/2 min |
| `clock-frozen` | Engine `playing`, no buffering, position unchanged | 4 s → treat as `buffering` (engines that forget to report it, D35) |
| `picture-black` | Clock moved ≥ 3 s since load/seek AND (`readyForDisplay === false` OR `framesPresented` still at its load value) AND `hasVideoTrack !== false` | 3 s of clock |
| `picture-frozen` | First picture seen, clock moved ≥ 3 s, `framesPresented` unchanged | 3 s of clock (VLC's `STALL_SECONDS`) |
| `audio-silent` | `hasAudioTrack` AND `audioProgress` defined AND unchanged while the clock moved ≥ 3 s | 3 s of clock |
| `slideshow` | `framesDropped / (framesPresented + framesDropped)` over the last 10 s | hint > 30 %, ladder > 60 % |

**False-positive guards.** No verdict while: `controller.paused` or engine `paused`; a seek is pending (from
`seek()` until the clock passed the target by 0.25 s + 2 s, like `metrics.ts` `RESUME_DELTA`); `phase !== 'playing'`;
`ended`; within 2 s after `load()`, an audio/subtitle switch or a source change; `AppState !== 'active'` unless PiP
(and in PiP only clock rules); web `document.visibilityState !== 'visible'` (Chrome stops presenting frames in a
hidden tab); `external === true` (AirPlay: clock rules only); `hasVideoTrack === false` (audio-only: no picture
rules); `framesPresented === undefined` (platform cannot tell: no picture rule, never guess); `audioProgress ===
undefined` (no audio rule); user mute does not suppress `audio-silent` (counters still advance when muted — a
silent counter is a real failure). Every verdict must hold for two consecutive ticks.

**Output.** The watchdog emits `{ verdict, since, evidence }`; the controller turns it into a status hint (§ c) and,
when the ladder threshold is reached, into a classified incident (`category T7` for picture/audio/slideshow,
`T1/T5/T6` for buffering by cause).

### b) One error taxonomy

#### b.1 Categories

Every failure from any source (HTTP envelope code, HTTP status, engine error, watchdog verdict, OS event) goes
through one pure function `classify(source) → { category, code, detail }` in `client/src/player/recovery/classify.ts`.

| Cat | Name | Typical sources |
|---|---|---|
| T1 | Transport | status 0, `network_unreachable`, `timeout`, `tls_error`, hls.js offline/timeout, Exo `IO_NETWORK_*`, AVP `NSURLErrorDomain`, NetInfo offline |
| T2 | Session gone | `playback_not_found`, `unknown_transcode`, `session_closed` (410), `unknown_stream`, `stream_expired`, playlist/segment 404 of a known-good URL |
| T3 | Signed out | 401 after refresh, `refresh_*`, `password_change_required`, `session_ended` |
| T4 | Server busy | 429 `too_many_playbacks`, `stream_capacity`, 503 `*_capacity`, `capacity_reached`, `catalog_unavailable` |
| T5 | Too slow | buffering budget exceeded, `segment_timeout` (504), watchdog `slideshow`, measured throughput < 1.2 × bitrate |
| T6 | Server failure | 5xx, `transcode_failed`, `rendition_split_failed`, `segment_unavailable`, `init_unavailable`, `segment_evicted`, `playback_failed`, wrong content type |
| T7 | Format / decoder | decode errors, `bufferAddCodecError`, `-12927`/`-11821`/`-12909`, Exo `DECODER_*`/`AUDIO_TRACK_*`, VLC error, watchdog `picture-black`/`picture-frozen`/`audio-silent` |
| T8 | Content | `release_dead`, `no_playable_file`, `probe_failed`, encrypted media, early end, corrupt segments after skip, `no_versions` |
| T9 | Policy | `age_restricted`, `transcoding_not_allowed`, `too_many_streams`, `title_not_found`/`season_`/`episode_not_found`, `forbidden` |
| T10 | System | interruption, route change, lock, PiP closed, AirPlay, autoplay blocked |
| T11 | Client | unknown codes, exceptions, `invalid_*` requests, `hlsjs:load`, caps load failure |

#### b.2 Ladder steps

| Step | What | Position |
|---|---|---|
| **W** wait | Keep the engine; show the hint; the engine's own retry runs | unchanged |
| **R** reload | `engine.load(sameSource, lastGoodPosition)` | `lastGoodPosition` |
| **N** new start | `POST /playback` with the same `releaseId`, audio/subtitle indexes and preferences, `startPositionTicks = lastGoodPosition` (what `restore()` does today, `controller.ts:482-516`) | `lastGoodPosition` |
| **Q** lower quality | `/switch { preferences.maxHeight }` one step down (2160 → 1080 → 720 → 480) | `resumePosition` |
| **S** step-down | `/switch { stepDown: true }` (server excludes method + engine) | `resumePosition` |
| **A** audio fallback | `/switch { audioStreamIndex }` same track, server-side conversion (needs the server flag `audioFallback`, follow-up B-task) — until then **S** | `resumePosition` |
| **V** other version | `/switch { releaseId: suggestedReleaseId }` only when the server suggested one, else the card's "Other version" | `resumePosition` |
| **G** give up | Terminal card with the category text, the ladder log, actions | stored `lastGoodPosition` |

#### b.3 Ladder and budgets per category

| Cat | Ladder (in order) | Budget | Card actions | Logged |
|---|---|---|---|---|
| T1 | W (engine retry) → R (backoff 2/4/8/16 s, only while NetInfo is online) → N | 2 min offline or 5 failed R/N | Retry (auto on `online`), Back | incident, NetInfo state, last HTTP status |
| T2 | N (once per 5 min) → T-of-the-new-error | 1 N | Retry, Back | old/new playbackId |
| T3 | pause → save position → card | — | Sign in again, Back | reason code |
| T4 | W with countdown (`Retry-After` or 5/10/20 s) → G | 3 tries / 60 s | Retry, Back | code, retryAfter |
| T5 | W (spinner + hint) → Q → Q → S | rebuffer > 15 s or 3 in 2 min per step; max 2 Q | Lower quality, Other version, Back | throughput, bitrate, rebuffer stats |
| T6 | R after `Retry-After`/30 s → N → S | 2 R + 1 N | Retry, Other version, Back | status, code, URL kind (no token) |
| T7 | (hls.js: recover → swapAudioCodec+recover) → R once (picture/audio verdicts: seek nudge first) → A (audio only) → S → S… → G | 1 R per revision; S until `no_more_methods` | Other version, Play with VLC (if offered), Back | engine error domain/code, verdict evidence, codec |
| T8 | R once (early end, corrupt) → V (if suggested) → G | 1 R | Other version, Back | position of the end, duration |
| T9 | G (too_many_streams: W with 10 s polls for 2 min) | — | only meaningful ones (no Retry for age/title) | code, params |
| T10 | adopt paused → hint → resume on OS `shouldResume` | — | Play | cause |
| T11 | R once → N once → G with code | 2 | Retry, Back | exception, code |

One incident at a time; a new failure during a ladder continues the same incident's ladder instead of starting a
second one. Budgets reset after 2 min of healthy playback.

#### b.4 Hints (one per situation, de/en, with the action)

| Key | Deutsch | English | Action |
|---|---|---|---|
| `H.starting` | Wiedergabe startet … | Starting playback… | — |
| `H.startSlow` | Der Start dauert länger als üblich. {cause} | Starting takes longer than usual. {cause} | Niedrigere Qualität / Lower quality (HLS) · Abbrechen / Cancel |
| `H.slowNet` | Langsame Verbindung: {measured} von {needed} Mbit/s. Wird gepuffert … | Slow connection: {measured} of {needed} Mbit/s. Buffering… | Niedrigere Qualität / Lower quality |
| `H.serverSlow` | Der Server wandelt langsamer um, als abgespielt wird. Wird gepuffert … | The server converts slower than playback. Buffering… | Niedrigere Qualität / Lower quality |
| `H.reconnecting` | Verbindung unterbrochen. Neuer Versuch in {seconds} s … | Connection lost. Retrying in {seconds} s… | Jetzt versuchen / Try now · Zurück / Back |
| `H.offline` | Keine Netzwerkverbindung. Es geht weiter, sobald das Gerät wieder online ist. | No network connection. Playback continues once this device is back online. | Zurück / Back |
| `H.serverDown` | Server nicht erreichbar. Neuer Versuch in {seconds} s … | Can’t reach the server. Retrying in {seconds} s… | Jetzt versuchen / Try now · Zurück / Back |
| `H.restarting` | Der Server hat die Wiedergabe beendet. Sie startet neu bei {time} … | The server ended this playback. Restarting at {time}… | — |
| `H.recovering` | Das Bild hängt. Wird bei {time} neu geladen … | The picture is stuck. Reloading at {time}… | — |
| `H.noPicture` | Kein Bild. Eine andere Wiedergabeart wird versucht … | No picture. Trying another way to play… | — |
| `H.noAudio` | Kein Ton. Die Tonspur wird neu geladen … | No sound. Reloading the audio… | Andere Tonspur / Other audio track |
| `H.decoder` | Dieses Gerät kann {format} nicht abspielen. Wird umgewandelt … | This device can’t play {format}. Converting instead… | — |
| `H.deviceSlow` | Das Gerät kommt nicht hinterher ({percent} % Bilder ausgelassen). | This device can’t keep up ({percent}% of frames dropped). | Niedrigere Qualität / Lower quality |
| `H.endedEarly` | Die Datei endet bei {time}, {missing} vor dem Ende. | The file ends at {time}, {missing} before the end. | Andere Version / Other version · Zurück / Back |
| `H.subtitleFailed` | Untertitel „{label}“ konnten nicht geladen werden. | Subtitles “{label}” couldn’t be loaded. | Andere Untertitel / Other subtitles |
| `H.pausedBySystem` | Pausiert: {cause}. | Paused: {cause}. | Weiter / Resume |
| `H.airplay` | Läuft auf {device}. | Playing on {device}. | — |
| `H.mutedAutoplay` | Ton aus – zum Einschalten tippen. | Sound off — tap to unmute. | Ton an / Unmute |
| `H.autoplayBlocked` | Der Browser hat den Start blockiert. | The browser blocked autoplay. | Abspielen / Play |
| `H.signedOut` | Abgemeldet: {reason}. Deine Position {time} ist gespeichert. | Signed out: {reason}. Your position {time} is saved. | Erneut anmelden / Sign in again |
| `H.serverBusy` | Der Server ist ausgelastet. Neuer Versuch in {seconds} s … | The server is busy. Retrying in {seconds} s… | Jetzt versuchen / Try now |
| `H.waitingForStream` | Startet, sobald die Wiedergabe auf {device} endet. | Starts as soon as playback on {device} stops. | Zurück / Back |

`{cause}` texts (de/en): Anruf/call, andere App spielt Ton/another app plays audio, Kopfhörer getrennt/headphones
disconnected, Bildschirm gesperrt/screen locked, Bild-in-Bild geschlossen/picture-in-picture closed, AirPlay
getrennt/AirPlay disconnected. Terminal cards keep the existing `errors.codes.*` texts and add "Was versucht wurde"
/ "What was tried" (ladder log, one line per step) and the code label. Unknown codes never fall back to
`errors.codes.unknown`: they use the category title (`errors.categories.T6.title` …) plus "Code: {code}".

### c) Timelines, position and progress

**Spinner → hint → ladder (buffering, mid-play).**

| t since stall | Shows | Does |
|---|---|---|
| 0–1 s | nothing (0 s after a seek: spinner) | engine retries |
| 1–4 s | centred spinner (no focus, `pointerEvents: none`) | — |
| ≥ 4 s | spinner + one hint line by cause: `H.slowNet` (throughput < 1.2 × bitrate), `H.serverSlow` (HLS transcode and throughput fine), `H.reconnecting`/`H.offline` (T1) | measure |
| ≥ 15 s or 3rd stall in 2 min | hint stays; notice "Lower quality to keep playing" | ladder T5 **Q** (or **R** for T6/T1) |
| ≥ 60 s total in one incident | terminal card | **G** |

**Start (after `ready`).** The card stays with a sixth step "Loading picture" (E03). 8 s → `H.startSlow` with the
cause (method transcode: "The server is converting the video"; slow throughput: measured Mbit/s). 20 s direct /
30 s HLS → **R** once; then the category ladder (no frames at all → T7, network errors → T1).

**When a retry becomes a step-down.** Only T7 steps down. T5 lowers quality first (a step-down from remux to
transcode is the fallback when there is no lower quality). T1/T2/T4/T6 never step down before their own budget is
spent, and transport errors never do.

**Position across every recovery.** One source of truth: `lastGoodPosition` (already updated only from steady
states, `controller.ts:281-285`) plus `startFloor` (`:111-112`). Every ladder step (R, N, Q, S, A, V) uses
`resumePosition` (`:151-155`); the watchdog's verdicts never update `lastGoodPosition` while a picture is black or
frozen (the clock may run without media). On **N** the new playback starts at `lastGoodPosition` with
`startPositionTicks` (no resume prompt: `startSeconds` is passed). Retry from the terminal card resumes at
`lastGoodPosition` too (today it restarts the route and asks).

**Progress across recoveries.** Heartbeats report `max(position, startFloor)` today. During an incident they report
`lastGoodPosition` (not an engine that reset to 0). After **N** the reports carry the new `playbackId`; the old one is
stopped. The queue keeps 401/403 reports per account until the account is signed in again (24 h cap), so a sign-out
mid-play does not lose the final position (A03, B23). A `stop` is always sent with `lastGoodPosition`.

### d) Test strategy (jest, no devices)

1. **Library fakes → real engines** (exists in part: `expo-video-engine.test.ts` FakePlayer, `web-engine-player.test.ts`
   hls.js mock, `vlc-engine.test.ts`). Extend each into a scriptable fake that can emit every native event and error
   of the matrix: `FakeHls` (all `ErrorTypes`/`ErrorDetails` with `fatal`, `response.code`), `FakeVideoElement`
   (`waiting`, `stalled`, `error` codes 1–4, `requestVideoFrameCallback`, `getVideoPlaybackQuality`,
   `webkitAudioDecodedByteCount`, `play()` rejecting `NotAllowedError`), `FakeExpoPlayer` (status, error payload with
   the patched `{domain, code, httpStatus}`, `readHealth` counters, `userPlayback` causes, external playback),
   `FakeVlcView` (`onEncounteredError`, `onStopped`, `onBuffering`, `getStats`, `onDialogDisplay`). Each test asserts the
   normalised `EngineEvent`s.
2. **`FakeEngine` → real controller + watchdog + recovery** (exists: `controller.test.ts`). Make it a `ScriptedEngine`
   with `emit`, `setHealth`, fake timers and a `FakeServer` for start/poll/switch/stop/progress that can answer any code.
3. **Screen tests** (`screens/player/__tests__`): render `PlayScreen` with a scripted controller state and assert the
   hint key, the actions and TV focus (status hints never focused).
4. **One test per matrix row**: `client/src/player/__tests__/matrix/{A,B,C,D,E}.test.ts` with
   `it.each(rows)` where each row has `id`, `engine` (one case per engine where the matrix differs), `script`
   (events/answers over fake time) and `expect` (`{category, ladder: ['R','S'], hint: 'H.slowNet', card?: code,
   position}`). Rows marked OK get a regression test too. A coverage test reads the row IDs from this file and fails
   if a row has no test (`F10-research.md` is the checklist).
5. **Server/client code drift test**: every code in `docs/api.md` §§5, 11, 12, 13 (parsed from the markdown) has an
   entry in `error-codes.ts` and a category in `classify.ts`.

### e) Live strategy

- **Dev World faults (B12)**: one fault at a time, armed per `playbackId` (so other agents' sessions on the same Dev
  World are untouched), on each target: Chrome (hls.js), Safari macOS + iPhone simulator Safari (native HLS),
  iPhone simulator + Apple TV simulator (AVPlayer), Google TV AVD + Android phone AVD (Exo, VLC with
  `engine: vlc`), iOS VLC via preference. Each run: arm → start or reach the state → screenshot at 1 s, 5 s, 20 s →
  assert hint/ladder from the client's diagnostics (`__streamarrPlayer.incidents` in dev) → clear.
- **Device/OS states without B12**: `xcrun simctl`/`adb` for network off/on (`svc wifi disable`, Network Link
  Conditioner on macOS), audio focus (`adb shell am start` of a music app / `cmd media_session`), lock (`adb shell
  input keyevent 26`, simulator lock), PiP close, background > 10 min (accelerated with
  `Streamarr:ViewerPlaybackIdleSeconds` = 60 on a dedicated Dev World port).
- **Real hardware list** (BACKLOG "Needs real hardware"): AirPlay, HEVC/DV/HDR decode failures, passthrough audio
  refusals, decoder reclaim, slideshow on a weak TV SoC, iPhone call interruption.
- Verification: an independent verifier walks the matrix as a checklist (row → evidence: test name + screenshot or
  log line) and reports any row still P1/P2.

### f) Slices for the builder (F10)

| Slice | Content | Rows closed | Effort |
|---|---|---|---|
| **S1 Taxonomy + texts** | `classify.ts` (all sources → T1–T11), codes missing in `error-codes.ts` (B11 refresh codes + reasons, `resolve_failed` kept, media codes `unknown_transcode`, `session_closed`, `segment_evicted`, `end_of_stream`, `unknown_stream`, `stream_capacity`, `invalid_event`), category texts, `H.*` hints de/en, unknown-code fallback, drift test | A04, A06, B12, E15, E16 (part) | M (1 d) |
| **S2 Matrix harness** | Scriptable library fakes, `ScriptedEngine`, `FakeServer`, `matrix/*.test.ts` skeleton with every row ID (pending), coverage test | — (enables all) | M (1 d) |
| **S3 Status layer UI** | `PlayerStatus` (spinner, hint line, action chips; never focusable on TV), start card until first frame (6th step), offline banner, paused-by-system chip, muted/blocked autoplay, AirPlay "playing on", panels closed on failure, card "What was tried" | E03, E04, E06, E10, E13, D07, D08, E09 | M (1.5 d) |
| **S4 Recovery ladder** | `recovery/ladder.ts` (incidents, budgets, steps R/N/Q/S/V/G), controller integration replacing `error → stepDown`, `lastGoodPosition` everywhere, early-`ended` handling, restore keeps a working source, progress queue keeps 401/403, foreground/online revalidation, too_many_streams/busy auto-retry | A03, A05, A09, A23–A25, B02–B05, B08, B10, B11, B15–B21, B23, B25, C01, C02, C07, C10, C11, C13–C15, C31, C32, D26, E17 | L (2.5 d) |
| **S5 Watchdog + web probes** | `health/watchdog.ts`, web `readHealth` (rVFC, playback quality, audio bytes, visibility), hls.js error refinement (status → category, recover budget, `swapAudioCodec`, `fragLoadPolicy` 30 s TTFB), Safari `stalled`, `hlsjs:load` retry | C08, C17, C27 (web), C28 (web), D01–D04, D06, D09, D10, D29, D33–D36, D38, D39 | M (1.5 d) |
| **S6 expo-video native probes** | patch-package for expo-video: Android `errorCodeName` + HTTP status, decoder counters, `onAudioUnderrun`, audio focus/noisy events; iOS NSError domain/code + `errorLog`, `isReadyForDisplay`, `AVPlayerItemVideoOutput` frame counter, interruption/route-change, external playback; engine `userPlayback` with causes | A12–A14, A16, A18, A19, C25, C26, D11–D13, D15–D21, D40 | L (2.5 d) |
| **S7 VLC probes** | extend the libVLC patch (`decodedAudio`, `playedAbuffers`, `lostAbuffers`), VLCKit 4 statistics on Apple, watchdog without the `displayedPictures > 0` gate, `directRendering:false` retry, `onDialogDisplay` | D22–D25, D27 | M (1 d) |
| **S8 Subtitles + content edge cases** | subtitle-only failures (off + notice), `subtitle_not_deliverable` notice with VLC action, encrypted media, zero-length files, seek debounce on transcode | C22–C24, C30, C31, D31 | S (0.5 d) |
| **S9 Live fault runs** | B12 faults × engines (§ e), OS-state runs, matrix walk with evidence, fixes from findings | all rows' live evidence | L (2–3 d, needs B12) |

Order: S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8, S9 after B12. S6/S7 need native rebuilds (one device at a time per the
round rules). Server follow-ups found here (not part of F10/B12): seek-back hang after retention (C09), audio
fallback flag for **A**, optional `playbackAlive` in the progress answer (B24), `Retry-After` on `segment_evicted`.

---

## 3. Open questions (decided here, no blocker)

- AVPlayer audio-silence cannot be measured without an `MTAudioProcessingTap`; F10 ships the heuristic (D21) and
  leaves a tap-based meter out (CPU and complexity on Apple TV).
- `AVPlayerItemVideoOutput` adds a decode-output path; S6 must measure CPU/GPU on Apple TV and fall back to
  `isReadyForDisplay` + clock-only rules if the cost is visible.
- hls.js `fragLoadPolicy` 30 s TTFB vs server 90 s wait: a server-side cap of ~25 s per wait (then `504`) would let
  both sides agree; proposed as a server follow-up, the client works with either.
