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
/// Production single-origin path (BRIEF §4): the Core Server serves the built Management SPA
/// from wwwroot as static files with an SPA fallback, while /api and /openapi keep their own
/// behavior. Boots a server with a throwaway wwwroot so no real SPA build is required.
/// </summary>
public sealed class SpaServingTests : IAsyncLifetime
{
    private const string IndexMarker = "<!--streamarr-spa-shell-->";
    private const string AssetBody = "console.log('streamarr');";

    private WebApplication _app = null!;
    private string _tempDir = null!;
    private string _baseUrl = null!;

    public async Task InitializeAsync()
    {
        _tempDir = Directory.CreateTempSubdirectory("streamarr-spa-").FullName;
        var webRoot = Path.Combine(_tempDir, "wwwroot");
        Directory.CreateDirectory(Path.Combine(webRoot, "assets"));
        await File.WriteAllTextAsync(
            Path.Combine(webRoot, "index.html"),
            $"<!doctype html><html><head><title>Streamarr</title></head><body>{IndexMarker}<div id=\"root\"></div></body></html>");
        await File.WriteAllTextAsync(Path.Combine(webRoot, "assets", "app.js"), AssetBody);

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production,
            WebRootPath = webRoot,
        });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = "spa-test-key",
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_tempDir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_tempDir, "keys"),
            ["Streamarr:Providers:0:Name"] = "dummy",
            ["Streamarr:Providers:0:Host"] = "127.0.0.1",
            ["Streamarr:Providers:0:Port"] = "119",
            ["Streamarr:Providers:0:UseSsl"] = "false",
            ["Streamarr:Providers:0:Username"] = "u",
            ["Streamarr:Providers:0:Password"] = "p",
            ["Streamarr:Providers:0:MaxConnections"] = "1",
        });
        builder.AddStreamarrServer();

        _app = builder.Build();
        _app.UseStreamarrServer();
        await _app.StartAsync();
        _baseUrl = _app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.First();
    }

    private HttpClient Client() => new() { BaseAddress = new Uri(_baseUrl) };

    [Fact]
    public async Task Root_serves_the_spa_shell_without_auth()
    {
        using var client = Client();
        var res = await client.GetAsync("/");
        res.EnsureSuccessStatusCode();
        Assert.Contains("text/html", res.Content.Headers.ContentType!.MediaType);
        Assert.Contains(IndexMarker, await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Client_side_route_falls_back_to_index_html()
    {
        using var client = Client();
        // A deep client-side route the server has no controller for — must resolve to the shell.
        var res = await client.GetAsync("/settings");
        res.EnsureSuccessStatusCode();
        Assert.Contains(IndexMarker, await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Static_asset_is_served()
    {
        using var client = Client();
        var res = await client.GetAsync("/assets/app.js");
        res.EnsureSuccessStatusCode();
        Assert.Equal(AssetBody, await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Unknown_api_route_is_not_swallowed_by_the_spa_fallback()
    {
        using var client = Client();
        var res = await client.GetAsync("/api/v1/does-not-exist");
        // The SPA fallback excludes /api, so this hits the auth fallback policy (401) and is
        // never answered with the HTML shell — API clients keep seeing clean, non-HTML errors.
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        var body = await res.Content.ReadAsStringAsync();
        Assert.DoesNotContain(IndexMarker, body);
    }

    [Fact]
    public async Task Openapi_spec_still_served_with_spa_enabled()
    {
        using var client = Client();
        var res = await client.GetAsync("/openapi/v1.json");
        res.EnsureSuccessStatusCode();
        Assert.Contains("openapi", await res.Content.ReadAsStringAsync());
    }

    public async Task DisposeAsync()
    {
        if (_app != null!)
            await _app.DisposeAsync();
        if (_tempDir != null! && Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }
}
