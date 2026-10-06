using System.Collections.Concurrent;
using Streamarr.Core.Media;

namespace Streamarr.DevWorld.Faults;

/// <summary>The product's health cache plus a reset: a cleared usenet_hole makes its releases healthy again instead of dead for the cache TTL.</summary>
public sealed class ResettableHealthCache(IReleaseHealthCache inner) : IReleaseHealthCache
{
    private readonly ConcurrentDictionary<string, ReleaseHealth?> _reset = new(StringComparer.Ordinal);

    /// <summary>Forgets what the product learned about the release; the next resolve classifies it again.</summary>
    public void Reset(string releaseId) => _reset[releaseId] = null;

    public void Record(string releaseId, ReleaseHealth health)
    {
        if (_reset.ContainsKey(releaseId))
        {
            if (health != ReleaseHealth.Dead)
            {
                _reset[releaseId] = health;
                return;
            }
            _reset.TryRemove(releaseId, out _);
        }
        inner.Record(releaseId, health);
    }

    public ReleaseHealth? Get(string releaseId) => _reset.TryGetValue(releaseId, out var health) ? health : inner.Get(releaseId);

    public bool IsDead(string releaseId) => Get(releaseId) == ReleaseHealth.Dead;
}
