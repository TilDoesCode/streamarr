using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

/// <summary>
/// Immediate-admission gate around the whole search pipeline. One search fans out to
/// every enabled indexer and buffers bounded responses, so bounding each response alone
/// does not bound process-wide in-flight memory.
/// </summary>
public sealed class SearchConcurrencyGate(IOptions<StreamarrOptions> options)
{
    private readonly SemaphoreSlim _gate = new(Math.Max(1, options.Value.MaxConcurrentSearches));

    public ValueTask<bool> TryEnterAsync(CancellationToken ct)
        => new(_gate.WaitAsync(0, ct));

    public void Exit() => _gate.Release();
}
