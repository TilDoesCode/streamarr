namespace Streamarr.Server.Services;

/// <summary>
/// The concurrent resolve slots (<c>MaxConcurrentResolves</c>), non-blocking. Device-download preparations hold at most all but one,
/// so a playback start always finds a slot (with a single slot nothing can be kept back).
/// </summary>
public sealed class ResolveAdmission(int slots)
{
    private readonly object _lock = new();
    private readonly int _slots = Math.Max(1, slots);
    private int _inUse;
    private int _downloads;

    public int DownloadSlots => Math.Max(1, _slots - 1);

    public bool TryEnter(bool download)
    {
        lock (_lock)
        {
            if (_inUse >= _slots || (download && _downloads >= DownloadSlots))
                return false;
            _inUse++;
            if (download)
                _downloads++;
            return true;
        }
    }

    public void Exit(bool download)
    {
        lock (_lock)
        {
            _inUse--;
            if (download)
                _downloads--;
        }
    }
}
