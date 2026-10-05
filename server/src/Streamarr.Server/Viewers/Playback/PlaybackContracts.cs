using Streamarr.Server.Contracts;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Viewers.Playback;

public sealed record PlaybackStartRequest
{
    /// <summary>Canonical movie or episode work id, e.g. <c>tmdb-movie-603</c> or <c>tmdb-tv-1396-s01e01</c>.</summary>
    public string? WorkId { get; init; }

    /// <summary>A version from <c>/viewer/catalog/works/{workId}/versions</c>; omitted = the recommended (rank 1) version.</summary>
    public string? ReleaseId { get; init; }

    /// <summary>Where playback starts (default 0); <c>resumePositionTicks</c> in the answer is the saved position.</summary>
    public long? StartPositionTicks { get; init; }

    /// <summary>Source stream index of the audio track; omitted = chosen from <c>preferences.audioLanguage</c>, then the default track.</summary>
    public int? AudioStreamIndex { get; init; }

    /// <summary>Source stream index of the subtitle; <c>-1</c> = none; omitted = chosen from <c>preferences.subtitleMode</c> and <c>subtitleLanguage</c>.</summary>
    public int? SubtitleStreamIndex { get; init; }

    public DeviceProfileDto? Device { get; init; }
    public PlaybackPreferencesDto? Preferences { get; init; }
}

/// <summary>User preferences for one playback; on a switch, set fields replace the current ones.</summary>
public sealed record PlaybackPreferencesDto
{
    /// <summary><c>auto</c> (default: native, then VLC as §2 ranks them), <c>native</c> (never VLC) or <c>vlc</c> (always VLC when available).</summary>
    public string? Engine { get; init; }

    /// <summary>Highest video height the viewer wants; lower than the source means a transcode.</summary>
    public int? MaxHeight { get; init; }

    /// <summary>Highest total bitrate the viewer wants (combined with the device's bandwidth cap).</summary>
    public int? MaxBitrateKbps { get; init; }

    /// <summary>Preferred audio language (ISO 639-1 or 639-2, e.g. <c>de</c> or <c>ger</c>).</summary>
    public string? AudioLanguage { get; init; }

    /// <summary>Preferred subtitle language.</summary>
    public string? SubtitleLanguage { get; init; }

    /// <summary><c>off</c>, <c>forced</c> (default: only forced subtitles, e.g. for foreign-language scenes) or <c>always</c>.</summary>
    public string? SubtitleMode { get; init; }
}

/// <summary>What the device can play; the server decides the method from it.</summary>
public sealed record DeviceProfileDto
{
    /// <summary><c>ios</c>, <c>ipados</c>, <c>tvos</c>, <c>android</c>, <c>androidtv</c> or <c>web</c>.</summary>
    public string? Platform { get; init; }

    /// <summary>Playback engines in the device's order of preference (the built-in <c>native</c>/<c>web</c> one first, <c>vlc</c> when bundled).</summary>
    public IReadOnlyList<EngineProfileDto>? Engines { get; init; }

    /// <summary>True when the VLC engine can be used on this device.</summary>
    public bool VlcAvailable { get; init; }

    /// <summary>Optional bandwidth cap of the connection.</summary>
    public int? MaxBitrateKbps { get; init; }
}

public sealed record EngineProfileDto
{
    /// <summary><c>native</c> (ExoPlayer, AVPlayer), <c>web</c> (browser video + hls.js / Safari HLS) or <c>vlc</c>.</summary>
    public string? Engine { get; init; }

    /// <summary>Containers the engine plays from a URL: <c>mp4</c>, <c>mkv</c>, <c>webm</c>, <c>ts</c>, <c>mpeg</c>, …</summary>
    public IReadOnlyList<string>? Containers { get; init; }

    public IReadOnlyList<VideoCodecProfileDto>? VideoCodecs { get; init; }
    public IReadOnlyList<AudioCodecProfileDto>? AudioCodecs { get; init; }

