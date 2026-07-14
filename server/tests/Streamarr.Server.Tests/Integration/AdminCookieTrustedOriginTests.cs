using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// The CSRF same-origin gate must accept a browser Origin that can never match the origin
/// Kestrel reconstructs locally — the case when the Management UI is served through a
/// TLS-terminating tunnel / Codecraft forwarded URL — but only when that exact origin is
/// on the operator-configured <c>TrustedOrigins</c> allowlist.
/// </summary>
public sealed class AdminCookieTrustedOriginTests : IClassFixture<AdminCookieTrustedOriginTests.Factory>
{
    private const string TrustedOrigin = "https://ui.example.test";
    private readonly Factory _factory;

    public AdminCookieTrustedOriginTests(Factory factory) => _factory = factory;

    [Fact]
    public async Task CookieMutation_AcceptsAllowlistedOrigin_ButStillRejectsForeignOrigin()
    {
        using var browser = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = true,
        });
        using var login = await browser.PostAsJsonAsync("/api/v1/auth/login", new
        {
            username = "admin",
            password = TestAuth.AdminPassword,
        });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);

        // An Origin that is neither same-origin nor allowlisted is still rejected, leaving the
        // session intact (the CSRF middleware short-circuits before the logout handler runs).
        using var foreignRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/logout");
        foreignRequest.Headers.Add("Origin", "https://evil.example");
        using var foreign = await browser.SendAsync(foreignRequest);
        Assert.Equal(HttpStatusCode.Forbidden, foreign.StatusCode);

        // The allowlisted browser-visible origin — cross-origin from Kestrel's local view
        // (http/localhost) — is accepted.
        using var allowedRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/logout");
        allowedRequest.Headers.Add("Origin", TrustedOrigin);
        using var allowed = await browser.SendAsync(allowedRequest);
        Assert.Equal(HttpStatusCode.NoContent, allowed.StatusCode);
    }

    public sealed class Factory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-trusted-origin-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
                ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
                ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
                // Also exercises the "blank entries are ignored" tolerance for env-injected origins.
                ["Streamarr:TrustedOrigins:0"] = TrustedOrigin,
                ["Streamarr:TrustedOrigins:1"] = "",
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
