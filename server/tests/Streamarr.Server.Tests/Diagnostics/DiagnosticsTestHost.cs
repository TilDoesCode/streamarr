using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>Newznab stand-in whose caps answer depends on the indexer host: ok, a wrong key, or a timeout.</summary>
public sealed class HostScriptedNewznab : INewznabClient
{
    public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
        => new Uri(indexer.BaseUrl).Host switch
        {
            "auth.example" => throw new NewznabRequestException("Newznab error 100: Incorrect user credentials", isTransient: false),
            "slow.example" => throw new NewznabRequestException($"Request to indexer '{indexer.Name}' timed out."),
            _ => Task.FromResult(new NewznabCapabilities { ServerTitle = "fake", SearchAvailable = true }),
        };

    public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
        => Task.FromResult(new NewznabSearchResponse { Items = [] });
}

/// <summary>TMDB stand-in that only answers the diagnostics probe.</summary>
public sealed class ProbeOnlyTmdb : ITmdbClient
{
    public TmdbProbeResult Probe { get; set; } = new(true);

    public Task<TmdbProbeResult?> ProbeAsync(CancellationToken cancellationToken) => Task.FromResult<TmdbProbeResult?>(Probe);

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
}

/// <summary>Viewer-enabled server with two indexers (one with a wrong key) and two real mock NNTP providers (one with a wrong password).</summary>
public class DiagnosticsFactory : ViewerApiFactory
{
    public const string ViewerName = "diag-viewer";
    public const string ViewerPassword = "correct horse battery";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private bool _seeded;
    private bool _disposed;

    public ProbeOnlyTmdb Tmdb { get; } = new();
    public MockNntpServer GoodNntp { get; } = new() { RequireAuth = true };
    public MockNntpServer StrictNntp { get; } = new() { RequireAuth = true };

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<INewznabClient>();
            services.AddSingleton<INewznabClient>(new HostScriptedNewznab());
            services.RemoveAll<ITmdbClient>();
            services.AddSingleton<ITmdbClient>(Tmdb);
        });
    }

    /// <summary>Configures the indexers, providers and a viewer once per fixture; returns the viewer's access token.</summary>
    public async Task<string> SeedAsync()
    {
        await _gate.WaitAsync();
        try
        {
            using var admin = await AdminAsync();
            if (!_seeded)
            {
                await Post(admin, "/api/v1/config/indexers", new { name = "Good Indexer", baseUrl = "https://ok.example", apiKey = "idx-secret-key-1", categories = new[] { 2000 } });
                await Post(admin, "/api/v1/config/indexers", new { name = "Wrong Key Indexer", baseUrl = "https://auth.example", apiKey = "idx-secret-key-2", categories = new[] { 2000 } });
                await Post(admin, "/api/v1/config/providers", new { name = "Main Provider", host = GoodNntp.Host, port = GoodNntp.Port, useSsl = false, username = GoodNntp.Username, password = GoodNntp.Password, maxConnections = 2, priority = 0 });
                await Post(admin, "/api/v1/config/providers", new { name = "Wrong Password Provider", host = StrictNntp.Host, port = StrictNntp.Port, useSsl = false, username = "user", password = "nope", maxConnections = 2, priority = 1 });
                await ViewerApi.ConfigureAsync(admin, new { enabled = true });
                await ViewerApi.CreateAsync(admin, new { username = ViewerName, password = ViewerPassword });
                _seeded = true;
            }
            using var anon = CreateClient();
            return await ViewerApi.AccessTokenAsync(anon, ViewerName, ViewerPassword);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task Post(HttpClient admin, string path, object body)
    {
        var response = await admin.PostAsJsonAsync(path, body);
        Assert.True(response.IsSuccessStatusCode, $"{path}: {await response.Content.ReadAsStringAsync()}");
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && !_disposed)
        {
            _disposed = true;
            GoodNntp.DisposeAsync().AsTask().GetAwaiter().GetResult();
            StrictNntp.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }
}
