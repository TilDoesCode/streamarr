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
using Streamarr.Core.Media;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Config API coverage (BRIEF §6.2 / §6.3): CRUD, secret masking + write-only
/// omit-to-keep semantics, connectivity test endpoints, events ingestion, machine API
/// keys. Runs the real DB-backed services over an isolated temp SQLite db + key ring.
/// </summary>
public sealed class ConfigApiTests : IClassFixture<ConfigApiTests.Factory>
{
    private const string ApiKey = "test-api-key-aaaaaaaaaaaaaaaaaaaa";
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
    public async Task ProviderAndIndexer_ClientIdsAndOversizedRouteIds_AreRejectedAsBadRequests()
    {
        using var client = Client();

        var indexer = await client.PostAsJsonAsync("/api/v1/config/indexers", new
        {
            id = "client-controlled",
            name = "unsafe-id",
            baseUrl = "https://idx.example",
        });
        Assert.Equal(HttpStatusCode.BadRequest, indexer.StatusCode);

        var provider = await client.PostAsJsonAsync("/api/v1/config/providers", new
        {
            id = "client-controlled",
            name = "unsafe-id",
            host = "news.example",
        });
        Assert.Equal(HttpStatusCode.BadRequest, provider.StatusCode);

        var oversized = new string('x', 129);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.GetAsync($"/api/v1/config/indexers/{oversized}")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await client.GetAsync($"/api/v1/config/providers/{oversized}")).StatusCode);
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
        Assert.Contains(_factory.Services.GetRequiredService<MultiProviderNntpClient>().Providers,
            p => p.ProviderName == "primary");

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
        Assert.DoesNotContain(_factory.Services.GetRequiredService<MultiProviderNntpClient>().Providers,
            p => p.ProviderName == "primary");
    }

    [Fact]
    public async Task ProviderAndIndexer_Reorder_IsTransactionalAndContiguous()
    {
        using var client = Client();
        var p1 = await CreateProvider(client, "order-p1");
        var p2 = await CreateProvider(client, "order-p2");
        var providers = (await client.GetFromJsonAsync<JsonElement>("/api/v1/config/providers"))
            .EnumerateArray().Select(x => x.GetProperty("id").GetString()!).ToArray();
        var providerOrder = providers.Reverse().ToArray();
        Assert.Equal(HttpStatusCode.NoContent,
            (await client.PutAsJsonAsync("/api/v1/config/providers/order", new { ids = providerOrder })).StatusCode);
        var reorderedProviders = (await client.GetFromJsonAsync<JsonElement>("/api/v1/config/providers"))
            .EnumerateArray().ToArray();
        Assert.Equal(providerOrder, reorderedProviders.Select(x => x.GetProperty("id").GetString()));
        Assert.Equal(Enumerable.Range(0, providerOrder.Length),
            reorderedProviders.Select(x => x.GetProperty("priority").GetInt32()));

        var invalid = await client.PutAsJsonAsync("/api/v1/config/providers/order", new { ids = new[] { p1, p1 } });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);

        var i1 = await CreateIndexer(client, "order-i1", "key");
        var i2 = await CreateIndexer(client, "order-i2", "key");
        var indexers = (await client.GetFromJsonAsync<JsonElement>("/api/v1/config/indexers"))
            .EnumerateArray().Select(x => x.GetProperty("id").GetString()!).Reverse().ToArray();
        Assert.Equal(HttpStatusCode.NoContent,
            (await client.PutAsJsonAsync("/api/v1/config/indexers/order", new { ids = indexers })).StatusCode);
        var reorderedIndexers = (await client.GetFromJsonAsync<JsonElement>("/api/v1/config/indexers"))
            .EnumerateArray().ToArray();
        Assert.Equal(indexers, reorderedIndexers.Select(x => x.GetProperty("id").GetString()));
        Assert.Equal(Enumerable.Range(0, indexers.Length),
            reorderedIndexers.Select(x => x.GetProperty("priority").GetInt32()));

        await client.DeleteAsync($"/api/v1/config/providers/{p1}");
        await client.DeleteAsync($"/api/v1/config/providers/{p2}");
        await client.DeleteAsync($"/api/v1/config/indexers/{i1}");
        await client.DeleteAsync($"/api/v1/config/indexers/{i2}");
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

    [Fact]
    public async Task Provider_SpeedTest_TransfersArticleBytesAndRatesStreamingHeadroom()
    {
        await using var nntp = new MockNntpServer { RequireAuth = true };
        nntp.Articles["speed@test"] = YencTestEncoder.Encode(
            YencTestEncoder.LcgBytes(92, 128 * 1024),
            "speed.bin");
        using var client = Client();

        var create = await client.PostAsJsonAsync("/api/v1/config/providers", new
        {
            name = "speed-mock",
            host = nntp.Host,
            port = nntp.Port,
            useSsl = false,
            username = nntp.Username,
            password = nntp.Password,
            maxConnections = 2,
        });
        var id = (await create.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        var response = await client.PostAsJsonAsync($"/api/v1/config/providers/{id}/speedtest", new
        {
            messageId = "speed@test",
            durationSeconds = 1,
        });
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(result.GetProperty("success").GetBoolean());
        Assert.True(result.GetProperty("bytesDownloaded").GetInt64() > 0);
        Assert.True(result.GetProperty("megabitsPerSecond").GetDouble() > 0);
        Assert.Equal(2, result.GetProperty("connectionsUsed").GetInt32());
        Assert.Equal("manual", result.GetProperty("articleSource").GetString());

        await client.DeleteAsync($"/api/v1/config/providers/{id}");
    }

    // ---- general config --------------------------------------------------------------

    [Fact]
    public async Task General_Get_Put_MasksTmdbKey()
    {
        using var client = Client();
        var liveTmdb = _factory.Services.GetRequiredService<TmdbOptions>();
        var liveSearch = _factory.Services.GetRequiredService<IndexerSearchOptions>();
        var revisionBefore = liveTmdb.CredentialRevision;

        await client.PutAsJsonAsync("/api/v1/config/general", new
        {
            tmdbApiKey = "tmdb-secret-123",
            connectionBudget = 42,
            sessionTtlSeconds = 1800,
            ephemeralCacheSizeMb = 204800,
            indexerResultLimit = 250,
        });

        Assert.Equal("tmdb-secret-123", liveTmdb.ApiKey);
        Assert.True(liveTmdb.CredentialRevision > revisionBefore);

        var raw = await client.GetStringAsync("/api/v1/config/general");
        Assert.DoesNotContain("tmdb-secret-123", raw);

        var body = JsonDocument.Parse(raw).RootElement;
        Assert.Equal(Mask, body.GetProperty("tmdbApiKey").GetString());
        Assert.True(body.GetProperty("hasTmdbApiKey").GetBoolean());
        Assert.Equal(42, body.GetProperty("connectionBudget").GetInt32());
        Assert.Equal(1800, body.GetProperty("sessionTtlSeconds").GetInt32());
        Assert.Equal(204800, body.GetProperty("ephemeralCacheSizeMb").GetInt32());
        Assert.Equal(250, body.GetProperty("indexerResultLimit").GetInt32());
        Assert.Equal(250, liveSearch.DefaultLimit);

        // omit-to-keep: a PUT without the key leaves it in place.
        var revisionBeforeOmittedWrite = liveTmdb.CredentialRevision;
        await client.PutAsJsonAsync("/api/v1/config/general", new { connectionBudget = 50 });
        var after = JsonDocument.Parse(await client.GetStringAsync("/api/v1/config/general")).RootElement;
        Assert.True(after.GetProperty("hasTmdbApiKey").GetBoolean());
        Assert.Equal(50, after.GetProperty("connectionBudget").GetInt32());
        Assert.Equal("tmdb-secret-123", liveTmdb.ApiKey);
        Assert.Equal(revisionBeforeOmittedWrite, liveTmdb.CredentialRevision);
    }

    [Fact]
    public async Task General_Put_RejectsInvalidBudget()
    {
        using var client = Client();
        var response = await client.PutAsJsonAsync("/api/v1/config/general", new { connectionBudget = 0 });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        response = await client.PutAsJsonAsync(
            "/api/v1/config/general",
            new { ephemeralCacheSizeMb = 0 });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        response = await client.PutAsJsonAsync(
            "/api/v1/config/general",
            new { indexerResultLimit = 1001 });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PreDownload_Get_Put_RoundTripsPartialUpdatesAndPublishesLiveSnapshot()
    {
        using var client = Client();
        var service = _factory.Services.GetRequiredService<PreDownloadConfigService>();

        var response = await client.PutAsJsonAsync("/api/v1/config/pre-download", new
        {
            enabled = true,
            downloadCurrentFile = false,
            currentFileThresholdSeconds = 25,
            downloadNextEpisode = true,
            nextEpisodeThresholdPercent = 80,
            preferSimilarNextEpisodeRelease = true,
            nextEpisodeReleaseSimilarityThresholdPercent = 83,
            maxConcurrentDownloads = 3,
        });
        response.EnsureSuccessStatusCode();

        response = await client.PutAsJsonAsync("/api/v1/config/pre-download", new
        {
            enabled = false,
        });
        response.EnsureSuccessStatusCode();

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(body.GetProperty("enabled").GetBoolean());
        Assert.False(body.GetProperty("downloadCurrentFile").GetBoolean());
        Assert.Equal(25, body.GetProperty("currentFileThresholdSeconds").GetInt32());
        Assert.True(body.GetProperty("downloadNextEpisode").GetBoolean());
        Assert.Equal(80, body.GetProperty("nextEpisodeThresholdPercent").GetInt32());
        Assert.True(body.GetProperty("preferSimilarNextEpisodeRelease").GetBoolean());
        Assert.Equal(83, body.GetProperty("nextEpisodeReleaseSimilarityThresholdPercent").GetInt32());
        Assert.Equal(3, body.GetProperty("maxConcurrentDownloads").GetInt32());
        Assert.False(service.Current.Enabled);
        Assert.False(service.Current.DownloadCurrentFile);
        Assert.Equal(25, service.Current.CurrentFileThresholdSeconds);
        Assert.Equal(80, service.Current.NextEpisodeThresholdPercent);
        Assert.True(service.Current.PreferSimilarNextEpisodeRelease);
        Assert.Equal(83, service.Current.NextEpisodeReleaseSimilarityThresholdPercent);
        Assert.Equal(3, service.Current.MaxConcurrentDownloads);

        var persisted = await client.GetFromJsonAsync<PreDownloadConfigResponse>(
            "/api/v1/config/pre-download");
        Assert.Equal(PreDownloadConfigResponse.From(service.Current), persisted);
    }

    [Theory]
    [InlineData("currentFileThresholdSeconds", -1)]
    [InlineData("currentFileThresholdSeconds", 3601)]
    [InlineData("nextEpisodeThresholdPercent", 0)]
    [InlineData("nextEpisodeThresholdPercent", 101)]
    [InlineData("nextEpisodeReleaseSimilarityThresholdPercent", -1)]
    [InlineData("nextEpisodeReleaseSimilarityThresholdPercent", 101)]
    [InlineData("maxConcurrentDownloads", 0)]
    [InlineData("maxConcurrentDownloads", 9)]
    public async Task PreDownload_Put_RejectsInvalidRanges(string property, int value)
    {
        using var client = Client();
        var response = await client.PutAsJsonAsync(
            "/api/v1/config/pre-download",
            new Dictionary<string, int> { [property] = value });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_pre_download_config",
            body.GetProperty("error").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData(0, 1, 0, 1)]
    [InlineData(3600, 100, 100, 8)]
    public async Task PreDownload_Put_AcceptsRangeBoundaries(
        int currentThreshold,
        int nextThreshold,
        int similarityThreshold,
        int concurrency)
    {
        using var client = Client();
        var response = await client.PutAsJsonAsync("/api/v1/config/pre-download", new
        {
            currentFileThresholdSeconds = currentThreshold,
            nextEpisodeThresholdPercent = nextThreshold,
            nextEpisodeReleaseSimilarityThresholdPercent = similarityThreshold,
            maxConcurrentDownloads = concurrency,
        });

        response.EnsureSuccessStatusCode();
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

    [Fact]
    public async Task Profile_RejectsUnsafeRangesWeightsAndLists()
    {
        using var client = Client();
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/config/profiles", new
        {
            id = "caller-controlled",
            name = "custom id",
        })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/config/profiles", new
        {
            name = "bad-weight",
            resolutionWeight = -1,
        })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/config/profiles", new
        {
            name = "bad-band",
            minBytesPerMinute = 100,
            maxBytesPerMinute = 10,
        })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/config/profiles", new
        {
            name = "overlap",
            groupAllowList = new[] { "GROUP" },
            groupDenyList = new[] { "group" },
        })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/config/profiles", new
        {
            name = "null-list",
            preferredResolutions = (string[]?)null,
        })).StatusCode);

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/debug/search", new
        {
            q = "example",
            profile = new
            {
                name = "invalid draft",
                preferredSources = (string[]?)null,
            },
        })).StatusCode);
    }

    // ---- events ----------------------------------------------------------------------

    [Fact]
    public async Task Events_Ingested_And_Stored()
    {
        using var client = Client();
        var svc = _factory.Services.GetRequiredService<WatchEventService>();
        var before = await svc.CountAsync(default);
        var releaseId = "rel-contract-" + Guid.NewGuid().ToString("N");
        const long durationTicks = 987_654_321L;
        const string sessionToken = "session-contract-token";
        const string releaseTitle = "Example.Movie.2026.1080p.WEB-DL-GROUP";

        var response = await client.PostAsJsonAsync("/api/v1/events", new
        {
            releaseId,
            workId = "tmdb-movie-1",
            title = releaseTitle,
            @event = "start",
            positionTicks = 123456789L,
            durationTicks,
            sessionToken,
            source = "web",
        });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        Assert.Equal(before + 1, await svc.CountAsync(default));
        var recent = await svc.RecentAsync(1, default);
        Assert.Equal(releaseId, recent[0].ReleaseId);
        Assert.Equal("start", recent[0].Event);
        Assert.Equal("web", recent[0].Source);
        Assert.Equal(releaseTitle, recent[0].Title);
        Assert.Equal(durationTicks, recent[0].DurationTicks);
        Assert.Equal(sessionToken, recent[0].SessionToken);

        var list = await client.GetFromJsonAsync<JsonElement>("/api/v1/events?limit=500");
        var listed = list.EnumerateArray().Single(entry =>
            entry.GetProperty("releaseId").GetString() == releaseId);
        Assert.Equal(durationTicks, listed.GetProperty("durationTicks").GetInt64());
        Assert.Equal(sessionToken, listed.GetProperty("sessionToken").GetString());
        Assert.Equal(releaseTitle, listed.GetProperty("title").GetString());
    }

    [Fact]
    public async Task Events_RejectsUnknownKind()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/events", new { releaseId = "r", @event = "bogus" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Events_ValidateDurationAndSessionTokenBounds()
    {
        using var client = Client();
        var invalidPayloads = new object[]
        {
            new { releaseId = "negative-duration", @event = "progress", durationTicks = -1L },
            new { releaseId = "long-token", @event = "progress", sessionToken = new string('x', 257) },
            new { releaseId = "control-token", @event = "progress", sessionToken = "valid-prefix\u0001" },
            new { releaseId = "long-title", @event = "progress", title = new string('x', 1_025) },
            new { releaseId = "control-title", @event = "progress", title = "valid-prefix\u0001" },
        };

        foreach (var payload in invalidPayloads)
        {
            var response = await client.PostAsJsonAsync("/api/v1/events", payload);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("invalid_event", body.GetProperty("error").GetProperty("code").GetString());
        }

        var boundary = await client.PostAsJsonAsync("/api/v1/events", new
        {
            releaseId = "valid-event-boundary-" + Guid.NewGuid().ToString("N"),
            @event = "progress",
            durationTicks = 0L,
            sessionToken = new string('x', 256),
        });
        Assert.Equal(HttpStatusCode.Accepted, boundary.StatusCode);
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

    [Fact]
    public async Task ApiKey_RejectsOversizedName()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/config/apikeys", new { name = new string('x', 129) });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task OversizedApiBody_ReturnsSafe413()
    {
        using var client = Client();
        using var content = new StringContent(
            JsonSerializer.Serialize(new { name = new string('x', 1024 * 1024 + 1) }),
            System.Text.Encoding.UTF8,
            "application/json");
        using var response = await client.PostAsync("/api/v1/config/apikeys", content);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<Streamarr.Server.Contracts.ErrorResponse>();
        Assert.Equal("payload_too_large", error!.Error.Code);
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

    [Fact]
    public async Task LocalReleaseAvailability_AcceptsMachineScopeAndValidatesBounds()
    {
        using var machine = MachineClient();
        var response = await machine.PostAsJsonAsync("/api/v1/releases/local-availability", new
        {
            workIds = new[] { "tmdb-tv-1-s01e02" },
            client = "jellyfin",
            requestedById = "user-1",
        });

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Array, body.GetProperty("releases").ValueKind);

        response = await machine.PostAsJsonAsync("/api/v1/releases/local-availability", new
        {
            workIds = Array.Empty<string>(),
            client = "jellyfin",
            requestedById = "user-1",
        });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            "invalid_local_release_availability_request",
            body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task LocalReleaseAvailability_ReturnsExactScopedPublicReleaseMetadata()
    {
        var suffix = Guid.NewGuid().ToString("N");
        var otherWorkId = $"availability-a-{suffix}";
        var workId = $"availability-b-{suffix}";
        var releaseId = $"availability-release-{suffix}";
        var missingReleaseId = $"availability-missing-{suffix}";
        var privateReleaseId = $"availability-private-{suffix}";
        var sessions = _factory.Services.GetRequiredService<SessionManager>();
        var workspace = _factory.Services.GetRequiredService<PreDownloadWorkspace>();
        var releaseStore = _factory.Services.GetRequiredService<IReleaseStore>();
        var general = _factory.Services.GetRequiredService<GeneralConfigService>();
        var originalScoreSetting = (await general.GetAsync(CancellationToken.None))
            .AddReleaseScoreToName;
        var tokens = new List<string>();

        void AddLocal(string localReleaseId, string requesterId)
        {
            var session = sessions.GetOrCreateOpeningSession(
                localReleaseId,
                workId,
                new ResolvedMediaFile
                {
                    FileName = "episode.mkv",
                    Container = "mkv",
                    SizeBytes = 4,
                    OpenStream = _ => new MemoryStream([1, 2, 3, 4]),
                },
                "ready",
                "jellyfin",
                requesterId).Session;
            Assert.True(session.AttachPreDownload(
                new PreDownloadCacheFile(workspace, session.Token, 4),
                $"job-{localReleaseId}",
                "nextEpisode",
                "test",
                null));
            tokens.Add(session.Token);
        }

        try
        {
            releaseStore.Register(otherWorkId, new Release
            {
                ReleaseId = releaseId,
                Title = "Wrong.Owner.S01E02.720p-GROUP",
                Indexer = "wrong-indexer",
                SizeBytes = 10,
                Score = 1,
            });
            releaseStore.Register(workId, new Release
            {
                ReleaseId = releaseId,
                Title = "Exact.Owner.S01E02.2160p.WEB-DL-GROUP",
                Indexer = "exact-indexer",
                SizeBytes = 4_294_967_296,
                Quality = new QualityInfo
                {
                    Resolution = "2160p",
                    Source = "webdl",
                    Codec = "hevc",
                    Hdr = "dolbyvision",
                    Audio = "eac3",
                    Edition = "extended",
                    Proper = true,
                    Repack = true,
                },
                Languages = ["de", "en"],
                ReleaseGroup = "GROUP",
                AgeDays = 2,
                Grabs = 81,
                Score = 934,
                Health = ReleaseHealth.Ready,
                NzbUrl = "https://indexer.example/secret.nzb",
            });
            releaseStore.Register(workId, new Release
            {
                ReleaseId = privateReleaseId,
                Title = "Private.Owner.S01E02.1080p-GROUP",
                Indexer = "private-indexer",
                SizeBytes = 4,
                Score = 500,
            });
            AddLocal(releaseId, "user-1");
            AddLocal(missingReleaseId, "user-1");
            AddLocal(privateReleaseId, "user-2");
            await general.UpdateAsync(
                new GeneralConfigWrite { AddReleaseScoreToName = false },
                CancellationToken.None);

            using var machine = MachineClient();
            var response = await machine.PostAsJsonAsync("/api/v1/releases/local-availability", new
            {
                workIds = new[] { workId },
                client = "jellyfin",
                requestedById = "user-1",
            });

            response.EnsureSuccessStatusCode();
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            var entries = body.GetProperty("releases").EnumerateArray().ToArray();
            Assert.Equal(2, entries.Length);
            Assert.DoesNotContain(entries, entry =>
                entry.GetProperty("releaseId").GetString() == privateReleaseId);

            var exact = Assert.Single(entries, entry =>
                entry.GetProperty("releaseId").GetString() == releaseId);
            Assert.Equal(workId, exact.GetProperty("workId").GetString());
            Assert.Equal("downloading", exact.GetProperty("state").GetString());
            var metadata = exact.GetProperty("release");
            Assert.Equal(releaseId, metadata.GetProperty("releaseId").GetString());
            Assert.Equal("Exact.Owner.S01E02.2160p.WEB-DL-GROUP", metadata.GetProperty("title").GetString());
            Assert.Equal("exact-indexer", metadata.GetProperty("indexer").GetString());
            Assert.Equal(4_294_967_296, metadata.GetProperty("sizeBytes").GetInt64());
            Assert.Equal("2160p", metadata.GetProperty("quality").GetProperty("resolution").GetString());
            Assert.Equal("GROUP", metadata.GetProperty("releaseGroup").GetString());
            Assert.Equal(934, metadata.GetProperty("score").GetInt32());
            Assert.False(metadata.GetProperty("addScoreToName").GetBoolean());
            Assert.Equal("ready", metadata.GetProperty("health").GetString());
            Assert.False(metadata.TryGetProperty("nzbUrl", out _));

            var missing = Assert.Single(entries, entry =>
                entry.GetProperty("releaseId").GetString() == missingReleaseId);
            Assert.Equal(JsonValueKind.Null, missing.GetProperty("release").ValueKind);
        }
        finally
        {
            foreach (var token in tokens)
                sessions.PurgeSession(token);
            await general.UpdateAsync(
                new GeneralConfigWrite { AddReleaseScoreToName = originalScoreSetting },
                CancellationToken.None);
        }
    }

    [Fact]
    public async Task LocalReleaseAvailability_BoundsFullMetadataPerWorkDeterministically()
    {
        var suffix = Guid.NewGuid().ToString("N");
        var workId = $"availability-bound-{suffix}";
        var sessions = _factory.Services.GetRequiredService<SessionManager>();
        var workspace = _factory.Services.GetRequiredService<PreDownloadWorkspace>();
        var releaseStore = _factory.Services.GetRequiredService<IReleaseStore>();
        var tokens = new List<string>();

        try
        {
            for (var index = 20; index >= 0; index--)
            {
                var releaseId = $"availability-{suffix}-{index:D2}";
                releaseStore.Register(workId, new Release
                {
                    ReleaseId = releaseId,
                    Title = $"Bounded.Show.S01E02.1080p-GROUP-{index:D2}",
                    Indexer = "bounded-indexer",
                    SizeBytes = 4,
                    Score = index,
                });
                var session = sessions.GetOrCreateOpeningSession(
                    releaseId,
                    workId,
                    new ResolvedMediaFile
                    {
                        FileName = "episode.mkv",
                        Container = "mkv",
                        SizeBytes = 4,
                        OpenStream = _ => new MemoryStream([1, 2, 3, 4]),
                    },
                    "ready",
                    "jellyfin",
                    "user-bound").Session;
                Assert.True(session.AttachPreDownload(
                    new PreDownloadCacheFile(workspace, session.Token, 4),
                    $"job-{index:D2}",
                    "nextEpisode",
                    "test",
                    null));
                tokens.Add(session.Token);
            }

            using var machine = MachineClient();
            var response = await machine.PostAsJsonAsync("/api/v1/releases/local-availability", new
            {
                workIds = new[] { workId },
                client = "jellyfin",
                requestedById = "user-bound",
            });

            response.EnsureSuccessStatusCode();
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            var entries = body.GetProperty("releases").EnumerateArray().ToArray();
            Assert.Equal(20, entries.Length);
            Assert.Equal(
                Enumerable.Range(0, 20).Select(index => $"availability-{suffix}-{index:D2}"),
                entries.Select(entry => entry.GetProperty("releaseId").GetString()));
            Assert.All(entries, entry => Assert.Equal(
                entry.GetProperty("releaseId").GetString(),
                entry.GetProperty("release").GetProperty("releaseId").GetString()));
        }
        finally
        {
            foreach (var token in tokens)
                sessions.PurgeSession(token);
        }
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
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/pre-download")).StatusCode);
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

    private static async Task<string> CreateProvider(HttpClient client, string name)
    {
        var response = await client.PostAsJsonAsync("/api/v1/config/providers", new
        {
            name,
            host = "news.example",
            enabled = true,
            maxConnections = 1,
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
                ["Streamarr:PreDownload:CachePath"] = Path.Combine(_dir, "pre-download"),
                ["Streamarr:LoginAttemptsPerMinute"] = "1000",
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
