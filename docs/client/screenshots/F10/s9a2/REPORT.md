# F10 S9a2 — web engines re-audit after the S9a fixes (live, Chrome only)

Auditor: unattended subagent · 2026-10-05 05:52–06:46 CEST · worktree `/Users/til/Development/streamarr-f10w` @ 225fe02 (read-only, no product change; `git status` shows only the new screenshot folder)

## Setup

- **App:** Metro web from f10w on :8083 (`EXPO_PUBLIC_TEST_MUTED=1 … --clear`).
- **Browser:** headless Chrome for Testing 149 (`--headless=new --mute-audio --disable-gpu`), fresh profile `/tmp/ri/s9a2/profile`, CDP :9223, 1280×800.
- **Driver:** CDP daemon `/tmp/ri/s9a2/cdpd.mjs` on :9333. Status sampler `/tmp/ri/s9a2/st.js` reads `__streamarrPlayer.phase/status/health/runner.current/failure/notice`, the engine snapshot and `<video>`. Row scripts are `mid.sh`, `startf.sh`, `samp.sh`, `p8.sh` and `b4.sh` in `/tmp/ri/s9a2/`.
- **Account:** signed in as anna through the web sign-in link, signed out at the end (Einstellungen → Abmelden → "Wer schaut? Anna Abgemeldet").
- **Faults:** Dev World 39300 (B12 + B13 + B13b). Faults were scoped to my playbacks (`playbackId`, `next:anna`) plus one `workId` fault for B06, cleared right after. My ids were f1–f48. All were cleared and `GET /devworld/faults` = `[]` at the end. No `global` and no `viewer` faults.
- **No simulator or emulator was booted.**
- **Screenshots:** `streamarr-f10w/docs/client/screenshots/F10/s9a2/` (JPEG, 130 files; the key ones were opened and checked).

**Note on short Dev World clips.** Dev World clips are short and hls.js buffers them in about 1 s. Mid-play faults therefore use a `throttle {video, 1100 kbps}` (`next:anna`) to keep the buffer small; it is removed right after the row fault is armed, the same method as S9a.

**Note on the time label.** The overlay's time label in `innerText` lags the clock by up to 10 s in headless Chrome. Positions in this report are `video.currentTime`.

## Results — S9a rows re-run (same repro)

