using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using OtpNet;
using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Tests.Integration;

namespace Streamarr.Server.Tests.Viewers;

public sealed class ManualClock(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;
}

/// <summary>TMDB stand-in: movie ratings plus one two-season series with an unaired finale.</summary>
public sealed class ViewerTmdbFake : ITmdbClient
{
    public const int SeriesId = 100;
    public const int BrokenSeriesId = 200;

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(tmdbId switch
        {
            1 => Movie(1, "PG-13"),
            2 => Movie(2, "R"),
            3 => Movie(3, null),
            4 => Movie(4, "6"),
            _ => null,
        });

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult<TmdbMatch?>(tmdbId == SeriesId
            ? new TmdbMatch { MediaType = MediaType.Tv, TmdbId = SeriesId, Title = "Test Show", OfficialRating = "TV-14" }
            : null);

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (tmdbId == BrokenSeriesId)
            throw new TmdbTransientException("TMDB is down");
        return Task.FromResult<TmdbTvSeriesCatalog?>(tmdbId != SeriesId ? null : new TmdbTvSeriesCatalog
        {
            Series = new TmdbMatch { MediaType = MediaType.Tv, TmdbId = SeriesId, Title = "Test Show", PosterUrl = "https://img/poster.jpg" },
            Seasons =
            [
                new TmdbSeasonSummary { SeasonNumber = 0, Title = "Specials", EpisodeCount = 1 },
                new TmdbSeasonSummary { SeasonNumber = 1, Title = "Season 1", EpisodeCount = 3 },
                new TmdbSeasonSummary { SeasonNumber = 2, Title = "Season 2", EpisodeCount = 2 },
            ],
        });
    }

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
    {
        if (tmdbId != SeriesId)
            return Task.FromResult<TmdbTvSeasonCatalog?>(null);
        TmdbEpisode[] episodes = seasonNumber switch
        {
            0 => [Episode(1, "2019-01-01")],
            1 => [Episode(1, "2020-01-01"), Episode(2, "2020-01-08"), Episode(3, "2020-01-15")],
            2 => [Episode(1, "2021-01-01"), Episode(2, "2099-01-01")],
            _ => [],
        };
        return Task.FromResult<TmdbTvSeasonCatalog?>(new TmdbTvSeasonCatalog
        {
            TmdbId = SeriesId,
            SeasonNumber = seasonNumber,
            Title = $"Season {seasonNumber}",
            Episodes = episodes,
        });
    }

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);

    private static TmdbMatch Movie(int id, string? rating)
        => new() { MediaType = MediaType.Movie, TmdbId = id, Title = $"Movie {id}", OfficialRating = rating };

    private static TmdbEpisode Episode(int number, string airDate)
        => new() { EpisodeNumber = number, Title = $"Episode {number}", AirDate = airDate };
}

public sealed class ViewerApiFactory : WebApplicationFactory<Program>
{
    public const string ApiKey = "machine-key-for-viewer-tests-0123456789";
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-viewers-").FullName;

    public ManualClock Clock { get; } = new(DateTimeOffset.UtcNow);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Production");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:SpecWarmup:Enabled"] = "false",
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
            ["Streamarr:LoginAttemptsPerMinute"] = "1000",
            ["Streamarr:ViewerAuthAttemptsPerMinute"] = "1000",
        }));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
            services.RemoveAll<ITmdbClient>();
            services.AddSingleton<ITmdbClient, ViewerTmdbFake>();
        });
    }

    private readonly SemaphoreSlim _adminGate = new(1, 1);
    private string? _adminToken;

    /// <summary>Admin JWTs are minted once, before tests move the shared clock ahead of the validator's wall clock.</summary>
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
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _adminToken);
        return client;
    }

    public HttpClient Viewer(string accessToken)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }
}

internal static class ViewerApi
{
    public static async Task ConfigureAsync(HttpClient admin, object settings)
    {
        var response = await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", settings);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    public static async Task<JsonElement> CreateAsync(HttpClient admin, object body)
    {
        var response = await admin.PostAsJsonAsync("/api/v1/config/viewers", body);
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    public static Task<HttpResponseMessage> CreateAsyncRaw(HttpClient admin, object body)
        => admin.PostAsJsonAsync("/api/v1/config/viewers", body);

    public static Task<HttpResponseMessage> LoginAsync(HttpClient client, string login, string password, string device = "tests")
        => client.PostAsJsonAsync("/api/v1/viewer/auth/login", new { login, password, deviceName = device });

    public static async Task<JsonElement> SignInAsync(HttpClient client, string login, string password)
    {
        var response = await LoginAsync(client, login, password);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("authenticated", body.GetProperty("status").GetString());
        return body.GetProperty("session");
    }

    public static async Task<string> AccessTokenAsync(HttpClient client, string login, string password)
        => (await SignInAsync(client, login, password)).GetProperty("accessToken").GetString()!;

    public static async Task<string> ErrorCodeAsync(HttpResponseMessage response)
        => (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetProperty("code").GetString()!;

    public static string Totp(string secret, DateTimeOffset at)
        => new Totp(Base32Encoding.ToBytes(secret)).ComputeTotp(at.UtcDateTime);

    public static long Ticks(double minutes) => TimeSpan.FromMinutes(minutes).Ticks;
}
