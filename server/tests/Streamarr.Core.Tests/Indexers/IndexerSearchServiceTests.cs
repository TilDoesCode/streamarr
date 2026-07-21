using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;

namespace Streamarr.Core.Tests.Indexers;

public class IndexerSearchServiceTests
{
    private static readonly NewznabQuery Query = new() { Term = "example movie" };

    private static IndexerSearchService Service(
        INewznabClient client,
        IEnumerable<IndexerConfig> indexers,
        IndexerSearchOptions? options = null,
        TimeProvider? time = null,
        SearchCache? cache = null)
    {
        options ??= new IndexerSearchOptions { PerIndexerRateLimitMilliseconds = 0 };
        time ??= TimeProvider.System;
        var limiter = new IndexerRateLimiter(options.RateLimitInterval, time);
        cache ??= new SearchCache(options.CacheTtl, time);
        return new IndexerSearchService(new InMemoryIndexerConfigStore(indexers), client, limiter, cache, options, time);
    }

    [Fact]
    public async Task FanOut_MergesReleasesFromEveryEnabledIndexer()
    {
        var client = new FakeNewznabClient()
            .Returns("Alpha", FakeNewznabClient.Item("Alpha.Release.2021-A", 1000, "a"))
            .Returns("Beta", FakeNewznabClient.Item("Beta.Release.2021-B", 2000, "b"));

        var result = await Service(client, [NewznabFixtures.Indexer("Alpha", 0), NewznabFixtures.Indexer("Beta", 1)])
            .SearchAsync(Query, CancellationToken.None);

        Assert.Equal(2, result.Releases.Count);
        Assert.Contains(result.Outcomes, o => o.IndexerName == "Alpha" && o.Succeeded);
        Assert.Contains(result.Outcomes, o => o.IndexerName == "Beta" && o.Succeeded);
        Assert.Contains(result.Releases, release => release.IndexerId == "alpha");
        Assert.Contains(result.Releases, release => release.IndexerId == "beta");
        Assert.False(result.FromCache);
    }

    [Fact]
    public void ReleaseId_IsBoundToStableIndexerConfigId_NotDisplayName()
    {
        var beforeRename = IndexerSearchService.ReleaseId("indexer-config-id", "upstream-guid");
        var afterRename = IndexerSearchService.ReleaseId("indexer-config-id", "upstream-guid");
        var anotherIndexer = IndexerSearchService.ReleaseId("other-config-id", "upstream-guid");

        Assert.Equal(beforeRename, afterRename);
        Assert.NotEqual(beforeRename, anotherIndexer);
    }

    [Fact]
    public async Task FanOut_DisabledIndexerIsNotQueried()
    {
        var client = new FakeNewznabClient()
            .Returns("Alpha", FakeNewznabClient.Item("Alpha.Release-A", 1000, "a"));

        var result = await Service(client,
                [NewznabFixtures.Indexer("Alpha", 0), NewznabFixtures.Indexer("Beta", 1, enabled: false)])
            .SearchAsync(Query, CancellationToken.None);

        Assert.Single(result.Releases);
        Assert.Single(result.Outcomes);
        Assert.Equal(1, client.SearchCallCount);
    }

    [Fact]
    public async Task FanOut_CapsIndexerCountAndProcessWideConcurrency()
    {
        var options = new IndexerSearchOptions
        {
            PerIndexerRateLimitMilliseconds = 0,
            MaxIndexersPerSearch = 4,
            MaxConcurrentIndexerRequests = 2,
        };
        var indexers = Enumerable.Range(0, 6)
            .Select(i => NewznabFixtures.Indexer($"Indexer{i}", i))
            .ToArray();
        var client = new FakeNewznabClient();
        foreach (var indexer in indexers)
            client.Delays(indexer.Name, TimeSpan.FromMilliseconds(30));

        var result = await Service(client, indexers, options)
            .SearchAsync(Query, CancellationToken.None);

        Assert.Equal(4, result.Outcomes.Count);
        Assert.Equal(4, client.SearchCallCount);
        Assert.InRange(client.MaxObservedConcurrentCalls, 1, 2);
    }

    [Fact]
    public async Task Dedupe_ByNormalizedTitleAndSize_KeepsHigherPriorityIndexer()
    {
        // same normalized title + size on both indexers; alpha has the better priority
        var client = new FakeNewznabClient()
            .Returns("Alpha", FakeNewznabClient.Item("Example.Movie.2021.1080p.WEB-DL-GROUP", 5000, "a"))
            .Returns("Beta", FakeNewznabClient.Item("example.movie.2021.1080p.web-dl-group", 5000, "b"));

        var result = await Service(client, [NewznabFixtures.Indexer("Alpha", 0), NewznabFixtures.Indexer("Beta", 1)])
            .SearchAsync(Query, CancellationToken.None);

        var release = Assert.Single(result.Releases);
        Assert.Equal("Alpha", release.Indexer);
        // both indexers still report their raw item count in the outcomes
        Assert.All(result.Outcomes, o => Assert.Equal(1, o.ItemCount));
    }

