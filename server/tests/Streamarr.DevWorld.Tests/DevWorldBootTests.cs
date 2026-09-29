using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld.Tests;

/// <summary>Boots the real Core Server the way Program does, so a backend change that breaks the Dev World fails dotnet test.</summary>
public class DevWorldBootTests(FakeWorld world) : IClassFixture<FakeWorld>
{
    [Fact]
    public async Task RealServer_SeedsViewers_RanksDeadReleasesFirst_AndServesTheHarnessEndpoints()
    {
        var ct = CancellationToken.None;
        await using var booted = await BootAsync(ct);
        var (options, viewers, ranks) = (booted.Options, booted.Viewers, booted.Ranks);

        Assert.Equal(["anna", "ben", "kind", "gast"], viewers.Select(v => v.Username));
        Assert.Equal(WorldSeeder.BenTotpSecret, viewers.Single(v => v.Username == "ben").TotpSecret);
        var dead = world.WithHealth("dead").ToList();
        Assert.Equal(2, dead.Count);
        Assert.All(dead, r => Assert.Equal(1, ranks[$"{r.Plan.WorkId}|{r.ReleaseId}"].Rank));

        using var http = new HttpClient { BaseAddress = new Uri(options.LocalUrl) };
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/devworld/ready", ct)).StatusCode);
        using var manifest = JsonDocument.Parse(await http.GetStringAsync("/devworld.json", ct));
        var root = manifest.RootElement;
        Assert.Empty(root.GetProperty("urls").GetProperty("lan").EnumerateArray());
        Assert.All(root.GetProperty("scenarios").GetProperty("deadFallback").EnumerateArray(), s =>
        {
            Assert.Equal(1, s.GetProperty("deadRank").GetInt32());
            Assert.False(string.IsNullOrEmpty(s.GetProperty("expectedFallbackReleaseId").GetString()));
        });
        Assert.Contains(root.GetProperty("scenarios").GetProperty("ageGate").GetProperty("blocked").EnumerateArray(),
            t => t.GetProperty("title").GetString() == "Night of the Living Dead");
        Assert.Contains(root.GetProperty("scenarios").GetProperty("missingArtwork").EnumerateArray(),
            s => s.GetProperty("seriesWorkId").GetString() == "tmdb-tv-33050" && !s.GetProperty("seasonPoster").GetBoolean());

        foreach (var path in (string[])["/api/v1/viewer/auth/login", "/devworld.json"])
        {
            using var preflight = new HttpRequestMessage(HttpMethod.Options, path);
            preflight.Headers.Add("Origin", "http://localhost:39301");
            preflight.Headers.Add("Access-Control-Request-Method", "POST");
            using var response = await http.SendAsync(preflight, ct);
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            Assert.Equal("*", Assert.Single(response.Headers.GetValues("Access-Control-Allow-Origin")));
        }
    }

    [Fact]
    public async Task RealServer_ResolvesEveryReleaseAsDesigned_AndStreamsTheCachedBytes()
    {
        var ct = CancellationToken.None;
        await using var booted = await BootAsync(ct);

        var checks = await WorldSeeder.CheckReleasesAsync(booted.App.Services, world.Store, booted.Options.LocalUrl, ct);

        Assert.Equal(world.Store.Releases.Sum(r => r.Plan.IsSeasonPack ? r.Plan.Files.Count : 1), checks.Count);
        Assert.All(checks, c => Assert.True(c.Passed, $"{c.Name} for {c.WorkId}: designed {c.Designed}, resolved {c.Actual}"));
        Assert.Equal(["dead", "degraded", "ready"], checks.Select(c => c.Designed).Distinct().Order());
        Assert.All(checks.Where(c => c.Designed == "dead"), c => Assert.Null(c.StreamUrl));

        using var http = new HttpClient();
        foreach (var check in checks.Where(c => c.Designed != "dead"))
        {
            var release = world.Store.Releases.Single(r => r.ReleaseId == check.ReleaseId);
            var episodeTag = check.WorkId[^6..].ToUpperInvariant() + ".";
            var file = release.Plan.Files.Single(f => !release.Plan.IsSeasonPack || f.FileName.Contains(episodeTag, StringComparison.Ordinal));
            var streamed = await http.GetByteArrayAsync(check.StreamUrl, ct);
            var cached = await File.ReadAllBytesAsync(world.Media[file.Media.Key].Path, ct);
            Assert.True(streamed.AsSpan().SequenceEqual(cached), $"{check.Name} for {check.WorkId} streamed {streamed.Length} bytes that differ from {file.FileName}");
        }
    }

    private async Task<BootedWorld> BootAsync(CancellationToken ct)
    {
        var port = FreePort();
        var options = new DevWorldOptions
        {
            Port = port,
            Host = "127.0.0.1",
            CacheDir = world.Root,
            StateDir = Path.Combine(world.Root, $"state-{port}"),
            CatalogPath = FakeWorld.CatalogPath,
        };
        Directory.CreateDirectory(options.StateDir);
        var nntp = DevWorldHost.CreateNntp(world.Store);
        var state = new DevWorldState();
        var app = DevWorldHost.Build(options, world.Plan, world.Store, nntp, state, []);
        var booted = new BootedWorld(app, nntp, options);
        try
        {
            await app.StartAsync(ct);
            booted.Viewers = await WorldSeeder.SeedViewersAsync(app.Services, ct);
            booted.Ranks = await WorldSeeder.WarmUpAsync(app.Services, world.Store, ct);
            state.MarkReady(JsonSerializer.Serialize(
                WorldSeeder.BuildManifest(options, world.Plan, world.Store, world.Media, booted.Viewers, booted.Ranks, new { }, null), DevCatalog.Json));
            return booted;
        }
        catch
        {
            await booted.DisposeAsync();
            throw;
        }
    }

    private sealed class BootedWorld(WebApplication app, MockNntpServer nntp, DevWorldOptions options) : IAsyncDisposable
    {
        public WebApplication App => app;
        public DevWorldOptions Options => options;
        public IReadOnlyList<SeededViewer> Viewers { get; set; } = [];
        public IReadOnlyDictionary<string, ReleaseRank> Ranks { get; set; } = new Dictionary<string, ReleaseRank>();

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
            await nntp.DisposeAsync();
        }
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
