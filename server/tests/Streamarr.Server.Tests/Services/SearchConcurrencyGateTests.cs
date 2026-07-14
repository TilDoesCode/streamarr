using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class SearchConcurrencyGateTests
{
    [Fact]
    public async Task AdmissionIsImmediateAndBounded()
    {
        var gate = new SearchConcurrencyGate(Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
        {
            MaxConcurrentSearches = 1,
        }));

        Assert.True(await gate.TryEnterAsync(default));
        Assert.False(await gate.TryEnterAsync(default));
        gate.Exit();
        Assert.True(await gate.TryEnterAsync(default));
        gate.Exit();
    }
}
