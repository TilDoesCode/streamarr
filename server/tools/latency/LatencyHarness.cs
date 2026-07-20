using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Core.Media;
using Streamarr.Server;
using Streamarr.Tests.Shared;

namespace Streamarr.Tools.Latency;

/// <summary>
/// Boots the real Core Server on a real Kestrel port and measures the two M1
/// acceptance latencies (BRIEF §10):
///   • cold-start — resolve request → first stream byte (fresh session each sample)
///   • seek       — a new Range request at the configured offset → first byte
/// against a configurable NNTP target: the in-repo mock server by default, or a
/// real provider from appsettings.Local.json when the owner supplies credentials
/// (see docs/DECISIONS.md Open items).
/// </summary>
public sealed class LatencyHarness : IAsyncDisposable
{
    private readonly HarnessOptions _options;
    private readonly IConfigurationRoot _config;

    private WebApplication? _app;
    private MockNntpServer? _mock;
    private string? _tempDir;
    private string _apiKey = "";
    private string _baseUrl = "";
    private string _releaseId = "";
    private string _targetDescription = "";

    public LatencyHarness(HarnessOptions options, IConfigurationRoot config)
    {
        _options = options;
        _config = config;
    }

    public async Task<int> RunAsync()
    {
        await BootAsync();

        Console.WriteLine($"Target        : {_targetDescription}");
        Console.WriteLine($"Server        : {_baseUrl}");
        Console.WriteLine($"Release       : {_releaseId}");
        Console.WriteLine($"Iterations    : {_options.Iterations}  (seek warm-up: {_options.SeekWarmup})");
        Console.WriteLine();

        var cold = await MeasureColdStartAsync();
        var seek = await MeasureSeekAsync();

        Console.WriteLine();
        Console.WriteLine("Results (time to first byte):");
        Console.WriteLine(cold.ToConsoleRow());
        Console.WriteLine(seek.ToConsoleRow());

        if (_options.Markdown)
        {
            Console.WriteLine();
            Console.WriteLine(LatencyStats.MarkdownHeader);
            Console.WriteLine(cold.ToMarkdownRow());
            Console.WriteLine(seek.ToMarkdownRow());
        }

        return 0;
    }

    // ----------------------------------------------------------------- smoke

    /// <summary>
    /// End-to-end proof (BRIEF §10 M1 acceptance): resolve a release, then verify a
    /// real player toolchain can read the stream URL — ffprobe reads the container,
    /// and mpv/ffplay does a play + seek. Any player is optional (SKIP if absent).
    /// </summary>
    public async Task<int> RunSmokeAsync()
    {
        await BootAsync();

        using var client = NewClient();
        var canDecodeFirstFrame = await ToolExistsAsync("ffmpeg");
        var ttff = Stopwatch.StartNew();
        var resolved = await ResolveAsync(client);
        var streamUrl = new Uri(new Uri(_baseUrl), resolved.StreamUrl!).AbsoluteUri;
        var firstFrameOk = !canDecodeFirstFrame || await DecodeFirstFrameAsync(streamUrl);
        ttff.Stop();

        Console.WriteLine($"Target        : {_targetDescription}");
        Console.WriteLine($"Server        : {_baseUrl}");
        Console.WriteLine($"Resolved      : {resolved.Status}, {resolved.SizeBytes} bytes");
        Console.WriteLine($"Stream URL    : {streamUrl}");
        Console.WriteLine(canDecodeFirstFrame
            ? $"First frame   : {(firstFrameOk ? "PASS" : "FAIL")} in {ttff.Elapsed.TotalMilliseconds:0.0} ms (resolve → decoded frame)"
            : "First frame   : SKIP (ffmpeg not installed)");
        Console.WriteLine();

        var ffprobeOk = await SmokeFfprobeAsync(streamUrl);
        var playOk = await SmokePlaySeekAsync(streamUrl, resolved);

        Console.WriteLine();
        Console.WriteLine("Smoke summary:");
        Console.WriteLine($"  ffprobe     : {(ffprobeOk ? "PASS" : "FAIL")}");
        Console.WriteLine($"  play + seek : {playOk}");

        return firstFrameOk && ffprobeOk && playOk.StartsWith("PASS", StringComparison.Ordinal) ? 0 : 1;
    }

    private async Task<bool> DecodeFirstFrameAsync(string streamUrl)
    {
        var result = await RunProcessAsync(
            "ffmpeg",
            [
                "-v", "error",
                "-headers", $"Authorization: Bearer {_apiKey}\r\n",
                "-i", streamUrl,
                "-map", "0:v:0",
                "-frames:v", "1",
                "-an",
                "-f", "null", "-",
            ],
            TimeSpan.FromSeconds(60));
        if (result.ExitCode == 0)
            return true;

        Console.WriteLine($"first frame   : FAIL (ffmpeg exit {result.ExitCode})");
        Console.WriteLine(Indent(result.StdErr));
        return false;
    }

