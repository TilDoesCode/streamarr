using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class SearchConcurrencyGateTests
{
    [Fact]
    public async Task FullCapacityRejectionIncludesStateAndRecoversAfterRelease()
    {
        var time = new ManualTimeProvider(DateTimeOffset.UnixEpoch);
        var logger = new CollectingLogger<SearchConcurrencyGate>();
        var gate = Gate(time: time, logger: logger);

        using var first = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
        time.Advance(TimeSpan.FromSeconds(3));

        Assert.Null(await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
        var full = gate.GetSnapshot();
        Assert.Equal(1, full.Active);
        Assert.Equal(1, full.Capacity);
        Assert.Equal(TimeSpan.FromSeconds(3), full.OldestAge);
        Assert.Contains(logger.Messages, message =>
            message.Contains(
                "active=1, capacity=1, oldestAgeMs=3000, holders=PublicSearch:1",
                StringComparison.Ordinal));

        first.Dispose();
        using var recovered = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
        Assert.Equal(1, gate.GetSnapshot().Active);
    }

    [Fact]
    public async Task DisposalIsIdempotent()
    {
        var gate = Gate();
        var admission = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));

        admission.Dispose();
        admission.Dispose();

        using var recovered = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
        Assert.Equal(1, gate.GetSnapshot().Active);
    }

    [Fact]
    public async Task CancelledAdmissionAttemptDoesNotConsumeCapacity()
    {
        var gate = Gate();
        using var occupied = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => gate.TryEnterAsync(SearchOperation.PublicSearch, cancellation.Token).AsTask());
        Assert.Equal(1, gate.GetSnapshot().Active);

        occupied.Dispose();
        using var recovered = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
    }

    [Fact]
    public async Task ExceptionInsideLeaseReleasesCapacity()
    {
        var gate = Gate();

        await Assert.ThrowsAsync<InvalidOperationException>(() => ThrowInsideAdmissionAsync(gate));

        Assert.Equal(0, gate.GetSnapshot().Active);
        using var recovered = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
    }

    [Fact]
    public async Task CallerCancellationCancelsAdmittedWorkAndReleaseRecoversCapacity()
    {
        var gate = Gate();
        using var cancellation = new CancellationTokenSource();
        using (var admission = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
                   await gate.TryEnterAsync(SearchOperation.PublicSearch, cancellation.Token)))
        {
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(
                () => Task.Delay(Timeout.InfiniteTimeSpan, admission.CancellationToken));
        }

        using var recovered = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));
    }

    [Fact]
    public async Task ServerDeadlineCancelsAdmittedWork()
    {
        var gate = Gate(timeoutSeconds: 1);
        using var admission = Assert.IsType<SearchConcurrencyGate.SearchAdmission>(
            await gate.TryEnterAsync(SearchOperation.PublicSearch, default));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Task.Delay(Timeout.InfiniteTimeSpan, admission.CancellationToken)
                .WaitAsync(TimeSpan.FromSeconds(3)));

        Assert.True(admission.DeadlineExceeded);
    }

    private static SearchConcurrencyGate Gate(
        int timeoutSeconds = 120,
        TimeProvider? time = null,
        ILogger<SearchConcurrencyGate>? logger = null)
        => new(
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                MaxConcurrentSearches = 1,
                SearchTimeoutSeconds = timeoutSeconds,
            }),
            logger,
            time);

    private static async Task ThrowInsideAdmissionAsync(SearchConcurrencyGate gate)
    {
        using var admission = await gate.TryEnterAsync(SearchOperation.PublicSearch, default);
        Assert.NotNull(admission);
        throw new InvalidOperationException("test");
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }

    private sealed class CollectingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }
}
