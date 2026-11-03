using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
using Streamarr.E2E.Harness;
using Streamarr.Server;
using Streamarr.Server.Tunnels;
using Streamarr.Tests.Shared;

// -----------------------------------------------------------------------------------------
// Streamarr E2E harness — boots the REAL Core Server against an in-process mock NNTP server
// with canned indexer + TMDB fixtures and a seeded admin, then serves the built Management
// SPA at a single origin. This is what the Playwright smoke E2E drives to prove BRIEF §3.1
// rule 4: the UI can log in, configure an indexer, search, resolve and *preview-play* a
// stream with Jellyfin absent. It is a test launcher only and is never shipped.
//
// Environment contract (set by web/playwright.config.ts):
//   E2E_PORT       loopback port to bind (default 5099)
//   E2E_WEB_DIST   absolute path to the built SPA (web/dist) served as static files
//   E2E_ADMIN_PASSWORD  admin password to seed (default "streamarr-e2e")
//   E2E_LAB_PORT   loopback port of the WireGuard lab control API (default 5098); E2E_TUNNEL_LAB=0 disables the lab
// -----------------------------------------------------------------------------------------

var port = Environment.GetEnvironmentVariable("E2E_PORT") is { Length: > 0 } p ? p : "5099";
var webDist = Environment.GetEnvironmentVariable("E2E_WEB_DIST");
var adminPassword = Environment.GetEnvironmentVariable("E2E_ADMIN_PASSWORD") is { Length: > 0 } ap
    ? ap
    : "streamarr-e2e";

var labPort = Environment.GetEnvironmentVariable("E2E_LAB_PORT") is { Length: > 0 } lbp ? int.Parse(lbp) : 5098;
var labWanted = Environment.GetEnvironmentVariable("E2E_TUNNEL_LAB") is not ("0" or "false");

var tempDir = Directory.CreateTempSubdirectory("streamarr-e2e-").FullName;

// --- 1) a real, browser-playable video published to a mock NNTP server -------------------
// WebM/VP8 so Playwright's (proprietary-codec-free) Chromium can decode it in <video>.
var video = await TestMediaFile.GenerateWebmAsync(durationSeconds: 10);
var nntp = new MockNntpServer { RequireAuth = true };
var published = NzbTestFixtures.PublishFile(nntp, "Example.Movie.2021.1080p.WEB-DL.x264-STREAMARR.webm", video, "e2e");
var nzbPath = Path.Combine(tempDir, "example.nzb");
File.WriteAllText(nzbPath, NzbTestFixtures.BuildNzbXml(published));

// --- 1b) the loopback WireGuard lab (docs/vpn.md): a fake VPN server with the mocks behind it --------
var lab = labWanted ? await TunnelLab.TryStartAsync(labPort, nntp.Port, File.ReadAllText(nzbPath)) : null;

// --- 2) boot the real server on a real Kestrel port --------------------------------------
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    EnvironmentName = Environments.Production,
    Args = args,
    // The built SPA is served as static files from a single origin (BRIEF §4). WebRoot must
    // be set through the options — WebApplicationBuilder.WebHost.UseWebRoot is unsupported.
    WebRootPath = string.IsNullOrWhiteSpace(webDist) ? null : webDist,
});
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
builder.Logging.SetMinimumLevel(LogLevel.Warning);

var settings = new Dictionary<string, string?>
{
    ["Serilog:MinimumLevel:Default"] = "Warning",
    ["Streamarr:ApiKey"] = "e2e-api-key-0123456789abcdef-xyz",
    ["Streamarr:Admin:Username"] = "admin",
    ["Streamarr:Admin:Password"] = adminPassword,
    // Every spec signs in through the real login form; the production limit of 5/min would throttle the suite.
    ["Streamarr:LoginAttemptsPerMinute"] = "60",
    ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(tempDir, "streamarr.db")}",
    ["Streamarr:DataProtectionKeysPath"] = Path.Combine(tempDir, "keys"),
    ["Streamarr:ConnectionBudget"] = "12",
    ["Streamarr:SessionTtlSeconds"] = "600",
    // Marks metadata as configured in the Management UI; the actual external boundary is
    // replaced by CannedTmdbClient below, so this fixture value is never sent anywhere.
    ["Streamarr:Tmdb:ApiKey"] = "e2e-fixture-key",
    ["Streamarr:AllowLocalNzbFiles"] = "true",
    ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
    // No indexer is seeded on purpose: the Playwright flow *adds one through the UI*
    // (BRIEF §9.1) and search then fans out to the canned INewznabClient below.
    ["Streamarr:Providers:0:Name"] = "mock",
    ["Streamarr:Providers:0:Host"] = nntp.Host,
    ["Streamarr:Providers:0:Port"] = nntp.Port.ToString(),
    ["Streamarr:Providers:0:UseSsl"] = "false",
    ["Streamarr:Providers:0:Username"] = nntp.Username,
    ["Streamarr:Providers:0:Password"] = nntp.Password,
    ["Streamarr:Providers:0:MaxConnections"] = "8",
    ["Streamarr:Transcoding:WorkspacePath"] = Path.Combine(tempDir, "transcode"),
    ["Streamarr:Transcoding:SamplesPath"] = Environment.GetEnvironmentVariable("E2E_TRANSCODING_SAMPLES") is { Length: > 0 } samples
        ? samples
        : Path.Combine(tempDir, "samples"),
};
if (lab is not null)
{
    settings["Streamarr:Tunnels:HelperPath"] = lab.HelperPath;
    settings["Streamarr:Tunnels:ExitCheckUrl"] = TunnelLab.ExitCheckUrl;
}
builder.Configuration.AddInMemoryCollection(settings);

