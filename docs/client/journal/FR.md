# FR — frame-rate matching on the Streamybox engine path

Status: partial — client fix done and emulator-verified; box verification pending (owner's OK, see "Box plan")
Branch: `fix/streamybox-frame-rate` (worktree `streamarr-worktrees/fr-streamybox`), off main ed8e104e.
Owner report (2026-11-07): Spider-Man (4K DV P8 / HDR10, 3840×2024, 23.976 fps, E-AC3 5.1 bitstream) in the Streamybox
engine drops frames visibly in motion. The display stayed 3840×2160@60 for the whole film (3:2 pulldown + drift).

## Root cause

**Client (confirmed on the emulator):** `StreamyboxPlayerView` voted only from `tracks.video.frameRate` (mpv
`current-tracks/video/demux-fps`), with four defects:

1. **No fallback**: a file without a container rate (e.g. an MKV without video DefaultDuration) gets `tracks.video`
   without `frameRate`; the view never called `setFrameRate`, so SurfaceFlinger had no vote and stayed at 60 Hz.
   Emulator, `fr2398-nodur.mkv`: `tracks.video = {width:1920,height:1080,codec:"h264",range:"sdr"}`, no vote of its own.
2. **Stale vote**: a later `tracks` event without a rate set the remembered rate to 0, so the next surface change voted
   nothing while SF kept the *previous* file's rate on the layer (emulator: 23.98 Hz stayed on the layer of a file with no
   rate; a 25 fps file after a 23.976 one keeps 23.976 until its own tracks arrive).
3. **Never cleared**: no `setFrameRate(0)` on stop, end or fatal error; the layer stays (SDR blank) under Streamarr's
   UI, so after a match the box would stay at 24 Hz there.
4. **Silent**: `runCatching` swallowed any `setFrameRate` failure and nothing was logged, so a box log could not show
   whether a vote was ever made (the 11-07 log has no client line at all).

What works (also on the old code): when the rate is present, the vote lands on the layer that shows the video,
`SurfaceView[dev.streamarr.app/…MainActivity](BLAST)`, as `23.98 Hz ExactOrMultiple OnlySeamless`, also after a reload
(sf-layers-emulator.txt). The vote is made in Streamarr's process on the BLAST surface (BBQSurface → SurfaceControl
transaction), independent of the remote producer (codec in the player process).

**Box (not yet settled — needs one live dump):**
- 11-07 01:37–04:00: the HWC log has **no** mode-change attempt during the film (no `UpdateDisplayModeNormal`), so SF never
  saw an effective 23.976 vote. With ContentDetection=false on the box (only explicit votes count) a present vote should
  have switched to 4K24 (mode 301, group 0 like the active 60 Hz modes, render range 0–60). Most likely defect 1 (no
  container rate for that file), but the log cannot prove it (defect 4).
- 11-05 18:20 (another DV title, Streamybox engine): SF **did** switch: HWC `update mode-id=223 3840x2160p24 success`
  at 18:20:34.9, then after the HDMI re-plug of that modeset (during a bridge park from 4K120) `3840x2160p60` at
  18:20:35.8, and it stayed 60 for the rest of the session. So a vote can be lost/overruled around a modeset + re-plug on
  this BSP; whether that is the bridge park, HDR or SF is open.
- ExoPlayer matches on the box (docs/74: 4K25, 4K24) were SDR titles; no HDR title has been seen matching yet.

## Decisions

- Vote the exact content rate (23.976 stays 23.976; the snap table/1 % window of the expo-video patch), FIXED_SOURCE,
  CHANGE_FRAME_RATE_ONLY_IF_SEAMLESS; the box gets a true 23.976 mode the moment the BSP offers one.
- Fallback order: mpv's container rate (`tracks.video.frameRate`), else the server's ffprobe rate, which the playback
  answer already carries as `mediaInfo.video.fps` (no server change). A client-side *measurement* like the expo-video
  patch is not possible here: the frames are produced in the player process and Streamarr's process only hosts the
  BLAST consumer (no public per-buffer callback), and mpv's `stats.totalFrames` (`estimated-frame-number`) needs the
  container rate itself. The measured rate exists in the player (`estimated-vf-fps`) → request to Streamybox below.
- The vote is held by a pure `FrameRateVote` (JVM-tested); the view votes on load (server rate, before the first frame),
  tracks, first frame (re-assert) and every surface change (`surfaceChanged`), clears on a new load without a rate, stop,
  `ended`, fatal error and destroy; pause and seek keep it. One log line per vote:
  `StreamyboxPlayer: frame rate vote 23.976 (player|server|none, reason) on WxH surface`.
- One snap helper for both players is not practical (the expo-video patch and the local module are separate Gradle
  projects); a jest check keeps both rate tables identical.
- Player UI: with the overlay hidden the real player screen renders 0 UI frames in 10 s (emulator, gfxinfo), so it does
  not fight the vote on devices with content detection; on the box (ContentDetection=false) UI layers do not vote anyway.
- VLC renders into a TextureView (`expo-libvlc-player` `USE_TEXTURE_VIEW = true`): no own layer, so no layer vote is
  possible without moving it to a SurfaceView → follow-up.
