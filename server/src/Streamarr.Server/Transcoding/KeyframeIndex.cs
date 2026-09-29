using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Transcoding;

public enum KeyframeIndexSource
{
    MatroskaCues,
    Mp4SampleTable,
    FfprobeScan,
}

public static class KeyframeIndexSourceNames
{
    public static string ToApi(this KeyframeIndexSource source) => source switch
    {
        KeyframeIndexSource.MatroskaCues => "matroska-cues",
        KeyframeIndexSource.Mp4SampleTable => "mp4-sample-table",
        _ => "ffprobe-scan",
    };
}

/// <summary>Keyframe presentation times of the first video track on the source timeline, plus byte positions where the container has them.</summary>
public sealed record ContainerIndex(
    KeyframeIndexSource Source,
    IReadOnlyList<double> Keyframes,
    IReadOnlyList<long>? ByteOffsets,
    bool OffsetsCoverAllStreams,
    VideoCodecConfig? Config,
    long? TotalBytes = null);

public sealed record KeyframeIndex(ContainerIndex Container, VideoCodecConfig? Config, double BuildMs)
{
    public KeyframeIndexSource Source => Container.Source;
    public IReadOnlyList<double> Keyframes => Container.Keyframes;
}

public sealed record KeyframeIndexResult(KeyframeIndex? Index, string? Error);

/// <summary>Random access to the source bytes: the loopback stream capability over HTTP ranges, or a local sample file.</summary>
public interface IRangeSource : IAsyncDisposable
{
    long Length { get; }
    Task<byte[]> ReadAsync(long offset, int count, CancellationToken ct);
}

public sealed class FileRangeSource(string path) : IRangeSource
{
    private readonly Microsoft.Win32.SafeHandles.SafeFileHandle _handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);

    public long Length => RandomAccess.GetLength(_handle);

    public async Task<byte[]> ReadAsync(long offset, int count, CancellationToken ct)
    {
        var buffer = new byte[Math.Max(0, (int)Math.Min(count, Length - offset))];
        var read = 0;
        while (read < buffer.Length)
        {
            var n = await RandomAccess.ReadAsync(_handle, buffer.AsMemory(read), offset + read, ct);
            if (n == 0)
                throw new EndOfStreamException("The source ended early.");
            read += n;
        }
        return buffer;
    }

    public ValueTask DisposeAsync()
    {
        _handle.Dispose();
        return ValueTask.CompletedTask;
    }
}

public sealed class HttpRangeSource : IRangeSource
{
    private readonly HttpClient _http;
    private readonly Uri _uri;

    private HttpRangeSource(HttpClient http, Uri uri, long length)
    {
        _http = http;
        _uri = uri;
        Length = length;
    }

    public long Length { get; }

    public static async Task<HttpRangeSource> OpenAsync(HttpClient http, Uri uri, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, uri);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        var length = response.Content.Headers.ContentLength
                     ?? throw new InvalidDataException("The stream did not report its length.");
        return new HttpRangeSource(http, uri, length);
    }

    public async Task<byte[]> ReadAsync(long offset, int count, CancellationToken ct)
    {
        count = (int)Math.Min(count, Length - offset);
        if (count <= 0)
            return [];
        using var request = new HttpRequestMessage(HttpMethod.Get, _uri);
        request.Headers.Range = new RangeHeaderValue(offset, offset + count - 1);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode != HttpStatusCode.PartialContent)
            throw new InvalidDataException($"The stream answered a range request with {(int)response.StatusCode}.");
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (bytes.Length != count)
            throw new InvalidDataException($"The stream returned {bytes.Length} of {count} requested bytes.");
        return bytes;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>Builds and caches a remux keyframe index: Matroska Cues or the MP4 sample table via range reads, else a time-boxed ffprobe packet scan.</summary>