builder.AddStreamarrServer();

// Replace the two external boundaries (indexer HTTP + TMDB HTTP) with canned fixtures,
// exactly as the integration tests do — everything else is the real DI graph. With the lab
// running, indexers on a .test host keep the real Newznab HTTP client so their requests
// really travel through the tunnel.
var canned = new CannedNewznabClient(nzbPath);
builder.Services.RemoveAll<INewznabClient>();
if (lab is not null)
{
    builder.Services.AddHttpClient<NewznabClient>(client => client.Timeout = Timeout.InfiniteTimeSpan)
        .ConfigurePrimaryHttpMessageHandler(sp => sp.GetRequiredService<IndexerHttpRouter>().CreateHandler())
        .RemoveAllLoggers();
    builder.Services.AddSingleton<INewznabClient>(sp => new LabNewznabClient(sp.GetRequiredService<NewznabClient>(), canned));
}
else
{
    builder.Services.AddSingleton<INewznabClient>(canned);
}
// Shorter supervisor timings keep the VPN flow inside the Playwright timeouts; the stale-handshake
// window stays at its default because WireGuard only rekeys every two minutes.
builder.Services.RemoveAll<TunnelSupervisorTimings>();
builder.Services.AddSingleton(new TunnelSupervisorTimings
{
    PollInterval = TimeSpan.FromSeconds(1),
    FirstPollDelay = TimeSpan.FromMilliseconds(500),
    HandshakeTimeout = TimeSpan.FromSeconds(20),
    ExitCheckInterval = TimeSpan.FromSeconds(15),
    RestartBackoffInitial = TimeSpan.FromSeconds(1),
    RestartBackoffMax = TimeSpan.FromSeconds(5),
});
builder.Services.RemoveAll<ITmdbClient>();
builder.Services.AddSingleton<ITmdbClient>(new CannedTmdbClient());

var app = builder.Build();
app.UseStreamarrServer();

await app.StartAsync();

var url = app.Services.GetRequiredService<IServer>()
    .Features.Get<IServerAddressesFeature>()!.Addresses.First();
Console.WriteLine($"[e2e-harness] listening on {url}");
Console.WriteLine($"[e2e-harness] admin=admin password={adminPassword} webRoot={webDist ?? "(none)"}");
if (lab is not null)
{
    lab.KillHelpers = async () =>
    {
        var supervisor = app.Services.GetRequiredService<TunnelSupervisor>();
        var killed = new List<int>();
        foreach (var row in await app.Services.GetRequiredService<TunnelConfigService>().ListAsync(CancellationToken.None))
        {
            if (supervisor.HelperProcessId(row.Id) is not { } pid)
                continue;
            try
            {
                System.Diagnostics.Process.GetProcessById(pid).Kill();
                killed.Add(pid);
            }
            catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
            {
            }
        }
        return killed;
    };
    Console.WriteLine($"[e2e-harness] tunnel lab: control http://127.0.0.1:{lab.ControlPort}/lab/status, peer pid {lab.PeerPid}, endpoint 127.0.0.1:{lab.UdpPort}, helper {lab.HelperPath}");
}
else
{
    Console.WriteLine(labWanted
        ? "[e2e-harness] tunnel lab: off (streamarr-tunnel is not built; run server/scripts/build-tunnel-helper.sh)"
        : "[e2e-harness] tunnel lab: disabled by E2E_TUNNEL_LAB");
}

await app.WaitForShutdownAsync();

await app.DisposeAsync();
if (lab is not null)
    await lab.DisposeAsync();
await nntp.DisposeAsync();
try { Directory.Delete(tempDir, recursive: true); } catch { /* best effort */ }

// -----------------------------------------------------------------------------------------

