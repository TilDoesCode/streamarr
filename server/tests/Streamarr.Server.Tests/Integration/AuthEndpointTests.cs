using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// The two-mode auth contract (BRIEF §6.4, §11): every /api/v1 endpoint rejects a missing
/// or invalid bearer token, machine API keys reach only their scope
/// (search/resolve/stream/events/caps/sessions) and are forbidden from /config and /debug,
/// and admin session JWTs unlock everything. Health is the documented unauthenticated
/// liveness probe.
/// </summary>
public sealed class AuthEndpointTests : IClassFixture<AuthEndpointTests.Factory>
{
    private const string ApiKey = "machine-key-for-auth-tests";
    private readonly Factory _factory;

    public AuthEndpointTests(Factory factory) => _factory = factory;

    /// <summary>Every protected endpoint, one representative request each.</summary>
    public static IEnumerable<object[]> ProtectedEndpoints() =>
    [
        ["GET", "/api/v1/search?q=x"],
        ["POST", "/api/v1/resolve"],
        ["GET", "/api/v1/stream/some-token"],
        ["GET", "/api/v1/caps"],
        ["POST", "/api/v1/events"],
        ["GET", "/api/v1/sessions"],
        ["POST", "/api/v1/sessions/some-token/close"],
        ["POST", "/api/v1/debug/search"],
        ["GET", "/api/v1/config/indexers"],
        ["GET", "/api/v1/config/providers"],
        ["GET", "/api/v1/config/general"],
        ["GET", "/api/v1/config/profiles"],
        ["GET", "/api/v1/config/apikeys"],
        ["GET", "/api/v1/auth/me"],
        ["POST", "/api/v1/auth/password"],
    ];

    [Theory]
    [MemberData(nameof(ProtectedEndpoints))]
    public async Task Endpoint_Requires_Credentials(string method, string path)
    {
        using var anon = _factory.CreateClient();
        var response = await Send(anon, method, path);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [MemberData(nameof(ProtectedEndpoints))]
    public async Task Endpoint_Rejects_Garbage_Bearer(string method, string path)
    {
        using var bogus = _factory.CreateClient();
        bogus.DefaultRequestHeaders.Authorization = new("Bearer", "not-a-real-token");
        var response = await Send(bogus, method, path);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Health_Is_Anonymous_Liveness()
    {
        using var anon = _factory.CreateClient();
        var response = await anon.GetAsync("/api/v1/health?deep=false");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task MachineKey_Reaches_Its_Scope_But_Not_Admin()
    {
        using var machine = _factory.CreateClient();
        machine.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);

        // In scope (BRIEF §6.4): caps is reachable.
        Assert.Equal(HttpStatusCode.OK, (await machine.GetAsync("/api/v1/caps")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await machine.GetAsync("/api/v1/sessions")).StatusCode);

        // Out of scope: /config + /debug are forbidden (authenticated, wrong role → 403).
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/general")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/apikeys")).StatusCode);
        var debug = await machine.PostAsJsonAsync("/api/v1/debug/search", new { q = "x" });
        Assert.Equal(HttpStatusCode.Forbidden, debug.StatusCode);
    }

    [Fact]
    public async Task Admin_Session_Unlocks_Everything()
    {
        using var admin = _factory.CreateClient();
        await admin.AuthenticateAsAdminAsync();

        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/config/general")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/config/apikeys")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/caps")).StatusCode);

        var me = await admin.GetFromJsonAsync<JsonElement>("/api/v1/auth/me");
        Assert.Equal("admin", me.GetProperty("role").GetString());
    }

    [Fact]
    public async Task Me_Reports_Machine_Role_For_ApiKey()
    {
        using var machine = _factory.CreateClient();
        machine.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);
        var me = await machine.GetFromJsonAsync<JsonElement>("/api/v1/auth/me");
        Assert.Equal("machine", me.GetProperty("role").GetString());
    }

    [Fact]
    public async Task Login_With_Bad_Credentials_Is_Unauthorized()
    {
        using var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/auth/login", new { username = "admin", password = "nope" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private static Task<HttpResponseMessage> Send(HttpClient client, string method, string path) => method switch
    {
        "GET" => client.GetAsync(path),
        "POST" => client.PostAsync(path, JsonContent.Create(new { })),
        _ => throw new ArgumentOutOfRangeException(nameof(method), method, "unsupported"),
    };

    public sealed class Factory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-auth-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:ApiKey"] = ApiKey,
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
