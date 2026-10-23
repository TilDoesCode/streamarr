using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Tests.Integration;
using Streamarr.Server.Viewers.MyList;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Mutable TMDB stand-in for the list: episodes and seasons can be added and air dates moved while a test runs.</summary>
public sealed class MyListTmdbFake : ITmdbClient
{
    public const int WeeklyShow = 700, Movie = 701, RatedMovie = 702, EndedShow = 710, SeasonShow = 720;

    private readonly ConcurrentDictionary<int, int> _seriesCalls = new();

    /// <summary>Episodes per (series, season) as (number, air date).</summary>
    public ConcurrentDictionary<(int Series, int Season), (int Number, string AirDate)[]> Episodes { get; } = new();

    public ConcurrentDictionary<int, string> Status { get; } = new();

    public int SeriesCalls(int tmdbId) => _seriesCalls.GetValueOrDefault(tmdbId);

    private static readonly Dictionary<int, string> Titles = new()
    {
        [WeeklyShow] = "Weekly Show", [EndedShow] = "Ended Show", [SeasonShow] = "Season Show",
    };

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(tmdbId switch
        {
            Movie => new TmdbMatch { MediaType = MediaType.Movie, TmdbId = Movie, Title = "List Movie", Year = 2024, OfficialRating = "PG", PosterUrl = "https://img.example/701.jpg" },
            RatedMovie => new TmdbMatch { MediaType = MediaType.Movie, TmdbId = RatedMovie, Title = "Rated Movie", Year = 2024, OfficialRating = "R" },
            _ => null,
        });

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult(Titles.TryGetValue(tmdbId, out var title) ? Series(tmdbId, title) : null);

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
    {
        _seriesCalls.AddOrUpdate(tmdbId, 1, (_, n) => n + 1);
        if (!Titles.TryGetValue(tmdbId, out var title))
            return Task.FromResult<TmdbTvSeriesCatalog?>(null);
        var seasons = Episodes.Where(p => p.Key.Series == tmdbId).OrderBy(p => p.Key.Season)
            .Select(p => new TmdbSeasonSummary
            {
                SeasonNumber = p.Key.Season,
                Title = $"Season {p.Key.Season}",
                EpisodeCount = p.Value.Length,
                AirDate = p.Value.FirstOrDefault().AirDate,
            })
            .ToList();
        return Task.FromResult<TmdbTvSeriesCatalog?>(new TmdbTvSeriesCatalog
        {
            Series = Series(tmdbId, title),
            Seasons = seasons,
            Status = Status.GetValueOrDefault(tmdbId, "Returning Series"),
        });
    }

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
        => Task.FromResult(Episodes.TryGetValue((tmdbId, seasonNumber), out var episodes)
            ? new TmdbTvSeasonCatalog
            {
                TmdbId = tmdbId,
                SeasonNumber = seasonNumber,
                Title = $"Season {seasonNumber}",
                Episodes = episodes.Select(e => new TmdbEpisode { EpisodeNumber = e.Number, Title = $"Episode {e.Number}", AirDate = e.AirDate }).ToList(),
            }
            : null);

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => Task.FromResult(Titles.Where(t => string.Equals(t.Value, title.Replace('.', ' '), StringComparison.OrdinalIgnoreCase))
            .Select(t => Series(t.Key, t.Value)).FirstOrDefault());

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);

    private static TmdbMatch Series(int id, string title)
        => new() { MediaType = MediaType.Tv, TmdbId = id, Title = title, Year = 2025, OfficialRating = "TV-14", PosterUrl = $"https://img.example/{id}.jpg" };
}

/// <summary>Indexer stand-in: releases per (series, season) that tests add over time; <see cref="Down"/> fails every search.</summary>
public sealed class MyListNewznabFake : INewznabClient
{
    private int _searches;

    public ConcurrentDictionary<(int Series, int Season), ConcurrentBag<string>> Releases { get; } = new();

    public volatile bool Down;

    public int Searches => Volatile.Read(ref _searches);

