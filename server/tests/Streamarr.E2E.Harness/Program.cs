using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
using Streamarr.Server;
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
// -----------------------------------------------------------------------------------------

var port = Environment.GetEnvironmentVariable("E2E_PORT") is { Length: > 0 } p ? p : "5099";
var webDist = Environment.GetEnvironmentVariable("E2E_WEB_DIST");
var adminPassword = Environment.GetEnvironmentVariable("E2E_ADMIN_PASSWORD") is { Length: > 0 } ap
    ? ap
    : "streamarr-e2e";

var tempDir = Directory.CreateTempSubdirectory("streamarr-e2e-").FullName;

// --- 1) a real, browser-playable video published to a mock NNTP server -------------------
// WebM/VP8 so Playwright's (proprietary-codec-free) Chromium can decode it in <video>.
var video = await TestMediaFile.GenerateWebmAsync(durationSeconds: 10);
var nntp = new MockNntpServer { RequireAuth = true };
var published = NzbTestFixtures.PublishFile(nntp, "Example.Movie.2021.1080p.WEB-DL.x264-STREAMARR.webm", video, "e2e");
var nzbPath = Path.Combine(tempDir, "example.nzb");
File.WriteAllText(nzbPath, NzbTestFixtures.BuildNzbXml(published));

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

builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
{
    ["Serilog:MinimumLevel:Default"] = "Warning",
    ["Streamarr:ApiKey"] = "e2e-api-key-0123456789abcdef-xyz",
    ["Streamarr:Admin:Username"] = "admin",
    ["Streamarr:Admin:Password"] = adminPassword,
    ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(tempDir, "streamarr.db")}",
    ["Streamarr:DataProtectionKeysPath"] = Path.Combine(tempDir, "keys"),
    ["Streamarr:ConnectionBudget"] = "12",
    ["Streamarr:SessionTtlSeconds"] = "600",
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
});

builder.AddStreamarrServer();

// Replace the two external boundaries (indexer HTTP + TMDB HTTP) with canned fixtures,
// exactly as the integration tests do — everything else is the real DI graph.
builder.Services.RemoveAll<INewznabClient>();
builder.Services.AddSingleton<INewznabClient>(new CannedNewznabClient(nzbPath));
builder.Services.RemoveAll<ITmdbClient>();
builder.Services.AddSingleton<ITmdbClient>(new CannedTmdbClient());

var app = builder.Build();
app.UseStreamarrServer();

await app.StartAsync();

var url = app.Services.GetRequiredService<IServer>()
    .Features.Get<IServerAddressesFeature>()!.Addresses.First();
Console.WriteLine($"[e2e-harness] listening on {url}");
Console.WriteLine($"[e2e-harness] admin=admin password={adminPassword} webRoot={webDist ?? "(none)"}");

await app.WaitForShutdownAsync();

await app.DisposeAsync();
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

/// <summary>Resolves every movie search to a single fixed TMDB work with a runtime.</summary>
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

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(ExampleMovie);

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(null);

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(ExampleMovie);

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(null);

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(ExampleMovie);
}
