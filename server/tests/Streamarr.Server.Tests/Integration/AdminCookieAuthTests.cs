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

        var setCookies = login.Headers.GetValues("Set-Cookie").ToArray();
        var setCookie = Assert.Single(setCookies, value =>
            value.StartsWith("streamarr_admin=", StringComparison.OrdinalIgnoreCase));
        var refreshCookie = Assert.Single(setCookies, value =>
            value.StartsWith("streamarr_admin_refresh=", StringComparison.OrdinalIgnoreCase));
        var lower = setCookie.ToLowerInvariant();
        Assert.Contains("streamarr_admin=", lower);
        Assert.Contains("httponly", lower);
        Assert.Contains("samesite=strict", lower);
        Assert.Contains("secure", lower);
        Assert.Contains("path=/", lower);
        var refreshLower = refreshCookie.ToLowerInvariant();
        Assert.Contains("httponly", refreshLower);
        Assert.Contains("samesite=strict", refreshLower);
        Assert.Contains("secure", refreshLower);
        Assert.Contains("path=/api/v1/auth", refreshLower);
        Assert.True(payload!.RefreshExpiresAt > payload.ExpiresAt);
        Assert.Contains("no-store", login.Headers.CacheControl!.ToString());
        var originalRefreshToken = CookieValue(refreshCookie, "streamarr_admin_refresh");

        using var refreshRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/refresh");
        refreshRequest.Headers.Add("Origin", "https://localhost");
        using var refresh = await browser.SendAsync(refreshRequest);
        Assert.Equal(HttpStatusCode.OK, refresh.StatusCode);
        var refreshedPayload = await refresh.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(refreshedPayload);
        Assert.NotEqual(payload.Token, refreshedPayload.Token);
        Assert.True(refreshedPayload.RefreshExpiresAt > refreshedPayload.ExpiresAt);
        Assert.Contains(refresh.Headers.GetValues("Set-Cookie"), value =>
            value.StartsWith("streamarr_admin_refresh=", StringComparison.OrdinalIgnoreCase));
        var rotatedRefreshToken = CookieValue(
            refresh.Headers.GetValues("Set-Cookie").Single(value =>
                value.StartsWith("streamarr_admin_refresh=", StringComparison.OrdinalIgnoreCase)),
            "streamarr_admin_refresh");

        // Two tabs can cross the access deadline together. A replay during the short rotation
        // grace receives the same replacement instead of invalidating the newly refreshed tab.
        using var concurrentTab = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"),
            HandleCookies = false,
        });
        using var concurrentRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/refresh");
        concurrentRequest.Headers.Add("Origin", "https://localhost");
        concurrentRequest.Headers.Add("Cookie", $"streamarr_admin_refresh={originalRefreshToken}");
        using var concurrentRefresh = await concurrentTab.SendAsync(concurrentRequest);
        Assert.Equal(HttpStatusCode.OK, concurrentRefresh.StatusCode);
        var concurrentRefreshToken = CookieValue(
            concurrentRefresh.Headers.GetValues("Set-Cookie").Single(value =>
                value.StartsWith("streamarr_admin_refresh=", StringComparison.OrdinalIgnoreCase)),
            "streamarr_admin_refresh");
        Assert.Equal(rotatedRefreshToken, concurrentRefreshToken);

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
        replay.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", refreshedPayload!.Token);
        using var replayResponse = await replay.GetAsync("/api/v1/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, replayResponse.StatusCode);

        using var afterPasswordChange = await browser.GetAsync("/api/v1/config/general");
        Assert.Equal(HttpStatusCode.Unauthorized, afterPasswordChange.StatusCode);

        using var revokedRefreshRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/refresh");
        revokedRefreshRequest.Headers.Add("Origin", "https://localhost");
        revokedRefreshRequest.Headers.Add("Cookie", $"streamarr_admin_refresh={rotatedRefreshToken}");
        using var revokedRefresh = await concurrentTab.SendAsync(revokedRefreshRequest);
        Assert.Equal(HttpStatusCode.Unauthorized, revokedRefresh.StatusCode);

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

        using var refreshAfterLogoutRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/refresh");
        refreshAfterLogoutRequest.Headers.Add("Origin", "https://localhost");
        using var refreshAfterLogout = await browser.SendAsync(refreshAfterLogoutRequest);
        Assert.Equal(HttpStatusCode.Unauthorized, refreshAfterLogout.StatusCode);
    }

    private static string CookieValue(string setCookie, string name)
    {
        var prefix = name + "=";
        Assert.StartsWith(prefix, setCookie, StringComparison.OrdinalIgnoreCase);
        var end = setCookie.IndexOf(';', prefix.Length);
        return setCookie[prefix.Length..(end < 0 ? setCookie.Length : end)];
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
