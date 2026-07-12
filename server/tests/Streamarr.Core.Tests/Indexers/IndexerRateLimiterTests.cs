using System.Diagnostics;
using Streamarr.Core.Indexers;

namespace Streamarr.Core.Tests.Indexers;

public class IndexerRateLimiterTests
{
    [Fact]
    public async Task WaitAsync_SpacesConsecutiveRequestsToSameIndexer()
    {
        var interval = TimeSpan.FromMilliseconds(120);
        var limiter = new IndexerRateLimiter(interval); // real clock

        var sw = Stopwatch.StartNew();
        await limiter.WaitAsync("alpha", CancellationToken.None); // immediate
        await limiter.WaitAsync("alpha", CancellationToken.None); // +120ms
        await limiter.WaitAsync("alpha", CancellationToken.None); // +120ms
        sw.Stop();

        // two enforced gaps of 120ms; allow scheduler slack on the lower bound
        Assert.True(sw.Elapsed >= TimeSpan.FromMilliseconds(200),
            $"expected >= 200ms of spacing, got {sw.ElapsedMilliseconds}ms");
    }

    [Fact]
    public async Task WaitAsync_DifferentIndexersDoNotBlockEachOther()
    {
        var limiter = new IndexerRateLimiter(TimeSpan.FromMilliseconds(500));

        var sw = Stopwatch.StartNew();
        await limiter.WaitAsync("alpha", CancellationToken.None);
        await limiter.WaitAsync("beta", CancellationToken.None);
        await limiter.WaitAsync("gamma", CancellationToken.None);
        sw.Stop();

        // each indexer's first request is immediate — no cross-indexer waiting
        Assert.True(sw.Elapsed < TimeSpan.FromMilliseconds(400),
            $"different indexers should not block; took {sw.ElapsedMilliseconds}ms");
    }

    [Fact]
    public async Task WaitAsync_ZeroInterval_NeverDelays()
    {
        var limiter = new IndexerRateLimiter(TimeSpan.Zero);

        var sw = Stopwatch.StartNew();
        for (var i = 0; i < 5; i++)
            await limiter.WaitAsync("alpha", CancellationToken.None);
        sw.Stop();

        Assert.True(sw.Elapsed < TimeSpan.FromMilliseconds(200));
    }
}
