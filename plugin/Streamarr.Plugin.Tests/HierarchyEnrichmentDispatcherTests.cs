using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Tests;

public sealed class HierarchyEnrichmentDispatcherTests
{
    [Fact]
    public async Task DuplicatePendingKey_RunsOnlyOnce()
    {
        using var dispatcher = new HierarchyEnrichmentDispatcher(
            NullLogger<HierarchyEnrichmentDispatcher>.Instance);
        await dispatcher.StartAsync(CancellationToken.None);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runs = 0;

        Assert.True(dispatcher.Enqueue("same", async ct =>
        {
            Interlocked.Increment(ref runs);
            entered.TrySetResult();
            await release.Task.WaitAsync(ct);
            completed.TrySetResult();
        }));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.True(dispatcher.Enqueue("same", _ =>
        {
            Interlocked.Increment(ref runs);
            return Task.CompletedTask;
        }));

        release.TrySetResult();
        await completed.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(1, Volatile.Read(ref runs));
        await dispatcher.StopAsync(CancellationToken.None);
    }
}
