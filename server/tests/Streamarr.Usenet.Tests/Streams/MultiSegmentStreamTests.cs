using System.Collections.Concurrent;
using System.Text;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Streams;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Usenet.Tests.Streams;

public class MultiSegmentStreamTests
{
    [Fact]
    public async Task ReadAhead_DownloadsWindowConcurrently_AndEmitsInOrder()
    {
        var parts = new Dictionary<string, byte[]>
        {
            ["one@test"] = YencTestEncoder.LcgBytes(1, 4_000),
            ["two@test"] = YencTestEncoder.LcgBytes(2, 4_000),
            ["three@test"] = YencTestEncoder.LcgBytes(3, 4_000),
        };
        var client = new BlockingNntpClient(parts, requiredConcurrentCalls: 3);

        await using var stream = MultiSegmentStream.Create(
            parts.Keys.ToArray(), client, articleBufferSize: 3, CancellationToken.None);

        await client.WindowFilled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(3, client.MaxConcurrentCalls);
        client.Release.SetResult();

        var actual = await ReadAllAsync(stream);
        Assert.Equal(parts.Values.SelectMany(x => x).ToArray(), actual);
    }

    [Fact]
    public async Task StartupReadAhead_BurstsThenDecaysToSteadyWindow()
    {
        var parts = Enumerable.Range(0, 12).ToDictionary(
            index => $"part-{index}@test",
            index => YencTestEncoder.LcgBytes(index + 20, 4_000));
        var client = new BlockingNntpClient(parts, requiredConcurrentCalls: 6);

        await using var stream = MultiSegmentStream.Create(
            parts.Keys.ToArray(),
            client,
            articleBufferSize: 2,
            CancellationToken.None,
            startupArticleBufferSize: 6,
            startupReadAheadSegments: 6);

        await client.WindowFilled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(6, client.CallCount);
        client.Release.SetResult();

        var firstFive = new byte[5 * 4_000];
        await stream.ReadExactlyAsync(firstFive);
        await WaitForAsync(() => client.CallCount >= 7);
        await Task.Delay(50);
        Assert.Equal(7, client.CallCount);

        using var remainder = new MemoryStream();
        await stream.CopyToAsync(remainder);
        var expected = parts.Values.SelectMany(bytes => bytes).ToArray();
        Assert.Equal(expected, firstFive.Concat(remainder.ToArray()).ToArray());
    }

    [Fact]
    public async Task MidBodyFailure_RetriesWholeArticle_AndValidatesBeforeDelivery()
    {
        var expected = YencTestEncoder.LcgBytes(4, 20_000);
        var client = new RetryNntpClient(expected);

        await using var stream = MultiSegmentStream.Create(
            new[] { "retry@test" }, client, articleBufferSize: 1, CancellationToken.None,
            retryCount: 2);

        Assert.Equal(expected, await ReadAllAsync(stream));
        Assert.Equal(2, client.CallCount);
    }

