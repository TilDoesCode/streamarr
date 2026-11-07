using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Services;

/// <summary>
/// The connection share of device downloads: at most <c>limit()</c> of their NNTP commands at once, each then entering the global
/// budget at low priority, so downloads never hold more than their share and always queue behind playback reads.
/// </summary>
public sealed class DownloadConnectionGate(SemaphoreNntpGate global, Func<int> limit) : INntpGate
{
    private readonly DynamicSemaphore _share = new(limit);
    private long _acquisitions;

    public int InUse => _share.InUse;

    /// <summary>NNTP commands that went through the download share so far.</summary>
    public long Acquisitions => Interlocked.Read(ref _acquisitions);

    public int Limit => _share.Limit;

    public async ValueTask AcquireAsync(SemaphorePriority priority, CancellationToken cancellationToken)
    {
        await _share.WaitAsync(cancellationToken).ConfigureAwait(false);
        Interlocked.Increment(ref _acquisitions);
        try
        {
            await global.AcquireAsync(SemaphorePriority.Low, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            _share.Release();
            throw;
        }
    }

    public void Release()
    {
        global.Release();
        _share.Release();
    }
}

/// <summary>Shared provider client for device-download transfers: the download connection share, low priority in the global budget.</summary>
public sealed class DownloadNntpClient(MultiProviderNntpClient providers, DownloadConnectionGate gate)
    : GatedNntpClient(providers, gate, disposeInner: false, transferPriority: SemaphorePriority.Low, disposeGate: false)
{
    public DownloadConnectionGate Share => gate;
}