    /// <summary>Subtitle formats the engine renders from the original file (<c>srt</c>, <c>ass</c>, <c>webvtt</c>, <c>pgs</c>, <c>vobsub</c>, …); omitted = not declared.</summary>
    public IReadOnlyList<string>? SubtitleFormats { get; init; }

    /// <summary>True when the engine plays fMP4 HLS (needed for a server remux or transcode).</summary>
    public bool Hls { get; init; }

    /// <summary>Channels of the audio output path (2 for stereo, 6 or 8 for a surround receiver); default 2.</summary>
    public int? MaxAudioChannels { get; init; }

    /// <summary>True when the engine tone-maps HDR10 and HLG to SDR itself (VLC, browsers): such sources then play on it although <c>hdrFormats</c> does not list them.</summary>
    public bool HdrToneMapping { get; init; }
}

public sealed record VideoCodecProfileDto
{
    /// <summary><c>h264</c>, <c>hevc</c>, <c>av1</c>, <c>vp9</c>, <c>mpeg2video</c>, <c>mpeg4</c>, <c>vc1</c>, …</summary>
    public string? Codec { get; init; }

    public int? MaxWidth { get; init; }
    public int? MaxHeight { get; init; }

    /// <summary>Highest decodable bit depth; default 8 for H.264 and 10 for HEVC/AV1/VP9.</summary>
    public int? MaxBitDepth { get; init; }

    /// <summary>HDR formats rendered for this codec: <c>hdr10</c>, <c>hlg</c>, <c>dolbyvision</c>.</summary>
    public IReadOnlyList<string>? HdrFormats { get; init; }
}

public sealed record AudioCodecProfileDto
{
    /// <summary><c>aac</c>, <c>ac3</c>, <c>eac3</c>, <c>truehd</c>, <c>dts</c>, <c>flac</c>, <c>opus</c>, <c>mp3</c>, …</summary>
    public string? Codec { get; init; }

    /// <summary>Channels the engine decodes for this codec (only checked for direct play; decoders usually downmix).</summary>
    public int? MaxChannels { get; init; }

    /// <summary>True when the engine bitstreams this codec to the audio output (no channel limit).</summary>
    public bool Passthrough { get; init; }
}

public sealed record PlaybackSwitchRequest
{
    /// <summary>Where the new rendition starts; default = the last reported position.</summary>
    public long? PositionTicks { get; init; }

    /// <summary>Another version of the same work.</summary>
    public string? ReleaseId { get; init; }

    public int? AudioStreamIndex { get; init; }

    /// <summary><c>-1</c> turns subtitles off.</summary>
    public int? SubtitleStreamIndex { get; init; }

    /// <summary>Set fields replace the playback's preferences (engine, quality, languages, subtitle mode).</summary>
    public PlaybackPreferencesDto? Preferences { get; init; }

    /// <summary>The current method failed on the device: continue with the next one in the ranking.</summary>
    public bool StepDown { get; init; }

    /// <summary>True: the server converts the selected audio track to AAC stereo (no direct play, no audio group) for the rest of this playback; false turns it off; null keeps it.</summary>
    public bool? AudioFallback { get; init; }
}

/// <summary>One viewer playback: its preparation state and, once <c>ready</c>, what to play and why.</summary>
public sealed record PlaybackResponse
{
    public required string PlaybackId { get; init; }

    /// <summary>Increments with every switch; the state belongs to this revision.</summary>
    public required int Revision { get; init; }

    /// <summary><c>queued</c>, <c>resolving</c>, <c>fallback</c>, <c>repairing</c>, <c>planning</c>, <c>starting</c>, <c>ready</c> or <c>failed</c>.</summary>
    public required string State { get; init; }

    public required string WorkId { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }

    /// <summary>Suggested delay before the next poll; 0 once ready or failed.</summary>
    public int PollAfterMs { get; init; }

