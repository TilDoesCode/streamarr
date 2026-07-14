using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

public sealed class AdminCookieAuthTests : IClassFixture<AdminCookieAuthTests.Factory>
{
    private const string NewPassword = "changed-admin-password";
    private readonly Factory _factory;

    public AdminCookieAuthTests(Factory factory) => _factory = factory;

    [Fact]
    public async Task LoginCookie_IsHardened_CsrfChecked_AndLogoutRevokesJwt()
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
        var payload = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(payload);

        var setCookie = Assert.Single(login.Headers.GetValues("Set-Cookie"));
        var lower = setCookie.ToLowerInvariant();
        Assert.Contains("streamarr_admin=", lower);
        Assert.Contains("httponly", lower);
        Assert.Contains("samesite=strict", lower);
        Assert.Contains("secure", lower);
        Assert.Contains("path=/", lower);
        Assert.Contains("no-store", login.Headers.CacheControl!.ToString());

        // The browser authenticates without exposing the JWT to application code.
        using var config = await browser.GetAsync("/api/v1/config/general");
        Assert.Equal(HttpStatusCode.OK, config.StatusCode);
        Assert.True(config.Headers.CacheControl!.NoStore);
        Assert.True(config.Headers.CacheControl.Private);
        Assert.Contains("Cookie", config.Headers.Vary);

        // Ambient cookie credentials cannot mutate state without exact-origin proof.
        using var rejected = await browser.PostAsync("/api/v1/auth/logout", null);
        Assert.Equal(HttpStatusCode.Forbidden, rejected.StatusCode);

        // Password rotation deletes the browser cookie in the same authenticated
        // response; a follow-up logout would already be unauthorized by design.
        using var passwordRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/password")
        {
            Content = JsonContent.Create(new
            {
                currentPassword = TestAuth.AdminPassword,
                newPassword = NewPassword,
            }),
        };
        passwordRequest.Headers.Add("Origin", "https://localhost");
        using var password = await browser.SendAsync(passwordRequest);
        Assert.Equal(HttpStatusCode.NoContent, password.StatusCode);
        Assert.True(password.Headers.CacheControl!.NoStore);
        Assert.Contains(password.Headers.GetValues("Set-Cookie"), value =>
            value.Contains("streamarr_admin=", StringComparison.OrdinalIgnoreCase) &&
            value.Contains("expires=", StringComparison.OrdinalIgnoreCase));

        // Conservative key rotation makes a copied bearer from that session unusable.
        using var replay = _factory.CreateClient();
        replay.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", payload!.Token);
        using var replayResponse = await replay.GetAsync("/api/v1/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, replayResponse.StatusCode);

        using var afterPasswordChange = await browser.GetAsync("/api/v1/config/general");
        Assert.Equal(HttpStatusCode.Unauthorized, afterPasswordChange.StatusCode);

        using var relogin = await browser.PostAsJsonAsync("/api/v1/auth/login", new
        {
            username = "admin",
            password = NewPassword,
        });
        Assert.Equal(HttpStatusCode.OK, relogin.StatusCode);

        using var logoutRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/logout");
        logoutRequest.Headers.Add("Origin", "https://localhost");
        using var logout = await browser.SendAsync(logoutRequest);
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);
        Assert.Contains(logout.Headers.GetValues("Set-Cookie"), value =>
            value.Contains("streamarr_admin=", StringComparison.OrdinalIgnoreCase) &&
            value.Contains("expires=", StringComparison.OrdinalIgnoreCase));
    }

    public sealed class Factory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-cookie-auth-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
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
