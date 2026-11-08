# REL-0.22 — release 0.22.0 integration (2026-11-08)

Release 0.22.0 = `main` ace4c05a (offline downloads) + `fix/box-playback-20261106` (13 commits, the owner's box build
0.21.3-box since 06.11) + `fix/streamybox-frame-rate` (7 commits, the frame-drop fix). Branch `release/0.22.0` in the
`release-0.22.0` worktree; merge and follow-up commits only, nothing pushed.

## Commits

| Commit | What |
|---|---|
| 576724fa | Merge `fix/box-playback-20261106` (conflict resolutions only) |
| 959c791e | fix(server): a download's transfer and a playback's progress hold never cross |
| 35bd7293 | fix(client-player): a download never takes the stream-link renewal path; a renewal keeps the start gate |
| b223f838 | Merge `fix/streamybox-frame-rate` (conflict resolutions only) |
| this one | docs: this journal, device evidence |

## Conflict resolutions (box merge)

- **`SessionManager.ActiveSession`**: main pins a session past its TTL while a device download reads it
  (`_transferPins`); the box holds a playback's capability open past its TTL while the viewer reports progress
  (`EffectiveExpiry`). One rule now: `ExpiredLocked(now)` = closed, or past the (held) TTL with no pin. `TryOpenStream`,
  `IsExpired`, `TryPin` and `HoldUntil` all use it. Both field blocks kept (live-stream counters, `MaxReuseHeadroom`).
- **`IPlaybackMedia`**: `StreamFile` (downloads) and `HoldStream` (box) both kept; no overlapping port.
- **`controller.ts`**: main's `paused` accessor (C4-03: a pause resets the start proof) plus the box's `offer` field; the
  lost-playback probe keeps main's local guard and adds the box's `streamRenewal` busy check.
- **Hint catalogue** (jest + docs): both sides added `N32`. Main's `N32` (`notice.downloadMissing`) keeps its id, the box's
  stutter offer and its "always" follow-up become `N33` and `N34`.

## Semantic interplay found and fixed

- **Reuse headroom vs. downloads (server, 959c791e).** The box reuses a capability only while `min(TTL/2, 6 h)` of it is
  left. That lookup is also how `DownloadFileSource` finds (`Find`) and closes (`Release`) its own transfer session, and a
  transfer is pinned past its TTL: a long download would have opened a second session for the same file and could not
  release the first. The headroom now applies to playbacks only. `HoldUntil` refuses transfer sessions, `TryPin` refuses
  anything else, so a playback's progress never holds a download's session and a pin never holds a playback's. "A
  download never displaces a playback session" is unchanged.
- **Renewal vs. downloads (client, 35bd7293).** A downloaded file plays as a server-shaped direct playback (`method:
  direct`, `file://` url, `local-…` id), so the box's `renewStream` let it through: a refused status or an early end
  would have started a server playback for a file. `renewStream` now refuses local playbacks. On the server a download's
  progress (its local id) reaches no live playback, so `HoldStream` is never called for it (pinned by a test). The
  buffer poll, lost-playback probe and repair poll were already local-guarded on main; Streamybox is never chosen for a
  local file (`engineFor`).
- **Renewal vs. the start gate.** A renewal reload goes through `attach()`, which re-arms the start floor (null floor
  for "From the beginning") and resets the playback proof (C4-03); the renewed start asks for `resumePosition`, which is
  the chosen point while a start is pending. Pinned by tests on Streamybox and ExoPlayer.
- **Observed-only readings (C5-02).** Every new Streamybox event was checked: subtitle cues and drop counters emit no
  `time` event, `reload()` emits none, mpv's `time` events read the player clock, the seek echo carries `observed: false`
  (main). `rewriteSource` emits nothing.

## Conflict resolutions (frame-rate merge)