    public void Add(int series, int season, string title) => Releases.GetOrAdd((series, season), _ => []).Add(title);

    public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
        => Task.FromResult(new NewznabCapabilities());

    public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _searches);
        if (Down)
            throw new HttpRequestException("indexer down");
        var items = query.TmdbId is { } id && query.Season is { } season && Releases.TryGetValue((id, season), out var titles)
            ? titles.Select(t => new NewznabItem
            {
                Title = t,
                Guid = $"guid-{t}",
                SizeBytes = 2_000_000_000,
                Grabs = 10,
                NzbUrl = $"https://nzb.mylist.example/get/{Uri.EscapeDataString(t)}.nzb",
                PublishDate = DateTimeOffset.UtcNow.AddDays(-1),
            }).ToArray()
            : [];
        return Task.FromResult(new NewznabSearchResponse { Items = items, Total = items.Length });
    }
}

/// <summary>A host for list tests: mutable TMDB and indexer fakes, a manual clock, monitor passes run by the tests.</summary>
public sealed class MyListFactory : WebApplicationFactory<Program>
{
    public const string Password = "correct horse battery";
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-mylist-").FullName;
    private string? _adminToken;

    /// <summary>Starts at the wall clock (admin JWTs are checked against it); air dates are relative to <see cref="Start"/>.</summary>
    public ManualClock Clock { get; } = new(DateTimeOffset.UtcNow);

    public DateOnly Start { get; } = DateOnly.FromDateTime(DateTime.UtcNow);

    /// <summary>An air date <paramref name="offset"/> days from the start.</summary>
    public string Day(int offset) => Start.AddDays(offset).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
    public MyListTmdbFake Tmdb { get; } = new();
    public MyListNewznabFake Newznab { get; } = new();

    public MyListMonitor Monitor => Services.GetRequiredService<MyListMonitor>();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Production");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = "machine-key-for-mylist-tests-0123456789",
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
            ["Streamarr:LoginAttemptsPerMinute"] = "1000",
            ["Streamarr:ViewerAuthAttemptsPerMinute"] = "1000",
            ["Streamarr:SpecWarmup:Enabled"] = "false",
            ["Streamarr:MyList:MonitorEnabled"] = "false",
            ["Streamarr:Search:SearchCacheTtlSeconds"] = "0",
            ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
            ["Streamarr:Search:MaxTransientRetries"] = "0",
            ["Streamarr:Indexers:0:Name"] = "mylist-indexer",
            ["Streamarr:Indexers:0:BaseUrl"] = "https://indexer.mylist.example",
            ["Streamarr:Indexers:0:ApiKey"] = "mylist-indexer-key",
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
        });
    }

    /// <summary>Enables viewers, creates one and returns a signed-in client.</summary>
    public async Task<HttpClient> ViewerAsync(string username, object? permissions = null)
    {
        _adminToken ??= await TestAuth.LoginAsAdminAsync(CreateClient());
        var admin = Bearer(_adminToken);
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        await ViewerApi.CreateAsync(admin, new { username, password = Password, permissions });
        return await SignInAsync(username);
    }

    /// <summary>A fresh session (access tokens expire on the manual clock once a test moves it by days).</summary>
    public async Task<HttpClient> SignInAsync(string username)
        => Bearer(await ViewerApi.AccessTokenAsync(CreateClient(), username, Password));

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

internal static class MyListApi
{
    public static async Task MarkPlayedAsync(HttpClient viewer, params string[] workIds)
    {
        var response = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    public static async Task<JsonElement> ListAsync(HttpClient viewer, string? status = null)
        => await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/list" + (status is null ? "" : $"?status={status}"));

    public static async Task<JsonElement> ItemAsync(HttpClient viewer, string workId)
        => (await ListAsync(viewer)).GetProperty("items").EnumerateArray().Single(i => i.GetProperty("workId").GetString() == workId);

    public static async Task<JsonElement> SummaryAsync(HttpClient viewer)
        => await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/list/summary");
}
