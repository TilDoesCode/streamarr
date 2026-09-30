using System.Net;
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
using Streamarr.Core.Tmdb;
using Streamarr.Server.Tests.Integration;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>TMDB behind the production caching decorator, switchable into a transient outage per call kind.</summary>
public sealed class FlakyTmdb(ITmdbClient inner) : ITmdbClient
{
    public volatile bool ListsDown;
    public volatile bool DetailsDown;

    private Task<T> Call<T>(bool down, Func<Task<T>> call) => down ? throw new TmdbTransientException("TMDB returned 503.") : call();

    public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(string query, MediaType? mediaType, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.SearchCandidatesAsync(query, mediaType, cancellationToken));

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.SearchAnyAsync(query, cancellationToken));

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.SearchMovieAsync(title, year, cancellationToken));

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.SearchTvAsync(title, cancellationToken));

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => Call(DetailsDown, () => inner.GetMovieAsync(tmdbId, cancellationToken));

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => Call(DetailsDown, () => inner.GetTvAsync(tmdbId, cancellationToken));

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
        => Call(DetailsDown, () => inner.GetTvSeriesCatalogAsync(tmdbId, cancellationToken));

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
        => Call(DetailsDown, () => inner.GetTvSeasonCatalogAsync(tmdbId, seasonNumber, cancellationToken));

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
        => Call(DetailsDown, () => inner.FindByImdbAsync(imdbId, cancellationToken));

    public Task<IReadOnlyList<TmdbMatch>> GetTrendingAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.GetTrendingAsync(mediaType, cancellationToken));

    public Task<IReadOnlyList<TmdbMatch>> GetPopularAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.GetPopularAsync(mediaType, cancellationToken));

    public Task<TmdbDiscoverPage> DiscoverAsync(TmdbDiscoverQuery query, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.DiscoverAsync(query, cancellationToken));

    public Task<IReadOnlyList<TmdbGenre>> GetGenresAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Call(ListsDown, () => inner.GetGenresAsync(mediaType, cancellationToken));
}

public sealed class ViewerCatalogOutageFactory : WebApplicationFactory<Program>
{
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-outage-").FullName;

    private FlakyTmdb? _tmdb;

    public CatalogTmdbFake Fake { get; } = new();

    public FlakyTmdb Tmdb => _tmdb ??= new(Fake);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Production");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = ViewerCatalogFactory.ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
            ["Streamarr:LoginAttemptsPerMinute"] = "1000",
            ["Streamarr:ViewerAuthAttemptsPerMinute"] = "1000",
            ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
            ["Streamarr:Indexers:0:Name"] = ViewerCatalogFactory.IndexerName,
            ["Streamarr:Indexers:0:BaseUrl"] = "https://indexer.catalog.example",
            ["Streamarr:Indexers:0:ApiKey"] = ViewerCatalogFactory.IndexerKey,
            ["Streamarr:Indexers:0:Categories:0"] = "2000",
        }));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<ITmdbClient>();
            services.AddSingleton<ITmdbClient>(new CachingTmdbClient(Tmdb, TimeSpan.FromHours(1)));
            services.RemoveAll<INewznabClient>();
            services.AddSingleton<INewznabClient>(new CatalogNewznabFake());
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }
}

