# Server-side transcoding

Streamarr can convert a stream that a player cannot decode — MKV, AC-3/E-AC-3/TrueHD
audio, HEVC or AV1, 10-bit, HDR10/HLG, interlaced MPEG-2 — into browser-safe
**H.264 + AAC HLS** (fragmented MP4) on the server. It is the first building block for
standalone clients that do not rely on Jellyfin's transcoder.

When the player can decode the video but not the container, the audio, or the subtitle format,
the server **remuxes** instead: the video is stream-copied into fMP4 HLS on keyframe-accurate
segments and only the audio (and text subtitles) are converted — see [Remux](#remux-direct-stream).

The feature is a **separate path**:

- It lives in its own module (`server/src/Streamarr.Server/Transcoding/`) and its own
  endpoints (`/api/v1/transcoding/*`, `/api/v1/transcode/{capability}/*`).
- It reads a resolved stream exactly like any other player: over loopback HTTP from
  `/api/v1/stream/{token}`. Direct play, the Jellyfin plugin, resolve, sessions, and the
  byte-range stream endpoint are unchanged; stopping a transcode never closes the stream
  session it reads from.
- Its settings are stored in their own table and never affect Jellyfin.

```text
 Usenet ──► /api/v1/stream/{token} ──► (direct play: browser, Jellyfin, mpv …)
                     │
                     └─ loopback HTTP ─► ffmpeg ─► fMP4 segments ─► /api/v1/transcode/{capability}/master.m3u8
                                         ▲                              (hls.js, Safari, TVs)
                          plan + hardware self-tests
```

## Quick start

1. Open **Transcoding** in the management UI. The **Overview** tab detects ffmpeg,
   lists its encoders and filters, and runs a real one-second encode, per-codec decode,
   and tone-mapping test for every hardware backend on this machine. It tells you in one
   line whether transcoding works, whether it is hardware accelerated, and — when a
   working GPU backend is not enabled — offers a one-click switch.
2. In **Test lab**, run a **benchmark**. Missing test media is generated with ffmpeg on
   first use (nothing is shipped in the image), then transcoded flat-out with the live
   pipeline. The result grades speed (× realtime and an estimate of concurrent streams),
   CPU use, time to first segment, seek-restart latency, keyframe alignment per segment,
   and whether ffmpeg silently fell back from the GPU to software.
3. Use the **test player** in the same tab to watch a sample through the real HLS path
   (hls.js, or native HLS on Safari) with live time-to-first-frame, buffer, dropped-frame,
   and seek-latency readouts.
4. In **Playback Preview**, resolve a release and switch the mode from *Direct play* to
   *Server remux (HLS)* or *Server transcode (HLS)*. If direct play fails, the player offers the switch itself.

### Test samples

| Sample | What it proves |
|---|---|
| 1080p H.264 · AC-3 5.1 (MKV) | The common WEB-DL shape; audio and container need the server. |
| 720p H.264 · AAC (MP4) | A browser-compatible baseline for comparing direct play. |
| 1080p HEVC Main10 · E-AC-3 5.1 | 10-bit HEVC hardware decode and 10 → 8-bit conversion. |
| 4K HEVC HDR10 · E-AC-3 5.1 | The worst case: 4K 10-bit decode, downscale, HDR → SDR tone mapping. |
| 576i MPEG-2 · AC-3 | Deinterlacing and SD scaling. |
| 1080p AV1 10-bit · Opus 5.1 | AV1 decode (hardware only on recent GPUs). |

Samples are cached in `Streamarr:Transcoding:SamplesPath`; generating the 4K HDR sample
takes one to two minutes on a small machine.

## Hardware acceleration

| Backend | Platforms | What to do |
|---|---|---|
| **VideoToolbox** | macOS (native install, not Docker) | Works with Homebrew ffmpeg. Select *Apple VideoToolbox*. HDR is tone-mapped on the GPU. |
| **VA-API** | Linux, Intel (Broadwell+) and AMD | Pass the render node into the container and add the host's `render` group (see below). The image ships `intel-media-va-driver-non-free` (amd64) and `mesa-va-drivers`. |
| **NVENC / NVDEC** | Linux, NVIDIA | Install the NVIDIA Container Toolkit and request the GPU. |
| **Quick Sync (QSV)** | Linux, Intel | The Ubuntu ffmpeg in the image has no QSV encoders — use VA-API (same hardware), or point `FfmpegPath` at a build with libvpl such as jellyfin-ffmpeg. |
| Software | everywhere | libx264. Run a benchmark: it reports × realtime and how many similar streams the CPU sustains. |

Docker Compose, Intel/AMD:

```yaml
services:
  streamarr:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "${RENDER_GID:-105}"   # getent group render | cut -d: -f3 on the host
```

Docker Compose, NVIDIA:

```yaml
services:
  streamarr:
    gpus: all
    environment:
      NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
```

After changing devices, restart the container and press **Re-run hardware detection**.
Every failed check shows ffmpeg's own error line, and each backend lists concrete setup
hints (missing device node, missing driver, missing encoder in this ffmpeg build).

Hardware decode is used only for codecs that passed the self-test (or the list you pin
manually in Settings). Anything the device cannot do falls back to software for that
stage, and the plan explains why.

### Multiple GPUs

Hosts with more than one GPU (an Intel iGPU plus an NVIDIA card, two NVIDIA cards, Intel
plus AMD) are common, and the wrong device usually fails silently. Streamarr therefore
lists every GPU it can see under **Overview → Graphics devices** — DRM render nodes with
vendor, driver and PCI slot from sysfs, NVIDIA GPUs from `nvidia-smi` — and runs a quick
H.264 encode on each one in addition to the full self-test on the selected device.

- **VA-API / QSV** use the render node chosen in *Settings → VA-API device*. The dropdown
  shows every node with its test result; nodes owned by the NVIDIA driver are marked,
  because they have no VA-API. The render-node order is not stable across hardware: a
  dedicated card is often `renderD128` and the iGPU `renderD129`.
- **NVENC / NVDEC** use the GPU chosen in *Settings → NVIDIA GPU*, numbered like
  `nvidia-smi` (PCI bus order). ffmpeg is pinned to it with `-init_hw_device cuda=cu:N` and
  `-gpu N`, and every ffmpeg child runs with `CUDA_DEVICE_ORDER=PCI_BUS_ID` so CUDA's
  numbering matches `nvidia-smi` instead of "fastest first".
- If the selected device fails but another one passes, the backend card names the working
  device and offers a one-click switch.
- **VideoToolbox** always uses the Mac's GPU; macOS does not let ffmpeg choose between GPUs.
- In Docker you can also expose only one GPU: `devices: ["/dev/dri/renderD129:/dev/dri/renderD129"]`
  or `NVIDIA_VISIBLE_DEVICES=1` (inside the container that GPU then becomes index 0).

## Time to first frame

The transcoder reads the same stream as direct play, after the same resolve (health
check, NZB, probe, startup read-ahead). What it adds is: probing the source, starting
ffmpeg, and encoding the **first whole segment** before anything can be served. The
Sessions tab shows this split per session (*Startup = probe + ffmpeg start + first segment
encoded + delivered*); the test player's time to first frame includes creating the session.

Measured with `TranscodingTtffTests` (cold release, simulated provider: 40 ms per command,
0.25 s per article per connection; 1080p source → 720p with libx264 on an Apple M2 and in
Docker with Ubuntu's ffmpeg 6.1). *Direct play* is ffmpeg acting as a player (probe, seek
via the MKV index, first decoded frame):

| After resolve (~4 s in this model, identical for both) | Direct play | Transcode, 3 s segments | 4 s segments |
|---|---|---|---|
| Start at 0 s | 0.3 s | 0.33 s | 0.37 s (0.56 s in Docker) |
| Resume/seek into a cold part at 120 s | 1.2 s | 1.75 s | 1.85 s |

On fast hardware the transcode path adds **0.05–0.3 s at the start and ~0.5 s on a seek
into data that is not downloaded yet**, almost all of it the first segment: ffmpeg has to
download and encode 3 s of media past the target before the first byte is servable. The
server's own overhead is small (probe ~50 ms, ffmpeg start ~20 ms, delivery ~10 ms).

Encoding the first segment dominates on heavy content or weak hardware. Local benchmark,
first 4 s segment ready (Apple M2):

| Source → output | CPU (libx264 veryfast) | VideoToolbox |
|---|---|---|
| 1080p H.264 → 720p | 0.41 s | 0.51 s |
| 1080p HEVC 10-bit → 1080p | 0.71 s | 0.68 s |
| 4K HDR10 → 1080p SDR | 1.85 s (no tone mapping available) | 0.72 s |
| 4K HDR10 → 4K | 3.68 s | 2.01 s |

Levers, in order of effect: hardware acceleration for 4K/HDR, a lower *Max height*, a
shorter *Segment length* (each second less saves roughly 1/speed seconds per start and
seek), and a faster preset. The **Test lab benchmark** reports *time to first segment* and
*seek to first segment* for your hardware. The first transcode right after a server start
no longer waits for detection: capability detection starts immediately at startup.

## How a transcode works

- **Plan.** ffprobe reads the source once. The planner decides output size (never
  upscaled, even dimensions), bitrate (capped by settings and the source), H.264 level
  and RFC 6381 `CODECS`, audio (copy AAC stereo, otherwise AAC stereo or 5.1), hardware
  decode/encode, tone mapping, and deinterlacing — and records *why* for each decision
  (`POST /api/v1/transcoding/plan` returns it without starting ffmpeg).
- **Playlist up front.** The media playlist is a complete VOD playlist computed from the
  runtime on a fixed segment grid (default 3 s, like Jellyfin), so a player can seek anywhere before
  anything was transcoded — the same approach as Jellyfin's dynamic HLS.
- **Keyframe grid.** Video is encoded with `-force_key_frames expr:gte(t,n_forced*L)` (plus a
  matching GOP for VideoToolbox, QSV, and NVENC), so every segment starts with a keyframe within
  one frame of `N × L`. On ffmpeg < 6 the expression uses absolute times after a seek.
- **fMP4 timing.** `-copyts -start_at_zero -avoid_negative_ts make_non_negative` plus
  `movflags=+frag_discont` keep segment timestamps on the original timeline, so segments
  of a restarted run line up with the earlier ones. The served `init.mp4` is normalized
  and identical across restarts.
- **Segment requests.** A finished segment is served immediately. A segment ffmpeg is
  about to produce is awaited. A request more than ~24 s beyond the encoder, or before
  the current run started, restarts ffmpeg with an input seek at that segment
  (`-ss N×L -start_number N`). ffmpeg writes segments via `temp_file`, so a file that
  exists is always complete. An input seek does not trim **stream-copied audio** (and Matroska
  files with subtitle tracks even seek back to the last subtitle cue, up to 30 s), so a restarted
  run that copies the audio drops the packets before `N×L` with
  `-bsf:a noise=drop=lt(pts*tb\,N×L)` (ffmpeg ≥ 6), keeping the original timestamps.
- **Colour tags.** A transcode always delivers SDR (`VIDEO-RANGE=SDR`). When the source is HDR (HDR10, HLG, Dolby
  Vision) the filter chain ends with `setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`
  and drops the mastering-display and content-light side data, so the bitstream VUI and the fMP4 `colr` box say
  BT.709 and no `mdcv`/`clli` survive — whatever tone mapping ran (GPU, zscale, or none when the build lacks
  zscale: then the picture is washed out, but players accept it; AVPlayer refuses an `SDR` playlist whose stream
  says PQ). ffmpeg ≥ 7 takes encoder colour tags from the frames, so `-color_trc` output options alone do not work.
  SDR sources keep their own tags; a remux copies the stream untouched and announces `PQ`/`HLG` from the source.
  The Dev World e2e (`colour_check`) ffprobes init + first segment of every remux/transcode and fails when
  `VIDEO-RANGE` and the tags disagree.
- **Throttling.** When a run is more than *throttle buffer* seconds ahead of the player it is
  *parked*: ffmpeg is ended (the segments it wrote stay, `job.paused: true`, no process, no
  remux/transcode slot). Once the player is within half the buffer of the parked front, a new run
  starts at that front segment, like a seek restart at a segment boundary (not counted in
  `restarts`). Any platform. The server no longer stops ffmpeg with `SIGSTOP`: on macOS a stopped
  child makes .NET's SIGCHLD handler spin (`waitid` reports stopped children there) while it holds
  the process-start lock, so every other ffmpeg/ffprobe spawn of the server waited (B16).
- **Cleanup.** ffmpeg is stopped after *job idle timeout* without segment requests, the
  whole session after *session idle timeout*; segments older than *segment retention*
  behind the playhead are deleted. A seek back to a deleted segment that the running ffmpeg already passed restarts
  ffmpeg at that segment (the run would never write it again). Sessions never survive a restart.
- **Competing requests.** One session has one run. When two requests want far-apart positions (two players on
  one session, or a stale hls.js retry next to a seek), the newer position wins at once; a request that would move
  the run back into the range the last restart left *waits* (polling, within its own wait budget) as long as the
  current position is still in use — requested, served or waited on within the last 3 s. It restarts back only once
  the newer position has been idle for 3 s. So the two never take turns restarting ffmpeg; the waiting one ends with
  its segment or `504 segment_timeout` at its budget. Before B16 they restarted the run on every attempt and the
  loser ran out of attempts (`503 segment_unavailable` after ~4 s, 7 restarts).
- **Waiting.** A segment, init or WebVTT request waits for ffmpeg at most *SegmentWaitTimeoutSeconds* (25 s) in
  total, across restarts, then answers `504 segment_timeout` with `Retry-After: 1`: the player gets a clear answer
  it can retry instead of a request that outlives its own fragment timeout.
- **Capacity.** At most *concurrent transcodes* ffmpeg processes run; a new session beyond
  that gets `503 transcode_capacity` instead of starving the running ones.

## Remux (direct stream)

A remux ("direct stream") copies the video bitstream into fragmented-MP4 HLS. It costs a fraction
of a transcode (no decode, no encode) and keeps the original quality, HDR included.

**When.** `POST /api/v1/transcoding/plan` (default `mode: auto`) and sessions with `mode: auto|remux`
decide direct → remux → transcode, each with stable reason codes:

| Mode | Chosen when |
|---|---|
| `direct` | The player can play the original file (container, codecs, bit depth, HDR, subtitle format, request limits). Only the plan endpoint returns it; a session always delivers HLS. Its `target` describes the original streams (`videoCopy`/`audioCopy` true, `encoder: none`), not a transcode. |
| `remux` | The video is H.264 (8-bit 4:2:0), HEVC Main/Main 10 or AV1 Main, in the client's `videoCodecs`, 10-bit only with `supports10Bit`, its HDR format (or the Dolby Vision base layer) in `hdrFormats`/`supportsHdr`, progressive, and within the request's `maxHeight`/`maxBitrateKbps`. The server's own transcode caps (max height, max bitrate) do not apply to copies. |
| `transcode` | Anything else (MPEG-2, VC-1, VP9, Hi10P H.264, 12-bit or 4:2:2 HEVC, interlaced, Dolby Vision profile 5, too large for the request), `mode: transcode`, or no usable keyframe index. |

Sessions default to `mode: transcode` so existing callers keep the unchanged transcode path;
`mode: remux` fails with `422 remux_not_possible` and the blockers when the video cannot be copied.

**Keyframe index.** Built once per stream (cached 10 minutes) with a few range reads over the
same loopback `/api/v1/stream/{token}` ffmpeg uses:

1. Matroska: EBML header → SeekHead (one nested SeekHead level) → Info (TimecodeScale), Tracks
   (first video track, `CodecPrivate`) → `Cues` (cue times and cluster positions of that track).
2. MP4/MOV: top-level box walk to `moov` (≤ 64 MiB), first video `trak`: `stts`, `ctts`, `stss`,
   `elst` (presentation time = decode time + composition offset − edit), `stsz`, `stsd`.
3. Otherwise (MPEG-TS, Matroska without a Cues entry, fragmented MP4): an ffprobe packet scan within
   `KeyframeScanTimeoutSeconds` (20 s). A scan over Usenet reads the whole file, so large sources
   usually fall back to a transcode instead.

An index is rejected when two keyframes are more than 24 s apart or when it lists more than
1 000 000 keyframes (a bound on what an untrusted file can make the server allocate); the plan then says
`keyframe_index_unavailable` and the session transcodes. Any unexpected error while reading the
container falls back to the scan and is never cached.

**Segments.** Target boundaries every 6 s move to the first keyframe at or after them; boundaries
that land on the same keyframe merge (a long GOP gives one longer segment, never a sliver), and a tail
under 1 s joins the last segment. `EXTINF` values are the real durations, `TARGETDURATION` is the
longest one rounded (RFC 8216), `#EXT-X-ENDLIST` is present from the start, so players can seek anywhere.

**How ffmpeg runs.** One process per run: `-c:v copy` (HEVC tagged `hvc1`), audio copied or encoded,
`-copyts -start_at_zero -avoid_negative_ts disabled`, fragmented MP4 (`frag_keyframe`, `delay_moov`,
`frag_discont`) on stdout. The server reads that box stream and writes the run's init segment and each
planned `{n}.m4s` atomically as soon as its last fragment reaches the next boundary; the final segment
is written only after a clean ffmpeg exit, never after a kill. Serving, throttling (parking), idle stop
and retention are the same as for transcodes.

**Seeks.** A request far from the running copy restarts ffmpeg one keyframe *before* the target
segment (`-ss` aims past ffmpeg's 3/23 s Matroska seek heuristic without reaching the next keyframe);
the pre-roll is dropped. Output timestamps are the source's minus its start time in every run, and
each run's decode times are aligned to the served init segment's edit list, so segments from
different runs join without gaps. Open-GOP sources (x265's default) work; a player that starts at a
segment skips the few leading pictures of its CRA keyframe, as with any HLS random access.
A WebVTT segment request is handled like a video segment request: when no live run will demux its
cues (the player loads subtitles before the video after a seek, or far ahead), it starts or restarts
the copy at that segment and waits for the cues, so a subtitle segment is never served empty just
because it was requested first.

**Audio.** One muxed rendition. The selected track is copied when it is AAC, AC-3, E-AC-3, FLAC or
Opus, listed in `audioCodecs`, and has at most `maxAudioChannels` channels. Otherwise it is converted
along E-AC-3 5.1 (640 kbps) → AC-3 5.1 (640 kbps) → AAC stereo (the audio bitrate setting), by what the
client lists and its channel limit. The run from 0 trims the encoder's priming delay from the input so
no timestamp is negative; a restarted run starts its converted audio on the next encoder frame boundary
of that run (AAC 1024, AC-3/E-AC-3 1536 samples), so audio decode times are identical in every run and
segments of different runs meet sample-exactly. **Audio fallback** (a viewer playback switched with
`audioFallback: true`, see api.md § 13): the selected track is always converted to AAC stereo, whatever the client
lists, and no other audio renditions are offered; transcodes do the same and direct play is skipped. **Switching audio** means a new session (`audioStreamIndex`); one ffmpeg per
session is simpler and more robust than parallel audio renditions.

**Subtitles.** Every text stream (SRT, ASS/SSA, WebVTT, MOV text) becomes a WebVTT rendition
(`#EXT-X-MEDIA:TYPE=SUBTITLES`, `LANGUAGE` as RFC 5646, `FORCED` from the disposition) at
`subtitles/{streamIndex}/main.m3u8`, aligned with the video segments. ffmpeg writes one WebVTT file per
stream alongside the video run; segments carry `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000` with cue
times on the media timeline and repeat cues that span a boundary. ASS styling is reduced to
`<b>`/`<i>`. Image subtitles (PGS, VobSub, DVB) cannot be delivered: the plan lists them with
`deliveredAs: none` and, when requested via `subtitleStreamIndex`, reason `subtitle_not_deliverable`
(`params.mode: remux`) so the client can offer direct play with VLC. A full transcode carries no
subtitle renditions; a selected stream gets `subtitle_not_deliverable` with `params.mode: transcode`.

**Burn-in.** Viewer playback (`/api/v1/viewer/playback`, [`viewers.md`](./viewers.md#playback)) can
burn a selected **image** subtitle into a transcode when the device can neither render it nor use
VLC: ffmpeg overlays it in one CPU filter graph (`[0:v]…[base];[base][0:s]overlay…`, deinterlacing
and tone mapping before, scaling after the overlay, hardware decode off, hardware encode still
possible). The plan says `subtitle_burned_in` and the stream's `deliveredAs` is `burnedIn`. Text
subtitles are not burned in (that needs libass). The machine/admin session API does not expose
burn-in. After a restart (seek), Matroska's subtitle seek-back also shows a subtitle that is already
on screen at the restart point; other containers show the next one.

For players: hls.js derives its time origin (`initPTS`) from the first fragment it loads. Started
mid-file, the audio of that fragment begins a little before the video keyframe, so hls.js places the
whole presentation, video and cues alike, up to one audio frame plus the B-frame delay later
(about 75 ms measured) than the playlist times. Subtitles stay in sync with the picture; only
`currentTime` differs slightly from a start at 0.

**Signalling.** `CODECS` comes from the bitstream's configuration record (`avcC` → `avc1.PPCCLL`,
`hvcC` → `hvc1.2.4.L150.90`-style strings with profile space, tier and constraint bytes, `av1C` →
`av01.0.08M.10`), with ffprobe profile/level as fallback; audio `mp4a.40.2/5/29`, `ac-3`, `ec-3`,
`fLaC`, `Opus`. `VIDEO-RANGE` is `PQ` (HDR10, Dolby Vision 8.1/7), `HLG` (HLG, Dolby Vision 8.4) or `SDR`.
The init segment carries `colr` (nclx primaries/transfer/matrix); mastering display and content light
level stay in the bitstream (SEI) and are written as `mdcv`/`clli` only when the source container had
them. `BANDWIDTH` is 1.1 × the peak segment bitrate measured from the index's byte positions
(`AVERAGE-BANDWIDTH` the mean). Matroska positions include every stream, so audio tracks with a known
constant rate (AC-3, E-AC-3, DTS core) are replaced by the delivered audio's rate; tracks without a
known rate stay in the estimate, which can only overstate it.

**Capacity.** Remux runs have their own pool (*Concurrent remuxes*, default 8, `503 remux_capacity`);
they never take a transcode slot. The Sessions tab labels every session *Remux* or *Transcode*.

## Audio renditions

A remux or transcode with two or more offered audio tracks (viewer playback offers the selected track plus up to
three more, one per language; the session API takes `audioRenditions`) delivers them as HLS audio renditions of one
group, so a player switches language inside the session:

```
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Deutsch · AC3 5.1",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="6",URI="audio/1/main.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English · AC3 2.0",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/2/main.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=…,CODECS="avc1.640028,ac-3",…,AUDIO="audio",SUBTITLES="subs",CLOSED-CAPTIONS=NONE
main.m3u8
```

**One ffmpeg process, demuxed on serve.** ffmpeg still writes one fragmented MP4: the video (track 1) plus every
offered audio track (rendition *i* = track *i* + 2), each with its own codec options (`-c:a:i copy` or
`-c:a:i aac -ac:a:i 2 …`, converted remux tracks with their own `atrim` origin, copied transcode tracks with their
own `noise=drop` filter after a restart). The remux segmenter and the transcode's HLS muxer cut it exactly as
before. When a player asks for `main.m3u8`/`init.mp4`/`{n}.m4s` the server returns only the video track, and
`audio/{id}/…` returns only that audio track (`Fmp4TrackSplit`: the `moof` keeps that track's `traf`, the `trun`
data offsets are rewritten against a new `mdat` holding its samples). Video and audio segment *n* therefore come
from the same fragment: identical boundaries, `EXTINF` durations and restart behaviour, and seeks, the throttle,
WebVTT subtitles and capacity pools are unchanged. `ffmpeg -hls var_stream_map` was not used: it would replace
the keyframe-accurate remux segmenter and run every rendition on its own playlist/restart logic.

**Names, codecs, languages.** `NAME` (and the playback response's `label`) is the language in its own name plus
what is delivered after conversion, e.g. `Deutsch · AAC 2.0` for a German AC-3 5.1 track a browser gets as AAC
stereo (not the source title, which describes the source). Each fMP4 audio track carries its ISO 639-2 language
(`-metadata:s:a:i language=deu`). Apple's authoring spec wants one codec per audio group. The remux group codec does
not depend on which rendition is selected (start, `audioLanguage` or `/switch` give the same group for one device and
title): among AAC, AC-3 and E-AC-3 (with an ffmpeg encoder) it is the codec most renditions would copy anyway, ties go
to the lowest source index, and every rendition in another codec — the selected one too — is converted to it (e.g.
TrueHD next to a copied AC-3 → AC-3 5.1; Sintel's German AC-3 5.1 on a 2-channel device → AC-3 2.0, really downmixed
with `-ac:a:i 2`, next to the copied English AC-3 2.0). Only a group whose renditions are all copied FLAC/Opus/MP3
stays mixed, because ffmpeg cannot write a matching track for every source. Transcode renditions are always AAC. A malformed muxed
fragment never becomes a generic error: splitting an init throws only `InvalidDataException`, splitting a segment
`InvalidDataException` (bounded `trun` sample counts) or `EndOfStreamException` (a truncated file), and the route
answers both with `500 rendition_split_failed` (logged with the stack; no internals in the body). When the segment
already started streaming, the connection is aborted instead. Covered by
`RemuxIntegrationTests.AudioRenditionSegment_ThatCannotBeSplit_Answers500RenditionSplitFailed`. The admin plan (`POST /api/v1/transcoding/plan`, session
responses, Playback Preview card) lists `audioRenditions` when a request offers them.

**Cost** (Sintel dual-audio, 180 s, 1 vs 2 audio tracks, same ffmpeg arguments; measured in B5): remux with two
tracks converted to AAC 4.7 → 10.7 s CPU (still 32× real time), remux copy unchanged (≈ 0.05 s), 720p transcode
59 → 67 s CPU (16× real time); disk per session +12 % (transcode) to +53 % (copying the 256 kbit/s AC-3 5.1 track of the Dev World source); first
segments about 80 ms later for a transcode (two audio encoders before the first fragment). The 4-rendition cap
bounds it; a single audio track stays muxed exactly as before.

## Settings

Editable in **Transcoding → Settings** (stored in the database):

| Setting | Default | Meaning |
|---|---|---|
| Enable server transcoding | on | When off, new sessions get `409 transcoding_disabled`. |
| Acceleration | Software | `none`, `videotoolbox`, `vaapi`, `qsv`, `nvenc`. |
| VA-API device | `/dev/dri/renderD128` | Render node for VA-API and QSV; picked from the detected GPUs. |
| NVIDIA GPU | 0 | NVENC/NVDEC GPU in `nvidia-smi` numbering. |
| Hardware decoding / codecs | on / every validated codec | Pin a manual list to avoid a buggy driver. |
| Hardware encoding | on | Off keeps GPU decode but encodes with libx264. |
| HDR tone mapping | on | GPU tone mapping on VideoToolbox and VA-API; CPU tone mapping needs ffmpeg with `zscale`. |
| Allow HEVC output | off | Only for clients that declare HEVC support. |
| Encoder preset / CRF | `veryfast` / 23 | libx264/libx265 only. |
| Max height / max bitrate | 2160 / 20 000 kbps | Clients may request less, never more. |
| Audio bitrate / allow surround | 192 kbps / off | AAC; 5.1 only for clients that accept it. |
| Segment length | 3 s | 2–10 s. Shorter segments start and seek faster; see *Time to first frame*. |
| Concurrent transcodes | 2 | Running ffmpeg processes across all users. |
| Concurrent remuxes | 8 | Running stream copies (1–64), counted separately. |
| Throttle / buffer | on / 120 s | Park (end) the run this far ahead of the player; it resumes at half the buffer. |
| ffmpeg threads | 0 (auto) | Limits encoder threads for software encodes. |
| Job idle / session idle / retention | 60 s / 30 min / 15 min | See *Cleanup*. |

Host-level options (appsettings or environment only):

| Option | Default | Meaning |
|---|---|---|
| `Streamarr:Transcoding:FfmpegPath` / `FfprobePath` | `ffmpeg` / `ffprobe` | Binaries to run, e.g. `/usr/lib/jellyfin-ffmpeg/ffmpeg`. |
| `Streamarr:Transcoding:WorkspacePath` | `cache/transcode` (`/app/data/transcode` in Docker) | Live segments and scratch files. Needs a few hundred MB per active stream. |
| `Streamarr:Transcoding:SamplesPath` | `cache/transcoding-samples` (`/app/data/transcoding-samples`) | Generated test media (about 100 MB for all samples). |
| `Streamarr:Transcoding:LocalSourceBaseUrl` | derived from the listen address | Loopback origin ffmpeg uses to read `/api/v1/stream`. Set it if the server only listens on a non-loopback address. |
| `Streamarr:Transcoding:MaxSessions` | 16 | Sessions (running or idle) kept at once. |
| `Streamarr:Transcoding:SegmentWaitTimeoutSeconds` | 25 | Longest one segment/init/WebVTT request waits in total (across ffmpeg restarts) before `504 segment_timeout` with `Retry-After: 1`. |
| `Streamarr:Transcoding:KeyframeIndexTimeoutSeconds` | 30 | Budget for reading Matroska Cues or the MP4 sample table for a remux. |
| `Streamarr:Transcoding:KeyframeScanTimeoutSeconds` | 20 | Budget for the ffprobe packet scan when the container has no usable index. |

## API

Admin endpoints under `/api/v1/transcoding` manage config, capabilities, samples,
benchmarks and sessions; `POST /api/v1/transcoding/sessions` (admin **or machine key**)
starts an HLS rendition of a stream token and returns a playlist capability. Details in
the [API reference](api.md#11-server-side-transcoding).

## Test harness (development)

| Layer | Where | What it covers |
|---|---|---|
| Unit | `server/tests/Streamarr.Server.Tests/Transcoding/*Tests.cs` | Planner decisions, the exact ffmpeg argv per backend, playlist math, ffprobe/`-encoders`/`-filters` parsing for ffmpeg 6–8, settings validation, culture-independent output. |
| Multi-GPU | `TranscodingMultiGpuTests` | GPU enumeration from fake sysfs/`/dev` trees and `nvidia-smi` output, per-device detection with a scripted ffmpeg (a failing and a working GPU per backend), device pinning in the argv. |
| TTFF | `TranscodingTtffTests` | Cold-release time to first frame for direct play vs. transcode, start and resume, against a mock provider with realistic latency and throughput; prints the per-stage breakdown. `STREAMARR_TTFF_SEGMENT_SECONDS` compares segment lengths. |
| Integration | `TranscodingIntegrationTests` | Real server + mock Usenet + **real ffmpeg**: a 3-minute H.264/AC-3 release is transcoded and validated segment by segment (keyframes, timestamps, A/V alignment, continuity across restarts), forward/backward seeks, throttling, idle stop, capacity, capability security, the special samples (10-bit, HDR, interlaced), benchmarks, and that stopping a transcode leaves the direct stream alone. |
| Remux | `RemuxPlannerTests`, `KeyframeIndexTests`, `RemuxSegmenterTests`, `CodecStringTests`, `RemuxPlaylistTests`, `RemuxIntegrationTests` | Decision matrix, audio ladder, Matroska/MP4 index vs. ffprobe on generated media (irregular keyframes, B-frames, edit lists, no Cues), segment planning, codec strings, WebVTT, the segmenter on real ffmpeg output (restart pre-roll, killed tail), and end to end over mock Usenet: keyframe-accurate playlists, far seeks, HEVC HDR10 signalling, audio conversion, subtitles, separate capacity. |
| Player simulator | `server/tools/hlssim` | Plays a rendition like hls.js (buffer target, realtime or faster playhead, scripted seeks, parallel players) against any running server and reports stalls, latencies and segment validation, including WebVTT renditions. `--mode remux` plus client flags (`--video-codecs`, `--audio-codecs`, `--max-channels`, `--ten-bit`, `--hdr-formats`) exercise remuxes. |
| UI | `web/src/**/*.test.tsx`, `web/e2e/transcoding-ui.spec.ts` | Component tests plus a Playwright run that detects ffmpeg, benchmarks, plays HLS in Chromium, and switches Playback Preview. |

```bash
# All transcoding tests (needs ffmpeg on PATH)
dotnet test server/tests/Streamarr.Server.Tests --filter "FullyQualifiedName~Transcoding"

# The same suite on Linux with Ubuntu's ffmpeg 6.1
docker run --rm -v "$PWD/server:/src:ro" mcr.microsoft.com/dotnet/sdk:8.0-noble bash -c \
  'apt-get update -qq && apt-get install -y -qq ffmpeg rsync >/dev/null &&
   rsync -a --exclude bin --exclude obj /src/ /work/ && cd /work &&
   dotnet test tests/Streamarr.Server.Tests --filter "FullyQualifiedName~Transcoding"'

# Drive a running server: realtime playback with two seeks, three parallel players
dotnet run --project server/tools/hlssim -- --server http://127.0.0.1:8080 --password '<admin>' \
  --sample h264-1080p-ac3 --max-height 720 --rate 1 --seek 6:22,26:2 --concurrency 3 --decode

# Remux a release for an HDR-capable Apple-like client, with a far seek
dotnet run --project server/tools/hlssim -- --server http://127.0.0.1:39310 --api-key <key> --release <id> --work <workId> \
  --mode remux --video-codecs h264,hevc --audio-codecs aac,ac3,eac3 --containers mp4 --max-channels 6 \
  --ten-bit --hdr-formats hdr10,hlg --rate 0 --seek 12:150 --decode
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Overview says *Software fallback — … is not working* | The selected backend failed its self-test. Open its card: each failed check shows ffmpeg's error and the card lists setup hints. |
| *No /dev/dri devices are visible* | Add `devices` and `group_add` (above) and recreate the container. |
| HDR looks grey or washed out | Tone mapping is off or unavailable: enable it, use a GPU backend, or an ffmpeg with `zscale` (the Docker image has it). |
| Hardware passes but the wrong GPU is busy (multi-GPU host) | Check *Overview → Graphics devices*; select the intended render node or NVIDIA GPU in Settings. |
| Slow start or seeks | Compare *Startup* in the Sessions tab with the benchmark's *time to first segment*; enable hardware acceleration, lower *Max height* or *Segment length*. |
| `503 transcode_capacity` | All transcode slots are busy; raise *Concurrent transcodes* or stop a session in the *Sessions* tab. |
| `503 remux_capacity` | All remux slots are busy; raise *Concurrent remuxes*. |
| `422 remux_not_possible` | `mode: remux` was requested but the video cannot be copied for this client; the message lists the blockers (`POST /transcoding/plan` shows them as `remuxBlockers`). |
| A remux falls back to a transcode with `keyframe_index_unavailable` | The source has no usable Cues/sample table and the ffprobe scan did not finish in time (large MPEG-TS over Usenet), or keyframes are more than 24 s apart. |
| `504 segment_timeout` | ffmpeg could not keep up or the source stalled; check the session's ffmpeg log and the benchmark speed for similar media. |
| Benchmark verdict *Marginal* or *Too slow* | Enable hardware acceleration, lower *Max height*, or use a faster preset. |

## Current limits

- Remux: H.264, HEVC and AV1 only (VP9, MPEG-2, VC-1 are transcoded); at most 4 audio renditions (other
  tracks need a new session via `/switch`); image subtitles are not delivered by a remux (only a viewer-playback
  transcode can burn them in); a cue that
  starts before a restarted run's first keyframe and is still showing at its start is only delivered
  if an earlier run demuxed it; sources without a Matroska Cues
  entry or an MP4 sample table need the ffprobe scan, which rarely finishes in time for large files
  over Usenet; the admin UI's preview player (hls.js light) does not render subtitles.
- One video rendition per session (no adaptive bitrate ladder). mediastreamvalidator (Apple HLS tools) was not available to
  validate the audio groups; checked with ffprobe, ffmpeg decode and hlssim.
- The Jellyfin plugin keeps using Jellyfin's own transcoder; this path is for
  Streamarr's own clients and the management UI.
