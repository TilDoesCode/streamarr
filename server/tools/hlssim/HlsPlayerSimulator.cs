using System.Diagnostics;
using System.Globalization;
using Streamarr.Server.Transcoding;

namespace Streamarr.Tools.HlsSim;

public sealed record SeekStep(double AtSeconds, double ToSeconds);

public sealed record HlsSimOptions
{
    /// <summary>Playback speed of the simulated player; 0 downloads as fast as possible without a playhead.</summary>
    public double PlaybackRate { get; init; } = 1;
    public double BufferTargetSeconds { get; init; } = 30;
    public double StartPositionSeconds { get; init; }
    public double? StopAfterMediaSeconds { get; init; }
    public IReadOnlyList<SeekStep> Seeks { get; init; } = [];
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(120);
    public bool Decode { get; init; }
    public string FfmpegPath { get; init; } = "ffmpeg";
    public double MaxStartDriftSeconds { get; init; } = 0.15;
    public double MaxLateDriftSeconds { get; init; } = 0.30;
    public double MaxDiscontinuitySeconds { get; init; } = 0.10;
    public double MaxAudioVideoOffsetSeconds { get; init; } = 0.25;

    /// <summary>Fetch and validate the WebVTT segment of every subtitle rendition alongside each video segment.</summary>
    public bool ValidateSubtitles { get; init; } = true;

    /// <summary>Request each WebVTT segment before its video segment, as hls.js may after a seek.</summary>
    public bool SubtitlesFirst { get; init; }
}

public sealed record SegmentFetch(
    int Index,
    double ExpectedStart,
    double ExpectedDuration,
    double? VideoStart,
    double? VideoDuration,
    double? AudioStart,
    bool StartsWithKeyframe,
    long Bytes,
    double LatencyMs,
    int Run,
    double? VideoDecodeStart = null);

public sealed record HlsSimReport
{
    public required int PlaylistSegments { get; init; }
    public required double SegmentLength { get; init; }
    public required double PlaylistDuration { get; init; }
    public required string Codecs { get; init; }
    public double? TimeToFirstSegmentMs { get; init; }
    public double? TimeToFirstFrameMs { get; init; }
    public required IReadOnlyList<SegmentFetch> Fetches { get; init; }
    public required IReadOnlyList<double> SeekLatenciesMs { get; init; }
    public int Stalls { get; init; }
    public double StallSeconds { get; init; }
    public double WallSeconds { get; init; }
    public long TotalBytes { get; init; }
    public required IReadOnlyList<string> Errors { get; init; }
    public required IReadOnlyList<string> Warnings { get; init; }
    public int SubtitleRenditions { get; init; }

    /// <summary>EXT-X-MEDIA TYPE=AUDIO renditions fetched next to every video segment.</summary>
    public int AudioRenditions { get; init; }
    public int AudioSegments { get; init; }
    public int SubtitleSegments { get; init; }
    public int SubtitleCues { get; init; }
    public IReadOnlyList<string> SubtitleSamples { get; init; } = [];

    /// <summary>Every cue received, as "rendition #segment: start text".</summary>
    public IReadOnlyList<string> SubtitleCueList { get; init; } = [];

    public bool Passed => Errors.Count == 0;

    public double LatencyPercentile(double percentile)
    {
        if (Fetches.Count == 0)
            return 0;
        var sorted = Fetches.Select(f => f.LatencyMs).Order().ToList();
        return sorted[Math.Clamp((int)Math.Ceiling(percentile / 100 * sorted.Count) - 1, 0, sorted.Count - 1)];
    }
}

public sealed record MediaPlaylist(string InitUri, IReadOnlyList<(double Duration, string Uri)> Segments, int TargetDuration);

public sealed record SubtitleRendition(string Name, string? Language, Uri PlaylistUrl, MediaPlaylist Playlist);

public sealed record AudioRendition(string Name, Uri PlaylistUrl, MediaPlaylist Playlist, byte[] InitBytes, Fmp4Init Init)
{
    public Dictionary<int, List<byte[]>> Runs { get; } = [];
}

