using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Services;

/// <summary>Shared provider client whose body transfers always enter the global budget at low priority.</summary>
public sealed class PreDownloadNntpClient(
    MultiProviderNntpClient providers,
    SemaphoreNntpGate gate)
    : GatedNntpClient(
        providers,
        gate,
        disposeInner: false,
        transferPriority: SemaphorePriority.Low,
        disposeGate: false);
