# DV — Dolby Vision on the Streamybox (Radxa ROCK 4D, RK3576, Android 14)

Status: done (real box not tested — it is off limits; see "Box re-test")
Branch: `fix/dolby-vision-streamybox` (worktree `streamarr-worktrees/dolby-vision`), based on origin/main 312ba70c.
Detection: the OS feature `dev.streamybox.dolby_vision=1` (the system's own DV player) is reported by media-caps and shown in
Settings › Device capabilities; the DeviceProfile and server planning stay on the safe path (see "Platform contract").

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

Follow-up (not in this branch): the playback handoff — identify the box (`streamyboxDolbyVision`), pass the URL/headers/track
selection to `dev.streamybox.player` and report its playback to the controller/watchdog. Only then should the profile advertise
`dolbyvision` for HEVC, and only then does a DV source produce DV-quality output.

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