/// <summary>
/// Plays an HLS VOD rendition the way hls.js does (buffer target, sequential fetches, seeks) while validating every fMP4
/// segment: keyframe at the start, timestamps on the playlist grid, audio/video alignment and continuity across restarts.
/// </summary>
public sealed class HlsPlayerSimulator(HttpClient http, HlsSimOptions options, Action<string>? log = null)
{
    public async Task<HlsSimReport> RunAsync(Uri masterUrl, CancellationToken ct)
    {
        var errors = new List<string>();
        var warnings = new List<string>();
        var fetches = new List<SegmentFetch>();
        var seekLatencies = new List<double>();
        var clock = Stopwatch.StartNew();

        var master = await GetStringAsync(masterUrl, ct);
        var (variantUri, codecs) = ParseMaster(master, errors);
        var mediaUrl = new Uri(masterUrl, variantUri);
        var media = ParseMedia(await GetStringAsync(mediaUrl, ct), errors);
        if (media.Segments.Count == 0)
            return Report(media, codecs, fetches, seekLatencies, 0, 0, null, null, clock, errors, warnings);
        var subtitles = new List<SubtitleRendition>();
        foreach (var (name, language, uri) in ParseSubtitleRenditions(master))
        {
            var url = new Uri(masterUrl, uri);
            var playlist = ParseMedia(await GetStringAsync(url, ct), errors, requireMap: false);
            subtitles.Add(new SubtitleRendition(name, language, url, playlist));
            if (playlist.Segments.Count != media.Segments.Count
                || playlist.Segments.Zip(media.Segments).Any(p => Math.Abs(p.First.Duration - p.Second.Duration) > 0.001))
            {
                errors.Add($"subtitle rendition '{name}' is not aligned with the video playlist");
            }
        }
        var audioRenditions = new List<AudioRendition>();
        foreach (var (name, _, uri) in ParseRenditions(master, "AUDIO"))
        {
            var url = new Uri(masterUrl, uri);
            var playlist = ParseMedia(await GetStringAsync(url, ct), errors);
            var audioInit = await GetBytesAsync(new Uri(url, playlist.InitUri), ct);
            var parsed = Fmp4.ParseInit(audioInit);
            if (parsed.Tracks.Count != 1 || parsed.Audio is null)
                errors.Add($"audio rendition '{name}': init must carry exactly one audio track");
            audioRenditions.Add(new AudioRendition(name, url, playlist, audioInit, parsed));
            if (playlist.Segments.Count != media.Segments.Count
                || playlist.Segments.Zip(media.Segments).Any(p => Math.Abs(p.First.Duration - p.Second.Duration) > 0.001))
            {
                errors.Add($"audio rendition '{name}' is not aligned with the video playlist");
            }
        }
        var audioSegments = 0;
        var subtitleSegments = 0;
        var subtitleCues = 0;
        var subtitleSamples = new List<string>();
        var subtitleCueList = new List<string>();

        var segmentLength = media.Segments[0].Duration;
        var starts = new double[media.Segments.Count];
        for (var i = 1; i < starts.Length; i++)
            starts[i] = starts[i - 1] + media.Segments[i - 1].Duration;
        var total = starts[^1] + media.Segments[^1].Duration;

        var initBytes = await GetBytesAsync(new Uri(mediaUrl, media.InitUri), ct);
        var init = Fmp4.ParseInit(initBytes);
        if (init.Video is null)
            errors.Add("init segment has no video track");
        if (init.Tracks.Count(t => t.Handler == "soun") > 1)
            warnings.Add("init segment carries more than one audio track");
        if (audioRenditions.Count > 0 && init.Audio is not null)
            errors.Add("the video playlist carries audio although the master declares audio renditions");

        var index = IndexAt(starts, options.StartPositionSeconds);
        var playhead = starts[index];
        var bufferedEnd = playhead;
        var playing = false;
        var stalled = false;
        var stalls = 0;
        var stallSeconds = 0d;
        var mediaPlayed = 0d;
        var run = 0;
        double? ttfs = null, ttff = null;
        double? seekStartedAt = null;
        var pendingSeeks = new Queue<SeekStep>(options.Seeks.OrderBy(s => s.AtSeconds));
        var runs = new List<List<byte[]>> { new() };
        SegmentFetch? previous = null;
        var lastTick = clock.Elapsed.TotalSeconds;

        while (true)
        {
            var now = clock.Elapsed.TotalSeconds;
            if (options.PlaybackRate > 0 && playing)
            {
                var advance = (now - lastTick) * options.PlaybackRate;
                var possible = Math.Max(0, bufferedEnd - playhead);
                if (advance > possible && index < media.Segments.Count)
                {
                    if (!stalled)
                    {
                        stalls++;
                        stalled = true;
                        log?.Invoke($"stall at {playhead:0.0}s");
                    }
                    stallSeconds += (advance - possible) / options.PlaybackRate;
                }
                var step = Math.Min(advance, possible);
                playhead += step;
                mediaPlayed += step;
            }
            lastTick = now;

            if (options.StopAfterMediaSeconds is { } stop && mediaPlayed >= stop)
                break;
            if (index >= media.Segments.Count && (options.PlaybackRate == 0 || playhead >= bufferedEnd - 0.001))
                break;

            if (pendingSeeks.TryPeek(out var seek) && (options.PlaybackRate == 0 ? fetches.Count > 0 && bufferedEnd >= seek.AtSeconds : playhead >= seek.AtSeconds))
            {
                pendingSeeks.Dequeue();
                index = IndexAt(starts, Math.Clamp(seek.ToSeconds, 0, total - 0.001));
                playhead = Math.Max(seek.ToSeconds, starts[index]);
                bufferedEnd = starts[index];
                playing = false;
                stalled = false;
                seekStartedAt = clock.Elapsed.TotalMilliseconds;
                previous = null;
                run++;
                runs.Add(new());
                log?.Invoke($"seek {seek.AtSeconds:0.0}s → {seek.ToSeconds:0.0}s (segment {index})");
                continue;
            }

            if (index < media.Segments.Count && (options.PlaybackRate == 0 || bufferedEnd - playhead < options.BufferTargetSeconds))
            {
                var (duration, uri) = media.Segments[index];
                if (options.ValidateSubtitles && options.SubtitlesFirst)
                    await FetchSubtitlesAsync(index, duration);
                var started = clock.Elapsed.TotalMilliseconds;
                byte[] data;
                try
                {
                    data = await GetBytesAsync(new Uri(mediaUrl, uri), ct);
                }
                catch (HttpRequestException e)
                {
                    errors.Add($"segment {index}: {e.Message}");
                    break;
                }
                var latency = clock.Elapsed.TotalMilliseconds - started;
                if (options.ValidateSubtitles && !options.SubtitlesFirst)
                    await FetchSubtitlesAsync(index, duration);
                var fetch = Inspect(index, starts[index], duration, data, init, latency, run, index == media.Segments.Count - 1, previous, errors, warnings);
                fetches.Add(fetch);
                runs[^1].Add(data);
                foreach (var rendition in audioRenditions.Where(r => index < r.Playlist.Segments.Count))
                {
                    var bytes = await GetBytesAsync(new Uri(rendition.PlaylistUrl, rendition.Playlist.Segments[index].Uri), ct);
                    audioSegments++;
                    var audio = Fmp4.ParseSegment(bytes, rendition.Init).Timings(rendition.Init).FirstOrDefault(t => t.Handler == "soun");
                    if (audio is null)
                        errors.Add($"audio '{rendition.Name}' segment {index}: no audio samples");
                    else if (fetch.VideoStart is { } videoStart && Math.Abs(audio.StartSeconds - videoStart) > options.MaxAudioVideoOffsetSeconds)
                        errors.Add($"audio '{rendition.Name}' segment {index}: starts {audio.StartSeconds - videoStart:+0.000;-0.000}s away from video");
                    if (!rendition.Runs.TryGetValue(run, out var list))
                        rendition.Runs[run] = list = [];
                    list.Add(bytes);
                }
                previous = fetch;
                ttfs ??= clock.Elapsed.TotalMilliseconds;
                if (!playing)
                {
                    playing = true;
                    stalled = false;
                    ttff ??= clock.Elapsed.TotalMilliseconds;
                    if (seekStartedAt is { } seekStart)
                    {
                        seekLatencies.Add(clock.Elapsed.TotalMilliseconds - seekStart);
                        seekStartedAt = null;
                    }
                }
                else if (stalled)
                {
                    stalled = false;
                }
                bufferedEnd += duration;
                if (options.PlaybackRate == 0)
                    mediaPlayed += duration;
                index++;
                lastTick = clock.Elapsed.TotalSeconds;
                continue;
            }

            await Task.Delay(25, ct);
        }

        if (options.Decode)
        {
            foreach (var (segments, number) in runs.Select((r, i) => (r, i)).Where(r => r.r.Count > 0))
            {
                var decodeErrors = await DecodeAsync(initBytes, segments, ct);
                if (decodeErrors.Length > 0)
                    errors.Add($"run {number} is not cleanly decodable: {decodeErrors}");
            }
            foreach (var rendition in audioRenditions)
            {
                foreach (var (number, segments) in rendition.Runs)
                {
                    var decodeErrors = await DecodeAsync(rendition.InitBytes, segments, ct);
                    if (decodeErrors.Length > 0)
                        errors.Add($"audio '{rendition.Name}' run {number} is not cleanly decodable: {decodeErrors}");
                }
            }
        }

        return Report(media, codecs, fetches, seekLatencies, stalls, stallSeconds, ttfs, ttff, clock, errors, warnings) with
        {
            SubtitleRenditions = subtitles.Count,
            AudioRenditions = audioRenditions.Count,
            AudioSegments = audioSegments,
            SubtitleSegments = subtitleSegments,
            SubtitleCues = subtitleCues,
            SubtitleSamples = subtitleSamples,
            SubtitleCueList = subtitleCueList,
        };

        async Task FetchSubtitlesAsync(int segment, double duration)
        {
            foreach (var rendition in subtitles.Where(r => segment < r.Playlist.Segments.Count))
            {
                var vtt = await GetStringAsync(new Uri(rendition.PlaylistUrl, rendition.Playlist.Segments[segment].Uri), ct);
                subtitleSegments++;
                foreach (var cue in InspectWebVtt(rendition.Name, segment, starts[segment], duration, vtt, errors))
                {
                    subtitleCues++;
                    subtitleCueList.Add($"{rendition.Name} #{segment}: {cue}");
                    if (subtitleSamples.Count < 12)
                        subtitleSamples.Add($"{rendition.Name} #{segment}: {cue}");
                }
            }
        }
    }

