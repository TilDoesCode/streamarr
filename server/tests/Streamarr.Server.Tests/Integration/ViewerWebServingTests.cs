using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// The Core Server serves the exported viewer web app under /watch with an SPA fallback, hashed-asset
/// caching and its own CSP, next to the Management SPA. Boots servers with throwaway export folders.
/// </summary>
public sealed class ViewerWebServingTests : IAsyncLifetime
{
    private const string ViewerMarker = "<!--streamarr-viewer-shell-->";
    private const string ManagementMarker = "<!--streamarr-spa-shell-->";
    private const string AssetPath = "/watch/_expo/static/js/web/entry-abc123.js";
    private const string AssetBody = "console.log('viewer');";

    private readonly List<WebApplication> _apps = [];
    private string _tempDir = null!;
    private string _baseUrl = null!;

    public async Task InitializeAsync()
    {
        _tempDir = Directory.CreateTempSubdirectory("streamarr-viewer-web-").FullName;
        var viewerRoot = Path.Combine(_tempDir, "viewer-web");
        Directory.CreateDirectory(Path.Combine(viewerRoot, "_expo", "static", "js", "web"));
        await File.WriteAllTextAsync(
            Path.Combine(viewerRoot, "index.html"),
            $"<!doctype html><html><head><title>Streamarr</title></head><body>{ViewerMarker}<div id=\"root\"></div></body></html>");
        await File.WriteAllTextAsync(Path.Combine(viewerRoot, "_expo", "static", "js", "web", "entry-abc123.js"), AssetBody);

        _baseUrl = await StartServerAsync("with-viewer", viewerRoot);
    }

    private async Task<string> StartServerAsync(string name, string viewerWebPath)
    {
        var dir = Path.Combine(_tempDir, name);
        var webRoot = Path.Combine(dir, "wwwroot");
        Directory.CreateDirectory(webRoot);
        await File.WriteAllTextAsync(
            Path.Combine(webRoot, "index.html"),
            $"<!doctype html><html><body>{ManagementMarker}</body></html>");

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production,
            WebRootPath = webRoot,
        });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = "viewer-web-test-key-0123456789abcdef",
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(dir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(dir, "keys"),
            ["Streamarr:ViewerWebPath"] = viewerWebPath,
            ["Streamarr:Providers:0:Name"] = "dummy",
            ["Streamarr:Providers:0:Host"] = "127.0.0.1",
            ["Streamarr:Providers:0:Port"] = "119",
            ["Streamarr:Providers:0:UseSsl"] = "false",
            ["Streamarr:Providers:0:Username"] = "u",
            ["Streamarr:Providers:0:Password"] = "p",
            ["Streamarr:Providers:0:MaxConnections"] = "1",
        });
        builder.AddStreamarrServer();

        var app = builder.Build();
        _apps.Add(app);
        app.UseStreamarrServer();
        await app.StartAsync();
        return app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.First();
    }

    private static HttpClient Client(string baseUrl) => new() { BaseAddress = new Uri(baseUrl) };

    [Theory]
    [InlineData("/watch/")]
    [InlineData("/watch/some/deep/route")]
    public async Task Shell_and_client_routes_serve_index_html_without_caching(string path)
    {
        using var client = Client(_baseUrl);
        var res = await client.GetAsync(path);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("text/html", res.Content.Headers.ContentType!.MediaType);
        Assert.Contains(ViewerMarker, await res.Content.ReadAsStringAsync());
        Assert.True(res.Headers.CacheControl!.NoCache);
        var csp = Assert.Single(res.Headers.GetValues("Content-Security-Policy"));
        Assert.Contains("frame-ancestors 'none'", csp);
        Assert.Contains("worker-src 'self' blob:", csp);
        Assert.Equal("nosniff", Assert.Single(res.Headers.GetValues("X-Content-Type-Options")));
    }

    [Fact]
    public async Task Bare_prefix_reaches_the_shell()
    {
        using var client = Client(_baseUrl);
        var res = await client.GetAsync("/watch");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains(ViewerMarker, await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Hashed_asset_is_cached_immutably()
    {
        using var client = Client(_baseUrl);
        var res = await client.GetAsync(AssetPath);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(AssetBody, await res.Content.ReadAsStringAsync());
        var cache = res.Headers.CacheControl!;
        Assert.True(cache.Public);
        Assert.Equal(TimeSpan.FromSeconds(31_536_000), cache.MaxAge);
        Assert.Contains(cache.Extensions, e => e.Name == "immutable");
    }

    [Fact]
    public async Task Missing_asset_is_404_not_the_shell()
    {
        using var client = Client(_baseUrl);
        var res = await client.GetAsync("/watch/missing.js");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.DoesNotContain(ViewerMarker, await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Management_spa_is_unaffected()
    {
        using var client = Client(_baseUrl);
        var res = await client.GetAsync("/settings");

        res.EnsureSuccessStatusCode();
        Assert.Contains(ManagementMarker, await res.Content.ReadAsStringAsync());
        var csp = Assert.Single(res.Headers.GetValues("Content-Security-Policy"));
        Assert.DoesNotContain("worker-src", csp);
    }

    [Fact]
    public async Task Route_is_inert_when_the_export_folder_is_missing()
    {
        var baseUrl = await StartServerAsync("without-viewer", Path.Combine(_tempDir, "does-not-exist"));
        using var client = Client(baseUrl);
        var res = await client.GetAsync("/watch/");

        // No endpoint matches, so the auth fallback policy (or a 404) answers — never either shell.
        Assert.False(res.IsSuccessStatusCode);
        var body = await res.Content.ReadAsStringAsync();
        Assert.DoesNotContain(ViewerMarker, body);
        Assert.DoesNotContain(ManagementMarker, body);
    }

    public async Task DisposeAsync()
    {
        foreach (var app in _apps)
            await app.DisposeAsync();
        if (_tempDir != null! && Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }
}