/// <summary>A TMDB outage is a retryable <c>503 catalog_unavailable</c>, never "not found" or an empty list, and is not cached.</summary>
public sealed class ViewerCatalogOutageTests(ViewerCatalogOutageFactory factory) : IClassFixture<ViewerCatalogOutageFactory>, IAsyncLifetime
{
    private const string Base = "/api/v1/viewer/catalog";
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = factory.CreateClient();
        _admin.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", await TestAuth.LoginAsAdminAsync(factory.CreateClient()));
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        factory.Tmdb.ListsDown = factory.Tmdb.DetailsDown = false;
        return Task.CompletedTask;
    }

    private async Task<HttpClient> ViewerAsync(string name, object? permissions = null)
    {
        var username = $"{name}-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(_admin, new { username, password = "correct horse battery", permissions });
        using var anon = factory.CreateClient();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", await ViewerApi.AccessTokenAsync(anon, username, "correct horse battery"));
        return client;
    }

    private static async Task AssertUnavailableAsync(HttpClient client, string path)
    {
        var response = await client.GetAsync(path);
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.ServiceUnavailable, $"{path}: {(int)response.StatusCode} {body}");
        Assert.Equal("catalog_unavailable", JsonDocument.Parse(body).RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("1", response.Headers.RetryAfter?.ToString());
    }

    [Fact]
    public async Task TmdbOutage_IsARetryable503_ForDetailsListsAndVersions()
    {
        using var viewer = await ViewerAsync("outage");
        factory.Tmdb.ListsDown = factory.Tmdb.DetailsDown = true;

        await AssertUnavailableAsync(viewer, $"{Base}/movies/{CatalogTmdbFake.Movie}");
        await AssertUnavailableAsync(viewer, $"{Base}/series/{CatalogTmdbFake.Show}");
        await AssertUnavailableAsync(viewer, $"{Base}/series/{CatalogTmdbFake.Show}/seasons/1");
        await AssertUnavailableAsync(viewer, $"{Base}/works/tmdb-movie-{CatalogTmdbFake.Movie}/versions");
        await AssertUnavailableAsync(viewer, $"{Base}/search?q=movie");
        await AssertUnavailableAsync(viewer, $"{Base}/discover");

        factory.Tmdb.ListsDown = factory.Tmdb.DetailsDown = false;
        var movie = await viewer.GetFromJsonAsync<JsonElement>($"{Base}/movies/{CatalogTmdbFake.Movie}");
        Assert.Equal("Catalog Movie", movie.GetProperty("title").GetString());
        var discover = await viewer.GetFromJsonAsync<JsonElement>($"{Base}/discover");
        Assert.Equal(4, discover.GetProperty("rows").GetArrayLength());
    }

    [Fact]
    public async Task Browse_AndGenres_AreRetryable503sInAnOutage_AndCachedPerQueryAfterwards()
    {
        using var viewer = await ViewerAsync("browseoutage");
        factory.Tmdb.ListsDown = true;

        await AssertUnavailableAsync(viewer, $"{Base}/browse?type=movie&sort=newest&page=2");
        await AssertUnavailableAsync(viewer, $"{Base}/genres?type=series");

        factory.Tmdb.ListsDown = false;
        var (discover, genres) = (factory.Fake.DiscoverCalls, factory.Fake.GenreCalls);
        var first = await viewer.GetFromJsonAsync<JsonElement>($"{Base}/browse?type=movie&sort=newest&page=2");
        var again = await viewer.GetFromJsonAsync<JsonElement>($"{Base}/browse?type=movie&sort=newest&page=2");
        await viewer.GetFromJsonAsync<JsonElement>($"{Base}/browse?type=movie&sort=newest&page=3");
        await viewer.GetFromJsonAsync<JsonElement>($"{Base}/browse?type=movie&sort=newest&page=2&genre={CatalogTmdbFake.DramaGenre}");
        await viewer.GetFromJsonAsync<JsonElement>($"{Base}/genres?type=series");
        await viewer.GetFromJsonAsync<JsonElement>($"{Base}/genres?type=series");

        Assert.Equal(first.GetRawText(), again.GetRawText());
        Assert.Equal(discover + 3, factory.Fake.DiscoverCalls);
        Assert.Equal(genres + 1, factory.Fake.GenreCalls);
    }

    [Fact]
    public async Task FailedCertificationLookups_AreA503_NotAnEmptyListForRestrictedViewers()
    {
        using var kid = await ViewerAsync("outagekid", new { maxAge = 12, blockUnrated = true });
        factory.Tmdb.DetailsDown = true;

        await AssertUnavailableAsync(kid, $"{Base}/search?q=movie");
        await AssertUnavailableAsync(kid, $"{Base}/discover");

        factory.Tmdb.DetailsDown = false;
        var search = await kid.GetFromJsonAsync<JsonElement>($"{Base}/search?q=movie");
        Assert.Equal([CatalogTmdbFake.KidsMovie, CatalogTmdbFake.BrokenMovie],
            search.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("tmdbId").GetInt32()).Order().ToArray());
    }

    [Fact]
    public async Task AgeGate_DuringATmdbOutage_IsA503ForRestrictedViewers_NotAgeRestricted()
    {
        using var kid = await ViewerAsync("gatekid", new { maxAge = 12, blockUnrated = true });
        using var adult = await ViewerAsync("gateadult");
        const string work = "tmdb-movie-999";
        var device = new { platform = "web", engines = new[] { new { engine = "web", hls = true, containers = new[] { "mp4" },
            videoCodecs = new[] { new { codec = "h264" } }, audioCodecs = new[] { new { codec = "aac" } } } } };
        factory.Tmdb.DetailsDown = true;

        await AssertUnavailableAsync(kid, $"/api/v1/viewer/access/{work}");
        var start = await kid.PostAsJsonAsync("/api/v1/viewer/playback", new { workId = work, device });
        var startBody = await start.Content.ReadAsStringAsync();
        Assert.True(start.StatusCode == HttpStatusCode.ServiceUnavailable, $"{(int)start.StatusCode} {startBody}");
        Assert.Equal("catalog_unavailable", JsonDocument.Parse(startBody).RootElement.GetProperty("error").GetProperty("code").GetString());
        var unrestricted = await adult.GetFromJsonAsync<JsonElement>($"/api/v1/viewer/access/{work}");
        Assert.True(unrestricted.GetProperty("allowed").GetBoolean());

        factory.Tmdb.DetailsDown = false;
        var unknown = await kid.GetFromJsonAsync<JsonElement>($"/api/v1/viewer/access/{work}");
        Assert.False(unknown.GetProperty("allowed").GetBoolean());
        Assert.Equal("rating_unavailable", unknown.GetProperty("reason").GetString());
    }
}
