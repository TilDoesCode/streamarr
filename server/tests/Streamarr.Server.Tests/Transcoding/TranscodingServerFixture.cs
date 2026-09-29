using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;
using Streamarr.Server.Tests.Integration;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>
/// Real server + real ffmpeg + mock Usenet: a 3-minute H.264/AC-3 5.1 MKV (which a browser cannot play directly)
/// is published as a release so the full Usenet → /stream → ffmpeg → HLS path is exercised end to end.
/// </summary>
public class TranscodingServerFixture : IAsyncLifetime
{
    public const string ApiKey = "transcoding-it-api-key-0123456789abcdef";
    public const string ReleaseId = "rel-transcode-source";
    public const string WorkId = "tmdb-movie-4242";
    public const int SourceSeconds = 180;

    private WebApplication _app = null!;
    private string _tempDir = null!;

    protected virtual TimeSpan NntpLatency => TimeSpan.Zero;
    protected virtual int NntpBytesPerSecondPerConnection => 0;
    protected virtual int SourceDurationSeconds => SourceSeconds;
    protected virtual string SourceSize => "640x360";
    protected virtual string SourceVideoBitrate => "600k";
    protected virtual int ArticleBytes => 256_000;

    /// <summary>Independent copies of the release; each starts cold (own articles, empty caches).</summary>
    protected virtual int ReleaseCopies => 1;

    public static string ReleaseIdFor(int copy) => copy == 0 ? ReleaseId : $"{ReleaseId}-{copy}";

    /// <summary>An additional source published as its own release (e.g. the remux fixtures' media matrix).</summary>
    public sealed record FixtureRelease(string ReleaseId, string WorkId, string FileName, byte[] Data);

    /// <summary>Extra releases to publish next to the transcode source; none by default.</summary>
    protected virtual Task<IReadOnlyList<FixtureRelease>> GenerateExtraReleasesAsync(string directory)
        => Task.FromResult<IReadOnlyList<FixtureRelease>>([]);

    public MockNntpServer Nntp { get; private set; } = null!;

    private readonly System.Collections.Concurrent.ConcurrentDictionary<int, int> _bodies = new();

    /// <summary>Articles (BODY commands) served for one release copy so far.</summary>
    public int BodiesServed(int copy) => _bodies.GetValueOrDefault(copy);
    public string BaseUrl { get; private set; } = null!;
    public string WorkspaceRoot { get; private set; } = null!;

