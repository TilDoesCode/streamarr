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

    public int InUse => _share.InUse;

    public int Limit => _share.Limit;

    public async ValueTask AcquireAsync(SemaphorePriority priority, CancellationToken cancellationToken)
    {
        await _share.WaitAsync(cancellationToken).ConfigureAwait(false);
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
