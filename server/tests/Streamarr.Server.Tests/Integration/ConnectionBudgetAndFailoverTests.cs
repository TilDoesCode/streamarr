using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Boots the real Core Server with bespoke provider + budget config to prove the M7
/// hardening invariants (BRIEF §10-M7): the global NNTP connection budget holds under
/// concurrent streams, and a provider that starts failing mid-stream fails over to the
/// next-priority (block-account) provider per segment.
/// </summary>
public sealed class ConnectionBudgetAndFailoverTests : IAsyncLifetime
{
    private const string ApiKey = "test-api-key-aaaaaaaaaaaaaaaaaaaa";
    private byte[] _video = null!;

    public async Task InitializeAsync() => _video = await TestMediaFile.GenerateMkvAsync(durationSeconds: 30);

    public Task DisposeAsync() => Task.CompletedTask;

    // ------------------------------------------------------------------ connection budget

    [Fact]
    public async Task GlobalBudget_IsNeverExceeded_UnderTwoConcurrentStreams_AndBothProgress()
    {
        const int budget = 3;
        await using var nntp = new MockNntpServer();
        // A single provider whose own pool (16) is well above the budget, so the *budget*
        // — not the pool — is the binding constraint under load.
        await using var host = await BootAsync(
            budget,
            [("primary", nntp, priority: 0, maxConn: 16)],
            "rel-budget", "work-budget");

        using var a = host.Client();
        using var b = host.Client();

        var urlA = (await Resolve(a, "rel-budget")).StreamUrl!;
        var urlB = (await Resolve(b, "rel-budget")).StreamUrl!;

        // Two full-body reads in parallel: read-ahead on each would want more than `budget`
        // connections combined, so this genuinely pushes against the cap.
        var bodies = await Task.WhenAll(
            a.GetByteArrayAsync(urlA),
            b.GetByteArrayAsync(urlB));

        // Both streams completed and are byte-identical to the source (they made progress) …
        Assert.Equal(_video, bodies[0]);
        Assert.Equal(_video, bodies[1]);
        // … yet the mock never saw more concurrent connections than the global budget.
        Assert.True(
            nntp.MaxObservedConnections <= budget,
            $"observed {nntp.MaxObservedConnections} concurrent connections > budget {budget}");
    }

    // ------------------------------------------------------------------- provider failover

    [Fact]
    public async Task PrimaryFailingMidStream_FailsOverToBackupProvider_PerSegment()
    {
        await using var primary = new MockNntpServer();
        await using var backup = new MockNntpServer();

        // Both providers carry the identical article set (same deterministic message-ids),
        // so either can serve the release — a primary + block-account topology.
        var published = Publish(primary, "failover");
        Publish(backup, "failover");
        var nzbPath = WriteNzb(published);

        await using var host = await BootAsync(
            budget: 8,
            [("primary", primary, priority: 0, maxConn: 8), ("backup", backup, priority: 1, maxConn: 8)],
            "rel-failover", "work-failover", nzbPath);

        using var client = host.Client();

        // Resolve + first read: the primary (priority 0) serves everything.
        var resolved = await Resolve(client, "rel-failover");
        Assert.Equal("ready", resolved.Status);
        var streamUrl = resolved.StreamUrl!;

        Assert.Equal(_video, await client.GetByteArrayAsync(streamUrl));
        Assert.True(primary.BodiesServed > 0, "primary should have served the initial read");
        var backupBefore = backup.BodiesServed;

        // The primary loses the articles mid-stream (block expired / DMCA'd / unreachable).
        primary.RejectBodies = true;

        // A subsequent read re-fetches every segment; each 430 on the primary transparently
        // fails over to the backup, so the stream stays byte-identical.
        Assert.Equal(_video, await client.GetByteArrayAsync(streamUrl));
        Assert.True(
            backup.BodiesServed > backupBefore,
            "backup provider should have taken over segment delivery after the primary started failing");
    }

    // ----------------------------------------------------------------------------- helpers

    private PublishedNzbFile Publish(MockNntpServer server, string prefix)
        => NzbTestFixtures.PublishFile(server, "video.mkv", _video, prefix);

    private static async Task<ResolveResponse> Resolve(HttpClient client, string releaseId)
    {
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = releaseId, Client = "hardening" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ResolveResponse>())!;
    }

    private string _tempDir = null!;

    private string WriteNzb(PublishedNzbFile file)
    {
        _tempDir ??= Directory.CreateTempSubdirectory("streamarr-hardening-").FullName;
        var path = Path.Combine(_tempDir, $"{Guid.NewGuid():N}.nzb");
        File.WriteAllText(path, NzbTestFixtures.BuildNzbXml(file));
        return path;
    }

    private async Task<TestHost> BootAsync(
        int budget,
        (string name, MockNntpServer nntp, int priority, int maxConn)[] providers,
        string releaseId,
        string workId,
        string? nzbPath = null)
    {
        _tempDir ??= Directory.CreateTempSubdirectory("streamarr-hardening-").FullName;

        // Default single-provider path publishes its own copy of the video.
        if (nzbPath is null)
        {
            var published = Publish(providers[0].nntp, releaseId);
            nzbPath = WriteNzb(published);
        }

        var settings = new Dictionary<string, string?>
        {
            ["Serilog:MinimumLevel:Default"] = "Warning",
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_tempDir, $"{Guid.NewGuid():N}.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_tempDir, $"keys-{Guid.NewGuid():N}"),
            ["Streamarr:ConnectionBudget"] = budget.ToString(),
            ["Streamarr:SessionTtlSeconds"] = "300",
            ["Streamarr:AllowLocalNzbFiles"] = "true",
        };

        for (var i = 0; i < providers.Length; i++)
        {
            var (name, nntp, priority, maxConn) = providers[i];
            settings[$"Streamarr:Providers:{i}:Name"] = name;
            settings[$"Streamarr:Providers:{i}:Host"] = nntp.Host;
            settings[$"Streamarr:Providers:{i}:Port"] = nntp.Port.ToString();
            settings[$"Streamarr:Providers:{i}:UseSsl"] = "false";
            settings[$"Streamarr:Providers:{i}:MaxConnections"] = maxConn.ToString();
            settings[$"Streamarr:Providers:{i}:Priority"] = priority.ToString();
        }

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Configuration.AddInMemoryCollection(settings);
        builder.AddStreamarrServer();

        var app = builder.Build();
        app.UseStreamarrServer();
        await app.StartAsync();

        var baseUrl = app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.First();

        app.Services.GetRequiredService<IReleaseStore>().Register(workId, new Release
        {
            ReleaseId = releaseId,
            Title = $"Example.2021.1080p.WEB-DL.x264-{releaseId}",
            Indexer = "mock",
            SizeBytes = 0,
            Score = 800,
            NzbUrl = nzbPath,
        });

        return new TestHost(app, baseUrl);
    }

    private sealed class TestHost(WebApplication app, string baseUrl) : IAsyncDisposable
    {
        public HttpClient Client()
        {
            var client = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromMinutes(2) };
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", ApiKey);
            return client;
        }

        public async ValueTask DisposeAsync() => await app.DisposeAsync();
    }
}
