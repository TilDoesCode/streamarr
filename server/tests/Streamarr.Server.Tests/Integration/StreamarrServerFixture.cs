using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Core.Media;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Boots the real Core Server on a real Kestrel port (ffprobe must be able to hit
/// the stream URL over HTTP) against an in-process mock NNTP server. A small real
/// mkv is generated with ffmpeg at fixture setup and published four ways: direct,
/// RAR-wrapped (stored, multi-volume), with one missing article (degraded), and
/// with most articles missing (dead).
/// </summary>
public sealed class StreamarrServerFixture : IAsyncLifetime
{
    public const string ApiKey = "test-api-key";

    public const string DirectReleaseId = "rel-direct";
    public const string RarReleaseId = "rel-rar";
    public const string DegradedReleaseId = "rel-degraded";
    public const string DeadReleaseId = "rel-dead";
    public const string FallbackReleaseId = "rel-fallback";
    public const string DeadWorkId = "tmdb-movie-9";

    /// <summary>RAR volume chunk size — range tests cross this boundary on purpose.</summary>
    public const int RarChunkSize = 150_000;

    public byte[] Video { get; private set; } = null!;
    public MockNntpServer Nntp { get; private set; } = null!;
    public string BaseUrl { get; private set; } = null!;

    private WebApplication _app = null!;
    private string _tempDir = null!;

    public HttpClient CreateClient(bool authenticated = true)
    {
        var client = new HttpClient { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromMinutes(2) };
        if (authenticated)
            client.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);
        return client;
    }

    public async Task InitializeAsync()
    {
        _tempDir = Directory.CreateTempSubdirectory("streamarr-it-").FullName;
        Video = await TestMediaFile.GenerateMkvAsync(durationSeconds: 30);
        Nntp = new MockNntpServer { RequireAuth = true };

        // --- publish the four flavors of the same video ---------------------------------

        // 1) direct mkv + an unpublished par2 decoy (must never be selected or sampled)
        var direct = NzbTestFixtures.PublishFile(Nntp, "video.mkv", Video, "direct");
        var directNzb = WriteNzb("direct.nzb", direct, Par2Decoy("direct"));

        // 2) the same mkv wrapped in a stored multi-volume RAR4 set
        var rarVolumes = Rar4TestWriter.WriteMultiVolume("video", "video.mkv", Video, RarChunkSize);
        var rarFiles = rarVolumes
            .Select((v, i) => NzbTestFixtures.PublishFile(Nntp, v.FileName, v.Bytes, $"rar-vol{i}"))
            .ToList();
        var rarNzb = WriteNzb("rar.nzb", [.. rarFiles, Par2Decoy("rar")]);

        // 3) degraded: one mid-file article was never published (expired/DMCA'd)
        var degraded = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "degraded", publishArticle: i => i != 4);
        var degradedNzb = WriteNzb("degraded.nzb", degraded);

        // 4) dead: only the first article survives
        var dead = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "dead", publishArticle: i => i == 0);
        var deadNzb = WriteNzb("dead.nzb", dead);

        // 5) fallback: a healthy sibling release of the same work as the dead one
        var fallback = NzbTestFixtures.PublishFile(Nntp, "video.mkv", Video, "fallback");
        var fallbackNzb = WriteNzb("fallback.nzb", fallback);

        // --- boot the real server on a random loopback port ------------------------------

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production,
        });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:ConnectionBudget"] = "12",
            ["Streamarr:SessionTtlSeconds"] = "300",
            ["Streamarr:HealthCheck:SampleCount"] = "24",
            ["Streamarr:HealthCheck:DeadMissingRatio"] = "0.5",
            ["Streamarr:Providers:0:Name"] = "mock",
            ["Streamarr:Providers:0:Host"] = Nntp.Host,
            ["Streamarr:Providers:0:Port"] = Nntp.Port.ToString(),
            ["Streamarr:Providers:0:UseSsl"] = "false",
            ["Streamarr:Providers:0:Username"] = Nntp.Username,
            ["Streamarr:Providers:0:Password"] = Nntp.Password,
            ["Streamarr:Providers:0:MaxConnections"] = "8",
        });
        builder.AddStreamarrServer();

        _app = builder.Build();
        _app.UseStreamarrServer();
        await _app.StartAsync();

        BaseUrl = _app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.First();

        // --- register the releases (M2 search will do this in production) ----------------

        var store = _app.Services.GetRequiredService<IReleaseStore>();
        Register(store, "tmdb-movie-1", DirectReleaseId, directNzb);
        Register(store, "tmdb-movie-2", RarReleaseId, rarNzb);
        Register(store, "tmdb-movie-3", DegradedReleaseId, degradedNzb);
        Register(store, DeadWorkId, DeadReleaseId, deadNzb, score: 900);
        Register(store, DeadWorkId, FallbackReleaseId, fallbackNzb, score: 850);
    }

    private static void Register(IReleaseStore store, string workId, string releaseId, string nzbPath, int score = 800)
        => store.Register(workId, new Release
        {
            ReleaseId = releaseId,
            Title = $"Example.2021.1080p.WEB-DL.x264-{releaseId}",
            Indexer = "mock-indexer",
            SizeBytes = 0,
            Score = score,
            NzbUrl = nzbPath,
        });

    private PublishedNzbFile Par2Decoy(string prefix)
    {
        // referenced by the NZB but intentionally never published: proves par2
        // companions are neither selected as primary nor health-sampled
        var junk = new byte[2048];
        return NzbTestFixtures.PublishFile(Nntp, "video.par2", junk, $"{prefix}-par2", publishArticle: _ => false);
    }

    private string WriteNzb(string name, params PublishedNzbFile[] files)
    {
        var path = Path.Combine(_tempDir, name);
        File.WriteAllText(path, NzbTestFixtures.BuildNzbXml(files));
        return path;
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
}

[CollectionDefinition("streamarr-server")]
public class StreamarrServerCollection : ICollectionFixture<StreamarrServerFixture>;