    /// <summary>Every release tried, in order, with its health (<c>resolving</c>, <c>ready</c>, <c>degraded</c>, <c>dead</c>).</summary>
    public required IReadOnlyList<PlaybackAttemptDto> Attempts { get; init; }

    /// <summary>The release that was requested but found dead, when an automatic fallback is playing instead.</summary>
    public PlaybackReleaseDto? FallbackFrom { get; init; }

    /// <summary>The version being prepared or played (rank 0 = not in the current cached ranking).</summary>
    public VersionDto? Version { get; init; }

    /// <summary>PAR2 repair progress while <c>repairing</c> (and for a repaired or progressive copy).</summary>
    public RepairStatusInfo? Repair { get; init; }

    /// <summary>Where this revision starts.</summary>
    public long StartPositionTicks { get; init; }

    /// <summary>The viewer's saved position for this work (null = none).</summary>
    public long? ResumePositionTicks { get; init; }

    /// <summary><c>direct</c>, <c>remux</c> or <c>transcode</c> (ready only).</summary>
    public string? Method { get; init; }

    /// <summary><c>native</c>, <c>web</c> or <c>vlc</c> (ready only).</summary>
    public string? Engine { get; init; }

    /// <summary>Capability path relative to the server origin (<c>/api/v1/stream/{token}</c> or <c>/api/v1/transcode/{capability}/master.m3u8</c>); players need no auth headers.</summary>
    public string? Url { get; init; }

    /// <summary>The stream capability of the resolved release.</summary>
    public string? StreamToken { get; init; }

    public PlaybackMediaInfoDto? MediaInfo { get; init; }

    /// <summary>True when the HLS master carries an audio group: switch between <see cref="AudioRenditions"/> in the player, no <c>/switch</c> needed.</summary>
    public bool InSessionAudioSwitch { get; init; }

    /// <summary>Audio renditions of the HLS master (group <c>audio</c>), in master order; empty when the audio is muxed into the video (ready only).</summary>
    public IReadOnlyList<PlaybackAudioRenditionDto>? AudioRenditions { get; init; }

    /// <summary>Why this method and engine (also present on <c>failed</c> when no method was possible).</summary>
    public PlaybackDecisionDto? Decision { get; init; }

    public PlaybackErrorDto? Error { get; init; }

    /// <summary><c>retry</c>, <c>otherVersion</c>, <c>lowerQuality</c>, <c>useVlc</c> (failed only).</summary>
    public IReadOnlyList<string>? SuggestedActions { get; init; }

    /// <summary>True after a <c>/switch</c> with <c>audioFallback</c>: every rendition carries the selected audio as AAC stereo.</summary>
    public bool AudioFallback { get; init; }
}

/// <summary>One <c>EXT-X-MEDIA:TYPE=AUDIO</c> entry; <see cref="Label"/> equals its NAME and <see cref="Language"/> its LANGUAGE.</summary>
public sealed record PlaybackAudioRenditionDto
{
    /// <summary>Stable id inside the playback revision (the URI is <c>audio/{id}/main.m3u8</c> next to the master).</summary>
    public required string Id { get; init; }

    /// <summary>Source audio stream index (as in <c>mediaInfo.audioTracks[].index</c> and <c>/switch audioIndex</c>).</summary>
    public required int StreamIndex { get; init; }

    public string? Language { get; init; }
    public required string Label { get; init; }

    /// <summary>Delivered channels and codec (<c>aac</c>, <c>ac3</c>, <c>eac3</c>, <c>flac</c>, <c>opus</c>).</summary>
    public required int Channels { get; init; }

    public required string Codec { get; init; }

    /// <summary>The rendition marked DEFAULT=YES (the selected track).</summary>
    public required bool Default { get; init; }
}

public sealed record PlaybackReleaseDto
{
    public required string ReleaseId { get; init; }
    public string? Name { get; init; }
}