    /// <summary>Checks one WebVTT segment: header, X-TIMESTAMP-MAP, and every cue overlapping the segment's playlist window.</summary>
    internal static List<string> InspectWebVtt(string rendition, int index, double start, double duration, string vtt, List<string> errors)
    {
        var cues = new List<string>();
        var lines = vtt.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        if (lines.FirstOrDefault()?.StartsWith("WEBVTT", StringComparison.Ordinal) != true)
            errors.Add($"subtitle '{rendition}' segment {index}: missing WEBVTT header");
        if (!lines.Any(l => l.StartsWith("X-TIMESTAMP-MAP=", StringComparison.Ordinal)))
            errors.Add($"subtitle '{rendition}' segment {index}: missing X-TIMESTAMP-MAP");
        for (var i = 0; i < lines.Length; i++)
        {
            if (!lines[i].Contains("-->", StringComparison.Ordinal))
                continue;
            var parts = lines[i].Split("-->", StringSplitOptions.TrimEntries);
            var from = WebVttSubtitles.ParseTimestamp(parts[0]);
            var to = WebVttSubtitles.ParseTimestamp(parts[1].Split(' ')[0]);
            if (from is null || to is null || to <= from)
            {
                errors.Add($"subtitle '{rendition}' segment {index}: malformed cue timing '{lines[i]}'");
                continue;
            }
            if (to <= start - 0.001 || from >= start + duration + 0.001)
                errors.Add($"subtitle '{rendition}' segment {index}: cue {parts[0]} lies outside {start:0.000}-{start + duration:0.000}s");
            cues.Add($"{parts[0]} {(i + 1 < lines.Length ? lines[i + 1] : string.Empty)}");
        }
        return cues;
    }