/// <summary>
/// A single-item Newznab fixture: whatever the query, returns one healthy 1080p movie
/// release whose NZB URL points at the file published to the mock NNTP server, so a later
/// /resolve reconstructs a real, playable stream.
/// </summary>
file sealed class CannedNewznabClient(string nzbPath) : INewznabClient
{
    private readonly NewznabItem[] _items =
    [
        new()
        {
            Title = "Example.Movie.2021.1080p.WEB-DL.x264-STREAMARR",
            Guid = "e2e-example-movie-1080p",
            NzbUrl = nzbPath,
            SizeBytes = 2_400_000_000,
            Categories = [2000],
            Grabs = 42,
            PublishDate = DateTimeOffset.UtcNow.AddDays(-3),
            UsenetDate = DateTimeOffset.UtcNow.AddDays(-3),
        },
    ];

    public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
        => Task.FromResult(new NewznabCapabilities
        {
            ServerTitle = "Streamarr E2E mock",
            ServerVersion = "1.0",
            SearchAvailable = true,
            MovieSearchAvailable = true,
            TvSearchAvailable = true,
            Categories = [new NewznabCategory { Id = 2000, Name = "Movies" }],
        });

    public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
        => Task.FromResult(new NewznabSearchResponse { Items = _items, Total = _items.Length });
}

/// <summary>Resolves every movie search to a single fixed TMDB work; also serves a small TV catalog for the viewer pages.</summary>
file sealed class CannedTmdbClient : ITmdbClient
{
    private static readonly TmdbMatch ExampleMovie = new()
    {
        MediaType = Streamarr.Core.Media.MediaType.Movie,
        TmdbId = 12345,
        ImdbId = "tt1234567",
        Title = "Example Movie",
        Year = 2021,
        RuntimeMinutes = 120,
        PosterUrl = "https://image.example/poster/12345.jpg",
        Overview = "A canned fixture work used by the Streamarr Playwright smoke E2E.",
    };

    private static readonly Dictionary<int, TmdbMatch> RatedMovies = new()
    {
        [603] = new() { MediaType = Streamarr.Core.Media.MediaType.Movie, TmdbId = 603, Title = "The Matrix", Year = 1999, OfficialRating = "R", RuntimeMinutes = 136 },
        [27205] = new() { MediaType = Streamarr.Core.Media.MediaType.Movie, TmdbId = 27205, Title = "Inception", Year = 2010, OfficialRating = "PG-13", RuntimeMinutes = 148 },
    };

    private static readonly Dictionary<int, (TmdbMatch Series, Dictionary<int, TmdbEpisode[]> Seasons)> Shows = new()
    {
        [1396] = (
            new() { MediaType = Streamarr.Core.Media.MediaType.Tv, TmdbId = 1396, Title = "Breaking Bad", Year = 2008, OfficialRating = "TV-MA" },
            new()
            {
                [1] = Episodes("2008-01-20", 7, ["Pilot", "Cat's in the Bag...", "...And the Bag's in the River", "Cancer Man", "Gray Matter", "Crazy Handful of Nothin'", "A No-Rough-Stuff-Type Deal"]),
                [2] = Episodes("2009-03-08", 13, []),
            }),
        [66732] = (
            new() { MediaType = Streamarr.Core.Media.MediaType.Tv, TmdbId = 66732, Title = "Stranger Things", Year = 2016, OfficialRating = "TV-14" },
            new()
            {
                [1] = Episodes("2016-07-15", 8, []),
                [2] = [.. Episodes("2017-10-27", 1, []), .. Episodes("2099-01-01", 8, [])[1..]],
            }),
    };

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(ExampleMovie);

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(ExampleMovie);

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(null);

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(RatedMovies.GetValueOrDefault(tmdbId) ?? ExampleMovie);

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult(Shows.TryGetValue(tmdbId, out var show) ? show.Series : null);

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult(Shows.TryGetValue(tmdbId, out var show)
            ? new TmdbTvSeriesCatalog
            {
                Series = show.Series,
                Seasons = show.Seasons.Select(s => new TmdbSeasonSummary { SeasonNumber = s.Key, Title = $"Season {s.Key}", EpisodeCount = s.Value.Length }).ToList(),
            }
            : null);

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
        => Task.FromResult(Shows.TryGetValue(tmdbId, out var show) && show.Seasons.TryGetValue(seasonNumber, out var episodes)
            ? new TmdbTvSeasonCatalog { TmdbId = tmdbId, SeasonNumber = seasonNumber, Title = $"Season {seasonNumber}", Episodes = episodes }
            : null);

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(ExampleMovie);

    private static TmdbEpisode[] Episodes(string firstAirDate, int count, string[] titles)
    {
        var first = DateOnly.Parse(firstAirDate, System.Globalization.CultureInfo.InvariantCulture);
        return Enumerable.Range(1, count).Select(n => new TmdbEpisode
        {
            EpisodeNumber = n,
            Title = n <= titles.Length ? titles[n - 1] : $"Episode {n}",
            AirDate = first.AddDays(7 * (n - 1)).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            RuntimeMinutes = 47,
        }).ToArray();
    }
}