    [Fact]
    public async Task TransientFailure_ExhaustsImmediateRetriesBeforeDelayedRetrySucceeds()
    {
        var expected = YencTestEncoder.LcgBytes(54, 20_000);
        var client = new TransientFailureNntpClient(expected, failuresBeforeSuccess: 3);
        var delayedRetryNumbers = new List<int>();
        var bodyCallsAtDelay = new List<int>();

        await using var stream = MultiSegmentStream.Create(
            new[] { "delayed-retry@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            retryCount: 2,
            transientRetryCount: 1,
            transientRetryDelay: retryNumber =>
            {
                delayedRetryNumbers.Add(retryNumber);
                bodyCallsAtDelay.Add(client.CallCount);
                return TimeSpan.Zero;
            });

        Assert.Equal(expected, await ReadAllAsync(stream));
        Assert.Equal(4, client.CallCount);
        Assert.Equal([1], delayedRetryNumbers);
        Assert.Equal([3], bodyCallsAtDelay);
    }

    [Fact]
    public async Task DelayedRetry_WithReadAheadDisabled_PausesBeforeFollowingArticle()
    {
        var expected = YencTestEncoder.LcgBytes(56, 8_000);
        var client = new TransientFailureNntpClient(expected, failuresBeforeSuccess: 1);
        var delayEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        await using var stream = MultiSegmentStream.Create(
            new[] { "first@test", "second@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            retryCount: 0,
            transientRetryCount: 1,
            transientRetryDelay: _ =>
            {
                delayEntered.TrySetResult();
                return TimeSpan.FromMilliseconds(150);
            },
            disableReadAhead: true);

        var read = ReadAllAsync(stream);
        await delayEntered.Task.WaitAsync(TimeSpan.FromSeconds(1));
        await Task.Delay(25);
        Assert.Equal(1, client.CallCount);

        Assert.Equal(expected.Concat(expected).ToArray(), await read);
        Assert.Equal(3, client.CallCount);
    }

    [Fact]
    public async Task MissingArticle_DoesNotUseImmediateOrDelayedRetries()
    {
        var client = new MissingNntpClient();
        var delayCalls = 0;
        await using var stream = MultiSegmentStream.Create(
            new[] { "missing@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            retryCount: 2,
            transientRetryCount: 5,
            transientRetryDelay: _ =>
            {
                Interlocked.Increment(ref delayCalls);
                return TimeSpan.Zero;
            });

        await Assert.ThrowsAsync<UsenetArticleNotFoundException>(() => ReadAllAsync(stream));

        Assert.Equal(1, client.CallCount);
        Assert.Equal(0, delayCalls);
    }

    [Fact]
    public async Task CancellationDuringTransientRetryDelay_StopsWithoutAnotherBodyAndReportsPartial()
    {
        var client = new TransientFailureNntpClient(
            YencTestEncoder.LcgBytes(55, 20_000),
            failuresBeforeSuccess: int.MaxValue);
        using var cancellation = new CancellationTokenSource();
        var delayEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var retryNumber = 0;
        var events = new ConcurrentQueue<SegmentTransferEvent>();
        await using var stream = MultiSegmentStream.Create(
            new[] { "cancel-delayed-retry@test" },
            client,
            articleBufferSize: 1,
            cancellation.Token,
            retryCount: 0,
            transientRetryCount: 3,
            transientRetryDelay: attempt =>
            {
                retryNumber = attempt;
                delayEntered.TrySetResult();
                return TimeSpan.FromMinutes(5);
            },
            onTransfer: events.Enqueue);

        var read = ReadAllAsync(stream);
        await delayEntered.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(1, client.CallCount);
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => read.WaitAsync(TimeSpan.FromSeconds(1)));

        Assert.Equal(1, retryNumber);
        Assert.Equal(1, client.CallCount);
        Assert.Single(events, transfer => transfer.Stage == SegmentTransferStage.Partial);
        Assert.DoesNotContain(events, transfer => transfer.Stage == SegmentTransferStage.Failed);
    }

    [Fact]
    public async Task MidBodyFailure_ReportsTheRootCauseAfterRetriesAreExhausted()
    {
        var client = new RetryNntpClient(YencTestEncoder.LcgBytes(40, 20_000));
        var events = new List<SegmentTransferEvent>();
        await using var stream = MultiSegmentStream.Create(
            new[] { "broken@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            retryCount: 0,
            onTransfer: transfer => events.Add(transfer));

        await Assert.ThrowsAsync<IOException>(() => ReadAllAsync(stream));

        var failure = Assert.Single(events, transfer => transfer.Stage == SegmentTransferStage.Failed);
        Assert.Equal(nameof(IOException), failure.ErrorType);
        Assert.Contains("Synthetic mid-body disconnect", failure.ErrorMessage);
    }

    [Fact]
    public async Task TransferObserver_ReportsQueueDownloadAndValidatedCompletion()
    {
        var expected = YencTestEncoder.LcgBytes(41, 8_000);
        var client = new BlockingNntpClient(
            new Dictionary<string, byte[]> { ["observed@test"] = expected },
            requiredConcurrentCalls: 1);
        var events = new List<SegmentTransferEvent>();

        await using var stream = MultiSegmentStream.Create(
            new[] { "observed@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            onTransfer: transfer => events.Add(transfer));
        await client.WindowFilled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        client.Release.SetResult();

        Assert.Equal(expected, await ReadAllAsync(stream));
        Assert.Collection(
            events,
            queued => Assert.Equal(SegmentTransferStage.Queued, queued.Stage),
            downloading => Assert.Equal(SegmentTransferStage.Downloading, downloading.Stage),
            downloaded =>
            {
                Assert.Equal(SegmentTransferStage.Downloaded, downloaded.Stage);
                Assert.Equal(expected.LongLength, downloaded.Bytes);
                Assert.True(downloaded.DurationMs >= 0);
            });
    }

    [Fact]
    public async Task TransferObserver_DistinguishesCacheHitFromProviderDownload()
    {
        var expected = YencTestEncoder.LcgBytes(42, 4_000);
        var client = new BlockingNntpClient(
            new Dictionary<string, byte[]> { ["cached-observed@test"] = expected },
            requiredConcurrentCalls: 1);
        using var cache = new SegmentCache(1024 * 1024);

        await using (var warm = MultiSegmentStream.Create(
                         new[] { "cached-observed@test" }, client, 1, CancellationToken.None, cache))
        {
            await client.WindowFilled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            client.Release.SetResult();
            Assert.Equal(expected, await ReadAllAsync(warm));
        }

        var events = new List<SegmentTransferEvent>();
        await using var cached = MultiSegmentStream.Create(
            new[] { "cached-observed@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            cache,
            onTransfer: transfer => events.Add(transfer));

        Assert.Equal(expected, await ReadAllAsync(cached));
        Assert.Contains(events, transfer =>
            transfer.Stage == SegmentTransferStage.Cached
            && transfer.Bytes == expected.LongLength);
        Assert.DoesNotContain(events, transfer => transfer.Stage == SegmentTransferStage.Downloading);
        Assert.Equal(1, client.CallCount);
    }

    [Fact]
    public async Task SegmentCache_SharesInFlightDownload_AndReusesCompletedBytes()
    {
        var expected = YencTestEncoder.LcgBytes(5, 8_000);
        var client = new BlockingNntpClient(
            new Dictionary<string, byte[]> { ["shared@test"] = expected },
            requiredConcurrentCalls: 1);
        var cache = new SegmentCache(1024 * 1024);

        await using var first = MultiSegmentStream.Create(
            new[] { "shared@test" }, client, 1, CancellationToken.None, cache);
        await using var second = MultiSegmentStream.Create(
            new[] { "shared@test" }, client, 1, CancellationToken.None, cache);

        await client.WindowFilled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, client.CallCount);
        client.Release.SetResult();

        var reads = await Task.WhenAll(ReadAllAsync(first), ReadAllAsync(second));
        Assert.All(reads, bytes => Assert.Equal(expected, bytes));

        await using var third = MultiSegmentStream.Create(
            new[] { "shared@test" }, client, 1, CancellationToken.None, cache);
        Assert.Equal(expected, await ReadAllAsync(third));
        Assert.Equal(1, client.CallCount);
    }

    [Fact]
    public async Task CoalescedCacheWaiter_ReportsItsActualWaitDuration()
    {
        var expected = YencTestEncoder.LcgBytes(51, 8_000);
        var client = new BlockingNntpClient(
            new Dictionary<string, byte[]> { ["coalesced@test"] = expected },
            requiredConcurrentCalls: 1);
        using var cache = new SegmentCache(1024 * 1024);
        await using var owner = MultiSegmentStream.Create(
            new[] { "coalesced@test" }, client, 1, CancellationToken.None, cache);
        await client.WindowFilled.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var waiterEvents = new ConcurrentQueue<SegmentTransferEvent>();
        await using var waiter = MultiSegmentStream.Create(
            new[] { "coalesced@test" },
            client,
            1,
            CancellationToken.None,
            cache,
            onTransfer: waiterEvents.Enqueue);
        var reads = Task.WhenAll(ReadAllAsync(owner), ReadAllAsync(waiter));
        await WaitForAsync(() => waiterEvents.Any(
            transfer => transfer.Stage == SegmentTransferStage.Queued));
        await Task.Delay(25);
        client.Release.SetResult();

        Assert.All(await reads, bytes => Assert.Equal(expected, bytes));
        var cached = Assert.Single(waiterEvents,
            transfer => transfer.Stage == SegmentTransferStage.Cached);
        Assert.NotNull(cached.DurationMs);
        Assert.True(cached.DurationMs >= 10);
        Assert.Equal(1, client.CallCount);
    }

    [Fact]
    public async Task CancelledCoalescedCacheWaiter_ReportsTerminalPartialNotFailure()
    {
        var expected = YencTestEncoder.LcgBytes(52, 8_000);
        var client = new BlockingNntpClient(
            new Dictionary<string, byte[]> { ["cancelled-waiter@test"] = expected },
            requiredConcurrentCalls: 1);
        using var cache = new SegmentCache(1024 * 1024);
        await using var owner = MultiSegmentStream.Create(
            new[] { "cancelled-waiter@test" }, client, 1, CancellationToken.None, cache);
        await client.WindowFilled.Task.WaitAsync(TimeSpan.FromSeconds(5));

        using var cancellation = new CancellationTokenSource();
        var waiterEvents = new ConcurrentQueue<SegmentTransferEvent>();
        await using var waiter = MultiSegmentStream.Create(
            new[] { "cancelled-waiter@test" },
            client,
            1,
            cancellation.Token,
            cache,
            onTransfer: waiterEvents.Enqueue);
        var waiterRead = ReadAllAsync(waiter);
        await WaitForAsync(() => waiterEvents.Any(
            transfer => transfer.Stage == SegmentTransferStage.Queued));
        await Task.Delay(25);
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => waiterRead.WaitAsync(TimeSpan.FromSeconds(2)));
        await WaitForAsync(() => waiterEvents.Any(
            transfer => transfer.Stage == SegmentTransferStage.Partial));
        var partial = Assert.Single(waiterEvents,
            transfer => transfer.Stage == SegmentTransferStage.Partial);
        Assert.NotNull(partial.DurationMs);
        Assert.True(partial.DurationMs >= 10);
        Assert.DoesNotContain(waiterEvents,
            transfer => transfer.Stage == SegmentTransferStage.Failed);
        Assert.Equal(1, client.CallCount);

        client.Release.SetResult();
        Assert.Equal(expected, await ReadAllAsync(owner));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task ActiveRead_ReportsBoundedCumulativeProgress(int articleBufferSize)
    {
        var expected = YencTestEncoder.LcgBytes(53, 800_000);
        var events = new ConcurrentQueue<SegmentTransferEvent>();
        await using var stream = MultiSegmentStream.Create(
            new[] { "progress@test" },
            new BlockingNntpClient(
                new Dictionary<string, byte[]> { ["progress@test"] = expected },
                requiredConcurrentCalls: 1),
            articleBufferSize,
            CancellationToken.None,
            openedFirstSegment: new MemoryStream(expected, writable: false),
            progressiveFirstSegment: articleBufferSize > 0,
            onTransfer: events.Enqueue);

        Assert.Equal(expected, await ReadAllAsync(stream));

        var progress = events
            .Where(transfer => transfer.Stage == SegmentTransferStage.Downloading
                               && transfer.Bytes > 0)
            .ToArray();
        Assert.InRange(progress.Length, 1, 4);
        Assert.All(progress, transfer =>
        {
            Assert.InRange(transfer.Bytes, 1, expected.LongLength - 1);
            Assert.NotNull(transfer.DurationMs);
        });
        Assert.True(progress.SequenceEqual(progress.OrderBy(transfer => transfer.Bytes)));
        var downloaded = Assert.Single(events,
            transfer => transfer.Stage == SegmentTransferStage.Downloaded);
        Assert.Equal(expected.LongLength, downloaded.Bytes);
    }

    [Fact]
    public async Task ProgressiveFirstSegment_ReturnsBytesBeforeArticleCompletes_AndCachesOnEof()
    {
        var first = Encoding.ASCII.GetBytes("first-");
        var second = Encoding.ASCII.GetBytes("second");
        var client = new ProgressiveNntpClient(first, second);
        using var cache = new SegmentCache(1024 * 1024);

        await using (var stream = MultiSegmentStream.Create(
                         new[] { "progressive@test" },
                         client,
                         articleBufferSize: 1,
                         CancellationToken.None,
                         cache,
                         progressiveFirstSegment: true))
        {
            var buffer = new byte[first.Length];
            await stream.ReadExactlyAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(1));
            Assert.Equal(first, buffer);
            Assert.False(client.Release.Task.IsCompleted);

            client.Release.TrySetResult();
            using var remainder = new MemoryStream();
            await stream.CopyToAsync(remainder);
            Assert.Equal(second, remainder.ToArray());
        }

        await using var cached = MultiSegmentStream.Create(
            new[] { "progressive@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            cache,
            progressiveFirstSegment: true);
        Assert.Equal(first.Concat(second).ToArray(), await ReadAllAsync(cached));
        Assert.Equal(1, client.CallCount);
    }

    [Fact]
    public async Task ProgressiveFirstSegment_FinishesReactiveCacheAfterConsumerCloses()
    {
        var first = Encoding.ASCII.GetBytes("first-");
        var second = Encoding.ASCII.GetBytes("second");
        var client = new ProgressiveNntpClient(first, second);
        using var cache = new SegmentCache(1024 * 1024);

        await using (var stream = MultiSegmentStream.Create(
                         new[] { "abandoned@test" },
                         client,
                         articleBufferSize: 1,
                         CancellationToken.None,
                         cache,
                         progressiveFirstSegment: true))
        {
            var buffer = new byte[first.Length];
            await stream.ReadExactlyAsync(buffer);
            Assert.Equal(first, buffer);
            client.Release.TrySetResult();
        }

        await WaitForAsync(() => cache.GetStats(["abandoned@test"]).Count == 1);
        await using var cached = MultiSegmentStream.Create(
            new[] { "abandoned@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            cache,
            progressiveFirstSegment: true);
        Assert.Equal(first.Concat(second).ToArray(), await ReadAllAsync(cached));
        Assert.Equal(1, client.CallCount);
    }

    [Fact]
    public async Task OpenedFirstSegment_DefaultPath_ValidatesAndSharesTheInFlightCacheEntry()
    {
        var first = Encoding.ASCII.GetBytes("first-");
        var second = Encoding.ASCII.GetBytes("second");
        var openedRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var client = new ProgressiveNntpClient(first, second);
        using var cache = new SegmentCache(1024 * 1024);

        await using var firstStream = MultiSegmentStream.Create(
            new[] { "opened@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            cache,
            openedFirstSegment: new GatedYencStream(first, second, openedRelease.Task));
        await using var secondStream = MultiSegmentStream.Create(
            new[] { "opened@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            cache);

        var reads = Task.WhenAll(ReadAllAsync(firstStream), ReadAllAsync(secondStream));
        await Task.Delay(25);
        var callsBeforeCompletion = client.CallCount;
        openedRelease.TrySetResult();
        client.Release.TrySetResult();

        var expected = first.Concat(second).ToArray();
        Assert.All(await reads, bytes => Assert.Equal(expected, bytes));
        Assert.Equal(0, callsBeforeCompletion);
        Assert.Equal(0, client.CallCount);
    }

    [Fact]
    public async Task ProgressiveFirstSegment_HeaderFailureDisposesTheOpenedBody()
    {
        var client = new MalformedHeaderNntpClient();
        using var cache = new SegmentCache(1024 * 1024);
        await using var stream = MultiSegmentStream.Create(
            new[] { "malformed@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            cache,
            progressiveFirstSegment: true);

        await Assert.ThrowsAsync<InvalidDataException>(() => ReadAllAsync(stream));

        Assert.True(client.BodyDisposed);
    }

    [Fact]
    public async Task ProgressiveFirstSegment_OpeningHonorsTheOwningRequestCancellation()
    {
        var client = new CancellationBlockingNntpClient();
        using var cache = new SegmentCache(1024 * 1024);
        using var cancellation = new CancellationTokenSource();
        var events = new List<SegmentTransferEvent>();
        await using var stream = MultiSegmentStream.Create(
            new[] { "cancel@test" },
            client,
            articleBufferSize: 1,
            cancellation.Token,
            cache,
            progressiveFirstSegment: true,
            onTransfer: transfer => events.Add(transfer));

        var read = stream.ReadAsync(new byte[1]).AsTask();
        await client.Entered.Task.WaitAsync(TimeSpan.FromSeconds(1));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => read.WaitAsync(TimeSpan.FromSeconds(1)));
        await client.CancellationObserved.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Contains(events, transfer => transfer.Stage == SegmentTransferStage.Partial);
        Assert.DoesNotContain(events, transfer => transfer.Stage == SegmentTransferStage.Failed);
    }

    [Fact]
    public async Task ProgressiveFirstSegment_ZeroCapacityCacheDoesNotDrainAfterClose()
    {
        var first = Encoding.ASCII.GetBytes("first-");
        var second = Encoding.ASCII.GetBytes("second");
        var client = new ProgressiveNntpClient(first, second);
        using var cache = new SegmentCache(0);
        var stream = MultiSegmentStream.Create(
            new[] { "disabled-cache@test" },
            client,
            articleBufferSize: 1,
            CancellationToken.None,
            cache,
            progressiveFirstSegment: true);

        var buffer = new byte[first.Length];
        await stream.ReadExactlyAsync(buffer);
        await stream.DisposeAsync();
        await Task.Delay(25);

        Assert.Equal(first, buffer);
        Assert.False(client.SecondReadStarted.Task.IsCompleted);
        Assert.Equal((0, 0L), cache.GetStats(["disabled-cache@test"]));
    }

    private static async Task<byte[]> ReadAllAsync(Stream stream)
    {
        using var output = new MemoryStream();
        await stream.CopyToAsync(output);
        return output.ToArray();
    }

    private static async Task WaitForAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!predicate())
            await Task.Delay(10, timeout.Token);
    }

    private abstract class TestNntpClient : NntpClientBase
    {
        protected static NntpDecodedBodyResponse Response(string id, byte[] bytes, Stream? raw = null) => new()
        {
            ResponseCode = 222,
            ResponseMessage = "222 body follows",
            SegmentId = id,
            Stream = new YencStream(raw ?? new MemoryStream(
                Encoding.Latin1.GetBytes(YencTestEncoder.Encode(bytes, "part.bin")), writable: false)),
        };

        public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken ct)
            => Task.CompletedTask;
        public override Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken ct)
            => throw new NotSupportedException();
        public override Task<NntpStatResponse> StatAsync(SegmentId id, CancellationToken ct)
            => throw new NotSupportedException();
        public override Task<NntpHeadResponse> HeadAsync(SegmentId id, CancellationToken ct)
            => throw new NotSupportedException();
        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(SegmentId id, CancellationToken ct)
            => throw new NotSupportedException();
        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
            SegmentId id, Action<ArticleBodyResult>? callback, CancellationToken ct)
            => throw new NotSupportedException();
        public override Task<NntpDateResponse> DateAsync(CancellationToken ct)
            => throw new NotSupportedException();
        public override void Dispose() { }
    }

    private sealed class BlockingNntpClient(
        IReadOnlyDictionary<string, byte[]> parts,
        int requiredConcurrentCalls) : TestNntpClient
    {
        private int _activeCalls;
        private int _maxConcurrentCalls;
        private int _callCount;

        public TaskCompletionSource WindowFilled { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int MaxConcurrentCalls => Volatile.Read(ref _maxConcurrentCalls);
        public int CallCount => Volatile.Read(ref _callCount);

        public override async Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _callCount);
            var active = Interlocked.Increment(ref _activeCalls);
            UpdateMax(ref _maxConcurrentCalls, active);
            if (active >= requiredConcurrentCalls) WindowFilled.TrySetResult();
            try
            {
                await Release.Task.WaitAsync(cancellationToken);
                return Response(segmentId, parts[segmentId]);
            }
            finally
            {
                Interlocked.Decrement(ref _activeCalls);
            }
        }

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId id, Action<ArticleBodyResult>? callback, CancellationToken ct)
            => DecodedBodyAsync(id, ct);

        private static void UpdateMax(ref int location, int value)
        {
            var current = Volatile.Read(ref location);
            while (value > current)
            {
                var observed = Interlocked.CompareExchange(ref location, value, current);
                if (observed == current) return;
                current = observed;
            }
        }
    }

    private sealed class RetryNntpClient(byte[] bytes) : TestNntpClient
    {
        private int _callCount;
        public int CallCount => _callCount;

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId, CancellationToken cancellationToken)
        {
            var attempt = Interlocked.Increment(ref _callCount);
            var encoded = Encoding.Latin1.GetBytes(YencTestEncoder.Encode(bytes, "part.bin"));
            Stream raw = attempt == 1
                ? new FailAfterFirstReadStream(encoded)
                : new MemoryStream(encoded, writable: false);
            return Task.FromResult(Response(segmentId, bytes, raw));
        }

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId id, Action<ArticleBodyResult>? callback, CancellationToken ct)
            => DecodedBodyAsync(id, ct);
    }

