import { pending } from '@/../jest/player/matrix';

// State matrix layer C (docs/client/player/state-matrix.md § 1): one test per row id.

describe('matrix C — Delivery (server → engine)', () => {
  pending(
    'C01',
    'Direct play: capability expired or LRU-evicted mid-play (404 unknown_stream; hard 24 h…',
    'S4'
  );
  pending(
    'C02',
    'Direct play 416 / range error / short file (Content-Length larger than the data)',
    'S4'
  );
  pending(
    'C03',
    'Direct play throughput below the bitrate (Usenet slow, 6 MiB/s pacing StreamarrOptions.…',
    'S5'
  );
  pending(
    'C04',
    'Direct play stalls on a Usenet hole (repair wait up to 90 s, RepairAwareStream.cs:67-12…',
    'S5'
  );
  pending('C05', 'Connection reset mid-transfer (progressive or segment)', 'S5');
  pending(
    'C06',
    'Remux/transcode fails to start (TranscodeException at create)',
    'regression test, S3+'
  );
  pending('C07', 'ffmpeg crashes mid-stream (non-zero exit)', 'S4');
  pending('C08', 'ffmpeg slower than real time (4K, weak server, software tone mapping)', 'S5');
  pending(
    'C09',
    'Seek back > 15 min inside one long transcode run (deleted segment, live run past it)',
    'S4'
  );
  pending(
    'C10',
    'Playlist 404 unknown_transcode (session closed: idle 1800 s, restart, superseded by ano…',
    'S4'
  );
  pending('C11', 'Playlist 5xx', 'S4');
  pending('C12', 'Endless / stale playlist (no ENDLIST, no new segments)', 'S5');
  pending(
    'C13',
    'Segment 404 unknown_segment / end_of_stream (index outside the timeline, remux exit 0 b…',
    'S4'
  );
  pending(
    'C14',
    'Segment 503 segment_unavailable / init_unavailable / segment_evicted (no Retry-After) /…',
    'S4'
  );
  pending('C15', 'Segment 410 session_closed (closed during the request)', 'S4');
  pending('C16', 'Segment truncated (connection closes early, wrong Content-Length)', 'S5');
  pending('C17', 'Corrupt segment (bad fMP4 box / bitstream)', 'S5');
  pending('C18', 'Timestamp discontinuity between ffmpeg runs', 'S5');
  pending(
    'C19',
    'Audio rendition 404 unknown_audio_rendition / 500 rendition_split_failed during an in-s…',
    'regression test, S3+'
  );
  pending(
    'C20',
    'Audio rendition fails during normal playback (split aborted after headers TranscodeStre…',
    'S5'
  );
  pending('C21', 'Video media playlist / init missing (500, 503 init_unavailable)', 'S5');
  pending('C22', 'Subtitle playlist or .vtt 404 (unknown_subtitle_stream) / 5xx', 'S8');
  pending('C23', 'Subtitle parse error (malformed WebVTT)', 'S8');
  pending(
    'C24',
    'Forced/selected subtitle not deliverable (subtitle_not_deliverable, deliveredAs: none)',
    'S8'
  );
  pending(
    'C25',
    'Wrong content type (playlist not application/vnd.apple.mpegurl, segment not video/mp4)',
    'S6'
  );
  pending('C26', 'HDR → SDR tag mismatch (AVPlayer -12927)', 'S6');
  pending(
    'C27',
    'Audio codec unsupported although declared (E-AC-3 on a browser, DTS passthrough with th…',
    'S5'
  );
  pending(
    'C28',
    'Video codec unsupported although declared (HEVC/AV1/DV profile without decoder)',
    'S5'
  );
  pending('C29', 'Resolution/level beyond the decoder (4K on a 1080p SoC, H.264 level 5.2)', 'S5');
  pending('C30', 'Encrypted content without DRM', 'S8');
  pending('C31', 'Zero-length or very short file (< 1 segment, duration 0)', 'S8');
  pending(
    'C32',
    'Stream ends earlier than the announced duration (truncated file, early remux end, VLC S…',
    'S4'
  );
  pending('C33', 'Announced duration shorter than the media', 'regression test, S3+');
  pending(
    'C34',
    'Image subtitle needs burn-in / VLC (subtitle_burned_in, image_subtitle_vlc)',
    'regression test, S3+'
  );
});
