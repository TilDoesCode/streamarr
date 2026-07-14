using System.Security.Cryptography;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// Short-lived, one-use capabilities for Jellyfin's OpenToken surface. A caller can only ask Core
/// to resolve a release that the plugin previously offered for that exact authenticated user and
/// item; arbitrary caller-controlled release ids never reach the machine-authenticated Core API.
/// </summary>
public sealed class MediaSourceOfferStore
{
    internal const int MaxOffers = 2048;
    private static readonly TimeSpan OfferTtl = TimeSpan.FromMinutes(10);
    private readonly Dictionary<string, Offer> _byToken = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public sealed record Offer(
        Guid ItemId,
        Guid UserId,
        string WorkId,
        string ReleaseId,
        IReadOnlySet<string> AllowedReleaseIds,
        DateTime ExpiresUtc);

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
            RemoveExpired(DateTime.UtcNow);
            // Do not invalidate another device's still-pending playback request for the same
            // Jellyfin user/item. Capacity is hard-bounded and expiry reclaims abandoned offers.
            if (_byToken.Count + releases.Length > MaxOffers)
                return new Dictionary<string, string>();

            var expires = DateTime.UtcNow + OfferTtl;
            var allowed = releases.ToHashSet(StringComparer.Ordinal);
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var releaseId in releases)
            {
                var token = CreateToken();
                _byToken[token] = new Offer(itemId, userId, workId, releaseId, allowed, expires);
                result[releaseId] = token;
            }

            return result;
        }
    }

    public bool TryTake(string? token, Guid userId, out Offer? offer)
    {
        offer = null;
        if (token is null
            || token.Length != 43
            || token.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_')
            || userId == Guid.Empty)
            return false;

        lock (_gate)
        {
            RemoveExpired(DateTime.UtcNow);
            if (!_byToken.TryGetValue(token, out var candidate)
                || candidate.UserId != userId)
            {
                return false;
            }

            _byToken.Remove(token);
            offer = candidate;
            return true;
        }
    }

    private void RemoveExpired(DateTime nowUtc)
    {
        foreach (var expired in _byToken.Where(pair => pair.Value.ExpiresUtc <= nowUtc).ToArray())
            _byToken.Remove(expired.Key);
    }

    private static string CreateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
}