    internal static IEnumerable<(string Name, string? Language, string Uri)> ParseSubtitleRenditions(string master) => ParseRenditions(master, "SUBTITLES");

    internal static IEnumerable<(string Name, string? Language, string Uri)> ParseRenditions(string master, string type)
    {
        foreach (var line in Lines(master).Where(l => l.StartsWith("#EXT-X-MEDIA:", StringComparison.Ordinal) && l.Contains($"TYPE={type},", StringComparison.Ordinal)))
        {
            string? Attribute(string name) => line.Split($"{name}=\"").ElementAtOrDefault(1)?.Split('"')[0];
            if (Attribute("URI") is { } uri)
                yield return (Attribute("NAME") ?? uri, Attribute("LANGUAGE"), uri);
        }
    }

    private SegmentFetch Inspect(
        int index, double expectedStart, double expectedDuration, byte[] data, Fmp4Init init, double latency, int run, bool last,
        SegmentFetch? previous, List<string> errors, List<string> warnings)
    {
        var timings = Fmp4.ParseSegment(data, init).Timings(init);
        var video = timings.FirstOrDefault(t => t.Handler == "vide");
        var audio = timings.FirstOrDefault(t => t.Handler == "soun");
        if (video is null)
        {
            errors.Add($"segment {index}: no video samples");
            return new SegmentFetch(index, expectedStart, expectedDuration, null, null, audio?.StartSeconds, false, data.Length, latency, run);
        }

        if (!video.StartsWithKeyframe)
            errors.Add($"segment {index}: does not start with a keyframe (not independently decodable)");
        var drift = video.StartSeconds - expectedStart;
        if (drift < -options.MaxStartDriftSeconds || drift > options.MaxLateDriftSeconds)
            errors.Add($"segment {index}: video starts at {video.StartSeconds:0.000}s but the playlist says {expectedStart:0.000}s");
        if (audio is not null && Math.Abs(audio.StartSeconds - video.StartSeconds) > options.MaxAudioVideoOffsetSeconds)
            errors.Add($"segment {index}: audio starts {audio.StartSeconds - video.StartSeconds:+0.000;-0.000}s away from video");
        if (!last && Math.Abs(video.DurationSeconds - expectedDuration) > 0.15)
            warnings.Add($"segment {index}: {video.DurationSeconds:0.000}s of video for a {expectedDuration:0.000}s playlist entry");
        if (previous is { VideoDecodeStart: { } prevStart, VideoDuration: { } prevDuration } && previous.Index == index - 1 && previous.Run == run)
        {
            // Decode time is continuous even where open-GOP leading pictures present before the segment's keyframe.
            var gap = video.DecodeStartSeconds - (prevStart + prevDuration);
            if (Math.Abs(gap) > options.MaxDiscontinuitySeconds)
                errors.Add($"segment {index}: {(gap > 0 ? "gap" : "overlap")} of {Math.Abs(gap) * 1000:0} ms after segment {index - 1}");
        }
        log?.Invoke(string.Create(CultureInfo.InvariantCulture,
            $"segment {index,4}: {data.Length / 1024,6} KiB in {latency,6:0} ms  video {video.StartSeconds,8:0.000}s +{video.DurationSeconds:0.000}s  key={video.StartsWithKeyframe}"));
        return new SegmentFetch(index, expectedStart, expectedDuration, video.StartSeconds, video.DurationSeconds, audio?.StartSeconds,
            video.StartsWithKeyframe, data.Length, latency, run, video.DecodeStartSeconds);
    }

