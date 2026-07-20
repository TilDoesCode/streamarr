using System.Security.Cryptography;
using System.Text;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// Short-lived, replayable capabilities for Jellyfin's OpenToken surface. Jellyfin clients cache
/// media-source metadata and can reuse an OpenToken after stop/replay, so redemption cannot consume
/// the token. A caller can still only ask Core to resolve a release that the plugin previously
/// offered for that exact authenticated user and item; arbitrary caller-controlled release ids
/// never reach the machine-authenticated Core API.
/// </summary>
public sealed class MediaSourceOfferStore
{
    internal const int MaxOffers = 2048;
    private static readonly TimeSpan OfferTtl = TimeSpan.FromMinutes(10);
    private readonly Dictionary<string, Offer> _byToken = new(StringComparer.Ordinal);
    private readonly Dictionary<OfferIndexKey, string> _byIndex = new();
    private readonly Dictionary<string, OfferIndexKey> _indexByToken = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _activeUses = new(StringComparer.Ordinal);
    private readonly SortedSet<ExpiryIndex> _expiryIndex = new(ExpiryIndexComparer.Instance);
    private readonly object _gate = new();
    private readonly TimeProvider _time;

    public MediaSourceOfferStore() : this(TimeProvider.System)
    {
    }

    internal MediaSourceOfferStore(TimeProvider time)
    {
        _time = time;
    }

    public sealed record Offer(
        Guid ItemId,
        Guid UserId,
        string WorkId,
        string ReleaseId,
        IReadOnlySet<string> AllowedReleaseIds,
        DateTime ExpiresUtc);

    public sealed class Lease : IDisposable
    {
        private readonly MediaSourceOfferStore _owner;
        private readonly string _token;
        private int _disposed;

        internal Lease(MediaSourceOfferStore owner, string token, Offer offer)
        {
            _owner = owner;
            _token = token;
            Offer = offer;
        }