    [Fact]
    public async Task Dedupe_DifferentSize_IsNotCollapsed()
    {
        var client = new FakeNewznabClient()
            .Returns("Alpha", FakeNewznabClient.Item("Example.Movie.2021-GROUP", 5000, "a"))
            .Returns("Beta", FakeNewznabClient.Item("Example.Movie.2021-GROUP", 5001, "b"));

        var result = await Service(client, [NewznabFixtures.Indexer("Alpha", 0), NewznabFixtures.Indexer("Beta", 1)])
            .SearchAsync(Query, CancellationToken.None);

        Assert.Equal(2, result.Releases.Count);
    }

    [Fact]
    public async Task ErrorIsolation_OneIndexerThrows_OthersStillReturn()
    {
        var client = new FakeNewznabClient()
            .Throws("Alpha", new NewznabRequestException("boom"))
            .Returns("Beta", FakeNewznabClient.Item("Beta.Release-B", 2000, "b"));

        var result = await Service(client, [NewznabFixtures.Indexer("Alpha", 0), NewznabFixtures.Indexer("Beta", 1)])
            .SearchAsync(Query, CancellationToken.None);

        var release = Assert.Single(result.Releases);
        Assert.Equal("Beta", release.Indexer);

        var alpha = result.Outcomes.Single(o => o.IndexerName == "Alpha");
        Assert.Equal(IndexerOutcomeStatus.Failed, alpha.Status);
        Assert.Equal("Indexer request failed", alpha.Error);
    }

    [Fact]
    public async Task TransientFailure_IsRetriedAndSuccessfulAttemptIsReturned()
    {
        var client = new FakeNewznabClient()
            .FailsThenReturns(
                "Alpha",
                1,
                new NewznabRequestException("temporary", isTransient: true),
                FakeNewznabClient.Item("Alpha.Release-A", 1000, "a"));
        var options = new IndexerSearchOptions
        {
            PerIndexerRateLimitMilliseconds = 0,
            MaxTransientRetries = 2,
            RetryBaseDelayMilliseconds = 0,
            RetryMaxDelayMilliseconds = 0,
        };

        var result = await Service(client, [NewznabFixtures.Indexer("Alpha")], options)
            .SearchAsync(Query, CancellationToken.None);

        Assert.Single(result.Releases);
        Assert.True(Assert.Single(result.Outcomes).Succeeded);
        Assert.Equal(2, client.SearchCallCount);
    }

    [Fact]
    public async Task PermanentFailure_IsNotRetried()
    {
        var client = new FakeNewznabClient()
            .Throws("Alpha", new NewznabRequestException("unauthorized", isTransient: false));
        var options = new IndexerSearchOptions
        {
            PerIndexerRateLimitMilliseconds = 0,
            MaxTransientRetries = 2,
            RetryBaseDelayMilliseconds = 0,
        };

        var result = await Service(client, [NewznabFixtures.Indexer("Alpha")], options)
            .SearchAsync(Query, CancellationToken.None);

        Assert.Empty(result.Releases);
        Assert.Equal(IndexerOutcomeStatus.Failed, Assert.Single(result.Outcomes).Status);
        Assert.Equal(1, client.SearchCallCount);
    }

    [Fact]
    public async Task DegradedFanOut_IsNotCached()
    {
        var client = new FakeNewznabClient()
            .Throws("Alpha", new NewznabRequestException("unauthorized", isTransient: false))
            .Returns("Beta");
        var options = new IndexerSearchOptions
        {
            PerIndexerRateLimitMilliseconds = 0,
            MaxTransientRetries = 0,
        };
        var service = Service(
            client,
            [NewznabFixtures.Indexer("Alpha", 0), NewznabFixtures.Indexer("Beta", 1)],
            options);

        var first = await service.SearchAsync(Query, CancellationToken.None);
        var second = await service.SearchAsync(Query, CancellationToken.None);

        Assert.False(first.FromCache);
        Assert.False(second.FromCache);
        Assert.Equal(4, client.SearchCallCount);
    }

    [Fact]
    public async Task ErrorIsolation_SlowIndexerTimesOut_FastOneStillReturns()
    {
        var client = new FakeNewznabClient()
            .Delays("Alpha", TimeSpan.FromSeconds(10), FakeNewznabClient.Item("Alpha.Slow-A", 1000, "a"))
            .Returns("Beta", FakeNewznabClient.Item("Beta.Fast-B", 2000, "b"));

        var options = new IndexerSearchOptions { PerIndexerTimeoutSeconds = 1, PerIndexerRateLimitMilliseconds = 0 };
        var result = await Service(client, [NewznabFixtures.Indexer("Alpha", 0), NewznabFixtures.Indexer("Beta", 1)], options)
            .SearchAsync(Query, CancellationToken.None);

        var release = Assert.Single(result.Releases);
        Assert.Equal("Beta", release.Indexer);
        Assert.Equal(IndexerOutcomeStatus.TimedOut, result.Outcomes.Single(o => o.IndexerName == "Alpha").Status);
    }