| row | browser | fault / steps | what the viewer saw (1 / 5 / 20 / 60 s) | status values | verdict | screenshot |
|---|---|---|---|---|---|---|
| START remux | Chrome | `seg_delay {video, 6000 ms, count 2}` (`next`), Sintel `start=90` | 1 s start card. 2–6 s: **black, clock 0:00 / −3:00, Pause icon, no visible spinner, no hint** (controls are up, so the spinner is not drawn). 6 s: "Der Start dauert länger als üblich. Der Server bereitet das Video noch vor. [Niedrigere Qualität][Abbrechen]". 15 s: picture at 1:30 | `status.spinner true` from 2 s, `hint startSlow{preparing}` at 6 s, engine pos 90, `rs 0→1→4` | **FAIL** (much better than S9a: the black start is now ~4 s and a hint follows, but there is still bare black 0:00 with nothing drawn while the controls show) | start-1s/5s.jpg, start-after.jpg |
| NET offline 20 s | Chrome | CDP offline 20 s mid-play (throttle kept), then online | 1 s: "Keine Netzwerkverbindung. Es geht weiter, sobald das Gerät wieder online ist. [Zurück]", plays from the buffer. 16 s: buffer empty → spinner + same hint. Back online: hint gone at once, continues 29.9 → 48 s, same playbackId, **no step-down notice** | `hint offline`, `offline true` → false, no recovery | PASS | offline-1s/5s/20s.jpg, offline-back-*.jpg |
| GONE (server-restart substitute) | Chrome | `playback_gone` (always) mid-play remux | 1 s: spinner + "Der Server hat die Wiedergabe beendet. Sie startet neu bei 0:17 …". 2 s: new playbackId at 17.8 s, plays; tracks kept; no notice | T2 `unknown_transcode`, pid 27f770 → f968a6 | PASS | gone-1s/5s/20s.jpg |
| STREAM_DEAD | Chrome | `stream_dead` + `setQuality(720)` | silent switch to 720p transcode at the position, no hint (fault hit "stream reported dead") | method transcode, same pid | PASS | stream-dead-*.jpg |
| A03 session revoked | — | `session_revoke {admin}` revokes anna's **newest** session. `/viewer/me/sessions` showed the native agent's Apple TV (created 06:38) and iPhone as newer than mine, so the fault would have hit their session | — | — | NOT RUN (shared viewer, my session is not the newest) | — |
| Session ended via refresh (A05) | — | `token_expire` / `refresh_fail` also target the newest session: same reason | — | — | NOT RUN (same) | — |
| C10/D01 404 | Chrome | `seg_status {video, 404 unknown_transcode}` always | 1 s: "Der Server hat die Wiedergabe beendet. Sie startet neu bei 0:17 …"; 3 s new start at the position; **1 fault hit** (no 31 s of hls.js retries); no notice | T2 → new pid b505af | PASS | c10-404-*.jpg |
| C10 503 (+ R7) | Chrome | `seg_status {video, 503 segment_unavailable} ×8` | 10 s (stall): "Problem auf dem Server. Neuer Versuch in 4 s … [Jetzt versuchen]" — **no Lower quality**; 14 s "Wiedergabe unterbrochen. Geht weiter bei 0:24 …" over the last frame with spinner; 22 s "Neuer Versuch in 15 s"; 40 s plays at 0:24. Never "Wird gepuffert", never lowering | T6 `segment_unavailable` | PASS | c10-503-1s/5s/20s/60s.jpg |
| C21 | Chrome | `seg_status {init, 503 init_unavailable} ×8` at start | 1 s spinner. 5 s "Der Start dauert länger … Der Server bereitet das Video noch vor." 10 s "Problem auf dem Server. Neuer Versuch in 4 s …". Then reload, 15 s countdown, reload. 40 s plays at 0:10. **Side effect:** notice "Untertitel „Deutsch“ konnten nicht geladen werden und sind aus." (see SEEK-SUB) | T6, `spinner true` throughout | PASS (subtitle side effect counted under SEEK-SUB) | c21-1s/5s/20s/60s.jpg, c21-95s.jpg |
| C12/C18 | Chrome | `playlist_endless {segments 10}` armed `next` before the start, Sintel `start=40`. (Armed mid-play it gets 0 hits: hls.js loads the VOD playlist once.) | Clock shows **0:00 / −1:00** at the start (duration 60 instead of 180). Plays to 0:59; 22–24 s stall with spinner, no hint. 26 s: **end card "ZU ENDE — Nochmal abspielen / Zurück zu den Details" at 0:59 of a 3:00 title**, and it stays. No step-down, no hint | `phase playing`, `rs 2`, 39 playlist hits | **FAIL** (false end: the viewer is told the film is over) | c12-1s/5s/20s/60s.jpg |
| D10 | iPhone Safari | — | — | — | NOT RUN (simulators belong to the native agent until ~10:00) | — |
| C16 | Chrome | `seg_truncate {video, 50 %} ×3` | nothing visible (hls.js re-fetched seg 6 three times) | no recovery | PASS | c16-*.jpg |
| C17/D02 | Chrome | `seg_corrupt {video, box} ×3` (segs 6, 7, 8) | nothing visible, playback continuous | no recovery | PASS | c17-*.jpg |
| D33(a) | — | Chrome has no HEVC → the server transcodes (unchanged since S9a; not re-run) | — | — | NOT REPRODUCIBLE | — |
| D33(b) | Chrome | `seekBy(20)`, then `getVideoPlaybackQuality` = 0 frames | 9 s "Das Bild hängt …" (frozen verdict first), reload at 0:41. 20 s "Kein Bild. Eine andere Wiedergabeart wird versucht …", then step-down to transcode with notice. The stub stays on the `<video>` element, so it repeats (harness artefact) | `picture-frozen` → `picture-black` | PASS | d33b-1s/5s/20s.jpg |
| D34 | Chrome | frozen `getVideoPlaybackQuality` | 5 s spinner + "Das Bild hängt. Wird bei 0:15 neu geladen …"; 9 s reload at 0:15 plays. Later black verdict + step-down only because the stub persists (artefact) | `picture-frozen`, `level hint` | PASS | d34-1s/5s/20s.jpg |
| D36/C20 | Chrome | `split_abort {rendition 1, 4096 B}` always, mid-play | 10 s "Kein Ton. Die Tonspur wird neu geladen …" with spinner. 18 s plays at 0:25 with the notice "Ton in Stereo umgewandelt, damit es weitergeht." Plays on to the end; never "Verbindung unterbrochen" | T7 `audio_rendition_failed` → audio fallback | PASS | d36-1s/5s/20s/60s.jpg |
| C27 | — | no undecodable rendition reaches Chrome | — | — | NOT REPRODUCIBLE | — |
| D38 live | — | CPU throttle slows JS, not the decoder (S9a); not re-run | — | — | NOT REPRODUCIBLE | — |
| D38 sim | Chrome | `getVideoPlaybackQuality` reports 70 % dropped | 10 s "Wechsel auf eine niedrigere Qualität, es geht weiter bei 0:21 …" → 720p at 0:21. 30 s: 480p | T5 `playback_slideshow` | PASS | d38-1s/5s/20s.jpg |
| C03 | Chrome | `throttle {video, 200 kbps}` mid-play | spinner on each stall, but the stalls stayed under 4 s, so the "Langsame Verbindung" hint never showed this run | — | NOT REPRODUCIBLE (this run) | c03-*.jpg, c03-stall-*.jpg |
| C08 | Chrome | `transcode_slow {readrate 0.5}` (`next`), BBB HEVC release (transcode) | spinner from 1 s. 6 s "Der Start dauert länger als üblich. **Der Server wandelt das Video um.**" 33 s reload; 50 s picture at 0:11. 70 s stall → "**Der Server wandelt langsamer um, als abgespielt wird.** Wird gepuffert … [Niedrigere Qualität]". Never "Langsame Verbindung" | `startSlow{converting}`, `picture_timeout` reload, `serverSlow` | PASS | c08-1s/5s/20s/60s.jpg |
| D29 | Chrome | `seg_delay {video, 25 s, after segment 12}` (`next`), start 0:05, `seekTo(130)` | 1 s spinner + "**Kein Ton. Die Tonspur wird neu geladen … [Andere Tonspur]**" plus the notice "Untertitel „Deutsch“ konnten nicht geladen werden". 16–40 s "Kein Ton …" reload with black 0:00. 50 s "Der Server wandelt langsamer um …". 60 s lowering to 720p | T7 `audio_rendition_failed` (wrong: only the **video** is delayed) | **FAIL** (wrong cause and a pointless action "Andere Tonspur" for 40 s) | d29-1s/20s/60s.jpg |
| D06 | Chrome | `Network.setBlockedURLs *hls*`, start Sintel at 0:20 | 3 s spinner. 8 s "Wiedergabe unterbrochen. Geht weiter bei 0:20 …". 18 s card "Ein Teil des Players konnte nicht geladen werden …" (`player_load_failed`, tried R, N). Unblock + "Erneut versuchen" → plays at 0:20 after ~12 s | T11 | PASS | d06-1s/5s/20s.jpg, d06-retry-40s.jpg |
| D09 | iPhone Safari | — | — | — | NOT RUN (device busy) | — |
| D35 | — | jest only | — | — | NOT REPRODUCIBLE | — |
| P1/D39 | — | Exo/AVPlayer | — | — | NOT REPRODUCIBLE (web audit) | — |
| P2/D41 | Chrome | `seg_corrupt {video, garbage}` always + `api_status {api:switch, 500}` once | 5 s reload; 10 s "Problem auf dem Server. Neuer Versuch in 5 s" (switch 500); 15 s reload. 20 s step-down notice "Wechsel zu Transkodierung …". 30 s plays the other release at 0:21 with "Zu einer anderen Version gewechselt …" (English only: that release has `en` audio/subs only). 20 fault hits in total (no hot loop) | R, S, R, V | PASS | p2-1s/5s/20s/60s.jpg |
| P3/A24 | — | Android | — | — | NOT REPRODUCIBLE (web audit) | — |
| P4/P10 | Chrome | in-engine English audio (index 2) + English subtitles (4), then `seg_status {video, 500 transcode_failed} ×7` | 10 s "Wiedergabe unterbrochen … 0:22" (+ a false "Untertitel „Englisch“ … aus" notice, SEEK-SUB). 30 s plays at 0:22; overlay Englisch 2.0 / Englisch; `textTracks` "English (styled): showing" | `currentAudio 2`, `currentSubtitle 4` | PASS | p4-*.jpg, p4-after.jpg |
| P5/C32 | Chrome | `direct_truncate 50 %` (`next`) on BBB mp4, start 1:20 (armed mid-play: Chrome had buffered the whole file, 0 effect) | 1:28 stall; 12 s spinner; 15 s "Laden dauert länger als üblich. Wird gepuffert … [Niedrigere Qualität]"; 25 s lowering → 720p transcode plays past the cut | T5 | PASS (compensated; the 416 is shown as generic buffering for 10 s) | p5-*.jpg |
| P6/B25 | — | needs a 39330 restart | — | — | NOT REPRODUCIBLE | — |
| P8/C14 | Chrome | `seg_status {video, 503, retryAfter 10} ×9`, during "Neuer Versuch in 5 s" `setQuality(720)` | 5 s "Der Start dauert länger … Der Server wandelt das Video um." 10 s "Problem auf dem Server. Neuer Versuch in 4 s" (remaining fault counts hit the new transcode). 15 s plays 720p at 0:24. Never stuck. The countdown shows 5 s (B13b: the player's own wait, by design) | `serverError{5}` | PASS | p8-1s/5s/20s/60s.jpg |
| D07 | — | `EXPO_PUBLIC_TEST_MUTED=1` always autoplays | — | — | NOT REPRODUCIBLE | — |
| D08 sim | Chrome | `Page.addScriptToEvaluateOnNewDocument` makes `play()` reject `NotAllowedError` | 5 s "Der Browser hat den Start blockiert. [Abspielen]" at 0:20; tap → plays 0:21, hint gone | `hint autoplayBlocked` → null | PASS | d08-5s.jpg, d08-played-1s.jpg |
| 10/A24 start offline | — | iPhone NLC | — | — | NOT REPRODUCIBLE (web audit) | — |
| E09 | Chrome | `engine.load = () => { throw }` + `playback_gone` | 1 s card "**Interner Fehler im Player** … Fehlercode player_internal_error [Erneut versuchen][Zurück]"; no Lower quality. "Was versucht wurde: Neu geladen bei 0:13 · **Der Ton konnte nicht geladen werden**" (the gone playback's first failing request was an audio fragment, so the trigger was called an audio failure) | failure `player_internal_error`, tried R(T7 `audio_rendition_failed`) | PASS (card right; the "tried" line names a wrong cause) | e09-1s/5s/20s.jpg |
| D26, A25, 19 | — | Android / screen readers | — | — | NOT REPRODUCIBLE (web audit) | — |
| B06 | Chrome | BBB h264 HLS release `f008c8…`, `transcode_never_start {transcode_failed}` (`workId`, always) + `playback_gone` | 1–5 s "Problem auf dem Server. Neuer Versuch in 5 s …" over the running picture. 8 s plays the direct-play mp4 release at 0:14 with "Zu einer anderen Version gewechselt, damit es weitergeht." | T6 `transcode_failed` → V | PASS | b06-1s/5s/20s/60s.jpg |
| 20 layout web 1280 | Chrome | observed incidentally | controls hidden: centred spinner + hint over the last frame (c10-503-20s). Controls shown: hint under the top bar, Play cluster free, **spinner not drawn** (see START, E18) | — | PASS (hint layout); the hidden spinner is counted under START | c10-503-20s.jpg, start-5s.jpg |

## Results — new rows (journal "Live checks for S9 — S4c + S8", "— S4d", "— S9a re-run", "— S4f"; web-provokable)

| row | browser | fault / steps | what the viewer saw | status values | verdict | screenshot |
|---|---|---|---|---|---|---|
| **SEEK-SUB** (new; every seek, every start at > 0, every reload with subtitles on) | Chrome | no fault: Sintel with German subtitles, `seekTo(130)` | 1 s notice "**Untertitel „Deutsch“ konnten nicht geladen werden und sind aus. Sie werden in einer Minute erneut versucht.**"; subtitles off (overlay "Aus") for ~60 s, then back. Also at a plain start at 0:20 (D08), after reloads (C21, P4, P8, P2) and after a seek (D29). hls.js event on the seek: `{details:"aborted", fatal:false, frag.type:"subtitle"}` (also `main` and `audio`) | `notice subtitleFailed {code subtitle_unavailable}` | **FAIL** (false failure text; subtitles lost for a minute on every seek) | seek-plain-1s.jpg, d08-5s.jpg, c21-60s.jpg |
| Retry-After / R7 | Chrome | see C10 503, P8, B4 | "Problem auf dem Server. Neuer Versuch in 5 s" (fixed 5 s per B13b), reload, never lowering | — | PASS | c10-503-*.jpg |
| playbackAlive | Chrome | see GONE | new start within ~1 s at the position, tracks kept | — | PASS | gone-*.jpg |
| Audio fallback (watchdog variant) | Chrome | see D36 | "Kein Ton …" → "Ton in Stereo umgewandelt" | — | PASS | d36-*.jpg |
| Subtitles 404 (C22) | Chrome | German subtitles (stream 5) on, `subtitle_status {rendition 5, 404}` always, seek | 1 s notice "Untertitel „Deutsch“ konnten nicht geladen werden und sind aus. Sie werden in einer Minute erneut versucht."; picture and audio unaffected; no step-down. Fault cleared → German subtitles back at ~50 s | `subtitleFailed {unknown_subtitle_stream}` | PASS | sub404-1s/5s/20s.jpg, sub404-back-60s.jpg |
| C31 | Chrome | `direct_truncate {percent 0}` (`next`) on BBB mp4 | 3 s spinner + "Eine andere Version wird versucht, es geht weiter bei 0:00 …"; 5 s the other release plays with "Zu einer anderen Version gewechselt …"; never the end card | T8 `end_of_stream` → V | PASS | c31-1s/5s/20s/60s.jpg |
| B3 | Chrome | `seg_stall {video, 60 s, after segment 29}` (`next`), start 2:48 | stall at 2:53 (−0:06); 2 s spinner; ~3 s end card "ZU ENDE"; no lowering, no `/switch` | — | PASS | b3-1s/5s/20s.jpg |
| B4 | Chrome | `seg_status {503, retryAfter 10} ×4`, during "Neuer Versuch in 5 s" `seekTo(100)` | the hint's time followed to 1:40; reload at 1:40, plays | — | PASS | b4-1s/5s/20s.jpg |
| **R13** | Chrome | `start_hang {600 s}` (`next`, hits the restart) + `playback_gone` mid-play | 1–20 s "Der Server hat die Wiedergabe beendet. Sie startet neu bei 0:10 …" while the old buffer plays 0:10 → 0:24. Buffer empty at ~22 s. 30 s card "**Wiedergabe beendet** — Diese Wiedergabe ist beendet oder abgelaufen … Fehlercode **playback_not_found**"; tried N(T2 `session_closed`), **Q(T5 `playback_stalled`)** | the restart playback `2573be` is still `starting` | **FAIL** (wrong card and code; Q on a closed playback; expected the restart to wait for the server's 60 s `start_timeout` / "server took too long") | r13-1s/5s/20s/60s.jpg |
| B16/E02 | Chrome | `playback_stuck {planning, 120 s}` (`next`) | start card; 33 s "Der Start dauert länger … Der Server bereitet das Video noch vor."; 63 s card "Der Server hängt beim Vorbereiten … Fehlercode start_stuck [Erneut versuchen][Andere Version wählen][Zurück]" | `start_stuck` | PASS | b16-1s/5s/20s/60s.jpg |
| **B13b viewer switch, slow server** | Chrome | Sintel remux playing; `transcode_slow {readrate 0.2}` (`playbackId`, always); `setQuality(720)` | The server answers the switch `ready` quickly, so the engine loads the new source at once: **the old picture is gone at 1 s** (black 0:00, spinner). 5 s "Der Server wandelt das Video um." 30 s lowering to 480p (`segment_timeout`). 60 s "Eine andere Version wird versucht …". 90 s reload. ~110 s card "**Kein Bild erschienen** … Fehlercode picture_timeout [Andere Version wählen][**Mit VLC abspielen**][Zurück]" | tried Q, S, V, R | **FAIL** (journal: "Couldn't switch …" while the old picture plays on. Instead: a two-minute ladder, a card naming the wrong cause, no Retry, and a VLC action offered in a web browser) | b13b-1s/5s/20s/60s.jpg, b13b-late.jpg |
| E18 | Chrome | `setQuality(480)` while playing | 0.6 / 1.6 s: the last frame stays under the controls (not black); label "0:00 / −3:00", no visible spinner while the controls show | `spinner true`, engine `loading` | PASS (picture kept; label/spinner counted under START) | e18-0_6s.jpg, e18-1_6s.jpg |
| A26 captive portal | — | `captive_portal` only has a `viewer` scope, which would hit the other agent's anna devices | — | — | NOT RUN (shared viewer) | — |
| A03/A05/A07, password_change | — | newest-session / viewer faults (see A03) | — | — | NOT RUN (shared viewer) | — |
| B5, R1, R5, B1, B2, D31, R12, E16, C24, B07, C04 | — | not reached in the time box (B2 needs Cast/AirPlay; R1 a firewall rule; R12/E16 need a dev-build code throw) | — | — | NOT RUN | — |
| Safari rows (D09, D10, white-pill button, B6) | — | no simulator for this slice | — | — | NOT RUN (device busy) | — |

**Counts (rows run or judged):** PASS 28 · FAIL 6 · NOT REPRODUCIBLE 11 · NOT RUN 9 groups (A03, A05, D10, D09, A26, Safari pill, B5…C04 group, R12/E16, B6).

**S9a FAIL rows, re-run:**
- Now PASS: C21, D36, P2, P8, E09, B06, C08, C10 503.
- Still FAIL: START (narrowed to ~4 s with nothing drawn), D29 (changed: now the wrong "Kein Ton" cause instead of black).
- New FAILs: C12 (now a false end card), SEEK-SUB, R13, B13b switch.
- D10 not re-run.

## FAIL rows — repro and suspected code

1. **SEEK-SUB — every seek / start at a position / reload with subtitles on says the subtitles failed and turns them off for a minute.**
   - Repro: Sintel (`tmdb-movie-45745`) with German subtitles, no fault, `__streamarrPlayer.seekTo(130)`. You get the notice "Untertitel „Deutsch“ konnten nicht geladen werden und sind aus …" at 1 s, and the overlay shows "Aus".
   - The hls.js error on the seek is `{details:'aborted', fatal:false, frag:{type:'subtitle'}}`, which hls.js raises itself when it cancels an in-flight load.
   - Suspect: `subtitleFailure()` in `client/src/player/engines/web-engine.web.tsx:719-728` counts any error whose `frag.type === 'subtitle'`, including `aborted`. It forwards that as `subtitleError` (`:435-436`), and the controller acts on it in `onSubtitleError` (`controller.ts:684-702`).
   - Fix direction: ignore `details === 'aborted'` (and errors raised while seeking or reloading).
   - The same aborted audio fragment feeds item 3.

2. **C12/C18 — a playlist without ENDLIST ends the film early with the end card.**
   - Repro: `{"fault":"playlist_endless","scope":{"next":"anna"},"params":{"segments":10},"mode":"always"}`, then open `/play/new?workId=tmdb-movie-45745&start=40`.
   - The duration shows 1:00 instead of 3:00. At 0:59 the stall becomes "ZU ENDE / Nochmal abspielen".
   - Suspect: `get duration()` (`controller.ts:346-350`) trusts the engine's finite duration (60 s from the cut playlist) over the server's `mediaInfo.durationTicks` (180 s). The S9a D10 fix only falls back to the server when the duration is not finite.
   - Then `nearEnd()` (`controller.ts:1093-1096`) and the stall handler `stall: () => (this.nearEnd() ? this.finish() : this.startStall())` (`controller.ts:299`) finish the title.
   - Fix direction: when the server's duration is known and the engine's is clearly shorter (> 10 s), use the server's for the end decision. Treat a stall more than `END_MARGIN` before the server's end as a stall, not an end.

3. **D29 — a delayed video segment is called "No sound" for 40 s.**
   - Repro: `{"fault":"seg_delay","scope":{"next":"anna"},"target":"video","params":{"ms":25000},"after":{"segment":12},"mode":"always"}`, start Sintel at 5, then `seekTo(130)`.
   - The viewer sees "Kein Ton. Die Tonspur wird neu geladen … [Andere Tonspur]" from 1 s, then a T7 `audio_rendition_failed` reload.
   - Mechanism: the seek aborts the in-flight audio fragment (`aborted`, status 0). Video fragments arrived within the last 15 s (before the seek), so the S9a "audio rendition failure" rule (`web-engine.web.tsx`, the non-fatal audio fragment branch that emits `loadRetry {audio:true}`) classifies it as an audio failure.
   - Fix direction: as in item 1, ignore `aborted`. Count only video fragments that arrived *after* the failing audio request.

4. **R13 — a restart the server leaves in `starting` ends on "Wiedergabe beendet / playback_not_found" after 30 s.**
   - Repro: Sintel playing, then arm `{"fault":"start_hang","scope":{"next":"anna"},"params":{"seconds":600}}` and `{"fault":"playback_gone","scope":{"playbackId":P},"mode":"always"}`.
   - While N waits for the new playback, the old hls.js source plays on from its buffer. When that runs dry, the stall is T5, so the runner runs **Q** (`/switch` on the closed playback) → `playback_not_found` → card.
   - This is the same mechanism as S9a E09; the S9a fix covered only a throwing `engine.load`.
   - Suspect: the N step in `controller.ts`/`recovery/runner.ts` — the old engine is not paused or detached when a new start is requested after T2, and stalls during an active N step are handled as new incidents.
   - Fix direction: stop the old source when N begins (keep the last frame), and let the N step wait for the server's own budget (`start_timeout` at 60 s, B13b) or the step budget.

5. **B13b viewer switch on a slow server — the old picture is dropped at once, then a 2-minute ladder ends on the wrong card, with a VLC button on web.**
   - Repro: Sintel remux playing, arm `{"fault":"transcode_slow","scope":{"playbackId":P},"params":{"readrate":0.2},"mode":"always"}`, then `__streamarrPlayer.setQuality(720)`.
   - The server reports the switch `ready` quickly (segments then come at 0.2× speed), so the "keep the old source on `start_timeout`" path never applies. The engine loads the new source and the picture goes black at once.
   - Ladder: Q (`segment_timeout`) → S → V (`no_more_methods`) → R → card `picture_timeout` "Kein Bild erschienen" at ~110 s.
   - Problems:
     - (a) A viewer switch could keep playing the old source until the new one delivers its first frame.
     - (b) The final card names "no picture" for a server that converts too slowly.
     - (c) The card offers no Retry, and offers **"Mit VLC abspielen" in a browser**: `ladder.ts:248` (T7 → `['otherVersion','useVlc']`), with no platform filter in `screens/player/card-actions.ts` `cardButtons`.

6. **START (and every reload/switch) — bare black or frozen frame with "0:00 / −3:00" and no visible spinner while the controls show.**
   - Repro: the START repro of S9a: `seg_delay {video, 6000 ms, count 2}` (`next`), Sintel `start=90`.
   - From 2 s to 6 s `status.spinner` is true, but the controls are shown, so no spinner is drawn. The clock reads 0:00 / −3:00 instead of 1:30, and the Play button shows Pause (start-5s.jpg). The hint arrives at 6 s.
   - The same label and missing spinner appear in every reload or switch (E18, C10-503 at 14–35 s, P4).
   - Suspect:
     - The status layer hides the spinner while the controls are visible (`screens/player/player-status.tsx`, layout rule 20).
     - The overlay clock uses the engine position (0 while loading) instead of `controller.position` / `loadPosition` (`overlay-labels.ts` / `play-screen.tsx`).
   - Fix direction: show the spinner (or a small spinner in the Play button) while the controls show, and show the target position while loading.

Observations (no verdict of their own):
- E09's "Was versucht wurde" line reads "Der Ton konnte nicht geladen werden". When `playback_gone` closes the session and an audio fragment fails first, the trigger is classified `audio_rendition_failed` (T7 → R) instead of T2. This works here only because the internal error is terminal. With a healthy engine, a gone playback whose audio fragment fails first would go R → A (`/switch audioFallback` on a closed playback). Worth a row test.
- C12 also showed a subtitle failure at the start: the fault cuts the subtitle playlist too, so that one is legitimate.

## Cleanup
- **Faults:** all of mine cleared; `GET /devworld/faults` = `[]`. No global or viewer fault was ever armed.
- **anna:** the Chrome session (`a34d80`) is signed out through Einstellungen → Abmelden. No other session was touched (A03/A05/A26 not run for that reason).
- **Processes:** the CDP daemon :9333, headless Chrome :9223 (profile `/tmp/ri/s9a2/profile`) and Metro :8083 are stopped. `lsof` shows nothing listening on 8083/9223/9333.
- **Devices:** no simulator or emulator was booted or touched.
- **f10w:** no files changed except the new screenshot folder `docs/client/screenshots/F10/s9a2/` (untracked).
