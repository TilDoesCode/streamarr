using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Streamarr.Server.Controllers;

namespace Streamarr.Server.Tests;

public class HealthEndpointTests : IClassFixture<HealthEndpointTests.Factory>
{
    private readonly Factory _factory;

    public HealthEndpointTests(Factory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Health_ReturnsOk()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/v1/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<HealthResponse>();
        Assert.NotNull(body);
        Assert.Equal("ok", body!.Status);
        Assert.False(string.IsNullOrEmpty(body.Version));
    }

    /// <summary>Boots the real app against an isolated temp SQLite db + key ring.</summary>
    public sealed class Factory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-health-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:Admin:Password"] = Integration.TestAuth.AdminPassword,
                ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
                ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
            }));
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && Directory.Exists(_dir))
                Directory.Delete(_dir, recursive: true);
        }
    }
}