    private async Task<string> DecodeAsync(byte[] init, List<byte[]> segments, CancellationToken ct)
    {
        var path = Path.Combine(Path.GetTempPath(), $"hlssim-{Guid.NewGuid():N}.mp4");
        try
        {
            await using (var file = File.Create(path))
            {
                await file.WriteAsync(init, ct);
                foreach (var segment in segments)
                    await file.WriteAsync(segment, ct);
            }
            var result = await new ProcessRunner().RunAsync(
                // The input time base avoids false "non monotonically increasing dts" from rescaling millisecond timestamps to 1/fps.
                options.FfmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-i", path, "-enc_time_base:v", "-1", "-f", "null", "-"], TimeSpan.FromMinutes(5), ct);
            return result.Succeeded ? result.StandardError.Trim() : $"exit {result.ExitCode}: {TranscodeRedaction.Tail(result.StandardError, 4)}";
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static int IndexAt(double[] starts, double position)
    {
        var index = Array.BinarySearch(starts, position);
        return Math.Clamp(index >= 0 ? index : ~index - 1, 0, starts.Length - 1);
    }

    internal static (string Uri, string Codecs) ParseMaster(string text, List<string> errors)
    {
        var lines = Lines(text);
        if (lines.FirstOrDefault() != "#EXTM3U")
            errors.Add("master playlist does not start with #EXTM3U");
        for (var i = 0; i < lines.Count - 1; i++)
        {
            if (!lines[i].StartsWith("#EXT-X-STREAM-INF:", StringComparison.Ordinal))
                continue;
            var codecs = lines[i].Split("CODECS=\"").ElementAtOrDefault(1)?.Split('"')[0] ?? string.Empty;
            return (lines[i + 1], codecs);
        }
        if (lines.Any(l => l.StartsWith("#EXTINF", StringComparison.Ordinal)))
            return (string.Empty, string.Empty);
        errors.Add("master playlist has no variant");
        return (string.Empty, string.Empty);
    }

    internal static MediaPlaylist ParseMedia(string text, List<string> errors, bool requireMap = true)
    {
        var lines = Lines(text);
        var segments = new List<(double, string)>();
        var init = string.Empty;
        var target = 0;
        double? pending = null;
        foreach (var line in lines)
        {
            if (line.StartsWith("#EXT-X-MAP:URI=\"", StringComparison.Ordinal))
                init = line["#EXT-X-MAP:URI=\"".Length..].TrimEnd('"');
            else if (line.StartsWith("#EXT-X-TARGETDURATION:", StringComparison.Ordinal))
                target = int.Parse(line["#EXT-X-TARGETDURATION:".Length..], CultureInfo.InvariantCulture);
            else if (line.StartsWith("#EXTINF:", StringComparison.Ordinal))
                pending = double.Parse(line["#EXTINF:".Length..].TrimEnd(',').Split(',')[0], CultureInfo.InvariantCulture);
            else if (!line.StartsWith('#') && pending is { } duration)
            {
                segments.Add((duration, line));
                pending = null;
            }
        }
        if (!lines.Contains("#EXT-X-ENDLIST"))
            errors.Add("media playlist is not a complete VOD playlist (#EXT-X-ENDLIST missing)");
        if (init.Length == 0 && requireMap)
            errors.Add("media playlist has no #EXT-X-MAP init segment");
        if (segments.Any(s => Math.Round(s.Item1) > target))
            errors.Add("a segment is longer than #EXT-X-TARGETDURATION");
        return new MediaPlaylist(init, segments, target);
    }

    private static List<string> Lines(string text)
        => text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    private async Task<string> GetStringAsync(Uri uri, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(options.RequestTimeout);
        using var response = await http.GetAsync(uri, timeout.Token);
        await EnsureSuccessAsync(response, uri);
        return await response.Content.ReadAsStringAsync(timeout.Token);
    }

    private async Task<byte[]> GetBytesAsync(Uri uri, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(options.RequestTimeout);
        using var response = await http.GetAsync(uri, timeout.Token);
        await EnsureSuccessAsync(response, uri);
        return await response.Content.ReadAsByteArrayAsync(timeout.Token);
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, Uri uri)
    {
        if (response.IsSuccessStatusCode)
            return;
        var body = await response.Content.ReadAsStringAsync();
        throw new HttpRequestException(
            $"{(int)response.StatusCode} for {TranscodeRedaction.Redact(uri.AbsolutePath)}: {(body.Length > 300 ? body[..300] : body)}");
    }

    private static HlsSimReport Report(
        MediaPlaylist media, string codecs, List<SegmentFetch> fetches, List<double> seeks, int stalls, double stallSeconds,
        double? ttfs, double? ttff, Stopwatch clock, List<string> errors, List<string> warnings) => new()
    {
        PlaylistSegments = media.Segments.Count,
        SegmentLength = media.Segments.Count > 0 ? media.Segments[0].Duration : 0,
        PlaylistDuration = media.Segments.Sum(s => s.Duration),
        Codecs = codecs,
        TimeToFirstSegmentMs = ttfs,
        TimeToFirstFrameMs = ttff,
        Fetches = fetches,
        SeekLatenciesMs = seeks,
        Stalls = stalls,
        StallSeconds = stallSeconds,
        WallSeconds = clock.Elapsed.TotalSeconds,
        TotalBytes = fetches.Sum(f => f.Bytes),
        Errors = errors,
        Warnings = warnings,
    };
}
