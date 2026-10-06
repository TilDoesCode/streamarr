using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Viewers.Auth;

/// <summary>One-minute windows for <c>POST /viewer/auth/refresh</c>: every refresh per token, only failed refreshes per client IP.</summary>
public sealed class ViewerRefreshLimiter(IOptions<StreamarrOptions> options, TimeProvider time, ILogger<ViewerRefreshLimiter> logger)
{
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
    internal const int MaxKeys = 20_000;
    private readonly ConcurrentDictionary<string, Counter> _counters = new(StringComparer.Ordinal);
    private readonly LogBudget _log = new(5, Window);

    /// <summary>Counts one refresh of the presented token and checks the address's failure budget; null when allowed.</summary>
    public RefreshLimit? Check(string? ipAddress, string? tokenHash)
    {
        var limits = options.Value;
        var now = time.GetUtcNow();
        var byToken = tokenHash is null ? null : Count("token:" + tokenHash, limits.ViewerRefreshPerTokenPerMinute, now);
        var byIp = Exhausted(IpKey(ipAddress), limits.ViewerRefreshPerIpPerMinute, now);
        return Max(byIp, byToken) is { } wait ? new RefreshLimit(wait, byToken is null) : null;
    }

    /// <summary>Counts one refused refresh against the client's address.</summary>
    public void NoteFailure(string? ipAddress) => Count(IpKey(ipAddress), options.Value.ViewerRefreshPerIpPerMinute, time.GetUtcNow());

    /// <summary>Logs a 429 within the log budget.</summary>
    public void NoteLimited(RefreshLimit limit, string? ipAddress)
    {
        if (!_log.TryTake(time.GetUtcNow(), out var suppressed))
            return;
        if (suppressed > 0)
            logger.LogInformation("Viewer refresh rate limit: {Suppressed} further refusals in the previous window were not logged", suppressed);
        logger.LogInformation("Viewer refresh rate limited ({Scope}) for {IpAddress}; at most {Lines} such lines per minute are logged",
            limit.ByAddress ? "per client" : "per token", ipAddress ?? "unknown", _log.Lines);
    }

    private static string IpKey(string? ipAddress) => "ip:" + (ipAddress ?? "unknown");

    private TimeSpan? Exhausted(string key, int limit, DateTimeOffset now)
    {
        if (!_counters.TryGetValue(key, out var counter))
            return null;
        lock (counter)
            return now < counter.WindowEnd && counter.Count >= Math.Max(1, limit) ? counter.WindowEnd - now : null;
    }

    private TimeSpan? Count(string key, int limit, DateTimeOffset now)
    {
        if (!_counters.ContainsKey(key) && _counters.Count >= MaxKeys)
        {
            Prune(now);
            if (_counters.Count >= MaxKeys && key.StartsWith("token:", StringComparison.Ordinal))
                return null;
        }
        var counter = _counters.GetOrAdd(key, _ => new Counter());
        lock (counter)
        {
            if (now >= counter.WindowEnd)
            {
                counter.WindowEnd = now + Window;
                counter.Count = 0;
            }
            counter.Count++;
            return counter.Count > Math.Max(1, limit) ? counter.WindowEnd - now : null;
        }
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var (key, counter) in _counters)
        {
            if (now >= counter.WindowEnd)
                _counters.TryRemove(key, out _);
        }
    }

    private static TimeSpan? Max(TimeSpan? a, TimeSpan? b) => a is null ? b : b is null ? a : a > b ? a : b;

    internal int TrackedKeys => _counters.Count;

    private sealed class Counter
    {
        public DateTimeOffset WindowEnd;
        public int Count;
    }
}

/// <summary>Why a refresh was limited: <paramref name="ByAddress"/> when only the address's failure budget is used up (a live token may still pass).</summary>
public readonly record struct RefreshLimit(TimeSpan Wait, bool ByAddress);

/// <summary>At most <see cref="Lines"/> log lines per window; the rest are counted and reported with the next line.</summary>
public sealed class LogBudget(int lines, TimeSpan window)
{
    private readonly object _lock = new();
    private DateTimeOffset _windowEnd = DateTimeOffset.MinValue;
    private int _used;
    private long _suppressed;

    public int Lines => lines;

    /// <summary>True when a line may be written; <paramref name="suppressedBefore"/> counts lines dropped since the last allowed one in an earlier window.</summary>
    public bool TryTake(DateTimeOffset now, out long suppressedBefore)
    {
        lock (_lock)
        {
            suppressedBefore = 0;
            if (now >= _windowEnd)
            {
                suppressedBefore = _suppressed;
                _suppressed = 0;
                _used = 0;
                _windowEnd = now + window;
            }
            if (_used < lines)
            {
                _used++;
                return true;
            }
            _suppressed++;
            return false;
        }
    }
}
