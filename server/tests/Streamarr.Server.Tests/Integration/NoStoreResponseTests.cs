using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Streamarr.Server.Security;
using Streamarr.Server.Tests.Viewers;

namespace Streamarr.Server.Tests.Integration;

internal static class NoStoreAssert
{
    public static void Holds(HttpResponseMessage response, string what)
    {
        var cacheControl = response.Headers.CacheControl;
        Assert.True(cacheControl is { NoStore: true, Private: true },
            $"{what} -> {(int)response.StatusCode}: Cache-Control '{cacheControl}' lacks private, no-store");
        Assert.True(response.Headers.Pragma.Any(p => p.Name == "no-cache"), $"{what}: Pragma no-cache missing");
    }
}

/// <summary>Every operation in the OpenAPI document answers with no-store, whatever its status, caller or method.</summary>
public sealed partial class NoStoreRouteWalkTests(ViewerApiFactory factory) : IClassFixture<ViewerApiFactory>
{
    [GeneratedRegex(@"\{[^}]+\}")]
    private static partial Regex RouteParameter();

    [Fact]
    public async Task EveryOpenApiOperation_SendsNoStore_AnonymousAndAsAdmin()
    {
        using var anon = factory.CreateClient();
        using var spec = JsonDocument.Parse(await anon.GetStringAsync("/openapi/v1.json"));
        var operations = spec.RootElement.GetProperty("paths").EnumerateObject()
            .SelectMany(p => p.Value.EnumerateObject().Select(o => (Path: p.Name, Method: o.Name.ToUpperInvariant())))
            .ToList();
        Assert.True(operations.Count > 100, $"only {operations.Count} operations in the spec");
        Assert.All(operations, op => Assert.StartsWith("/api/", op.Path));

        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true, email = new { mode = "outbox" } });
        foreach (var client in new[] { anon, admin })
        {
            // Mutating calls run last so a sign-out or logout cannot hide the reads behind 401s.
            foreach (var (path, method) in operations.OrderBy(op => op.Method is "GET" or "HEAD" ? 0 : 1))
            {
                using var request = new HttpRequestMessage(new HttpMethod(method), RouteParameter().Replace(path, "1"));
                if (method is "POST" or "PUT" or "PATCH")
                    request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                NoStoreAssert.Holds(response, $"{method} {path}");
            }
        }
    }

    [Fact]
    public void AnEndpointCannotWeakenTheRule_AndPathsOutsideTheApiAreLeftAlone()
    {
        var api = Context("/api/v1/viewer/auth/login", out var apiFeature);
        NoStoreApiResponses.Apply(api);
        api.Response.Headers.CacheControl = "public, max-age=600";
        api.Response.Headers.Remove("Pragma");
        apiFeature.Start();
        Assert.Equal(NoStoreApiResponses.CacheControl, api.Response.Headers.CacheControl.ToString());
        Assert.Equal("no-cache", api.Response.Headers.Pragma.ToString());

        var web = Context("/watch/assets/app.js", out var webFeature);
        NoStoreApiResponses.Apply(web);
        web.Response.Headers.CacheControl = "public, max-age=600";
        webFeature.Start();
        Assert.Equal("public, max-age=600", web.Response.Headers.CacheControl.ToString());
    }

    private static DefaultHttpContext Context(string path, out RecordingResponseFeature feature)
    {
        var context = new DefaultHttpContext();
        feature = new RecordingResponseFeature { Headers = context.Response.Headers };
        context.Features.Set<IHttpResponseFeature>(feature);
        context.Request.Path = path;
        return context;
    }

    private sealed class RecordingResponseFeature : HttpResponseFeature
    {
        private readonly List<(Func<object, Task> Callback, object State)> _starting = [];

        public override void OnStarting(Func<object, Task> callback, object state) => _starting.Add((callback, state));

        public void Start()
        {
            foreach (var (callback, state) in _starting)
                callback(state).GetAwaiter().GetResult();
        }
    }
}

/// <summary>The responses that carry tokens, TOTP secrets, recovery codes or generated passwords, on their success path.</summary>
public sealed class NoStoreSecretResponseTests(ViewerApiFactory factory) : IClassFixture<ViewerApiFactory>
{
    private const string Password = "correct horse battery";

    [Fact]
    public async Task TokenSecretAndCodeResponses_SendNoStore()
    {
        using var cookieClient = factory.CreateClient();
        var adminLogin = await cookieClient.PostAsJsonAsync("/api/v1/auth/login", new { username = TestAuth.AdminUsername, password = TestAuth.AdminPassword });
        Assert.Equal(HttpStatusCode.OK, adminLogin.StatusCode);
        NoStoreAssert.Holds(adminLogin, "admin login");

        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true, email = new { mode = "outbox" } });
        using var anon = factory.CreateClient();
        var created = await ViewerApi.CreateAsyncRaw(admin, new { username = "nostore-viewer", password = Password });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        NoStoreAssert.Holds(created, "admin create viewer");
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("viewer").GetProperty("id").GetString();
        var generated = await admin.PostAsJsonAsync($"/api/v1/config/viewers/{id}/password", new { mustChangePassword = false });
        Assert.Equal(HttpStatusCode.OK, generated.StatusCode);
        NoStoreAssert.Holds(generated, "admin set password");
        var password = (await generated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("generatedPassword").GetString()!;

        var login = await ViewerApi.LoginAsync(anon, "nostore-viewer", password);
        Assert.True(login.StatusCode == HttpStatusCode.OK, await login.Content.ReadAsStringAsync());
        NoStoreAssert.Holds(login, "viewer login");
        var session = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("session");

        var refresh = await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = session.GetProperty("refreshToken").GetString() });
        Assert.Equal(HttpStatusCode.OK, refresh.StatusCode);
        NoStoreAssert.Holds(refresh, "viewer refresh");
        var access = (await refresh.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;

        using var viewer = factory.Viewer(access);
        var setup = await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/setup", new { currentPassword = password });
        Assert.Equal(HttpStatusCode.OK, setup.StatusCode);
        NoStoreAssert.Holds(setup, "2FA setup");
        var secret = (await setup.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("secret").GetString()!;
        var enable = await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/enable", new { code = ViewerApi.Totp(secret, factory.Clock.GetUtcNow()) });
        Assert.Equal(HttpStatusCode.OK, enable.StatusCode);
        NoStoreAssert.Holds(enable, "2FA enable (recovery codes)");

        var recovery = await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/recovery-codes", new { currentPassword = password });
        Assert.Equal(HttpStatusCode.OK, recovery.StatusCode);
        NoStoreAssert.Holds(recovery, "recovery codes");

        var challenge = await ViewerApi.LoginAsync(anon, "nostore-viewer", password);
        NoStoreAssert.Holds(challenge, "viewer login (mfa_required)");
        var mfaToken = (await challenge.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mfaToken").GetString();
        factory.Clock.Advance(TimeSpan.FromSeconds(30));
        var second = await anon.PostAsJsonAsync("/api/v1/viewer/auth/login/second-factor", new { mfaToken, code = ViewerApi.Totp(secret, factory.Clock.GetUtcNow()) });
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        NoStoreAssert.Holds(second, "second factor");
    }
}
