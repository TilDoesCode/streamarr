using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class KeyedAsyncLockTests
{
    [Fact]
    public async Task SameKey_IsExclusive_AndEntriesRetireAfterSuccessAndCancellation()
    {
        var keyedLock = new KeyedAsyncLock();
        var inside = 0;
        var maximumInside = 0;

        async Task Enter(CancellationToken cancellationToken)
        {
            using var lease = await keyedLock.AcquireAsync("release-1", cancellationToken);
            var current = Interlocked.Increment(ref inside);
            InterlockedExtensions.Max(ref maximumInside, current);
            await Task.Yield();
            Interlocked.Decrement(ref inside);
        }

        await Task.WhenAll(Enumerable.Range(0, 100).Select(_ => Enter(CancellationToken.None)));
        Assert.Equal(1, maximumInside);
        Assert.Equal(0, keyedLock.ActiveKeyCount);

        using var held = await keyedLock.AcquireAsync("cancelled", CancellationToken.None);
        using var cancellation = new CancellationTokenSource();
        var waiter = keyedLock.AcquireAsync("cancelled", cancellation.Token).AsTask();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiter);
        Assert.Equal(1, keyedLock.ActiveKeyCount);
        held.Dispose();
        Assert.Equal(0, keyedLock.ActiveKeyCount);
    }

    private static class InterlockedExtensions
    {
        public static void Max(ref int location, int value)
        {
            var current = Volatile.Read(ref location);
            while (current < value)
            {
                var observed = Interlocked.CompareExchange(ref location, value, current);
                if (observed == current)
                    return;
                current = observed;
            }
        }
    }
}