Six files (more than `merge-tree` against main showed, because the box branch is in now), resolved as `fr/box-build`
618c2819 did on the old base: `StreamyboxPlayerView.kt` (FR's tracks / first frame / ended / fatal-error dispatch with
the box's three-argument `sizeBuffer`) and `streamybox-engine.test.ts` are byte-identical to `fr/box-build`;
`streamybox-engine.tsx` and `types.ts` differ from it only by main's C5-02 (`observed`, `startSettled`); the load passes
both `subtitle` (box) and `frameRate` (FR); `JOURNAL.md` keeps both lines.

## Tests (Node 24.14.0, .NET 10.0.401 SDK)

- Client: typecheck 0, lint 0, jest **307/307 suites, 3216/3216 tests** (at b223f838).
- Server: Release build 0 errors; `dotnet test` Release: Usenet 256/256, Core 535/535, DevWorld 94/94, Server
  **2012/2025** — the 13 failures are the known local ffmpeg transcode/remux integration tests (RemuxIntegrationTests ×7,
  TranscodingIntegrationTests ×6). Total 2897/2910.
- Web: no web file changed; typecheck 0 (tests not needed).
- API: `freeze-openapi.sh` + `web generate:api` + `client gen:api`: no drift (the box's `docs/api.md` change is prose).
- New interplay tests: `SessionManagerTests.TransferPinAndPlaybackHold_CoexistAndNeverCross`,
  `FindReusableSession_ReuseHeadroomIsForPlaybacks_ADownloadFindsItsPinnedSessionPastItsTtl` (both fail without the fix),
  `ViewerPlaybackTests.WatchProgress_OfADownloadedFile_HoldsNoStreamCapability`; client `controller-stream-renewal`
  "a renewal during an unlanded resume start keeps the start gate" (Streamybox + expo-video), `local-mode` "a download
  never takes the stream-renewal path" (native + VLC; fails without the guard).
- Embedded server: the box's `SERVER_CONTROL` `knownSigner` manifest + `server_control.xml` merge and verify
  (`:embedded-server:processDebugManifest :embedded-server:verifyReleaseResources`, module included temporarily; the dev
  client itself is `STREAMARR_EMBEDDED_SERVER=0` as always, the server bundle is built separately).

## Device smoke (screenshots and logs: `docs/client/screenshots/REL-0.22/`)

Debug dev client from b223f838 (`expo prebuild -p android`, `:app:assembleDebug -PreactNativeArchitectures=arm64-v8a`,
`STREAMARR_EMBEDDED_SERVER=0`, 4 min 47 s, APK sha256 098bf297…), Metro 8082 (explicit URL), Dev World 39300 (published
main 1dfae10c). Emulators identified by AVD name.

- **`sbx_player_embed` (emulator-5580, Streamybox Player 1.7.2, SOFTWARE decode, `debug.streamarr.streamybox=1`).** The
  HDR10 title `mkv-hevc-hdr10-dts-1080p` through the Streamybox engine (dev player, as the FR check; Dev World has no DV
  release): the server transcodes it here (no 10-bit HEVC on the emulator), plays. The load carries the box's
  `surfaceFitsVideo` + `subtitleEvents` and FR's `frameRateHint 24`; surface `videoAspect 1.778`. Vote:
  `24.0 (server, load)` → `24.0 (player, first frame)`; `dumpsys SurfaceFlinger`: the SurfaceView (BLAST) layer at
  **24.00 Hz ExactOrMultiple**. English subtitle on: the cue shows (`[EN] Subtitle 14 …`), drawn by mpv — player 1.7.2 in
  SOFTWARE mode sends no cue events, so Streamarr's own cue overlay is not exercised on this image (unit-tested only).
  **Back**: `frame rate vote cleared (none, stop)`, render session released, no SurfaceView layer and no vote left.
- **`Streamarr_Phone` (emulator-5554).** Signed in, downloaded Big Buck Bunny (1080p WEB-DL, direct, 9 MB), airplane mode
  on and the server reverse removed: offline shell with the download; played it from the file; closed at 0:55
  ("2 min left"); reopened offline: "Resume from 0:55" → playing at **0:56** 2.5 s later (burned-in timecode 00:00:57).
  No recovery step and no server call logged during offline playback.

## Observations

- Argent 0.32: taps on the rotated (landscape) player still miss; adb taps in display coordinates were used there.
- Two iOS simulators of other sessions (iPhone SE DE test, iPhone Air) attached to Metro 8082 while it ran.
- Phone: after airplane mode the offline shell showed, then the normal shell came back while still offline (playback
  unaffected). No connectivity / offline-shell / downloads file differs from main, so this is pre-existing.

## Release v0.22.0 (2026-11-08)

- Dry run (Release workflow_dispatch on `release/0.22.0` 7814bd71, run 42520458116): all jobs green incl. the signed
  Android TV APK. Then `main` pushed (`ace4c05a..7814bd71`) and tag `v0.22.0` (annotated) on 7814bd71.
- Tag run 42523554223 green: image `ghcr.io/tildoescode/streamarr:0.22.0` (amd64 + arm64), plugin + home bundle,
  signed APK (versionCode 22000, arm64-v8a, 135,466,856 bytes, SHA-256 `ef930e92…`, signer `8faf77c4…` = 0.21.0's key),
  GitHub release, Jellyfin catalog (6ed45f61), Android update manifest (runtime `c0de456f…`). CI on main 42523551693 green.
- The workflow skipped OTA and IPA (no `EXPO_TOKEN` secret); both published from this Mac with eas-cli 27.2.0 (same as CI)
  from a clean checkout of the tag: OTA `production` iOS group 60f71cb2 (runtime `96ce4b33…`), Android group 90eafb13
  (runtime `c0de456f…`); EAS sideload build cf489bdd → `streamarr-ios-0.22.0.ipa` 0.22.0 (6), iOS 16.4+, attached to the
  release and listed in the AltStore source (`altstore` branch).
- Release notes EN/DE + APK/IPA details + change list on the GitHub release.
- Follow-ups: add the `EXPO_TOKEN` secret so CI publishes OTA + IPA; the phone offline-shell flip under airplane mode
  (Observations) needs a look; box tests (frame-rate vote, Streamybox `feat/fractional-refresh`) wait for the owner.