    private async Task<bool> SmokeFfprobeAsync(string streamUrl)
    {
        var args = new List<string>
        {
            "-v", "error",
            "-headers", $"Authorization: Bearer {_apiKey}\r\n",
            "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
            "-of", "default=noprint_wrappers=1",
            streamUrl,
        };

        var result = await RunProcessAsync("ffprobe", args, TimeSpan.FromSeconds(60));
        if (!result.Found)
        {
            Console.WriteLine("ffprobe       : SKIP (ffprobe not installed)");
            return true; // optional tool: not a failure
        }

        if (result.ExitCode != 0)
        {
            Console.WriteLine($"ffprobe       : FAIL (exit {result.ExitCode})");
            Console.WriteLine(Indent(result.StdErr));
            return false;
        }

        Console.WriteLine("ffprobe       : read the stream —");
        Console.WriteLine(Indent(result.StdOut.Trim()));
        return true;
    }

    private async Task<string> SmokePlaySeekAsync(string streamUrl, ResolveResult resolved)
    {
        var durationSeconds = (resolved.RunTimeTicks ?? 0) / (double)TimeSpan.TicksPerSecond;
        var seekSeconds = durationSeconds > 0 ? durationSeconds * _options.SeekOffsetFraction : 0;

        // mpv is a real, scriptable player and is preferred when present. ffplay is a
        // GUI player whose realtime, headless seek hangs, so it is NOT used for the
        // automated seek clip; ffmpeg — the decode engine mpv/ffplay both wrap — gives
        // a frame-accurate, always-exits play + seek decode proof instead.
        if (await ToolExistsAsync("mpv"))
            return await RunPlayerAsync("mpv", streamUrl, seekSeconds, MpvArgs);
        if (await ToolExistsAsync("ffmpeg"))
            return await RunPlayerAsync("ffmpeg", streamUrl, seekSeconds, FfmpegDecodeArgs);

        Console.WriteLine("play + seek   : SKIP (no mpv/ffmpeg installed)");
        return "SKIP (no player installed)";
    }

    private async Task<string> RunPlayerAsync(
        string player, string streamUrl, double seekSeconds,
        Func<string, double, IReadOnlyList<string>> buildArgs)
    {
        // 1) play from the start
        var play = await RunProcessAsync(player, buildArgs(streamUrl, 0), TimeSpan.FromSeconds(30));
        var playOk = play.ExitCode == 0;
        Console.WriteLine($"play          : {player} from 0s → {(playOk ? "PASS" : $"FAIL (exit {play.ExitCode})")}");
        if (!playOk)
            Console.WriteLine(Indent(play.StdErr));

        // 2) seek to the configured offset and decode there
        var seek = await RunProcessAsync(player, buildArgs(streamUrl, seekSeconds), TimeSpan.FromSeconds(30));
        var seekOk = seek.ExitCode == 0;
        var seekLabel = seekSeconds.ToString("0.0", CultureInfo.InvariantCulture);
        var pct = (int)(_options.SeekOffsetFraction * 100);
        Console.WriteLine(
            $"seek          : {player} @ {seekLabel}s ({pct}%) → " +
            $"{(seekOk ? "PASS" : $"FAIL (exit {seek.ExitCode})")}");
        if (!seekOk)
            Console.WriteLine(Indent(seek.StdErr));

        return playOk && seekOk ? $"PASS ({player})" : $"FAIL ({player})";
    }

    private IReadOnlyList<string> MpvArgs(string streamUrl, double startSeconds) =>
    [
        "--no-config", "--no-video", "--length=2", "--really-quiet",
        $"--http-header-fields=Authorization: Bearer {_apiKey}",
        $"--start={startSeconds.ToString("0.###", CultureInfo.InvariantCulture)}",
        streamUrl,
    ];

    // -ss before -i = frame-accurate input seek; -t 2 decodes 2s from there to null.
    private IReadOnlyList<string> FfmpegDecodeArgs(string streamUrl, double startSeconds) =>
    [
        "-v", "error",
        "-headers", $"Authorization: Bearer {_apiKey}\r\n",
        "-ss", startSeconds.ToString("0.###", CultureInfo.InvariantCulture),
        "-i", streamUrl,
        "-t", "2",
        "-f", "null", "-",
    ];

    private static async Task<bool> ToolExistsAsync(string tool)
        => (await RunProcessAsync(tool, ["-version"], TimeSpan.FromSeconds(10))).Found;

    private sealed record ProcessResult(bool Found, int ExitCode, string StdOut, string StdErr);

