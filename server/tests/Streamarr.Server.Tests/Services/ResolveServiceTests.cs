using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class ResolveServiceTests
{
    [Fact]
    public async Task SpeculativeMaterializationObservation_DoesNotWaitAndConsumesFailure()
    {
        var source = new TaskCompletionSource<ResolvedMediaFile>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var observation = ResolveService.ObserveMaterializationAsync(source.Task);

        Assert.False(observation.IsCompleted);
        source.SetException(new InvalidDataException("speculative failure"));
        await observation.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.True(observation.IsCompletedSuccessfully);
        Assert.True(source.Task.IsFaulted);
    }
}