    private sealed class TransientFailureNntpClient(
        byte[] bytes,
        int failuresBeforeSuccess) : TestNntpClient
    {
        private int _callCount;
        public int CallCount => Volatile.Read(ref _callCount);

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken)
        {
            var attempt = Interlocked.Increment(ref _callCount);
            return attempt <= failuresBeforeSuccess
                ? Task.FromException<NntpDecodedBodyResponse>(
                    new TimeoutException("Synthetic NNTP read timeout."))
                : Task.FromResult(Response(segmentId, bytes));
        }

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId id,
            Action<ArticleBodyResult>? callback,
            CancellationToken ct) => DecodedBodyAsync(id, ct);
    }

    private sealed class MissingNntpClient : TestNntpClient
    {
        private int _callCount;
        public int CallCount => Volatile.Read(ref _callCount);

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _callCount);
            return Task.FromException<NntpDecodedBodyResponse>(
                new UsenetArticleNotFoundException(segmentId));
        }

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId id,
            Action<ArticleBodyResult>? callback,
            CancellationToken ct) => DecodedBodyAsync(id, ct);
    }

    private sealed class ProgressiveNntpClient(byte[] first, byte[] second) : TestNntpClient
    {
        private int _callCount;
        public int CallCount => _callCount;
        public TaskCompletionSource Release { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource SecondReadStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _callCount);
            return Task.FromResult(new NntpDecodedBodyResponse
            {
                ResponseCode = 222,
                ResponseMessage = "222 body follows",
                SegmentId = segmentId,
                Stream = new GatedYencStream(first, second, Release.Task, SecondReadStarted),
            });
        }

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId id,
            Action<ArticleBodyResult>? callback,
            CancellationToken ct) => DecodedBodyAsync(id, ct);
    }

    private sealed class GatedYencStream(
        byte[] first,
        byte[] second,
        Task release,
        TaskCompletionSource? secondReadStarted = null)
        : YencStream(Stream.Null)
    {
        private int _read;

        public override ValueTask<YencHeader?> GetYencHeadersAsync(CancellationToken cancellationToken = default)
            => ValueTask.FromResult<YencHeader?>(new YencHeader
            {
                FileName = "part.bin",
                FileSize = first.Length + second.Length,
                PartOffset = 0,
                PartSize = first.Length + second.Length,
                LineLength = 128,
                PartNumber = 1,
                TotalParts = 1,
            });

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            if (_read == 0)
            {
                _read++;
                first.CopyTo(buffer);
                return first.Length;
            }
            if (_read == 1)
            {
                _read++;
                secondReadStarted?.TrySetResult();
                await release.WaitAsync(cancellationToken);
                second.CopyTo(buffer);
                return second.Length;
            }
            return 0;
        }
    }

    private sealed class MalformedHeaderNntpClient : TestNntpClient
    {
        private readonly TrackingMemoryStream _body =
            new(Encoding.ASCII.GetBytes("not-a-yenc-article\r\n"));

        public bool BodyDisposed => _body.IsDisposed;

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken)
            => Task.FromResult(new NntpDecodedBodyResponse
            {
                ResponseCode = 222,
                ResponseMessage = "222 body follows",
                SegmentId = segmentId,
                Stream = new YencStream(_body),
            });

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId id,
            Action<ArticleBodyResult>? callback,
            CancellationToken ct) => DecodedBodyAsync(id, ct);
    }

    private sealed class CancellationBlockingNntpClient : TestNntpClient
    {
        public TaskCompletionSource Entered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource CancellationObserved { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken)
        {
            Entered.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                CancellationObserved.TrySetResult();
                throw;
            }

            throw new InvalidOperationException("The cancellation wait unexpectedly completed.");
        }

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId id,
            Action<ArticleBodyResult>? callback,
            CancellationToken ct) => DecodedBodyAsync(id, ct);
    }

    private sealed class TrackingMemoryStream(byte[] bytes) : MemoryStream(bytes, writable: false)
    {
        public bool IsDisposed { get; private set; }

        protected override void Dispose(bool disposing)
        {
            IsDisposed = true;
            base.Dispose(disposing);
        }
    }

    private sealed class FailAfterFirstReadStream(byte[] bytes) : Stream
    {
        private readonly MemoryStream _inner = new(bytes, writable: false);
        private bool _readOnce;

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_readOnce) throw new IOException("Synthetic mid-body disconnect.");
            _readOnce = true;
            return await _inner.ReadAsync(buffer[..Math.Min(buffer.Length, 256)], cancellationToken);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing) _inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
