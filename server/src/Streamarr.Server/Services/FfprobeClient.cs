using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

public sealed record FfprobeResult
{
    public long? RunTimeTicks { get; init; }
    public required IReadOnlyList<MediaStreamInfo> MediaStreams { get; init; }
}

/// <summary>
/// Runs ffprobe against a narrowly scoped stream-capability URL so front-ends never have
/// to probe a slow remote source themselves (BRIEF §6.2). Probing failures are
/// soft: /resolve still answers, just without pre-probed media info.
/// </summary>
public class FfprobeClient(IOptions<StreamarrOptions> options, ILogger<FfprobeClient> logger)
{
    internal const int MaxStandardOutputBytes = 4 * 1024 * 1024;
    internal const int MaxStandardErrorBytes = 64 * 1024;
    internal const int MaxMediaStreams = 64;
    private readonly SemaphoreSlim _processGate = new(Math.Max(1, options.Value.MaxConcurrentFfprobe));

    public async Task<FfprobeResult?> ProbeAsync(string url, CancellationToken ct)
    {
        await _processGate.WaitAsync(ct);
        var o = options.Value;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(o.FfprobeTimeoutSeconds));

            var fast = await ProbeCoreAsync(
                url,
                o.FfprobeProbeSizeBytes,
                o.FfprobeAnalyzeDurationMs,
                timeout.Token);
            if (IsCompleteFastResult(fast))
                return fast;

            logger.LogInformation("ffprobe fast-path budget was insufficient; retrying with the escalated budget");
            return await ProbeCoreAsync(
                url,
                o.FfprobeEscalatedProbeSizeBytes,
                o.FfprobeEscalatedAnalyzeDurationMs,
                timeout.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning("ffprobe timed out probing a stream capability");
            return null;
        }
        finally
        {
            _processGate.Release();
        }
    }

    internal static bool IsCompleteFastResult(FfprobeResult? result)
        => result is { RunTimeTicks: not null, MediaStreams.Count: > 0 };

    protected virtual async Task<FfprobeResult?> ProbeCoreAsync(
        string url,
        int probeSizeBytes,
        int analyzeDurationMs,
        CancellationToken ct)
    {
        var o = options.Value;
        var psi = CreateStartInfo(o.FfprobePath, url, probeSizeBytes, analyzeDurationMs);

        try
        {
            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("Could not start ffprobe.");

            void KillProcess()
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // The process may have exited between the limit check and Kill.
                }
            }

            var stdoutTask = ReadBoundedTextAsync(
                process.StandardOutput.BaseStream,
                MaxStandardOutputBytes,
                ct,
                KillProcess);
            var stderrTask = ReadBoundedTextAsync(
                process.StandardError.BaseStream,
                MaxStandardErrorBytes,
                ct,
                KillProcess);
            try
            {
                await process.WaitForExitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                KillProcess();
                throw;
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            if (process.ExitCode != 0)
            {
                // ffprobe commonly echoes its input URL to stderr. That URL contains a
                // live stream capability, so only retain the exit code in persistent logs.
                logger.LogWarning("ffprobe exited with {ExitCode}", process.ExitCode);
                return null;
            }

            return Parse(stdout);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning(e, "ffprobe failed while probing a stream capability");
            return null;
        }
    }

    internal static ProcessStartInfo CreateStartInfo(
        string path,
        string url,
        int probeSizeBytes,
        int analyzeDurationMs)
    {
        var psi = new ProcessStartInfo(path)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("-v");
        psi.ArgumentList.Add("error");
        psi.ArgumentList.Add("-probesize");
        psi.ArgumentList.Add(probeSizeBytes.ToString(CultureInfo.InvariantCulture));
        psi.ArgumentList.Add("-analyzeduration");
        psi.ArgumentList.Add(checked((long)analyzeDurationMs * 1000).ToString(CultureInfo.InvariantCulture));
        psi.ArgumentList.Add("-print_format");
        psi.ArgumentList.Add("json");
        psi.ArgumentList.Add("-show_entries");
        psi.ArgumentList.Add("format=duration:stream=codec_type,codec_name,width,height,channels:stream_tags=language");
        psi.ArgumentList.Add(url);
        return psi;
    }

    internal static async Task<string> ReadBoundedTextAsync(
        Stream source,
        int maxBytes,
        CancellationToken ct,
        Action? onLimitExceeded = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxBytes);
        using var result = new MemoryStream(Math.Min(maxBytes, 64 * 1024));
        var buffer = new byte[Math.Min(maxBytes + 1, 64 * 1024)];

        while (true)
        {
            var remaining = maxBytes - checked((int)result.Length);
            var read = await source.ReadAsync(
                buffer.AsMemory(0, Math.Min(buffer.Length, remaining + 1)),
                ct);
            if (read == 0)
                break;
            if (read > remaining)
            {
                onLimitExceeded?.Invoke();
                throw new InvalidDataException($"ffprobe output exceeded the {maxBytes} byte limit.");
            }

            await result.WriteAsync(buffer.AsMemory(0, read), ct);
        }

        return Encoding.UTF8.GetString(result.GetBuffer(), 0, checked((int)result.Length));
    }

    internal static FfprobeResult Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        long? runTimeTicks = null;
        if (root.TryGetProperty("format", out var format) &&
            format.TryGetProperty("duration", out var duration) &&
            double.TryParse(duration.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) &&
            double.IsFinite(seconds) && seconds >= 0 &&
            seconds <= long.MaxValue / (double)TimeSpan.TicksPerSecond)
        {
            runTimeTicks = (long)(seconds * TimeSpan.TicksPerSecond);
        }

        var mediaStreams = new List<MediaStreamInfo>();
        if (root.TryGetProperty("streams", out var streams))
        {
            foreach (var stream in streams.EnumerateArray().Take(MaxMediaStreams))
            {
                var type = GetString(stream, "codec_type") switch
                {
                    "video" => "Video",
                    "audio" => "Audio",
                    "subtitle" => "Subtitle",
                    _ => null,
                };
                if (type == null)
                    continue;

                mediaStreams.Add(new MediaStreamInfo
                {
                    Type = type,
                    Codec = GetBoundedString(stream, "codec_name", 64),
                    Width = GetBoundedInt(stream, "width", 1, 32_768),
                    Height = GetBoundedInt(stream, "height", 1, 32_768),
                    Channels = GetBoundedInt(stream, "channels", 1, 128),
                    Language = stream.TryGetProperty("tags", out var tags)
                        ? GetBoundedString(tags, "language", 32)
                        : null,
                });
            }
        }

        return new FfprobeResult { RunTimeTicks = runTimeTicks, MediaStreams = mediaStreams };
    }

    private static string? GetString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string? GetBoundedString(JsonElement element, string name, int maxChars)
    {
        var value = GetString(element, name);
        return value is { Length: > 0 } && value.Length <= maxChars && !value.Any(char.IsControl)
            ? value
            : null;
    }

    private static int? GetBoundedInt(JsonElement element, string name, int minimum, int maximum)
        => element.TryGetProperty(name, out var value) &&
           value.ValueKind == JsonValueKind.Number &&
           value.TryGetInt32(out var parsed) &&
           parsed >= minimum && parsed <= maximum
            ? parsed
            : null;
}