public sealed class KeyframeIndexService(
    IHttpClientFactory httpFactory,
    IProcessRunner runner,
    IOptions<TranscodingOptions> options,
    ILogger<KeyframeIndexService> logger)
{
    public const string HttpClientName = "streamarr-transcode-index";

    /// <summary>A keyframe gap beyond this makes segments too long for HLS; the index is then rejected.</summary>
    public const double MaxKeyframeGapSeconds = 24;

    /// <summary>Bounds the memory an untrusted index can claim (a 4 h all-intra 60 fps source has 864 000 keyframes).</summary>
    public const int MaxKeyframes = 1_000_000;

    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(10);
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, Lazy<Task<KeyframeIndexResult>> Build)> _cache = new(StringComparer.Ordinal);

    public Task<KeyframeIndexResult> GetAsync(TranscodeSource source, SourceMediaInfo media, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var (key, entry) in _cache)
        {
            if (now - entry.At > CacheTtl)
                _cache.TryRemove(key, out _);
        }
        var cached = _cache.GetOrAdd(source.Input, _ => (now, new Lazy<Task<KeyframeIndexResult>>(() => BuildSafelyAsync(source, media))));
        return cached.Build.Value.WaitAsync(ct);
    }

    /// <summary>Never faults, so the cache cannot keep a failed build: unexpected errors become an uncached "no index" result.</summary>
    private async Task<KeyframeIndexResult> BuildSafelyAsync(TranscodeSource source, SourceMediaInfo media)
    {
        try
        {
            return await BuildAsync(source, media);
        }
        catch (Exception e)
        {
            _cache.TryRemove(source.Input, out _);
            logger.LogWarning(e, "Keyframe index build failed for {Source}", TranscodeRedaction.Redact(source.Input));
            return new KeyframeIndexResult(null, $"index build failed: {e.GetType().Name}");
        }
    }

    internal async Task<KeyframeIndexResult> BuildAsync(TranscodeSource source, SourceMediaInfo media)
    {
        var clock = Stopwatch.StartNew();
        using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(Math.Max(5, options.Value.KeyframeIndexTimeoutSeconds)));
        var ct = budget.Token;
        ContainerIndex? index = null;
        string? rejected = null;
        try
        {
            var family = TranscodePlanner.ContainerFamily(media.Container);
            if (family is "mkv" or "mp4")
            {
                await using var range = await OpenAsync(source, ct);
                index = family == "mkv" ? await MatroskaIndexReader.ReadAsync(range, ct) : await Mp4IndexReader.ReadAsync(range, ct);
                rejected = index is null ? $"no usable {(family == "mkv" ? "Matroska Cues" : "MP4 sample table")}" : Reject(index, media);
                if (rejected is not null)
                    index = null;
            }
        }
        catch (Exception e)
        {
            rejected = $"container index failed: {e.Message}";
            logger.LogDebug(e, "Container keyframe index failed for {Source}", TranscodeRedaction.Redact(source.Input));
        }

        if (index is null)
        {
            var remaining = TimeSpan.FromSeconds(options.Value.KeyframeScanTimeoutSeconds);
            index = await ScanAsync(source, remaining);
            if (index is not null && Reject(index, media) is { } scanRejected)
            {
                rejected = scanRejected;
                index = null;
            }
            else if (index is null)
            {
                rejected = (rejected is null ? string.Empty : rejected + "; ") + "the ffprobe packet scan did not finish within its time budget";
            }
        }
        if (index is null)
        {
            logger.LogInformation("No keyframe index for {Source}: {Reason}", TranscodeRedaction.Redact(source.Input), rejected);
            _cache.TryRemove(source.Input, out _);
            return new KeyframeIndexResult(null, rejected);
        }

        var config = index.Config ?? await ExtradataAsync(source, media);
        logger.LogInformation(
            "Keyframe index for {Source}: {Count} keyframes from {Kind} in {Ms:0} ms",
            TranscodeRedaction.Redact(source.Input), index.Keyframes.Count, index.Source.ToApi(), clock.Elapsed.TotalMilliseconds);
        return new KeyframeIndexResult(new KeyframeIndex(index, config, clock.Elapsed.TotalMilliseconds), null);
    }

    internal static string? Reject(ContainerIndex index, SourceMediaInfo media)
    {
        if (index.Keyframes.Count == 0)
            return "the index lists no keyframes";
        if (index.Keyframes.Count > MaxKeyframes)
            return $"the index lists more than {MaxKeyframes} keyframes";
        var end = media.StartTime + media.DurationSeconds;
        var previous = media.StartTime;
        foreach (var keyframe in index.Keyframes.Append(end))
        {
            if (keyframe - previous > MaxKeyframeGapSeconds)
                return $"keyframes are {keyframe - previous:0.#} s apart (at most {MaxKeyframeGapSeconds:0} s allowed)";
            previous = Math.Max(previous, keyframe);
        }
        return null;
    }

    private async Task<IRangeSource> OpenAsync(TranscodeSource source, CancellationToken ct)
        => source.IsNetwork
            ? await HttpRangeSource.OpenAsync(httpFactory.CreateClient(HttpClientName), new Uri(source.Input), ct)
            : new FileRangeSource(source.Input);

    private async Task<ContainerIndex?> ScanAsync(TranscodeSource source, TimeSpan budget)
    {
        var args = new List<string> { "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,pos,flags", "-of", "compact=p=0" };
        if (source.IsNetwork)
            args.AddRange(["-user_agent", FfmpegArgumentBuilder.UserAgent]);
        args.Add(source.Input);
        var psi = new ProcessStartInfo(options.Value.FfprobePath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        FfmpegEnvironment.Apply(psi);
        foreach (var argument in args)
            psi.ArgumentList.Add(argument);

        var keyframes = new List<(double Time, long Position)>();
        using var process = new Process { StartInfo = psi };
        try
        {
            process.Start();
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            logger.LogWarning(e, "ffprobe could not be started for a keyframe scan");
            return null;
        }
        _ = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(budget);
        try
        {
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync(timeout.Token)) is not null)
            {
                if (ParsePacket(line) is { } packet)
                    keyframes.Add(packet);
                if (keyframes.Count > MaxKeyframes)
                {
                    ProcessRunner.Kill(process);
                    return null;
                }
            }
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            ProcessRunner.Kill(process);
            return null;
        }
        if (process.ExitCode != 0 || keyframes.Count == 0)
            return null;
        keyframes.Sort((a, b) => a.Time.CompareTo(b.Time));
        var positions = keyframes.Select(k => k.Position).ToList();
        var monotonic = positions.Zip(positions.Skip(1)).All(p => p.Second >= p.First) && positions.All(p => p >= 0);
        return new ContainerIndex(KeyframeIndexSource.FfprobeScan, keyframes.Select(k => k.Time).ToList(), monotonic ? positions : null, true, null);
    }

    internal static (double Time, long Position)? ParsePacket(string line)
    {
        double? time = null;
        long position = -1;
        var key = false;
        foreach (var field in line.Split('|'))
        {
            var separator = field.IndexOf('=');
            if (separator <= 0)
                continue;
            var value = field[(separator + 1)..];
            switch (field[..separator])
            {
                case "pts_time" when double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var t):
                    time = t;
                    break;
                case "pos" when long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p):
                    position = p;
                    break;
                case "flags":
                    key = value.StartsWith('K');
                    break;
            }
        }
        return key && time is { } seconds && double.IsFinite(seconds) ? (seconds, position) : null;
    }

    private async Task<VideoCodecConfig?> ExtradataAsync(TranscodeSource source, SourceMediaInfo media)
    {
        var args = new List<string> { "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=extradata", "-show_data", "-of", "json" };
        if (source.IsNetwork)
            args.AddRange(["-user_agent", FfmpegArgumentBuilder.UserAgent]);
        args.Add(source.Input);
        var result = await runner.RunAsync(options.Value.FfprobePath, args, TimeSpan.FromSeconds(options.Value.ProbeTimeoutSeconds), CancellationToken.None);
        if (!result.Succeeded)
            return null;
        try
        {
            using var document = JsonDocument.Parse(result.StandardOutput);
            var stream = document.RootElement.GetProperty("streams").EnumerateArray().FirstOrDefault();
            if (stream.ValueKind != JsonValueKind.Object || !stream.TryGetProperty("extradata", out var dump) || dump.GetString() is not { } text)
                return null;
            return ClassifyExtradata(media.Video?.Codec, ParseHexDump(text));
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    internal static VideoCodecConfig? ClassifyExtradata(string? codec, byte[] data)
    {
        if (data.Length < 4)
            return null;
        if (data[0] == 0 && data[1] == 0 && (data[2] == 1 || (data[2] == 0 && data[3] == 1)))
            return new VideoCodecConfig(VideoCodecConfig.AnnexB, data);
        return codec switch
        {
            "h264" when data[0] == 1 => new VideoCodecConfig(VideoCodecConfig.AvcC, data),
            "hevc" when data[0] == 1 => new VideoCodecConfig(VideoCodecConfig.HvcC, data),
            "av1" when (data[0] & 0x80) != 0 => new VideoCodecConfig(VideoCodecConfig.Av1C, data),
            _ => null,
        };
    }

    /// <summary>Parses ffprobe's <c>-show_data</c> hex dump ("00000000: 0102 0304 ...  ascii").</summary>
    internal static byte[] ParseHexDump(string dump)
    {
        var bytes = new List<byte>();
        foreach (var raw in dump.Split('\n'))
        {
            var colon = raw.IndexOf(": ", StringComparison.Ordinal);
            if (colon < 0)
                continue;
            var hex = raw[(colon + 2)..];
            hex = hex[..Math.Min(hex.Length, 40)].Replace(" ", string.Empty, StringComparison.Ordinal);
            for (var i = 0; i + 1 < hex.Length; i += 2)
            {
                if (!byte.TryParse(hex.AsSpan(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var b))
                    break;
                bytes.Add(b);
            }
        }
        return bytes.ToArray();
    }
}
