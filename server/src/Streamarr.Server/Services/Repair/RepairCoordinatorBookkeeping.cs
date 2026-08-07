namespace Streamarr.Server.Services.Repair;

/// <summary>
/// Bounded coordinator metadata. Inactive release mappings use LRU eviction while active
/// mappings are retained; expired failure backoffs are swept on access and the remaining
/// entries are capped by earliest expiry.
/// </summary>
internal sealed class RepairCoordinatorBookkeeping(int maxEntries, TimeProvider time)
{
    private readonly Dictionary<string, ReleaseEntry> _releaseFingerprints = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> _failureBackoffs = new(StringComparer.Ordinal);
    private readonly object _sync = new();
    private readonly int _maxEntries = Math.Max(1, maxEntries);

    public void RegisterRelease(
        string releaseId,
        string fingerprint,
        Func<string, bool>? isFingerprintActive = null)
    {
        lock (_sync)
        {
            _releaseFingerprints[releaseId] = new ReleaseEntry(fingerprint, time.GetUtcNow().UtcTicks);
            TrimReleaseMappingsLocked(isFingerprintActive);
        }
    }

    /// <summary>
    /// Re-applies the inactive metadata cap after active-job ownership changes. Active
    /// mappings are never eviction candidates, even when they temporarily exceed the cap.
    /// </summary>
    public void TrimReleaseMappings(Func<string, bool>? isFingerprintActive = null)
    {
        lock (_sync)
            TrimReleaseMappingsLocked(isFingerprintActive);
    }

    public bool TryGetFingerprint(string releaseId, out string fingerprint)
    {
        lock (_sync)
        {
            if (!_releaseFingerprints.TryGetValue(releaseId, out var entry))
            {
                fingerprint = string.Empty;
                return false;
            }
            entry.LastAccessTimestamp = time.GetUtcNow().UtcTicks;
            fingerprint = entry.Fingerprint;
            return true;
        }
    }

    public bool IsFailureBlocked(string fingerprint)
    {
        lock (_sync)
        {
            SweepExpiredFailuresLocked();
            return _failureBackoffs.TryGetValue(fingerprint, out var blockedUntil)
                   && blockedUntil > time.GetUtcNow();
        }
    }

    public void ClearFailure(string fingerprint)
    {
        lock (_sync)
            _failureBackoffs.Remove(fingerprint);
    }

    public void RecordFailure(string fingerprint, TimeSpan duration)
    {
        lock (_sync)
        {
            SweepExpiredFailuresLocked();
            if (duration <= TimeSpan.Zero)
            {
                _failureBackoffs.Remove(fingerprint);
                return;
            }
            _failureBackoffs[fingerprint] = time.GetUtcNow() + duration;
            while (_failureBackoffs.Count > _maxEntries)
            {
                var victim = _failureBackoffs.MinBy(item => item.Value);
                _failureBackoffs.Remove(victim.Key);
            }
        }
    }

    internal int ReleaseCount
    {
        get
        {
            lock (_sync)
                return _releaseFingerprints.Count;
        }
    }

    internal int FailureCount
    {
        get
        {
            lock (_sync)
            {
                SweepExpiredFailuresLocked();
                return _failureBackoffs.Count;
            }
        }
    }

    private void SweepExpiredFailuresLocked()
    {
        var now = time.GetUtcNow();
        foreach (var fingerprint in _failureBackoffs
                     .Where(item => item.Value <= now)
                     .Select(item => item.Key)
                     .ToList())
        {
            _failureBackoffs.Remove(fingerprint);
        }
    }

    private void TrimReleaseMappingsLocked(Func<string, bool>? isFingerprintActive)
    {
        while (_releaseFingerprints.Count > _maxEntries)
        {
            var candidates = _releaseFingerprints
                .Where(item => isFingerprintActive?.Invoke(item.Value.Fingerprint) != true)
                .ToList();
            if (candidates.Count == 0)
                return;
            var victim = candidates.MinBy(item => item.Value.LastAccessTimestamp);
            _releaseFingerprints.Remove(victim.Key);
        }
    }

    private sealed class ReleaseEntry(string fingerprint, long lastAccessTimestamp)
    {
        public string Fingerprint { get; } = fingerprint;
        public long LastAccessTimestamp { get; set; } = lastAccessTimestamp;
    }
}
