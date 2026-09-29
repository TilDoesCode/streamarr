using System.Collections.Concurrent;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;
using Streamarr.Server.Tests.Integration;
using Streamarr.Server.Tests.Transcoding;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Resolve stand-in: every release resolves ready unless a test scripts the hops, errors or repair progress.</summary>
public sealed class FakePlaybackResolver : IPlaybackResolver
{
    public delegate Task<ResolveResponse> Handler(PlaybackResolveCall call, IResolveObserver observer, CancellationToken ct);

    public ConcurrentQueue<PlaybackResolveCall> Calls { get; } = new();
    public ConcurrentDictionary<string, RepairStatusInfo> Repairs { get; } = new(StringComparer.Ordinal);
    public Handler? Script { get; set; }

    public static string Token(string releaseId) => $"tok-{releaseId}";

    public static ResolveResponse Ready(string releaseId, string status = "ready") => new()
    {
        ReleaseId = releaseId,
        Status = status,
        StreamUrl = $"/api/v1/stream/{Token(releaseId)}",
        Attempts = [new ResolveAttempt { ReleaseId = releaseId, Status = status }],
    };

    public async Task<ResolveResponse> ResolveAsync(PlaybackResolveCall call, IResolveObserver observer, CancellationToken ct)
    {
        Calls.Enqueue(call);
        if (Script is { } script)
            return await script(call, observer, ct);
        observer.HopStarted(call.ReleaseId, 0);
        observer.HopFinished(call.ReleaseId, "ready");
        return Ready(call.ReleaseId);
    }

    public RepairStatusInfo? RepairStatus(string releaseId) => Repairs.GetValueOrDefault(releaseId);
}

/// <summary>Probe/ffmpeg stand-in: media per release, HLS sessions planned with the real planner, injectable start failures.</summary>
public sealed class FakePlaybackMedia : IPlaybackMedia
{
    public sealed record Started(string Id, string StreamToken, ClientProfile Client, TranscodeLimits Limits, double StartSeconds, ModePreference Mode);

    private int _next;

    public ConcurrentDictionary<string, SourceMediaInfo?> Sources { get; } = new(StringComparer.Ordinal);
    public ConcurrentQueue<Started> Starts { get; } = new();
    public ConcurrentQueue<string> Closed { get; } = new();
    public ConcurrentQueue<string> Touched { get; } = new();
    public ConcurrentDictionary<ModePreference, string> FailModes { get; } = new();
    public HashSet<string> DeadStreams { get; } = [];
    public ServerHls Server { get; set; } = Available();
    public TaskCompletionSource? StartGate { get; set; }
    public TaskCompletionSource? ProbeGate { get; set; }

    public static ServerHls Available(bool enabled = true)
        => new(enabled, enabled ? null : "transcoding_disabled", new TranscodingSettings(),
            TranscodeTestData.Capabilities() with { Encoders = new HashSet<string>(TranscodeTestData.Capabilities().Encoders) { "ac3", "eac3" } });

    public Task<ServerHls> ServerAsync(CancellationToken ct) => Task.FromResult(Server);

    public async Task<SourceMediaInfo?> ProbeAsync(string streamToken, CancellationToken ct)
    {
        if (ProbeGate is { } gate)
            await gate.Task.WaitAsync(ct);
        if (DeadStreams.Contains(streamToken))
            throw new TranscodeException("unknown_stream", "No live stream session exists for this token (closed or expired).", 404);
        var releaseId = streamToken["tok-".Length..];
        return Sources.TryGetValue(releaseId, out var media) ? media : TranscodeTestData.Media(container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2);
    }

    public bool StreamAlive(string streamToken) => !DeadStreams.Contains(streamToken);

    public async Task<HlsRendition> StartHlsAsync(
        string streamToken, ClientProfile client, TranscodeLimits limits, string clientLabel, double startSeconds, ModePreference mode, CancellationToken ct)
    {
        if (StartGate is { } gate)
            await gate.Task;
        if (FailModes.TryGetValue(mode, out var code))
            throw new TranscodeException(code, $"Injected {code}.", 422);
        var media = (await ProbeAsync(streamToken, ct))!;
        var plan = TranscodePlanner.Decide(media, client, limits, Server.Settings, Server.Capabilities, mode, allowDirect: false);
        if (mode == ModePreference.Remux && plan.Mode != DeliveryMode.Remux)
            throw new TranscodeException("remux_not_possible", "A stream copy is not possible.", 422);
        var id = $"hls-{Interlocked.Increment(ref _next)}";
        Starts.Enqueue(new Started(id, streamToken, client, limits, startSeconds, mode));
        return new HlsRendition(id, plan.Mode, plan, media);
    }