public sealed record PlaybackAttemptDto
{
    public required string ReleaseId { get; init; }
    public string? Name { get; init; }

    /// <summary><c>resolving</c>, <c>ready</c>, <c>degraded</c> or <c>dead</c>.</summary>
    public required string Status { get; init; }
}

public sealed record PlaybackErrorDto
{
    public required string Code { get; init; }
    public required string Message { get; init; }
    public IReadOnlyDictionary<string, string>? Params { get; init; }
}

public sealed record PlaybackDecisionDto
{
    public string? Method { get; init; }
    public string? Engine { get; init; }

    /// <summary>Stable codes with <c>params</c> for localized texts: the planner's reasons plus track and engine notes.</summary>
    public required IReadOnlyList<PlanReasonResponse> Reasons { get; init; }

    /// <summary>Higher-ranked methods that were not possible, each with why.</summary>
    public required IReadOnlyList<PlaybackSkippedDto> Skipped { get; init; }
}

public sealed record PlaybackSkippedDto
{
    public required string Method { get; init; }
    public required string Engine { get; init; }
    public required IReadOnlyList<PlanReasonResponse> Reasons { get; init; }
}

public sealed record PlaybackMediaInfoDto
{
    /// <summary>Container family of the original file (<c>mkv</c>, <c>mp4</c>, <c>mpeg</c>, …).</summary>
    public string? Container { get; init; }

    public long DurationTicks { get; init; }
    public int? BitrateKbps { get; init; }
    public PlaybackVideoDto? Video { get; init; }
    public required IReadOnlyList<PlaybackAudioTrackDto> AudioTracks { get; init; }
    public required IReadOnlyList<PlaybackSubtitleTrackDto> SubtitleTracks { get; init; }
}

public sealed record PlaybackVideoDto
{
    public required int Index { get; init; }
    public required string Codec { get; init; }
    public string? Profile { get; init; }
    public required int BitDepth { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public double? Fps { get; init; }

    /// <summary><c>none</c>, <c>hdr10</c>, <c>hlg</c> or <c>dolbyvision</c>.</summary>
    public required string Hdr { get; init; }

    public int? DolbyVisionProfile { get; init; }
    public bool Interlaced { get; init; }

    /// <summary>What the player receives: <c>SDR</c>, <c>PQ</c> or <c>HLG</c> (a transcode is SDR).</summary>
    public string? VideoRange { get; init; }

    /// <summary>The video codec the player receives (the source codec unless transcoded).</summary>
    public string? DeliveredCodec { get; init; }
    public int? DeliveredHeight { get; init; }
}

public sealed record PlaybackAudioTrackDto
{
    public required int Index { get; init; }
    public required string Codec { get; init; }
    public required int Channels { get; init; }
    public string? Language { get; init; }
    public string? Title { get; init; }
    public bool Default { get; init; }
    public bool Selected { get; init; }

    /// <summary><c>original</c> (direct play: the engine switches locally), <c>copy</c>, <c>converted</c> or <c>none</c> (switch to hear it).</summary>
    public required string DeliveredAs { get; init; }

    /// <summary>The HLS audio rendition carrying this track (switch in the player); null = not in the master.</summary>
    public string? RenditionId { get; init; }

    public string? DeliveredCodec { get; init; }
    public int? DeliveredChannels { get; init; }
}

public sealed record PlaybackSubtitleTrackDto
{
    public required int Index { get; init; }
    public required string Codec { get; init; }
    public string? Language { get; init; }
    public string? Title { get; init; }
    public bool Forced { get; init; }
    public bool Default { get; init; }
    public bool TextBased { get; init; }
    public bool Selected { get; init; }

    /// <summary><c>embedded</c> (direct play), <c>webvtt</c> (HLS rendition of a remux or transcode), <c>burnedIn</c> (in the transcoded picture) or <c>none</c>.</summary>
    public required string DeliveredAs { get; init; }
}