    [Fact]
    public async Task NoEnabledIndexers_ReturnsEmpty()
    {
        var result = await Service(new FakeNewznabClient(), [NewznabFixtures.Indexer("Alpha", enabled: false)])
            .SearchAsync(Query, CancellationToken.None);

        Assert.Empty(result.Releases);
        Assert.Empty(result.Outcomes);
    }

    [Fact]
    public async Task Cache_SecondIdenticalSearch_IsServedFromCache_WithoutRequeryingIndexers()
    {
        var client = new FakeNewznabClient()
            .Returns("Alpha", FakeNewznabClient.Item("Alpha.Release-A", 1000, "a"));
        var service = Service(client, [NewznabFixtures.Indexer("Alpha")]);

        var first = await service.SearchAsync(Query, CancellationToken.None);
        var second = await service.SearchAsync(Query, CancellationToken.None);

        Assert.False(first.FromCache);
        Assert.True(second.FromCache);
        Assert.Equal(1, client.SearchCallCount); // second call served from cache
        Assert.Equal(first.Releases.Count, second.Releases.Count);
    }

    [Fact]
    public async Task Cache_DifferentQuery_IsNotServedFromCache()
    {
        var client = new FakeNewznabClient()
            .Returns("Alpha", FakeNewznabClient.Item("Alpha.Release-A", 1000, "a"));
        var service = Service(client, [NewznabFixtures.Indexer("Alpha")]);

        await service.SearchAsync(new NewznabQuery { Term = "first" }, CancellationToken.None);
        await service.SearchAsync(new NewznabQuery { Term = "second" }, CancellationToken.None);

        Assert.Equal(2, client.SearchCallCount);
    }

    [Fact]
    public async Task Cache_ExpiresAfterTtl_TriggersFreshFanOut()
    {
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 7, 12, 0, 0, 0, TimeSpan.Zero));
        var client = new FakeNewznabClient()
            .Returns("Alpha", FakeNewznabClient.Item("Alpha.Release-A", 1000, "a"));
        var options = new IndexerSearchOptions { SearchCacheTtlSeconds = 60, PerIndexerRateLimitMilliseconds = 0 };
        var service = Service(client, [NewznabFixtures.Indexer("Alpha")], options, time);

        await service.SearchAsync(Query, CancellationToken.None);
        time.Advance(TimeSpan.FromSeconds(61)); // past the 60s TTL
        var afterExpiry = await service.SearchAsync(Query, CancellationToken.None);

        Assert.False(afterExpiry.FromCache);
        Assert.Equal(2, client.SearchCallCount);
    }

    [Fact]
    public async Task Release_AgeDays_ComputedFromUsenetDate()
    {
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 7, 12, 0, 0, 0, TimeSpan.Zero));
        var posted = new DateTimeOffset(2026, 7, 2, 0, 0, 0, TimeSpan.Zero); // 10 days earlier
        var client = new FakeNewznabClient();
        client.Returns("Alpha", new NewznabItem
        {
            Title = "Aged.Release-A",
            Guid = "a",
            SizeBytes = 1000,
            UsenetDate = posted,
        });

        var result = await Service(client, [NewznabFixtures.Indexer("Alpha")], time: time)
            .SearchAsync(Query, CancellationToken.None);

        Assert.Equal(10, Assert.Single(result.Releases).AgeDays);
    }

    [Fact]
    public async Task Integration_TwoRealClientsOverFixtures_DedupeOverlap()
    {
        HttpResponseMessage Route(HttpRequestMessage req)
        {
            var host = req.RequestUri!.Host;
            return host switch
            {
                "alpha.example" => StubHttpMessageHandler.Xml(NewznabFixtures.Load("alpha-search.xml")),
                "beta.example" => StubHttpMessageHandler.Xml(NewznabFixtures.Load("beta-search.xml")),
                _ => StubHttpMessageHandler.Status(System.Net.HttpStatusCode.NotFound),
            };
        }

        var realClient = new NewznabClient(new HttpClient(new StubHttpMessageHandler(Route)));
        var indexers = new[]
        {
            NewznabFixtures.Indexer("Alpha", 0, baseUrl: "https://alpha.example"),
            NewznabFixtures.Indexer("Beta", 1, baseUrl: "https://beta.example"),
        };

        var result = await Service(realClient, indexers).SearchAsync(Query, CancellationToken.None);

        // alpha: a1,a2,a3 (3) · beta: b1(dup of a1),b2,b3 → +b2,b3 → 5 unique
        Assert.Equal(5, result.Releases.Count);

        // the a1/b1 overlap collapses to a single release, kept from higher-priority Alpha
        var overlap = result.Releases.Where(r => r.SizeBytes == 5368709120).ToList();
        var single = Assert.Single(overlap);
        Assert.Equal("Alpha", single.Indexer);
    }
}
