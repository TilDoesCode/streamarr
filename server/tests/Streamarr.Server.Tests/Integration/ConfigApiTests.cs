using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Config;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Config API coverage (BRIEF §6.2 / §6.3): CRUD, secret masking + write-only
/// omit-to-keep semantics, connectivity test endpoints, events ingestion, machine API
/// keys. Runs the real DB-backed services over an isolated temp SQLite db + key ring.
/// </summary>
public sealed class ConfigApiTests : IClassFixture<ConfigApiTests.Factory>
{
    private const string ApiKey = "test-api-key";
    private const string SecretIndexerKey = "super-secret-indexer-key";
    private const string Mask = "••••••••";

    private readonly Factory _factory;

    public ConfigApiTests(Factory factory) => _factory = factory;

    /// <summary>An admin-authenticated client — config CRUD requires an admin session.</summary>
    private HttpClient Client()
    {
        var client = _factory.CreateClient();
        client.AuthenticateAsAdminAsync().GetAwaiter().GetResult();
        return client;
    }

    /// <summary>A machine-key client — used to prove machine keys cannot reach /config.</summary>
    private HttpClient MachineClient()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);
        return client;
    }

    // ---- indexers --------------------------------------------------------------------

    [Fact]
    public async Task Indexer_Crud_RoundTrips_AndMasksSecret()
    {
        using var client = Client();

        var create = await client.PostAsJsonAsync("/api/v1/config/indexers", new
        {
            name = "myindexer",
            baseUrl = "https://idx.example",
            apiKey = SecretIndexerKey,
            categories = new[] { 2000, 5000 },
            priority = 3,
        });
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);

        var created = await create.Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetString()!;
        Assert.Equal("myindexer", created.GetProperty("name").GetString());
        // Secret is masked on read, never the plaintext.
        Assert.Equal(Mask, created.GetProperty("apiKey").GetString());
        Assert.True(created.GetProperty("hasApiKey").GetBoolean());

        // The plaintext key never crosses the wire.
        var listRaw = await client.GetStringAsync("/api/v1/config/indexers");
        Assert.DoesNotContain(SecretIndexerKey, listRaw);

        // Update while omitting the secret keeps it (omit-to-keep).
        var update = await client.PutAsJsonAsync($"/api/v1/config/indexers/{id}", new
        {
            name = "renamed",
            baseUrl = "https://idx.example",
            priority = 7,
        });
        Assert.Equal(HttpStatusCode.OK, update.StatusCode);
        var updated = await update.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("renamed", updated.GetProperty("name").GetString());
        Assert.Equal(7, updated.GetProperty("priority").GetInt32());
        Assert.True(updated.GetProperty("hasApiKey").GetBoolean()); // secret survived

        // The stored (decrypted) key is still usable server-side.
        var store = _factory.Services.GetRequiredService<IndexerConfigService>();
        var config = store.GetAll().Single(i => i.Id == id);
        Assert.Equal(SecretIndexerKey, config.ApiKey);
        Assert.Equal("renamed", config.Name);

        // Delete.
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v1/config/indexers/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v1/config/indexers/{id}")).StatusCode);
    }

    [Fact]
    public async Task Indexer_Update_WithNewSecret_ReplacesIt()
    {
        using var client = Client();
        var id = await CreateIndexer(client, "rotate", "first-key");

        await client.PutAsJsonAsync($"/api/v1/config/indexers/{id}", new
        {
            name = "rotate",
            baseUrl = "https://idx.example",
            apiKey = "second-key",
        });

        var store = _factory.Services.GetRequiredService<IndexerConfigService>();
        Assert.Equal("second-key", store.GetAll().Single(i => i.Id == id).ApiKey);

        await client.DeleteAsync($"/api/v1/config/indexers/{id}");
    }

    [Fact]
    public async Task Indexer_Create_RejectsMissingName()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/config/indexers", new { baseUrl = "https://x" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Indexer_Test_ReturnsCapsWithLatency()
    {
        using var client = Client();
        var id = await CreateIndexer(client, "capstest", "key");

        var response = await client.PostAsync($"/api/v1/config/indexers/{id}/test", null);
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(result.GetProperty("success").GetBoolean());
        Assert.True(result.GetProperty("latencyMs").GetDouble() >= 0);
        Assert.Equal("MockIndexer", result.GetProperty("serverTitle").GetString());
        Assert.True(result.GetProperty("categoryCount").GetInt32() >= 1);

        await client.DeleteAsync($"/api/v1/config/indexers/{id}");
    }

    // ---- providers -------------------------------------------------------------------

    [Fact]
    public async Task Provider_Crud_RoundTrips_AndMasksPassword()
    {
        using var client = Client();

        var create = await client.PostAsJsonAsync("/api/v1/config/providers", new
        {
            name = "primary",
            host = "news.example",
            port = 563,
            username = "user",
            password = "hunter2",
            maxConnections = 20,
        });
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var created = await create.Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetString()!;
        Assert.Equal(Mask, created.GetProperty("password").GetString());
        Assert.True(created.GetProperty("hasPassword").GetBoolean());
        Assert.Equal("user", created.GetProperty("username").GetString());

        var raw = await client.GetStringAsync("/api/v1/config/providers");
        Assert.DoesNotContain("hunter2", raw);

        // omit-to-keep on update
        await client.PutAsJsonAsync($"/api/v1/config/providers/{id}", new
        {
            name = "primary", host = "news.example", maxConnections = 30,
        });
        var svc = _factory.Services.GetRequiredService<ProviderConfigService>();
        var entity = await svc.GetAsync(id, default);
        Assert.Equal("hunter2", svc.ToProvider(entity!).Password);
        Assert.Equal(30, entity!.MaxConnections);

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v1/config/providers/{id}")).StatusCode);
    }

    [Fact]
    public async Task Provider_Test_ConnectsAndReportsAchievableConnections()
    {
        await using var nntp = new MockNntpServer { RequireAuth = true };
        using var client = Client();

        var create = await client.PostAsJsonAsync("/api/v1/config/providers", new
        {
            name = "mock",
            host = nntp.Host,
            port = nntp.Port,
            useSsl = false,
            username = nntp.Username,
            password = nntp.Password,
            maxConnections = 3,
        });
        var id = (await create.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var response = await client.PostAsync($"/api/v1/config/providers/{id}/test", null);
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(result.GetProperty("success").GetBoolean());
        Assert.Equal(3, result.GetProperty("requestedConnections").GetInt32());
        Assert.Equal(3, result.GetProperty("achievableConnections").GetInt32());

        await client.DeleteAsync($"/api/v1/config/providers/{id}");
    }

    [Fact]
    public async Task Provider_Test_FailsAgainstWrongCredentials()
    {
        await using var nntp = new MockNntpServer { RequireAuth = true };
        using var client = Client();

        var create = await client.PostAsJsonAsync("/api/v1/config/providers", new
        {
            name = "badcreds",
            host = nntp.Host,
            port = nntp.Port,
            useSsl = false,
            username = "wrong",
            password = "wrong",
            maxConnections = 1,
        });
        var id = (await create.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var result = await (await client.PostAsync($"/api/v1/config/providers/{id}/test", null))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(result.GetProperty("success").GetBoolean());
        Assert.Equal(0, result.GetProperty("achievableConnections").GetInt32());

        await client.DeleteAsync($"/api/v1/config/providers/{id}");
    }

    // ---- general config --------------------------------------------------------------

    [Fact]
    public async Task General_Get_Put_MasksTmdbKey()
    {
        using var client = Client();

        await client.PutAsJsonAsync("/api/v1/config/general", new
        {
            tmdbApiKey = "tmdb-secret-123",
            connectionBudget = 42,
            sessionTtlSeconds = 1800,
        });

        var raw = await client.GetStringAsync("/api/v1/config/general");
        Assert.DoesNotContain("tmdb-secret-123", raw);

        var body = JsonDocument.Parse(raw).RootElement;
        Assert.Equal(Mask, body.GetProperty("tmdbApiKey").GetString());
        Assert.True(body.GetProperty("hasTmdbApiKey").GetBoolean());
        Assert.Equal(42, body.GetProperty("connectionBudget").GetInt32());
        Assert.Equal(1800, body.GetProperty("sessionTtlSeconds").GetInt32());

        // omit-to-keep: a PUT without the key leaves it in place.
        await client.PutAsJsonAsync("/api/v1/config/general", new { connectionBudget = 50 });
        var after = JsonDocument.Parse(await client.GetStringAsync("/api/v1/config/general")).RootElement;
        Assert.True(after.GetProperty("hasTmdbApiKey").GetBoolean());
        Assert.Equal(50, after.GetProperty("connectionBudget").GetInt32());
    }

    [Fact]
    public async Task General_Put_RejectsInvalidBudget()
    {
        using var client = Client();
        var response = await client.PutAsJsonAsync("/api/v1/config/general", new { connectionBudget = 0 });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ---- profiles --------------------------------------------------------------------

    [Fact]
    public async Task Profile_Crud_RoundTrips_AndDefaultIsProtected()
    {
        using var client = Client();

        var list = await client.GetFromJsonAsync<JsonElement>("/api/v1/config/profiles");
        Assert.Contains(list.EnumerateArray(), p => p.GetProperty("id").GetString() == "default");

        var create = await client.PostAsJsonAsync("/api/v1/config/profiles", new
        {
            name = "German 4K",
            preferredResolutions = new[] { "2160p", "1080p" },
            preferredLanguages = new[] { "de" },
            resolutionWeight = 200,
        });
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var created = await create.Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetString()!;
        Assert.Equal("German 4K", created.GetProperty("name").GetString());
        Assert.Equal(200, created.GetProperty("resolutionWeight").GetInt32());

        // The ranker sees the stored profile.
        var provider = _factory.Services.GetRequiredService<ProfileConfigService>();
        var profile = provider.Get(id);
        Assert.Equal(id, profile.Id);
        Assert.Equal(200, profile.ResolutionWeight);
        Assert.Equal(new[] { "de" }, profile.PreferredLanguages);

        // Default cannot be edited or deleted.
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.PutAsJsonAsync("/api/v1/config/profiles/default", new { name = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.DeleteAsync("/api/v1/config/profiles/default")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v1/config/profiles/{id}")).StatusCode);
    }

    // ---- events ----------------------------------------------------------------------

    [Fact]
    public async Task Events_Ingested_And_Stored()
    {
        using var client = Client();
        var svc = _factory.Services.GetRequiredService<WatchEventService>();
        var before = await svc.CountAsync(default);

        var response = await client.PostAsJsonAsync("/api/v1/events", new
        {
            releaseId = "rel-abc",
            workId = "tmdb-movie-1",
            @event = "start",
            positionTicks = 123456789L,
            source = "web",
        });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        Assert.Equal(before + 1, await svc.CountAsync(default));
        var recent = await svc.RecentAsync(1, default);
        Assert.Equal("rel-abc", recent[0].ReleaseId);
        Assert.Equal("start", recent[0].Event);
        Assert.Equal("web", recent[0].Source);
    }

    [Fact]
    public async Task Events_RejectsUnknownKind()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/events", new { releaseId = "r", @event = "bogus" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Events_RequireAuth()
    {
        using var anon = _factory.CreateClient();
        var response = await anon.PostAsJsonAsync("/api/v1/events", new { releaseId = "r", @event = "start" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ---- machine api keys ------------------------------------------------------------

    [Fact]
    public async Task ApiKey_Create_Authenticates_Then_Revoke_Rejects()
    {
        using var client = Client();

        var create = await client.PostAsJsonAsync("/api/v1/config/apikeys", new { name = "jellyfin" });
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var created = await create.Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetString()!;
        var token = created.GetProperty("token").GetString()!;
        Assert.False(string.IsNullOrWhiteSpace(token));

        // The token authenticates a fresh client.
        using var minted = _factory.CreateClient();
        minted.DefaultRequestHeaders.Authorization = new("Bearer", token);
        Assert.Equal(HttpStatusCode.OK, (await minted.GetAsync("/api/v1/caps")).StatusCode);

        // List never leaks the token, only its prefix.
        var raw = await client.GetStringAsync("/api/v1/config/apikeys");
        Assert.DoesNotContain(token, raw);

        // Revoke → the token no longer authenticates.
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v1/config/apikeys/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await minted.GetAsync("/api/v1/caps")).StatusCode);
    }

    // ---- caps ------------------------------------------------------------------------

    [Fact]
    public async Task Caps_ListsCategoriesAndProviders()
    {
        using var client = Client();
        var idxId = await CreateIndexer(client, "capsidx", "k", categories: [2000, 5040]);

        var caps = await client.GetFromJsonAsync<JsonElement>("/api/v1/caps");
        var categoryIds = caps.GetProperty("categories").EnumerateArray()
            .Select(c => c.GetProperty("id").GetInt32()).ToArray();
        Assert.Contains(2000, categoryIds);
        Assert.Contains(5040, categoryIds);
        Assert.Contains("movie", caps.GetProperty("mediaTypes").EnumerateArray().Select(m => m.GetString()));

        await client.DeleteAsync($"/api/v1/config/indexers/{idxId}");
    }

    // ---- auth ------------------------------------------------------------------------

    [Fact]
    public async Task Config_RequiresAuth()
    {
        using var anon = _factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/v1/config/indexers")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/v1/config/providers")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/v1/config/general")).StatusCode);
    }

    [Fact]
    public async Task Config_And_Debug_RejectMachineKeys_WithForbidden()
    {
        // A machine API key authenticates (search/resolve/stream/events/caps) but must
        // never reach the admin surface (BRIEF §6.4).
        using var machine = MachineClient();
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/indexers")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/providers")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/general")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/profiles")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/apikeys")).StatusCode);

        var debug = await machine.PostAsJsonAsync("/api/v1/debug/search", new { q = "Example" });
        Assert.Equal(HttpStatusCode.Forbidden, debug.StatusCode);

        // …but the same machine key does reach its own scope.
        Assert.Equal(HttpStatusCode.OK, (await machine.GetAsync("/api/v1/caps")).StatusCode);
    }

    [Fact]
    public async Task Admin_Login_Then_Reaches_Config()
    {
        using var admin = _factory.CreateClient();
        await admin.AuthenticateAsAdminAsync();
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/config/indexers")).StatusCode);

        // A wrong password is rejected.
        using var raw = _factory.CreateClient();
        var bad = await raw.PostAsJsonAsync("/api/v1/auth/login", new { username = "admin", password = "wrong" });
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
    }

    private static async Task<string> CreateIndexer(HttpClient client, string name, string apiKey, int[]? categories = null)
    {
        var response = await client.PostAsJsonAsync("/api/v1/config/indexers", new
        {
            name,
            baseUrl = "https://idx.example",
            apiKey,
            categories = categories ?? [2000],
        });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
    }

    // ---- test host -------------------------------------------------------------------

    public sealed class Factory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-config-").FullName;

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

            builder.ConfigureTestServices(services =>
            {
                // Indexer /test roundtrips against a fake Newznab caps response.
                services.RemoveAll<INewznabClient>();
                services.AddSingleton<INewznabClient>(new FakeCapsNewznabClient());
            });
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && Directory.Exists(_dir))
                Directory.Delete(_dir, recursive: true);
        }
    }

    private sealed class FakeCapsNewznabClient : INewznabClient
    {
        public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
            => Task.FromResult(new NewznabCapabilities
            {
                ServerTitle = "MockIndexer",
                ServerVersion = "1.0",
                SearchAvailable = true,
                MovieSearchAvailable = true,
                Categories = [new NewznabCategory { Id = 2000, Name = "Movies" }],
            });

        public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
            => Task.FromResult(new NewznabSearchResponse());
    }
}
