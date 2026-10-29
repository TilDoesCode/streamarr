# DV — Dolby Vision on the Streamybox (Radxa ROCK 4D, RK3576, Android 14)

Status: done (real box not tested — it is off limits; see "Box re-test")
Branch: `fix/dolby-vision-streamybox` (worktree `streamarr-worktrees/dolby-vision`), based on origin/main 312ba70c.
Detection: the OS feature `dev.streamybox.dolby_vision=1` (the system's own DV player) is reported by media-caps and shown in
Settings › Device capabilities; the DeviceProfile and server planning stay on the safe path (see "Platform contract").
Playback: DV direct plays run in the embedded Streamybox Player engine (see "Eingebetteter Streamybox Player").

## Symptom (user)

DV releases: no error card, the picture stays empty, then the app silently moves on to another release.

## What the box is

No `video/dolby-vision` decoder; `c2.rk.hevc.decoder` / `c2.rk.av1.decoder` list Main/Main10 but not the HDR10 SDK profiles
(streamybox docs/08). Display EDID: SDR + PQ only (tests/results/edid-lg-20261006.md), so no `HDR_TYPE_DOLBY_VISION`.
The app reports hevc/av1 with hdr10+hlg, no dolbyvision (media-caps `chooseDecoders`).

## Hypothesis "media3 needs HEVC Main10HDR10 for a DV base layer" — refuted

Media3 version shipped: 1.9.0 (`node_modules/expo-video/android/build.gradle:21`). Source read at tag 1.9.0:

- `MediaCodecVideoRenderer.java:820-831`: display without DV → `MediaCodecUtil.getAlternativeDecoderInfos`.
- `MediaCodecUtil.java:378-404` `getAlternativeCodecMimeType`: DvheSt (profile 8) and DvheDtr (4) → `video/hevc`, Dvav110 (10) → AV1,
  DvavSe (9) → AVC; **DvheStn (5) and DvheDtb (7) → none** (comment: not backward compatible / deprecated).
- `MediaCodecInfo.java:336-353` `isCodecProfileAndLevelSupported`: a DV format on an HEVC decoder is checked as
  **`HEVCProfileMain10`, level 0** — not Main10HDR10. c2.rk.hevc.decoder lists Main10 → `FORMAT_HANDLED`.
- Emulator proof (harness, HEVC decoder capabilities replaced by Main10 only like the RK decoder): `dvhe.08.03` track
  `supported=YES`, decoder c2.android.hevc.decoder, first frame rendered (screenshots/DV/dv81b8-*-rktrue.log).

## Root causes found per profile on this box

| Profile | Server plan (box profile) | What reaches the decoder | Verdict |
|---|---|---|---|
| 8.1 MP4 (direct) | direct, native, shows HDR10 | Media3 passes the **dvvC record as `csd-1`** (24 B `01 00 10 …`) and `KEY_PROFILE=256` (DvheSt) to `c2.rk.hevc.decoder` | **Broken on RK (source evidence):** MPP parses any codec-config buffer whose first bytes are not a start code as hvcC → `is_nalff=1`, `nal_length_size=1`; every Annex-B sample then splits to length 0 → no frame |
| 8.1 / 8.4 MKV (direct) | direct, native, HDR10 / HLG | csd-0 only, `KEY_PROFILE=256` (non-fatal), RPU NAL 62 in every sample | Should decode (MPP handles NAL 62 explicitly); unverified: MPP turns the RPU into "DLBY" dynamic HDR metadata on the frame → gralloc/HWC path differs from HDR10 |
| 7 (remux) | remux, native, HDR10 base | plain hvc1 (ffmpeg drops dvcC), RPU NAL 62 + EL NAL 63 copied | Direct would show **no video track** (`NO_UNSUPPORTED_TYPE`, Media3 has no fallback for DvheDtb); remux is right. Now NAL 62/63 are stripped |
| 5 | transcode, libx264 2160p, software tone mapping | — | Direct would be audio-only black (`NO_UNSUPPORTED_TYPE`, emulator screenshot). The transcode is **3x too slow**: 7.6 fps at 2160p on 12 M4-Pro cores with the server's zscale/tonemap chain (ffmpeg 6.1.1, Docker runtime image); colours of IPTPQc2 are wrong without RPU reshaping (planner warning) |

Evidence lines:
- Media3 `BoxParser.java:1592-1613` appends the dvcC/dvvC/dvwC body to `initializationData` (→ `csd-1`); `MatroskaExtractor.java:2504-2511`
  only sets codecs/MIME (no csd). `MediaCodecVideoRenderer.java:2445-2454` sets `KEY_PROFILE` to the DV constant for any decoder.
- Rockchip codec2 (`rockchip-toybrick/rk_platform_vendor_rockchip_codec2` master `component/video/C2RKMpiDec.cpp:2485-2486`): codec-config
  input → `mpp_packet_set_extra_data`. MPP develop `mpp/codec/dec/h265/h265d_api.c:105-110` → `h265d_extradata`;
  `h265d_flow.c:1527-1541`: `extradata[0] || extradata[1] || extradata[2] > 1` → "extradata is encoded as hvcC format", `is_nalff = 1`,
  `nal_length_size = 1 + (ptr[21] & 3)` (= 1 for a dvcC record); `h265d_flow.c:1387-1447` then reads 1-byte lengths.
  `h265d_flow.c:1156` (NAL_UNSPEC62 ignored for decoding), `:1225-1253` (RPU collected as DLBY dynamic meta), `:1214` ("Skipping NAL unit 63").
- `C2RKMpiDec.cpp:512-517` ProfileLevelSetter ignores the value; AOSP `CCodecConfig.cpp:738-746` maps an unknown SDK profile to
  PROFILE_UNUSED, `:2061-2064` config failure "is non-fatal" (android-14.0.0_r27) → KEY_PROFILE=256 is harmless but removed anyway.
- Remux: ffmpeg 9.0.1 with the BuildRemux flags writes `hvc1` without dvcC/dvvC (box search of init), CODECS `hvc1.2.4.L…` (no dvh1, no
  SUPPLEMENTAL-CODECS) → the HLS path never had the csd problem.
- Server plans per profile and the P5 benchmark: screenshots/DV/server-plans.txt. Version list (PlaybackPredictor) agrees with the decider
  for every profile ("WEB-DL.DV" without HDR10 tag → transcode + `dolby_vision_profile_unknown`).

## Recovery path (why "empty picture, then another release, no card")

- Media3 never errors in these cases. No video track (P5/P7 direct) → audio clock runs, Exo frame counter stays 0 → watchdog
  `picture-black` (health/watchdog.ts:193-199). Decoder that eats input but outputs nothing (RK + dvvC csd) → player never READY →
  `pictureTimeout` after START_BUDGET_MS (20 s progressive, 30 s HLS) → T7 `picture_timeout` (controller.ts:1662-1667).
- T7 ladder (recovery/ladder.ts:244-277): R (reload same method) → S step-down (server `stepDown: true`, next method of the ranking;
  for 8.1: direct → remux → transcode) up to 3 → V another release (controller.ts:984-1003). Hint "Kein Bild. Eine andere Wiedergabeart
  wird versucht …", notices "Zum Direkt-Stream gewechselt …" / "Zu einer anderen Version gewechselt, damit es weitergeht." — the V notice
  carries no reason, and nothing of it reaches the server: `PlaybackSwitchRequest` has only `StepDown: bool`, the stop before the V start
  has no body → stream history cannot say why. A track-selection failure is not classified on its own (only via the picture watchdog).
- So for 8.1 the ladder already retries the same release via the server remux (the DV-signalling-free path) before another release;
  on the box that remux still carried the RPU, and a P5 transcode is too slow → V.

## Changes

1. Client (expo-video patch): `DolbyVisionBaseLayer.kt` + `VideoPlayer.kt` `getCodecAdapterFactory()` override. A DV format configured on a
   non-DV decoder (Media3's HEVC/AVC/AV1 fallback) gets no `KEY_PROFILE` and no trailing dvcC/dvvC `csd-N` (API 29+). Logcat tag
   `StreamarrDV`: `dvhe.08.06 on c2.rk.hevc.decoder: base layer as video/hevc, config record removed|absent`.
2. Server: `FfmpegArgumentBuilder.BuildRemux` adds `-bsf:v filter_units=remove_types=62|63` for HEVC Dolby Vision sources: the copy is plain
   HEVC HDR10/HLG like the release that is known to play on the box (dovi_tool: RPU 31103 B before, none after; bsf exists in 6.1.1 and 9.0.1).
3. Tests: FfmpegArgumentBuilderTests (DV 8.1/7 stripped, HDR10 not), PredictionConsistencyTests Rock4D DV 8.1/8.4/7/5 (decider = version list),
   RemuxIntegrationTests asserts the DV init has hvc1 and no dvcC/dvvC/dvh1.
4. Client (detection only): `AndroidCaps.report` sends `streamyboxDolbyVision` from the OS feature and the capabilities screen shows
   it as "Dolby Vision player: Streamybox Player". The DeviceProfile is deliberately unchanged (details under "Platform contract").

Not changed (recommendations): P5 — cap software tone mapping at 1080p (zscale scale first: 34 fps vs 7.6) or use libplacebo with
RPU reshaping / VAAPI; send the failure code with `stepDown`/the V start so stream history and the info panel show it; name the reason in
the V notice. Platform: register `C2StreamHdrStaticInfo` in libcodec2_rk_component (streamybox docs/08) — fixes the HDR10 profile list,
not DV.

## Verification

- Server.Tests 1654/1667 (13 known ffmpeg 9.0.1 transcoding/remux integration failures; the DV integration test fails at its pre-existing
  HLG assertion / SimulateAsync locally, the new init assertions pass when the HLG part is skipped). ViewerVersionsLatencyTests flaked once
  under load (passes alone).
- Client: typecheck 0, lint 0, jest 2217/2219 (2 known tab-guard). `./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a` OK,
  `DolbyVisionBaseLayer` in classes2.dex (needs a fresh GRADLE_USER_HOME here: `~/.gradle` fails on the RN gradle-plugin `libs` catalog).
- Emulator `streamarr_dv_tv` (own AVD, Android TV 34, emulator-5590): harness app = Media3 1.9.0 + the same DolbyVisionBaseLayer.kt
  (`streamarr-worktrees/dv-harness`). The emulator decodes only 8-bit HEVC (c2.android.hevc: Main, MainStill), so the DV clips use an
  8-bit base layer with real dovi_tool RPUs. Logs + screenshots: docs/client/screenshots/DV/.
  - dv81 MP4 without fix: `profile=256 csd-0[2413B 00000001…],csd-1[24B 0100101d1000]`; with fix: `profile=- csd-0` only, first frame.
  - dv81 MKV: csd-0 only (fix removes profile), first frame. Remux (plain / RPU-stripped): `video/hevc`, first frame.
  - dv5 / dv7 direct: `NO_UNSUPPORTED_TYPE`, video track not selected, audio only (black).
- Not reproducible off the box: the MPP hvcC misparse itself, and whether HWC/gralloc handle the DLBY metadata MPP attaches for RPUs.

## Platform contract: `dev.streamybox.dolby_vision` (player-capable, not a DV display)

The box now ships its own software Dolby Vision player (`dev.streamybox.player`: HEVC profiles 5/8.1/8.4, tone-mapped to HDR10
or SDR) and announces it as an Android system feature:

- `pm list features` → `feature:dev.streamybox.dolby_vision=1` (next to `feature:dev.streamybox.hdr10_rgb=1`).
- The contract is only `PackageManager.hasSystemFeature("dev.streamybox.dolby_vision", 1)`. There is still **no
  `video/dolby-vision` MediaCodec** and the sink still lists **HDR10/HLG only** (LG monitor): `Display.hdrCapabilities` has no
  `HDR_TYPE_DOLBY_VISION`, and DV never goes out as DV — the player outputs HDR10 or SDR.

What Streamarr reads from it (detection only):

- `AndroidCaps.report` adds the top-level `streamyboxDolbyVision` (`MediaCapsReport`), read from
  `hasSystemFeature("dev.streamybox.dolby_vision", 1)`.
- Settings › Device capabilities shows the row "Dolby Vision player" (`capabilities-dolby-vision-player`) with
  "Streamybox Player" when the feature is set, "Unavailable" otherwise.
- The flag describes the **device's** player, not Streamarr's engine: Streamarr's own ExoPlayer/Media3 still does not decode
  DV and never starts `dev.streamybox.player` (no handoff yet, see below).

**Deliberately not in the DeviceProfile.** `chooseDecoders` ignores the flag: the profile keeps HEVC `hdrFormats`
`["hdr10","hlg"]` (no `dolbyvision`) exactly as before. Adding it would make the server see HEVC DV as supported: `HdrBlocker`
skips the DV branch for `Direct`, so P5 (no base layer) and P7 would be planned as direct play and `dolby_vision_base_layer`
would disappear. Streamarr's player has no fallback for those Media3 types (`NO_UNSUPPORTED_TYPE`, see the profile table), so the
result would be audio-only black — the very failure this journal is about. Until the external player is actually used, planning
stays on the safe path that works today: P8.x direct with the HDR10/HLG base layer, P7 remux (RPU/EL stripped), P5 transcode.

The follow-up is done as an embedded engine, not a handoff: see "Eingebetteter Streamybox Player". The normal profile still
never advertises `dolbyvision`; only the starts of that engine do.

## Eingebetteter Streamybox Player

Owner decision (2026-10-28): no jump into the player's own activity. The Streamybox Player is a fourth engine, `streamybox`,
inside Streamarr's player: Streamarr owns the `SurfaceView` and its overlay (controls, panels, progress, resume, versions), the
player process renders mpv into that surface over Binder (contract: `streamybox-work/dv-player/embedded-contract.md`, AIDL
`dev.streamybox.player.render`). libmpv is not bundled; the engine exists only where the player is installed.

Architecture (branch `feat/streamybox-embedded-player`):

- **Availability** (`engines/index.ts`, `modules/streamybox-player`): Android, the render service resolves and answers
  `apiVersion() >= 1` → `streamyboxAvailable()`. Without it everything behaves exactly as before.
- **Setting** (Settings › Device capabilities › Playback engines): "Dolby Vision: Streamybox Player" with *Automatic* / *Off*
  (`capabilities-dolby-vision`, override `dolbyVisionPlayer: 'off'`; automatic is no override). It shows only when the report has
  `streamyboxDolbyVision` **and** the render service is installed; there it defaults to *Automatic*.
- **Profile** (`player/streamybox.ts`): `withDolbyVision(profile)` returns a clone in which the built-in (`native`) engine's
  10-bit HEVC adds `dolbyvision`; AV1, 8-bit HEVC, VLC and the original profile stay unchanged. The clone is only the `device`
  of start requests while the engine is on; `versions` hints, the "other version" ranking and the normal profile never see it.
- **Routing** (`controller.ts` `engineFor`): an answer `ready` + `direct` + engine not `vlc` + `mediaInfo.video.hdr ===
  'dolbyvision'` (`isDolbyVisionDirect`) loads in `streamybox`; everything else (other HDR, SDR, remux, transcode, a VLC pick)
  loads in the built-in engine. Load, health monitor, progress, panels and the recovery ladder are the normal ones.
- **Why one start is enough.** `mediaInfo.video.hdr` is the *source's* format, so the DV profile changes the server's plan only
  where the source is DV and the mode is `Direct` (`TranscodePlanner.HdrBlocker`: `Direct && SupportsHdrFormat(DV)` → no
  blocker). Non-DV sources are planned identically; a DV remux or transcode is planned identically too (the remux branch never
  reads DV support, P5 has no base layer → transcode, P7/P8 remux the RPU/EL-stripped base layer). VLC's caps are unchanged, so
  VLC never gets P5/P7 direct. Hence: with the DV profile, a P5/P7 file can only come back as a native direct play, and exactly
  that answer goes to `streamybox` — the built-in ExoPlayer can never receive a P5/P7 direct play. No second server start is
  needed for non-DV media.
- **Fallback** (`leaveDolbyVision`): a failure of the `streamybox` engine (bind/`load` throws, a fatal `error` event, no first
  frame in the start budget = `picture_timeout`, watchdog black/frozen, stall ladder) turns the mode off for the rest of this
  viewing and runs ladder step **N** (new start): the old playback is stopped, a new one starts at the same position and
  release with the **normal** profile, and loads in the built-in engine (notice "The Streamybox Player couldn't play this, so it
  continues in the built-in player."). Session/stream losses (T2), sign-out (T3), the waits (T4/T9/T10) and anything while
  offline keep the normal ladder and stay on DV.
- **Overlay**: the Info panel adds a row "HDR" — "Dolby Vision · Streamybox Player · HDR10" (SDR when the player reports
  `output: sdr`); profile 7 reads "HDR10 base layer (Dolby Vision P7) · Streamybox Player" (DE "HDR10-Basis (Dolby Vision P7)"),
  never "Dolby Vision". The Player panel's hint adds "Dolby Vision plays in the Streamybox Player." while that engine plays.

Limits:

- Profile 7 is the HDR10 base layer only (mpv ignores the enhancement layer, NAL 63). It still goes direct to the Streamybox
  Player with the DV profile (the EL is simply not decoded); the UI says so.
- The output is HDR10 (or SDR), never DV on HDMI: the box has no DV sink path.
- Frame-rate matching belongs to the engine/native view (contract § Display: `Surface.setFrameRate` from `tracks.video.frameRate`).
- A crash of the player process ends in the engine's `error` → the same fallback; an Android kill of Streamarr leaves the
  service to release mpv via `linkToDeath`.
- One render client at a time: another app attaching replaces Streamarr's session (`error: replaced`) → fallback here.
- Box run 2026-10-29 04:17 (Streamarr 0.19.1 build a0cf2036, player 1.5.5, sound off): Cyberpunk Edgerunners S02E02
  "1080p · Dolby Vision / HDR10 · WEB-DL" (WAREZCX, DD+ 5.1) plays inside Streamarr with the Streamarr overlay. Info panel:
  direct play, "HDR: Dolby Vision · Streamybox Player · HDR10", player "Streamybox · hevc (mediacodec) hwdec=mediacodec";
  DRI `HDR[2]`/BT.2020, SurfaceView dataspace BT2020 SMPTE 2084, PCM audio (no spdif muxer in the player's FFmpeg).
  `am force-stop dev.streamybox.player` → ExoPlayer takes over at the same position (HDR10 base layer), no crash; Back →
  DRI `SDR[0]`/BT.709, no render-service binding, crash buffer empty. Evidence: `$SB_WORK/dv-player/streamarr-embed/box-run-20261029-040858/`.
- The ranking still recommends the H.264 SDR release of that episode ("Empfohlen"), so DV only plays when the user picks the
  DV version; ranking DV up when the Streamybox engine is available is a follow-up. P5 was verified through the player's render
  service only (`jellyfin_1080p_dv_p5.mp4`: `dolbyVisionProfile 5`, `mediacodec-copy`, HDR10), not yet through a Streamarr title.
- 124 dropped frames were counted across the version switch and pause; not re-measured in steady playback.

### Ton (Surround mit Dolby Vision)

Owner requirement (2026-10-29): surround must work for Dolby Vision files in the Streamybox Player. The box's TV (EDID "LG TV
SSCR2") takes LPCM only as 2.0 but AC-3 6 ch, E-AC-3 8 ch and TrueHD 8 ch, no DTS: surround is bitstream only. Player 1.5.6
(agent A) bitstreams AC-3, E-AC-3 (IEC 192 kHz) and TrueHD (8-ch HBR) when the output reports them, decodes everything else
(DTS-HD, FLAC, Opus …) and downmixes to the output; `muted` makes it use PCM (a bitstream ignores the volume).

- **Routing** (branch `feat/streamybox-passthrough`): until now the DV profile carried ExoPlayer's audio. A DV file with TrueHD,
  DTS or 7.1 FLAC therefore failed the direct-play check (codec not decodable, channels over `maxAudioChannels` 2) and came back
  as a remux (base layer, converted audio) in ExoPlayer — the Streamybox Player never got it. Declaring mpv's audio on the
  built-in engine would have been wrong for every other title (the DV profile is the `device` of *every* start while the engine
  is on), so the server got an additive field: `engines[].dolbyVisionAudio { audioCodecs, maxAudioChannels }`
  (`DeviceCaps.ParseEngine`, `EngineCaps.For`, `PlaybackDecider.Decide`). The decider uses it only for the direct-play check of a
  Dolby Vision source the engine lists in `hdrFormats`; remux and transcode (ExoPlayer plays those) and every other source keep
  `audioCodecs`/`maxAudioChannels`. `withDolbyVision` fills it (`streamyboxAudio`): aac, ac3, eac3, truehd, dts, flac, opus, mp3,
  vorbis, alac, mp2, pcm up to 8 ch, `maxAudioChannels` 8; AC-3/E-AC-3/TrueHD carry `passthrough` where Media3's verdict already
  passes them through (the flag only lifts the channel limit, which 8 ch never reaches). Servers before this field ignore it
  (System.Text.Json skips unknown members): with an old server a DV + TrueHD/DTS file still ends as a remux in ExoPlayer.
- **Info panel**: player 1.5.6 adds `output` (`passthrough:<codec>` | `pcm:<channels>`) to each audio track of the `tracks`
  event. The engine turns the selected track's value into `audioEncoding`/`audioChannels`, so the existing row "Audio output" /
  "Tonausgabe" reads "Bitstream TrueHD" / "PCM 2.0" as it does for ExoPlayer. Player 1.5.5 sends no field → no row.
- **Test mute**: `effectiveMuted` keeps `muted` on in test-muted builds, at load and after a reload, so the player uses PCM at
  volume 0 there.
- Read-only box check 2026-10-29: `settings get global encoded_surround_output` = `1` (Never; audio policy
  `FORCE_ENCODED_SURROUND_NEVER`). With that setting Android itself refuses encoded output: Media3 reports no passthrough and the
  player's bitstream may be refused too — Streamybox Settings › Ton › Tonformat must be *Automatisch* for surround.

Tests: server `PlaybackDeciderTests` (`DolbyVision_DirectPlaysWithTheDvPlayersAudio` for TrueHD 7.1, E-AC-3, DTS, FLAC 5.1; none
without the field; never for HDR10 sources or the remux; needs DV in `hdrFormats`; invalid channel count rejected); client
`streamybox.test.ts` (`dolbyVisionAudio` on the built-in engine only, ExoPlayer audio untouched, passthrough only AC-3/E-AC-3/TrueHD),
`controller-streamybox.test.ts` (sent with the DV profile, absent with the setting off and after the fallback),
`streamybox-engine.test.ts` (output → stats, track switch, 1.5.5 without row, test mute across a reload).

Tests: `player/__tests__/streamybox.test.ts` (profile clone, eligibility, setting/overrides),
`controller-streamybox.test.ts` (DV direct → streamybox with the DV profile; other HDR, remux, transcode, VLC → built-in; setting
off / no option / no service → exact old behaviour with the normal profile; engine error and failed `load` → new start with the
normal profile at the position and release; no second Streamybox engine after a fallback; a refused stream keeps DV),
`streamybox-labels.test.ts` (EN/DE labels, P7, notice), `settings/__tests__/capabilities.test.tsx` (row only with feature +
service, automatic by default, off stored as the only override, profile without `dolbyvision`).

### Box run 2026-10-29 11:10 (surround)

Player 1.5.6 with the HDMI audio guard on the box (`streamybox_hdmi_audio_sads=095707,150750,570701,670403`): AC-3 5.1,
E-AC-3 5.1 and TrueHD 5.1 clips through the render service go out as IEC 61937 (`passthrough:ac3` 48 kHz/2 ch,
`passthrough:eac3` 192 kHz/2 ch, `passthrough:truehd` 192 kHz/8 ch HBR), no PCM fallback; mute → `pcm:2`.
Not box-verified: the same through a Streamarr title (the CEC mute of the AVR did not hold when the AVR woke from
standby, so the run was stopped), and TrueHD direct play needs a server with `dolbyVisionAudio` (this branch).

## Box re-test

Kit: `streamarr-worktrees/dv-harness/box-kit/` (1080p 10-bit, 8 s): dv81.mkv, dv81.mp4, dv84.mkv, dv7.mkv, dv5.mkv, hdr10.mkv/.mp4
(controls), dv81-remux-rpu.mp4 (fMP4 like today's remux), dv81-remux-stripped.mp4 (like the new remux), dv-harness.apk.

1. `adb install -r dv-harness.apk`; copy a clip into the app:
   `adb push dv81.mp4 /sdcard/Download/ && adb shell "cat /sdcard/Download/dv81.mp4 | run-as dev.streamarr.dvharness sh -c 'cat > files/dv81.mp4'"`
2. Run each clip with fix off, then on:
   `adb logcat -c; adb shell am start -n dev.streamarr.dvharness/.MainActivity --es uri file:///data/data/dev.streamarr.dvharness/files/dv81.mp4 --ez fix false`
   then `adb logcat -d | grep -E "DvHarness|StreamarrDV|C2RKMpiDec|mpp|h265d|hvcC|nal: unit"`.
   Decisive lines: `configure codec=c2.rk.hevc.decoder … csd-1[24B 0100…]` + MPP `extradata is encoded as hvcC format` and no
   `RESULT first frame rendered` (fix off) vs. `config record removed` + `RESULT first frame rendered` (fix on). Expect dv81.mkv and
   both remux files to show a first frame even with fix off; if dv81.mkv / dv81-remux-rpu.mp4 stay black but dv81-remux-stripped.mp4
   plays, the RPU/DLBY metadata path is the second cause (then the server strip covers remux, and direct MKV needs a client-side strip).
3. HDR check while dv81.mkv plays: `adb shell dumpsys SurfaceFlinger | grep -i -E "hdr|dataspace"` and the VOP state
   (streamybox docs/04: HDR[2] + BT.2020, NV15) — same as hdr10.mkv.
4. Streamarr app (this branch): play a real "WEB-DL DV HDR10" MKV and an MP4 one, then a BluRay DV (P7) remux and a "WEB-DL DV" (P5).
   `adb logcat | grep -E "StreamarrDV|ExoPlayerImpl|MediaCodecVideoRenderer|C2RKMpiDec"`; Info panel: method + "Dolby Vision wird als HDR10
   gezeigt". P5: expect the server transcode; watch server CPU/speed (stream history) — at 2160p software it will likely stall.
   The plan must be unchanged by the new feature flag (item 6).
5. If a failover still happens: note the hints/notices shown ("Kein Bild …", "Zum Direkt-Stream gewechselt …") and the server log for
   `stepDown` switches of that playback.
6. Streamybox DV player contract (detection only): `adb shell pm list features | grep dev.streamybox.dolby` must show
   `feature:dev.streamybox.dolby_vision=1` and `feature:dev.streamybox.hdr10_rgb=1`. Settings › Device capabilities must show
   "Dolby Vision player: Streamybox Player" (screen reader/label: `Dolby-Vision-Player` in German). The measured report carries
   `streamyboxDolbyVision: true`, but the DeviceProfile must still have **no `dolbyvision`**: HEVC `hdrFormats` stays
   `["hdr10","hlg"]`, AV1 unchanged. Watch the Info panel/plan on an 8.1 MKV, an 8.4 MKV and a P7 remux: direct/remux as before, with
   `dolby_vision_base_layer` where it appeared before — no black screen. If a P5/P7 playback suddenly goes direct, stop: that is the
   planning regression this section guards against.
7. **Embedded Streamybox Player** (build of `feat/streamybox-embedded-player`): `adb shell dumpsys package dev.streamybox.player |
   grep -i RenderService` lists the exported service; Settings › Device capabilities shows "Dolby Vision: Streamybox Player" with
   *Automatic* selected. Uninstalled player / feature removed → the row is gone.
8. DV P8.1 4K24 (`p81_4k24.mp4`) and 1080p (`p81v2_1080p24.mkv`): plays **inside Streamarr** (no foreign activity in
   `dumpsys window | grep mCurrentFocus`), Info panel "Direct play" + "HDR: Dolby Vision · Streamybox Player · HDR10", Player row
   "Streamybox · …hwdec=mediacodec"; DRI `HDR[2]`/BT.2020, 23.976 Hz, correct colours; overlay, seek, pause, audio/subtitle
   switch, resume after Back and progress in "Continue watching" work.
9. DV P5 (`jellyfin_1080p_dv_p5.mp4`): same, copy-back (`mediacodec-copy`), no green/purple picture. P7 remux source: direct,
   Info panel "HDR10 base layer (Dolby Vision P7) · Streamybox Player".
10. Non-DV H.264 and HDR10 HEVC: built-in engine (Player row "expo-video"), the plan unchanged against item 4.
11. Setting *Off*: P8.1 direct in the built-in engine as before, P7 remux, P5 transcode — never a P5/P7 direct play.
12. Fallback: `adb shell am force-stop dev.streamybox.player` while a P5 plays → notice "The Streamybox Player couldn't play
    this …", a new start at the same position: P5 transcode in the built-in engine. `logcat -b crash` empty.
13. **Surround (player 1.5.6 + this branch + the new server):** Streamybox Settings › Ton › Tonformat *Automatisch*
    (`settings get global encoded_surround_output` → `0`); the box server must run `feat/streamybox-passthrough` (else DV +
    TrueHD/DTS stays a remux). Play DV P8.1 with TrueHD Atmos 7.1, with E-AC-3 JOC 5.1, with AC-3 5.1 and with DTS-HD MA 5.1:
    Info panel "Direct play", "HDR: Dolby Vision · Streamybox Player", "Audio output: Bitstream TrueHD" / "Bitstream Dolby
    Digital+" / "Bitstream Dolby Digital" / "PCM 2.0" (DTS: the TV takes no DTS, mpv decodes and downmixes); the TV's info shows
    Dolby TrueHD/Atmos, Dolby Digital Plus, Dolby Digital. Audio switch to a second track updates the row.
14. Volume and mute: Streamarr's mute (and a test-muted build) → "PCM 2.0" in the row and silence; unmute → the bitstream again.
    With Tonformat *Nie*: every track "PCM 2.0", no failed start, no stall at the first frame (the 1.5.5 spdif stall).
15. Non-DV TrueHD/DTS titles: plan and engine unchanged (ExoPlayer remux or VLC as before) — `dolbyVisionAudio` must not reach them.
