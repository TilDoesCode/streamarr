using System.Diagnostics;
using System.Globalization;
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
/// Runs ffprobe against the (authenticated) stream URL so front-ends never have
/// to probe a slow remote source themselves (BRIEF §6.2). Probing failures are
/// soft: /resolve still answers, just without pre-probed media info.
/// </summary>
public class FfprobeClient(IOptions<StreamarrOptions> options, ILogger<FfprobeClient> logger)
{
    public async Task<FfprobeResult?> ProbeAsync(string url, string? bearerApiKey, CancellationToken ct)
    {
        var o = options.Value;
        var psi = new ProcessStartInfo(o.FfprobePath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("-v");
        psi.ArgumentList.Add("error");
        psi.ArgumentList.Add("-print_format");
        psi.ArgumentList.Add("json");
        psi.ArgumentList.Add("-show_format");
        psi.ArgumentList.Add("-show_streams");
        if (!string.IsNullOrEmpty(bearerApiKey))
        {
            psi.ArgumentList.Add("-headers");
            psi.ArgumentList.Add($"Authorization: Bearer {bearerApiKey}\r\n");
        }

        psi.ArgumentList.Add(url);

        try
        {
            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("Could not start ffprobe.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(o.FfprobeTimeoutSeconds));

            var stdoutTask = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(timeout.Token);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // already exited
                }

                throw;
            }

            var stdout = await stdoutTask;
            if (process.ExitCode != 0)
            {
                var stderr = await stderrTask;
                logger.LogWarning("ffprobe exited with {ExitCode}: {Stderr}", process.ExitCode, stderr.Trim());
                return null;
            }

            return Parse(stdout);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning("ffprobe timed out probing {Url}", url);
            return null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning(e, "ffprobe failed for {Url}", url);
            return null;
        }
    }

    internal static FfprobeResult Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        long? runTimeTicks = null;
        if (root.TryGetProperty("format", out var format) &&
            format.TryGetProperty("duration", out var duration) &&
            double.TryParse(duration.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds))
        {
            runTimeTicks = (long)(seconds * TimeSpan.TicksPerSecond);
        }

        var mediaStreams = new List<MediaStreamInfo>();
        if (root.TryGetProperty("streams", out var streams))
        {
            foreach (var stream in streams.EnumerateArray())
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
                    Codec = GetString(stream, "codec_name"),
                    Width = GetInt(stream, "width"),
                    Height = GetInt(stream, "height"),
                    Channels = GetInt(stream, "channels"),
                    Language = stream.TryGetProperty("tags", out var tags) ? GetString(tags, "language") : null,
                });
            }
        }

        return new FfprobeResult { RunTimeTicks = runTimeTicks, MediaStreams = mediaStreams };
    }

    private static string? GetString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? GetInt(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32()
            : null;
}