    private static async Task<ProcessResult> RunProcessAsync(string fileName, IReadOnlyList<string> args, TimeSpan timeout)
    {
        var psi = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args)
            psi.ArgumentList.Add(a);

        Process process;
        try
        {
            process = Process.Start(psi)!;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return new ProcessResult(Found: false, ExitCode: -1, "", "");
        }

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            await process.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            return new ProcessResult(Found: true, ExitCode: -2, await stdout, "timed out");
        }

        return new ProcessResult(Found: true, process.ExitCode, await stdout, await stderr);
    }

    private static string Indent(string text)
        => string.Join('\n', text.Split('\n').Select(l => "    " + l));

    // ----------------------------------------------------------------- boot

    private async Task BootAsync()
    {
        var overrides = new Dictionary<string, string?>();

        if (_options.Mode == TargetMode.Mock)
            await PrepareMockTargetAsync(overrides);
        else
            PrepareRealTarget();

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production,
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);

        // start from the same config the harness parsed (appsettings[.Local].json) …
        builder.Configuration.AddConfiguration(_config);
        // … then layer mock-target provider wiring on top (no-op in real mode).
        builder.Configuration.AddInMemoryCollection(overrides);

        builder.AddStreamarrServer();

        _app = builder.Build();
        _app.UseStreamarrServer();
        await _app.StartAsync();

        _baseUrl = _app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.First();
        _apiKey = _config["Streamarr:ApiKey"] ?? "";

        RegisterRelease();
    }

    private async Task PrepareMockTargetAsync(Dictionary<string, string?> overrides)
    {
        _tempDir = Directory.CreateTempSubdirectory("streamarr-latency-").FullName;
        _mock = new MockNntpServer { RequireAuth = true };

        var video = await TestMediaFile.GenerateMkvAsync(durationSeconds: 30);
        var direct = NzbTestFixtures.PublishFile(_mock, "video.mkv", video, "latency-direct");
        var nzbPath = Path.Combine(_tempDir, "latency.nzb");
        await File.WriteAllTextAsync(nzbPath, NzbTestFixtures.BuildNzbXml(direct));

        _releaseId = "latency-mock";
        _config["Latency:NzbUrl"] = nzbPath;

        // Every mock run must begin with isolated persistence. Reusing the tool output's default
        // database/cache can silently turn a cold sample warm, while a persisted mock-provider
        // port points at a listener that no longer exists. These overrides also make the command
        // documented in m1-latency.md self-contained in Production mode.
        overrides["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_tempDir, "latency.db")}";
        overrides["Streamarr:DataProtectionKeysPath"] = Path.Combine(_tempDir, "keys");
        overrides["Streamarr:NzbCachePath"] = Path.Combine(_tempDir, "nzb-cache");
        overrides["Streamarr:AllowLocalNzbFiles"] = "true";
        overrides["Streamarr:Admin:Password"] = "latency-harness-admin-password";
        overrides["Streamarr:Providers:0:Name"] = "mock";
        overrides["Streamarr:Providers:0:Host"] = _mock.Host;
        overrides["Streamarr:Providers:0:Port"] = _mock.Port.ToString();
        overrides["Streamarr:Providers:0:UseSsl"] = "false";
        overrides["Streamarr:Providers:0:Username"] = _mock.Username;
        overrides["Streamarr:Providers:0:Password"] = _mock.Password;
        overrides["Streamarr:Providers:0:MaxConnections"] = "8";

        _targetDescription = $"mock NNTP ({_mock.Host}:{_mock.Port}) — canned fixtures";
    }

    private void PrepareRealTarget()
    {
        var providerHost = _config["Streamarr:Providers:0:Host"];
        var nzbUrl = _config["Latency:NzbUrl"];
        if (string.IsNullOrWhiteSpace(providerHost))
            throw new InvalidOperationException(
                "Real mode needs at least one Streamarr:Providers entry in appsettings.Local.json. " +
                "Copy appsettings.Local.json.example and fill in credentials.");
        if (string.IsNullOrWhiteSpace(nzbUrl))
            throw new InvalidOperationException(
                "Real mode needs Latency:NzbUrl (a known-good NZB) in appsettings.Local.json.");

        _releaseId = _config["Latency:ReleaseId"] ?? "latency-real";
        _targetDescription = $"real provider ({providerHost}) — NZB {nzbUrl}";
    }

    private void RegisterRelease()
    {
        var store = _app!.Services.GetRequiredService<IReleaseStore>();
        store.Register(
            _config["Latency:WorkId"] ?? "latency-work",
            new Release
            {
                ReleaseId = _releaseId,
                Title = _config["Latency:Title"] ?? "Latency.Probe-STREAMARR",
                Indexer = "latency-harness",
                SizeBytes = 0,
                Score = 800,
                NzbUrl = _config["Latency:NzbUrl"]!,
            });
    }

    // ----------------------------------------------------------------- measurement

    private HttpClient NewClient() => new()
    {
        BaseAddress = new Uri(_baseUrl),
        Timeout = TimeSpan.FromMinutes(5),
        DefaultRequestHeaders = { Authorization = new AuthenticationHeaderValue("Bearer", _apiKey) },
    };

    /// <summary>resolve → open a fresh session → first stream byte → close. Repeat.</summary>
    private async Task<LatencyStats> MeasureColdStartAsync()
    {
        using var client = NewClient();
        var samples = new List<double>(_options.Iterations);

        for (var i = 0; i < _options.Iterations; i++)
        {
            var sw = Stopwatch.StartNew();
            var resolved = await ResolveAsync(client);
            await ReadFirstByteAsync(client, resolved.StreamUrl!, from: 0);
            sw.Stop();

            samples.Add(sw.Elapsed.TotalMilliseconds);
            await CloseAsync(client, resolved.StreamUrl!);
            Console.WriteLine(Fmt($"  cold-start [{i + 1}/{_options.Iterations}]", sw.Elapsed.TotalMilliseconds));
        }

        return LatencyStats.Of("cold-start", samples);
    }

    /// <summary>One warm session, then time repeated Range requests at the seek offset.</summary>
    private async Task<LatencyStats> MeasureSeekAsync()
    {
        using var client = NewClient();
        var resolved = await ResolveAsync(client);
        var size = resolved.SizeBytes ?? throw new InvalidOperationException("resolve returned no sizeBytes");
        var offset = (long)(size * _options.SeekOffsetFraction);

        try
        {
            for (var i = 0; i < _options.SeekWarmup; i++)
                await ReadFirstByteAsync(client, resolved.StreamUrl!, from: offset);

            var samples = new List<double>(_options.Iterations);
            for (var i = 0; i < _options.Iterations; i++)
            {
                var sw = Stopwatch.StartNew();
                await ReadFirstByteAsync(client, resolved.StreamUrl!, from: offset);
                sw.Stop();

                samples.Add(sw.Elapsed.TotalMilliseconds);
                Console.WriteLine(Fmt(
                    $"  seek@{(int)(_options.SeekOffsetFraction * 100)}% [{i + 1}/{_options.Iterations}]",
                    sw.Elapsed.TotalMilliseconds));
            }

            return LatencyStats.Of($"seek@{(int)(_options.SeekOffsetFraction * 100)}%", samples);
        }
        finally
        {
            await CloseAsync(client, resolved.StreamUrl!);
        }
    }

    private async Task<ResolveResult> ResolveAsync(HttpClient client)
    {
        // mirror the server's ResolveResponse locally (read-only tool: no need to
        // reference the server's internal contract types).
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve", new { releaseId = _releaseId, client = "latency-harness" });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<ResolveResult>()
                   ?? throw new InvalidOperationException("empty /resolve response");
        if (body.StreamUrl is null)
            throw new InvalidOperationException(
                $"release resolved '{body.Status}' with no stream URL (not playable — cannot measure latency)");
        return body;
    }

    /// <summary>
    /// Time to first byte at <paramref name="from"/> (0 for cold-start). Requests a
    /// single-byte range (bytes=N-N) and reads it to completion: the server resolves
    /// and yEnc-decodes exactly the covering segment and returns, so the measurement
    /// is a clean first-byte latency with no abandoned full-range copy to race the
    /// session teardown.
    /// </summary>
    private static async Task ReadFirstByteAsync(HttpClient client, string streamUrl, long from)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, streamUrl);
        request.Headers.Range = new RangeHeaderValue(from, from);

        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseContentRead);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsByteArrayAsync();
        if (body.Length == 0)
            throw new InvalidOperationException("stream returned no bytes at the requested offset");
    }

    private static string Fmt(string label, double ms)
        => $"{label} {ms.ToString("0.0", CultureInfo.InvariantCulture)} ms";

    private static async Task CloseAsync(HttpClient client, string streamUrl)
    {
        var token = streamUrl.Split('/').Last();
        using var _ = await client.PostAsync($"/api/v1/sessions/{token}/close", content: null);
    }

    public async ValueTask DisposeAsync()
    {
        if (_app is not null)
            await _app.DisposeAsync();
        if (_mock is not null)
            await _mock.DisposeAsync();
        if (_tempDir is not null && Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }

    /// <summary>Minimal mirror of the server's ResolveResponse (read-only fields we use).</summary>
    private sealed record ResolveResult
    {
        public string Status { get; init; } = "";
        public string? StreamUrl { get; init; }
        public long? SizeBytes { get; init; }
        public long? RunTimeTicks { get; init; }
    }
}