    public HttpClient CreateClient(bool authenticated = true)
    {
        var client = new HttpClient { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromMinutes(3) };
        if (authenticated)
            client.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);
        return client;
    }

    public async Task<HttpClient> CreateAdminClientAsync()
    {
        var client = CreateClient(authenticated: false);
        await client.AuthenticateAsAdminAsync();
        return client;
    }

    public T GetRequiredService<T>() where T : notnull => _app.Services.GetRequiredService<T>();

    public async Task InitializeAsync()
    {
        _tempDir = Directory.CreateTempSubdirectory("streamarr-transcode-it-").FullName;
        WorkspaceRoot = Path.Combine(_tempDir, "transcode");
        var video = await GenerateSourceAsync(Path.Combine(_tempDir, "source.mkv"));

        Nntp = new MockNntpServer
        {
            RequireAuth = true,
            CommandLatency = NntpLatency,
            BodyBytesPerSecond = NntpBytesPerSecondPerConnection,
            OnBodyServed = id =>
            {
                var dash = id.LastIndexOf('-');
                var start = id.IndexOf("transcode-", StringComparison.Ordinal);
                if (start >= 0 && dash > start && int.TryParse(id[(start + "transcode-".Length)..dash], out var copy))
                    _bodies.AddOrUpdate(copy, 1, (_, n) => n + 1);
            },
        };
        var nzbPaths = new List<string>();
        for (var copy = 0; copy < ReleaseCopies; copy++)
        {
            var published = NzbTestFixtures.PublishFile(
                Nntp, "Transcode.Source.2024.1080p.WEB-DL.DDP5.1.H.264.mkv", video, $"transcode-{copy}", partSize: ArticleBytes);
            var nzbPath = Path.Combine(_tempDir, $"transcode-{copy}.nzb");
            await File.WriteAllTextAsync(nzbPath, NzbTestFixtures.BuildNzbXml(published));
            nzbPaths.Add(nzbPath);
        }

        var extras = await GenerateExtraReleasesAsync(_tempDir);
        var extraNzbs = new List<string>();
        foreach (var extra in extras)
        {
            var published = NzbTestFixtures.PublishFile(Nntp, extra.FileName, extra.Data, $"extra-{extra.ReleaseId}", partSize: ArticleBytes);
            var nzbPath = Path.Combine(_tempDir, $"{extra.ReleaseId}.nzb");
            await File.WriteAllTextAsync(nzbPath, NzbTestFixtures.BuildNzbXml(published));
            extraNzbs.Add(nzbPath);
        }

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Serilog:MinimumLevel:Default"] = "Warning",
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:LoginAttemptsPerMinute"] = "100",
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_tempDir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_tempDir, "keys"),
            ["Streamarr:ConnectionBudget"] = "12",
            ["Streamarr:SessionTtlSeconds"] = "900",
            ["Streamarr:AllowLocalNzbFiles"] = "true",
            ["Streamarr:PreDownload:CachePath"] = Path.Combine(_tempDir, "pre-download"),
            ["Streamarr:PreDownload:MinimumFreeDiskBytes"] = "0",
            ["Streamarr:Providers:0:Name"] = "mock",
            ["Streamarr:Providers:0:Host"] = Nntp.Host,
            ["Streamarr:Providers:0:Port"] = Nntp.Port.ToString(),
            ["Streamarr:Providers:0:UseSsl"] = "false",
            ["Streamarr:Providers:0:Username"] = Nntp.Username,
            ["Streamarr:Providers:0:Password"] = Nntp.Password,
            ["Streamarr:Providers:0:MaxConnections"] = "8",
            ["Streamarr:Repair:WorkspacePath"] = Path.Combine(_tempDir, "repair"),
            ["Streamarr:Transcoding:WorkspacePath"] = WorkspaceRoot,
            ["Streamarr:Transcoding:SamplesPath"] = SharedSamplesPath(),
            ["Streamarr:Transcoding:MaintenanceIntervalMilliseconds"] = "200",
            ["Streamarr:Transcoding:SegmentWaitTimeoutSeconds"] = "60",
        });
        builder.AddStreamarrServer();

        _app = builder.Build();
        _app.UseStreamarrServer();
        await _app.StartAsync();

        BaseUrl = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        var store = _app.Services.GetRequiredService<IReleaseStore>();
        for (var copy = 0; copy < ReleaseCopies; copy++)
        {
            store.Register(WorkId, new Release
            {
                ReleaseId = ReleaseIdFor(copy),
                Title = $"Transcode.Source.2024.1080p.WEB-DL.DDP5.1.H.264-STREAMARR{copy}",
                Indexer = "mock-indexer",
                SizeBytes = video.Length,
                Score = 900 - copy,
                NzbUrl = nzbPaths[copy],
            });
        }
        for (var i = 0; i < extras.Count; i++)
        {
            store.Register(extras[i].WorkId, new Release
            {
                ReleaseId = extras[i].ReleaseId,
                Title = Path.GetFileNameWithoutExtension(extras[i].FileName),
                Indexer = "mock-indexer",
                SizeBytes = extras[i].Data.Length,
                Score = 800 - i,
                NzbUrl = extraNzbs[i],
            });
        }
    }

    /// <summary>Resolves the release like a client would and returns the direct-play stream capability.</summary>
    public Task<string> ResolveStreamTokenAsync(HttpClient client, int copy = 0) => ResolveStreamTokenAsync(client, ReleaseIdFor(copy), WorkId);

    public async Task<string> ResolveStreamTokenAsync(HttpClient client, string releaseId, string workId)
    {
        var response = await client.PostAsJsonAsync("/api/v1/resolve",
            new ResolveRequest { ReleaseId = releaseId, WorkId = workId, Client = "transcoding-it" });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var streamUrl = body.GetProperty("streamUrl").GetString()!;
        return Uri.UnescapeDataString(streamUrl[(streamUrl.LastIndexOf('/') + 1)..]);
    }

    public async Task DisposeAsync()
    {
        if (_app != null!)
            await _app.DisposeAsync();
        if (Nntp != null!)
            await Nntp.DisposeAsync();
        if (_tempDir != null! && Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }

    /// <summary>Samples are deterministic, so a shared cache keeps repeated local runs fast.</summary>
    private static string SharedSamplesPath()
        => Environment.GetEnvironmentVariable("STREAMARR_TEST_TRANSCODING_SAMPLES") is { Length: > 0 } configured
            ? configured
            : Path.Combine(Path.GetTempPath(), "streamarr-test-transcoding-samples");

    private async Task<byte[]> GenerateSourceAsync(string path)
    {
        var psi = new ProcessStartInfo("ffmpeg") { RedirectStandardError = true, UseShellExecute = false };
        foreach (var argument in new[]
                 {
                     "-y", "-hide_banner", "-loglevel", "error",
                     "-f", "lavfi", "-i", $"testsrc2=size={SourceSize}:rate=24000/1001:duration={SourceDurationSeconds},noise=alls=6:allf=t",
                     "-f", "lavfi", "-i", $"sine=frequency=440:beep_factor=4:sample_rate=48000:duration={SourceDurationSeconds}",
                     "-filter_complex", "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]",
                     "-map", "0:v", "-map", "[a]",
                     "-c:v", "libx264", "-preset", "ultrafast", "-b:v", SourceVideoBitrate, "-g", "240", "-pix_fmt", "yuv420p",
                     "-c:a", "ac3", "-b:a", "192k",
                     path,
                 })
        {
            psi.ArgumentList.Add(argument);
        }
        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Could not start ffmpeg.");
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"ffmpeg failed ({process.ExitCode}): {stderr}");
        return await File.ReadAllBytesAsync(path);
    }
}

[CollectionDefinition("transcoding-server", DisableParallelization = true)]
public class TranscodingServerCollection : ICollectionFixture<TranscodingServerFixture>;