        public Offer Offer { get; }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                _owner.Release(_token);
        }
    }

    public IReadOnlyDictionary<string, string> CreateOffers(
        Guid itemId,
        Guid userId,
        string workId,
        IReadOnlyList<string> releaseIds)
    {
        if (itemId == Guid.Empty || userId == Guid.Empty)
            return new Dictionary<string, string>();
        ArgumentException.ThrowIfNullOrWhiteSpace(workId);

        var releases = releaseIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .Take(StreamarrPayloadBounds.MaxReleasesPerWork)
            .ToArray();
        if (releases.Length == 0)
            return new Dictionary<string, string>();

        lock (_gate)
        {
            var now = _time.GetUtcNow().UtcDateTime;
            RemoveExpired(now);
            // Do not invalidate another device's still-pending playback request for the same
            // Jellyfin user/item. Capacity is hard-bounded and expiry reclaims abandoned offers.
            var allowed = releases.ToHashSet(StringComparer.Ordinal);
            var releaseSetKey = BuildReleaseSetKey(releases);
            var indexKeys = new OfferIndexKey[releases.Length];
            var newOfferCount = 0;
            for (var index = 0; index < releases.Length; index++)
            {
                var indexKey = new OfferIndexKey(itemId, userId, workId, releases[index], releaseSetKey);
                indexKeys[index] = indexKey;
                if (!_byIndex.ContainsKey(indexKey))
                    newOfferCount++;
            }
            if (_byToken.Count + newOfferCount > MaxOffers)
                return new Dictionary<string, string>();

            var expires = now + OfferTtl;
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var index = 0; index < releases.Length; index++)
            {
                var releaseId = releases[index];
                var indexKey = indexKeys[index];
                if (_byIndex.TryGetValue(indexKey, out var existingToken)
                    && _byToken.TryGetValue(existingToken, out var existingOffer))
                {
                    // Refresh the lease when Jellyfin asks for the same projection again. Keeping
                    // the token stable also makes already-cached client metadata safe to replay.
                    StoreOffer(existingToken, existingOffer with { ExpiresUtc = expires });
                    result[releaseId] = existingToken;
                    continue;
                }

                var token = CreateToken();
                StoreOffer(token, new Offer(itemId, userId, workId, releaseId, allowed, expires));
                _byIndex[indexKey] = token;
                _indexByToken[token] = indexKey;
                result[releaseId] = token;
            }

            return result;
        }
    }

    public bool TryAcquire(string? token, Guid userId, out Lease? lease)
    {
        lease = null;
        if (token is null
            || token.Length != 43
            || token.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_')
            || userId == Guid.Empty)
            return false;

        lock (_gate)
        {
            RemoveExpired(_time.GetUtcNow().UtcDateTime);
            if (!_byToken.TryGetValue(token, out var candidate)
                || candidate.UserId != userId)
            {
                return false;
            }

            _activeUses[token] = _activeUses.GetValueOrDefault(token) + 1;
            lease = new Lease(this, token, candidate);
            return true;
        }
    }

    private void Release(string token)
    {
        lock (_gate)
        {
            if (!_activeUses.TryGetValue(token, out var uses))
                return;
            if (uses > 1)
            {
                _activeUses[token] = uses - 1;
                return;
            }

            _activeUses.Remove(token);
            if (_byToken.TryGetValue(token, out var offer))
            {
                // Start the replay grace period when playback actually ends. A movie or long
                // episode must not age its cached OpenToken while it is still being watched.
                StoreOffer(token, offer with
                {
                    ExpiresUtc = _time.GetUtcNow().UtcDateTime + OfferTtl,
                });
            }
        }
    }

    private void RemoveExpired(DateTime nowUtc)
    {
        while (_expiryIndex.Count > 0)
        {
            var expired = _expiryIndex.Min;
            if (expired.ExpiresUtc > nowUtc)
                break;

            _expiryIndex.Remove(expired);
            if (_activeUses.ContainsKey(expired.Token))
                continue;
            if (!_byToken.Remove(expired.Token, out var offer)
                || offer.ExpiresUtc != expired.ExpiresUtc)
            {
                continue;
            }

            if (_indexByToken.Remove(expired.Token, out var indexKey)
                && _byIndex.TryGetValue(indexKey, out var indexedToken)
                && string.Equals(indexedToken, expired.Token, StringComparison.Ordinal))
            {
                _byIndex.Remove(indexKey);
            }
        }
    }

    private void StoreOffer(string token, Offer offer)
    {
        if (_byToken.TryGetValue(token, out var previous))
            _expiryIndex.Remove(new ExpiryIndex(previous.ExpiresUtc, token));
        _byToken[token] = offer;
        _expiryIndex.Add(new ExpiryIndex(offer.ExpiresUtc, token));
    }

    /// <summary>
    /// Length framing makes the canonical set key unambiguous even when release ids contain the
    /// separator. It is computed once per projection; indexed lookup then stays O(1) per release
    /// regardless of how many other users/items have pending offers.
    /// </summary>
    private static string BuildReleaseSetKey(IEnumerable<string> releaseIds)
    {
        var canonical = releaseIds.ToArray();
        Array.Sort(canonical, StringComparer.Ordinal);
        var builder = new StringBuilder();
        foreach (var releaseId in canonical)
            builder.Append(releaseId.Length).Append(':').Append(releaseId);
        return builder.ToString();
    }

    private static string CreateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private readonly record struct OfferIndexKey(
        Guid ItemId,
        Guid UserId,
        string WorkId,
        string ReleaseId,
        string ReleaseSetKey);

    private readonly record struct ExpiryIndex(DateTime ExpiresUtc, string Token);

    private sealed class ExpiryIndexComparer : IComparer<ExpiryIndex>
    {
        public static readonly ExpiryIndexComparer Instance = new();

        public int Compare(ExpiryIndex left, ExpiryIndex right)
        {
            var expiryComparison = left.ExpiresUtc.CompareTo(right.ExpiresUtc);
            return expiryComparison != 0
                ? expiryComparison
                : StringComparer.Ordinal.Compare(left.Token, right.Token);
        }
    }
}