    public Task CloseHlsAsync(string id, string reason)
    {
        Closed.Enqueue(id);
        return Task.CompletedTask;
    }

    public void TouchHls(string id) => Touched.Enqueue(id);

    public ConcurrentDictionary<string, DateTimeOffset> Accessed { get; } = new(StringComparer.Ordinal);

    public DateTimeOffset? HlsLastAccess(string id) => Accessed.TryGetValue(id, out var at) ? at : null;
}

public sealed class ViewerPlaybackFactory : WebApplicationFactory<Program>
{
    public const string ApiKey = "machine-key-for-playback-tests-0123456789";
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-playback-").FullName;
    private readonly SemaphoreSlim _adminGate = new(1, 1);
    private string? _adminToken;

    public ManualClock Clock { get; } = new(DateTimeOffset.UtcNow);
    public CatalogTmdbFake Tmdb { get; } = new();
    public CatalogNewznabFake Newznab { get; } = new();
    public FakePlaybackResolver Resolver { get; } = new();
    public FakePlaybackMedia Media { get; } = new();

    public static readonly PlaybackTimings Timings = new(
        TimeSpan.FromMilliseconds(20), TimeSpan.FromMilliseconds(20), TimeSpan.FromMilliseconds(400), TimeSpan.FromSeconds(30), TimeSpan.FromHours(1));

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Production");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
            ["Streamarr:LoginAttemptsPerMinute"] = "1000",
            ["Streamarr:ViewerAuthAttemptsPerMinute"] = "1000",
            ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
            ["Streamarr:Indexers:0:Name"] = "playback-indexer",
            ["Streamarr:Indexers:0:BaseUrl"] = "https://indexer.playback.example",
            ["Streamarr:Indexers:0:ApiKey"] = "playback-indexer-key",
            ["Streamarr:Indexers:0:Categories:0"] = "2000",
            ["Streamarr:Indexers:0:Categories:1"] = "5000",
        }));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
            services.RemoveAll<ITmdbClient>();
            services.AddSingleton<ITmdbClient>(Tmdb);
            services.RemoveAll<INewznabClient>();
            services.AddSingleton<INewznabClient>(Newznab);
            services.RemoveAll<IPlaybackResolver>();
            services.AddSingleton<IPlaybackResolver>(Resolver);
            services.RemoveAll<IPlaybackMedia>();
            services.AddSingleton<IPlaybackMedia>(Media);
            services.AddSingleton(Timings);
        });
    }

    public ViewerPlaybackService Playbacks => Services.GetRequiredService<ViewerPlaybackService>();

    public ReleaseRegistrar Releases => new(Services.GetRequiredService<Streamarr.Core.Media.IReleaseStore>());

    public async Task<HttpClient> AdminAsync()
    {
        await _adminGate.WaitAsync();
        try
        {
            _adminToken ??= await TestAuth.LoginAsAdminAsync(CreateClient());
        }
        finally
        {
            _adminGate.Release();
        }
        return Bearer(_adminToken);
    }

    public HttpClient Bearer(string token)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }
}

/// <summary>Registers releases for a work the way a search would.</summary>
public sealed class ReleaseRegistrar(Streamarr.Core.Media.IReleaseStore store)
{
    public string Register(string workId, string title, string? releaseId = null)
    {
        var id = releaseId ?? $"rel-{Guid.NewGuid():N}"[..20];
        store.Register(workId, new Streamarr.Core.Media.Release
        {
            ReleaseId = id,
            Title = title,
            Indexer = "playback-indexer",
            SizeBytes = 4_000_000_000,
            Score = 500,
            NzbUrl = $"https://nzb.playback.example/{id}.nzb",
        });
        return id;
    }
}