- No display-change listener / re-vote loop yet: re-sending an unchanged rate is a no-op in SF; whether the 11-05 loss
  needs a client reaction is decided by the box dump.

## Log

- 12:30 Read box evidence (round-2026-11-07/frame-drops): SF ContentDetection=false, policy allows 4K24 (group 0),
  `mModeSwitchingType WITHIN_GROUPS`, no app mode request; box Android 14, Streamarr 0.21.3-box (fix/box-playback-20261106,
  not on main), player 1.7.2. HWC: no mode change on 11-07; 11-05 18:20 Streamybox session switched to 24 then back to 60.
- 12:40 Emulator `sbx_player_embed` (port 5580) booted; player 1.7.2 installed, decode setting SOFTWARE (adb root, as
  streamybox `test-render-service.sh --hwdec SOFTWARE`), `debug.streamarr.streamybox=1`; Dev World on 39381 (media cloned
  with `cp -c`); debug build with `GRADLE_USER_HOME=/Volumes/DevSSD/Caches/Gradle-fr-streamybox` and
  `STREAMARR_EMBEDDED_SERVER=0`; Metro 8086 (Metro did not pick up edits on this volume until restarted with `--clear`).
- 12:58 Before: dev player `__streamarrPlayer.run(variant,'streamybox')`, then `engine.load()` of host-served clips
  (`fr2398.mkv` 23.976, `fr2398-nodur.mkv` without DefaultDuration, `fr25.mkv`). Results above (defects 1, 2).
- 13:08 After: all cases on the layer as intended (sf-layers-emulator.txt, logcat-votes-emulator.txt).
- 13:20 Box build prepared: local throwaway branch `fr/box-build` = fix/box-playback-20261106 + merge of this branch
  (conflicts only additive: tracks branch keeps the box's aspect-aware `sizeBuffer`, props/defaults/JSX/apply keep both).
  Release APK `~/.cache/fr/streamarr-0.21.3-box-fr-21003.apk` (sha256 240fdf3e…), signer CN=Streamarr Android Release,
  versionCode 21003, versionName 0.21.3-box-fr; embedded server bundle extracted from the box's own APK (manifest 0.21.0+98da4cb0,
  sha256s match except the AGP-stripped tunnel lib, as on the box); `assembleRelease -x lintVital*` (lint vital ran out of
  Metaspace). A debug build of the same tree on the emulator: `23.976 (server, load)` → layer 23.98 ExactOrMultiple.
- Tests: JVM `FrameRateVoteTest` 8/8 (`./gradlew :streamybox-player:testDebugUnitTest`); typecheck 0, lint 0; jest full
  (Node 24.14.0) 234/234 suites, 2437/2437 tests.

## Evidence

- `docs/client/screenshots/FR/sf-layers-emulator.txt` — SF HWC layer table before/after per case.
- `docs/client/screenshots/FR/logcat-votes-emulator.txt` — the vote lines with load/tracks/first frame/ended/stop.
- `docs/client/screenshots/FR/emulator-streamybox-playing.png` — the Streamybox engine playing in the dev player.

## Box plan (needs the owner's OK)

Phase 1 (current 0.21.3-box, nothing installed): resume Spider-Man ~90 s, read `dumpsys SurfaceFlinger` (layer vote),
`dumpsys display`, DRI `summary`, logcat; Back → 60 Hz. Phase 2: build = fix/box-playback-20261106 + this branch
(throwaway, unpushed), versionName 0.21.3-box-fr, release key; rollback = `~/.cache/fr/box-rollback/streamarr-0.21.3-box-21003.apk`
(pulled read-only; signer CN=Streamarr Android Release). Checks: active mode 4K24 + DRI 24 Hz timing, layer vote
`23.98 Hz ExactOrMultiple`, mpv counters, one ExoPlayer title still matches, Back → 60 Hz.

## Requests to Streamybox

1. Render service: when mpv has no container rate, fill `tracks.video.frameRate` from `estimated-vf-fps` once it is
   stable (e.g. 2 s, ±0.1 %), else `container-fps`; send a new `tracks` event when it becomes known. Streamarr votes
   whatever arrives (its own fallback is the server's ffprobe rate).
2. HWC/display: on 11-05 18:20 a 4K24 match (`mode-id=223 … p24 success`) was replaced by 4K60 0.85 s later after the
   HDMI re-plug of that modeset (bridge park from 4K120 in progress) and SF never went back to 24 although the client's
   vote stayed. Please check whether the bridge/baseparameter or the HDR output path re-applies the stored 4K60 timing
   after a re-plug, and whether an HDR (PQ) layer can be frame-rate matched at all on this BSP.
3. (Known, other agent) no true 23.976 mode: Streamarr votes 23.976 exactly and will pick it up as soon as it exists.

## Follow-ups

- VLC engine: TextureView → no frame-rate vote; needs a SurfaceView mode in the patch or a window-level request.
- Merge note: `fix/box-playback-20261106` changes `sizeBuffer`/`chooseBufferSize` in the same file; this branch only
  touches the vote parts, so a merge is mechanical.
