using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Tests.Services;

public sealed class MediaMaterializationCacheTests
{
    [Fact]
    public async Task GetOrCreate_ReusesExactCandidate_AndInvalidatesChangedSegments()
    {
        var cache = Cache();
        var calls = 0;

        Task<ResolvedMediaFile> Materialize(CancellationToken _)
        {
            calls++;
            return Task.FromResult(Media(calls));
        }

        var candidate = Candidate("one@test");
        var first = await cache.GetOrCreateAsync("release-1", candidate, Materialize, default);
        var second = await cache.GetOrCreateAsync("release-1", candidate, Materialize, default);
        var changed = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("changed@test"),
            Materialize,
            default);

        Assert.Same(first, second);
        Assert.NotSame(first, changed);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task GetOrCreate_DoesNotCacheFailures()
    {
        var cache = Cache();
        var calls = 0;

        async Task<ResolvedMediaFile> Materialize(CancellationToken _)
        {
            await Task.Yield();
            if (++calls == 1)
                throw new InvalidDataException("bad archive");
            return Media(calls);
        }

        await Assert.ThrowsAsync<InvalidDataException>(
            () => cache.GetOrCreateAsync("release-1", Candidate("one@test"), Materialize, default));
        var recovered = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("one@test"),
            Materialize,
            default);

        Assert.Equal(2, calls);
        Assert.Equal(2, recovered.SizeBytes);
    }

    [Fact]
    public async Task GetOrCreate_IsSingleFlightForConcurrentCallers()
    {
        var cache = Cache();
        var calls = 0;
        var releaseFactory = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<ResolvedMediaFile> Materialize(CancellationToken _)
        {
            Interlocked.Increment(ref calls);
            await releaseFactory.Task;
            return Media(calls);
        }

        var candidate = Candidate("one@test");
        var first = cache.GetOrCreateAsync("release-1", candidate, Materialize, default);
        var second = cache.GetOrCreateAsync("release-1", candidate, Materialize, default);
        releaseFactory.SetResult();

        var results = await Task.WhenAll(first, second);
        Assert.Same(results[0], results[1]);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task GetOrCreate_FifoEvictsUntilTotalWeightFits()
    {
        var cache = Cache(maxEntries: 32, maxSizeMb: 1);
        var calls = new Dictionary<string, int>(StringComparer.Ordinal);

        Task<ResolvedMediaFile> Materialize(string releaseId)
        {
            calls[releaseId] = calls.GetValueOrDefault(releaseId) + 1;
            return Task.FromResult(Media(
                calls[releaseId],
                estimatedCacheWeightBytes: 700 * 1024));
        }

        var first = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("one@test"),
            _ => Materialize("release-1"),
            default);
        var second = await cache.GetOrCreateAsync(
            "release-2",
            Candidate("two@test"),
            _ => Materialize("release-2"),
            default);

        var secondHit = await cache.GetOrCreateAsync(
            "release-2",
            Candidate("two@test"),
            _ => Materialize("release-2"),
            default);
        var firstAgain = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("one@test"),
            _ => Materialize("release-1"),
            default);

        Assert.Same(second, secondHit);
        Assert.NotSame(first, firstAgain);
        Assert.Equal(2, calls["release-1"]);
        Assert.Equal(1, calls["release-2"]);
    }

    [Fact]
    public async Task GetOrCreate_DoesNotRetainResultLargerThanWeightBudget()
    {
        var cache = Cache(maxEntries: 32, maxSizeMb: 1);
        var calls = 0;

        Task<ResolvedMediaFile> Materialize(CancellationToken _)
            => Task.FromResult(Media(
                Interlocked.Increment(ref calls),
                estimatedCacheWeightBytes: 2 * 1024 * 1024));

        var first = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("one@test"),
            Materialize,
            default);
        var second = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("one@test"),
            Materialize,
            default);

        Assert.NotSame(first, second);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task GetOrCreate_StillEnforcesEntryCountAlongsideWeightBudget()
    {
        var cache = Cache(maxEntries: 1, maxSizeMb: 64);
        var calls = new Dictionary<string, int>(StringComparer.Ordinal);

        Task<ResolvedMediaFile> Materialize(string releaseId)
        {
            calls[releaseId] = calls.GetValueOrDefault(releaseId) + 1;
            return Task.FromResult(Media(calls[releaseId]));
        }

        var first = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("one@test"),
            _ => Materialize("release-1"),
            default);
        var second = await cache.GetOrCreateAsync(
            "release-2",
            Candidate("two@test"),
            _ => Materialize("release-2"),
            default);
        var secondHit = await cache.GetOrCreateAsync(
            "release-2",
            Candidate("two@test"),
            _ => Materialize("release-2"),
            default);
        var firstAgain = await cache.GetOrCreateAsync(
            "release-1",
            Candidate("one@test"),
            _ => Materialize("release-1"),
            default);

        Assert.Same(second, secondHit);
        Assert.NotSame(first, firstAgain);
        Assert.Equal(2, calls["release-1"]);
        Assert.Equal(1, calls["release-2"]);
    }

    [Fact]
    public void EstimatedWeight_IncludesMessageIdStorageAndRarSliceMaps()
    {
        var shortIds = MediaFileMaterializer.EstimateCacheWeightBytes(
            "video.mkv",
            "mkv",
            [new[] { "one@test" }],
            hasFlattenedSegmentArray: false,
            rarSliceCount: 0);
        var longIds = MediaFileMaterializer.EstimateCacheWeightBytes(
            "video.mkv",
            "mkv",
            [new[] { new string('x', 900) + "@test" }],
            hasFlattenedSegmentArray: false,
            rarSliceCount: 0);
        var rar = MediaFileMaterializer.EstimateCacheWeightBytes(
            "video.mkv",
            "mkv",
            [new[] { "one@test" }],
            hasFlattenedSegmentArray: true,
            rarSliceCount: 10);

        Assert.True(longIds > shortIds + 1_700);
        Assert.True(rar > shortIds + 1_900);
    }

    private static MediaMaterializationCache Cache(int maxEntries = 32, int maxSizeMb = 64)
        => new(Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
        {
            MediaMaterializationCacheMaxEntries = maxEntries,
            MediaMaterializationCacheSizeMb = maxSizeMb,
        }));

    private static MediaFileCandidate Candidate(string messageId)
    {
        var file = new NzbFile { Subject = "\"video.part01.rar\" yEnc" };
        file.Segments.Add(new NzbSegment
        {
            Number = 1,
            Bytes = 123,
            MessageId = messageId,
        });
        return new MediaFileCandidate
        {
            DisplayName = "video.part01.rar",
            IsRarWrapped = true,
            Files = [file],
        };
    }

    private static ResolvedMediaFile Media(long size, long estimatedCacheWeightBytes = 0) => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = size,
        EstimatedCacheWeightBytes = estimatedCacheWeightBytes,
        OpenStream = _ => Stream.Null,
    };
}
