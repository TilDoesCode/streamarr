using System.Diagnostics;
using System.Net.Sockets;
using Streamarr.Server.Config;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>One provider tried by a Usenet speed test: its place in the provider order and the outcome code.</summary>
public sealed record UsenetSpeedAttempt(int Index, string Role, string Name, string Code, string? Error);

/// <summary>A finished server ↔ Usenet speed test (shared by every caller until it goes stale).</summary>
public sealed record UsenetSpeedResult
{
    /// <summary><c>ok</c>, <c>failed</c> (every tried provider failed, see <see cref="Code"/>) or <c>busy</c> (no free connection; never stored).</summary>
    public required string Status { get; init; }

    /// <summary>Why it failed: the last attempt's code, <c>no_providers</c> or <c>no_free_connections</c>; null when ok.</summary>
    public string? Code { get; init; }

    public required DateTimeOffset MeasuredAt { get; init; }
    public double MegabitsPerSecond { get; init; }
    public long BytesDownloaded { get; init; }
    public int DurationMilliseconds { get; init; }
    public int FirstByteMilliseconds { get; init; }
    public int ConnectionsUsed { get; init; }
    public int ConnectionsMax { get; init; }

    /// <summary>Streams that were playing while the test ran (the result then shares the line with them).</summary>
    public int ActiveStreams { get; init; }

    /// <summary>The measured provider (or the last one tried when it failed).</summary>
    public UsenetSpeedAttempt? Provider { get; init; }

    public bool FallbackUsed { get; init; }
    public IReadOnlyList<UsenetSpeedAttempt> Attempts { get; init; } = [];

    /// <summary>Where the downloaded articles came from: <c>recent-stream</c>, <c>recent-nzb</c> or <c>newsgroup</c>; null when none was found.</summary>
    public string? ArticleSource { get; init; }
}

/// <summary>How a run request was answered.</summary>
public sealed record UsenetSpeedRun(UsenetSpeedResult? Result, bool Reused, bool Joined, TimeSpan? RetryAfter)
{
    public bool RateLimited => Result is null;
}

/// <summary>
/// Measures how fast the server downloads from Usenet: the primary provider (provider order), the next one when it fails
/// (connect, login, no test article, timeout). One test at a time server-wide (callers join it), the result is shared
/// for a while, starts are limited per caller, and the test only borrows connections the provider pool has free right now.
/// The admin's test of one stored provider (<see cref="TestProviderAsync"/>) uses the same path and never runs next to it.
/// </summary>
public sealed class UsenetSpeedTestService(
    MultiProviderNntpClient nntp,
    Func<int> activeStreams,
    TimeProvider time,
    ILogger<UsenetSpeedTestService> logger,
    IRecentArticleSource? recent = null)
{
    public static readonly TimeSpan ReuseOk = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan ReuseFailed = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan CallerWindow = TimeSpan.FromMinutes(10);
    public const int CallerStartsPerWindow = 3;

    /// <summary>Connections a test uses when nothing else runs on the provider.</summary>
    public const int IdleTestConnections = 8;

    /// <summary>Connections a test uses next to active streams; the rest stays theirs.</summary>
    public const int BusyTestConnections = 2;

    public const int MaxProviderAttempts = 3;
    private const int OverviewWindow = 500;

    /// <summary>Verified articles a test rotates through, so the provider's own cache of one article does not inflate the speed.</summary>
    private const int ArticlesPerTest = 6;
    private const int MaxStatChecks = 16;
    private const long MinimumCandidateBytes = 64 * 1024;
    private const long MaximumCandidateBytes = 63L * 1024 * 1024;
    private static readonly TimeSpan ArticleCacheTtl = TimeSpan.FromMinutes(30);

    public TimeSpan MeasureDuration { get; init; } = TimeSpan.FromSeconds(8);
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(6);
    public TimeSpan DrainTimeout { get; init; } = TimeSpan.FromSeconds(3);
    public long MaximumBytes { get; init; } = 256L * 1024 * 1024;
    public long ProviderTestMaximumBytes { get; init; } = 512L * 1024 * 1024;
    public IReadOnlyList<string> DiscoveryGroups { get; init; } = ["alt.binaries.test", "alt.binaries.misc", "alt.binaries.boneless"];

    private readonly object _gate = new();
    private readonly SemaphoreSlim _measureGate = new(1, 1);
    private readonly Dictionary<string, List<DateTimeOffset>> _starts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (SegmentId Id, DateTimeOffset At)> _articles = new(StringComparer.Ordinal);
    private Task<UsenetSpeedResult>? _running;
    private UsenetSpeedResult? _latest;

    /// <summary>The last stored result (ok or failed), however old.</summary>
    public UsenetSpeedResult? Latest
    {
        get
        {
            lock (_gate)
                return _latest;
        }
    }

    public bool Running
    {
        get
        {
            lock (_gate)
                return _running is { IsCompleted: false };
        }
    }

    /// <summary>When a stored result stops being handed out instead of a new test.</summary>
    public static DateTimeOffset FreshUntil(UsenetSpeedResult result)
        => result.MeasuredAt + (result.Status == "ok" ? ReuseOk : ReuseFailed);

    /// <summary>The server ↔ Usenet bandwidth for bitrate checks: the last successful result no older than <paramref name="maxAge"/>.</summary>
    public int? BandwidthKbps(TimeSpan maxAge)
    {
        var latest = Latest;
        return latest is { Status: "ok", MegabitsPerSecond: > 0 } && time.GetUtcNow() - latest.MeasuredAt <= maxAge
            ? (int)Math.Round(latest.MegabitsPerSecond * 1000)
            : null;
    }

    /// <summary>Joins the running test, hands out a fresh shared result, or starts a test (counted against <paramref name="callerKey"/> when <paramref name="limitCaller"/>).</summary>
    public async Task<UsenetSpeedRun> RunAsync(string callerKey, bool limitCaller, CancellationToken ct)
    {
        Task<UsenetSpeedResult> task;
        var joined = false;
        lock (_gate)
        {
            var now = time.GetUtcNow();
            if (_running is { IsCompleted: false } running)
            {
                task = running;
                joined = true;
            }
            else if (_latest is { } latest && now < FreshUntil(latest))
            {
                return new UsenetSpeedRun(latest, Reused: true, Joined: false, null);
            }
            else
            {
                if (limitCaller && !TryCountStart(callerKey, now, out var retryAfter))
                    return new UsenetSpeedRun(null, false, false, retryAfter);
                task = _running = Task.Run(() => MeasureAsync(callerKey, limitCaller));
            }
        }

        var result = await task.WaitAsync(ct).ConfigureAwait(false);
        return new UsenetSpeedRun(result, Reused: false, Joined: joined, null);
    }

    private bool TryCountStart(string callerKey, DateTimeOffset now, out TimeSpan retryAfter)
    {
        if (!_starts.TryGetValue(callerKey, out var starts))
            _starts[callerKey] = starts = [];
        starts.RemoveAll(at => now - at >= CallerWindow);
        if (starts.Count >= CallerStartsPerWindow)
        {
            retryAfter = starts.Min() + CallerWindow - now;
            return false;
        }
        starts.Add(now);
        retryAfter = TimeSpan.Zero;
        return true;
    }

    private void RefundStart(string callerKey)
    {
        if (_starts.TryGetValue(callerKey, out var starts) && starts.Count > 0)
            starts.RemoveAt(starts.Count - 1);
    }

    private async Task<UsenetSpeedResult> MeasureAsync(string callerKey, bool counted)
    {
        UsenetSpeedResult result;
        await _measureGate.WaitAsync().ConfigureAwait(false);
        try
        {
            result = await MeasureProvidersAsync().ConfigureAwait(false);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Usenet speed test failed unexpectedly");
            result = new UsenetSpeedResult { Status = "failed", Code = "error", MeasuredAt = time.GetUtcNow() };
        }
        finally
        {
            _measureGate.Release();
        }

        lock (_gate)
        {
            if (result.Status == "busy")
            {
                if (counted)
                    RefundStart(callerKey);
            }
            else
            {
                _latest = result;
            }
        }
        logger.LogInformation(
            "Usenet speed test: {Status} {Code} {Mbps} Mbit/s via provider {Index} ({Connections} connections, {Streams} active streams)",
            result.Status, result.Code, result.MegabitsPerSecond, result.Provider?.Index, result.ConnectionsUsed, result.ActiveStreams);
        return result;
    }

    /// <summary>Providers in the pool's order: priority, then pooled before backup-only.</summary>
    internal static IReadOnlyList<MultiConnectionNntpClient> Ordered(IEnumerable<MultiConnectionNntpClient> providers)
        => providers
            .Where(p => p.ProviderType != UsenetProviderType.Disabled)
            .OrderBy(p => p.Priority)
            .ThenBy(p => p.ProviderType)
            .ToList();

    /// <summary>
    /// Connections a test may borrow from a provider: never more than are free right now (at most <paramref name="idleLimit"/>);
    /// next to active streams at most <see cref="BusyTestConnections"/> and a quarter of the provider's maximum (at least one) stays free for them.
    /// </summary>
    internal static int ConnectionTarget(int max, int available, int activeStreams, int poolActive, int idleLimit = IdleTestConnections)
    {
        if (activeStreams > 0 || poolActive > 0)
            return Math.Max(0, Math.Min(Math.Min(BusyTestConnections, idleLimit), available - Math.Max(1, max / 4)));
        return Math.Max(0, Math.Min(idleLimit, available));
    }

    private async Task<UsenetSpeedResult> MeasureProvidersAsync()
    {
        var providers = Ordered(nntp.Providers);
        var streams = Math.Max(0, activeStreams());
        if (providers.Count == 0)
            return new UsenetSpeedResult { Status = "failed", Code = "no_providers", MeasuredAt = time.GetUtcNow(), ActiveStreams = streams };

        var attempts = new List<UsenetSpeedAttempt>();
        for (var i = 0; i < Math.Min(MaxProviderAttempts, providers.Count); i++)
        {
            var provider = providers[i];
            var role = i == 0 ? "primary" : "backup";
            var target = ConnectionTarget(provider.MaxConnections, provider.AvailableConnections, streams, provider.ActiveConnections);
            var outcome = target < 1
                ? new Outcome("no_free_connections")
                : await MeasureProviderAsync(provider, target, null, MeasureDuration, MaximumBytes).ConfigureAwait(false);
            var attempt = new UsenetSpeedAttempt(i + 1, role, provider.ProviderName, outcome.Code, outcome.Error);
            if (outcome.Code == "no_free_connections" && i == 0)
            {
                return new UsenetSpeedResult
                {
                    Status = "busy", Code = "no_free_connections", MeasuredAt = time.GetUtcNow(), ActiveStreams = streams,
                    Provider = attempt, Attempts = [attempt], ConnectionsMax = provider.MaxConnections,
                };
            }
            attempts.Add(attempt);
            if (outcome.Code == "ok")
            {
                return new UsenetSpeedResult
                {
                    Status = "ok",
                    MeasuredAt = time.GetUtcNow(),
                    MegabitsPerSecond = Math.Round(outcome.MegabitsPerSecond, 1),
                    BytesDownloaded = outcome.Bytes,
                    DurationMilliseconds = outcome.DurationMilliseconds,
                    FirstByteMilliseconds = outcome.FirstByteMilliseconds,
                    ConnectionsUsed = outcome.Connections,
                    ConnectionsMax = provider.MaxConnections,
                    ActiveStreams = streams,
                    Provider = attempt,
                    FallbackUsed = i > 0,
                    Attempts = attempts,
                    ArticleSource = outcome.ArticleSource,
                };
            }
        }

        return new UsenetSpeedResult
        {
            Status = "failed",
            Code = attempts[^1].Code,
            MeasuredAt = time.GetUtcNow(),
            ActiveStreams = streams,
            Provider = attempts[^1],
            FallbackUsed = attempts.Count > 1,
            Attempts = attempts,
        };
    }

    private sealed record Outcome(string Code, string? Error = null)
    {
        public double MegabitsPerSecond { get; init; }
        public long Bytes { get; init; }
        public int DurationMilliseconds { get; init; }
        public int FirstByteMilliseconds { get; init; }
        public int SetupMilliseconds { get; init; }
        public int Connections { get; init; }
        public string? ArticleSource { get; init; }
    }

    private sealed record ArticleSet(IReadOnlyList<SegmentId> Articles, string Source);

    private async Task<Outcome> MeasureProviderAsync(
        MultiConnectionNntpClient provider, int target, SegmentId? manualArticle, TimeSpan duration, long maxBytes)
    {
        var setup = Stopwatch.StartNew();
        var locks = new List<ConnectionLock<INntpClient>>();
        try
        {
            var articles = manualArticle is { } manual ? new ArticleSet([manual], "manual") : null;
            for (var tries = 0; tries < 3 && articles is null; tries++)
            {
                var (first, error) = await BorrowAsync(provider, 1).ConfigureAwait(false);
                if (first.Count == 0)
                    return error is null ? new Outcome("no_free_connections") : Failure(error);
                var connection = first[0];
                try
                {
                    articles = await ResolveArticlesAsync(provider.ProviderName, connection.Connection).ConfigureAwait(false);
                    locks.Add(connection);
                    if (articles is null)
                        return new Outcome("no_article");
                }
                catch (Exception e)
                {
                    connection.Replace();
                    connection.Dispose();
                    // a reused idle connection the provider silently dropped is replaced, not counted as a provider failure
                    if (!connection.WasReused || tries == 2)
                        return Failure(e);
                }
            }
            if (articles is null)
                return new Outcome("no_article");

            if (target > locks.Count)
            {
                var (more, error) = await BorrowAsync(provider, target - locks.Count).ConfigureAwait(false);
                locks.AddRange(more);
                if (locks.Count == 0)
                    return error is null ? new Outcome("no_free_connections") : Failure(error);
            }
            var setupMilliseconds = (int)setup.ElapsedMilliseconds;
            var transfer = await TransferAsync(locks, articles.Articles, duration, maxBytes).ConfigureAwait(false);
            return transfer with { SetupMilliseconds = setupMilliseconds, ArticleSource = articles.Source };
        }
        finally
        {
            foreach (var borrowed in locks)
                borrowed.Dispose();
        }
    }

    private async Task<(IReadOnlyList<ConnectionLock<INntpClient>> Locks, Exception? Error)> BorrowAsync(
        MultiConnectionNntpClient provider, int count)
    {
        using var timeout = new CancellationTokenSource(ConnectTimeout);
        try
        {
            return await provider.TryBorrowConnectionsAsync(count, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException e)
        {
            return ([], new TimeoutException("Connecting timed out.", e));
        }
    }

    /// <summary>Articles recently streamed through this provider first, then those of recently cached NZBs, then newsgroup discovery.</summary>
    private async Task<ArticleSet?> ResolveArticlesAsync(string providerName, INntpClient connection)
    {
        if (connection is not SingleConnectionNntpClient client)
            return null;

        using var timeout = new CancellationTokenSource(ConnectTimeout + ConnectTimeout);
        if (recent is not null)
        {
            var served = await VerifiedAsync(client, SafeRecent(() => recent.ServedBy(providerName)), timeout.Token).ConfigureAwait(false);
            if (served.Count > 0)
                return new ArticleSet(served, "recent-stream");

            IReadOnlyList<RecentArticle> cached = [];
            try
            {
                cached = await recent.FromRecentNzbsAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogDebug(e, "Recent NZBs unavailable as speed test source");
            }
            var fromNzbs = await VerifiedAsync(client, cached, timeout.Token).ConfigureAwait(false);
            if (fromNzbs.Count > 0)
                return new ArticleSet(fromNzbs, "recent-nzb");
        }

        return await DiscoverAsync(providerName, client, timeout.Token).ConfigureAwait(false) is { } found
            ? new ArticleSet([found], "newsgroup")
            : null;
    }

    private IReadOnlyList<RecentArticle> SafeRecent(Func<IReadOnlyList<RecentArticle>> read)
    {
        try
        {
            return read();
        }
        catch (Exception e)
        {
            logger.LogDebug(e, "Recently streamed articles unavailable as speed test source");
            return [];
        }
    }

    /// <summary>The first candidates this connection's provider still carries (STAT), at most <see cref="ArticlesPerTest"/>.</summary>
    private static async Task<IReadOnlyList<SegmentId>> VerifiedAsync(
        SingleConnectionNntpClient client, IReadOnlyList<RecentArticle> candidates, CancellationToken ct)
    {
        var verified = new List<SegmentId>();
        var checks = 0;
        foreach (var candidate in candidates)
        {
            if (verified.Count >= ArticlesPerTest || checks++ >= MaxStatChecks)
                break;
            SegmentId id;
            try
            {
                id = new SegmentId(candidate.MessageId);
            }
            catch (ArgumentException)
            {
                continue;
            }
            if ((await client.StatAsync(id, ct).ConfigureAwait(false)).ArticleExists)
                verified.Add(id);
        }
        return verified;
    }

    private async Task<SegmentId?> DiscoverAsync(string providerName, SingleConnectionNntpClient client, CancellationToken ct)
    {
        lock (_gate)
        {
            if (_articles.TryGetValue(providerName, out var cached) && time.GetUtcNow() - cached.At < ArticleCacheTtl)
                return cached.Id;
        }

        foreach (var groupName in DiscoveryGroups)
        {
            var group = await client.GroupAsync(groupName, ct).ConfigureAwait(false);
            if (group.ResponseType != NntpResponseType.GroupSelected || group.EstimatedArticleCount <= 0 ||
                group.HighArticleNumber < group.LowArticleNumber)
                continue;

            var first = Math.Max(group.LowArticleNumber, group.HighArticleNumber - OverviewWindow + 1);
            var overview = await client.OverviewAsync(first, group.HighArticleNumber, ct).ConfigureAwait(false);
            if (overview.ResponseType != NntpResponseType.OverviewInformationFollows)
                continue;

            var candidates = overview.Entries
                .Where(entry => entry.Bytes is >= MinimumCandidateBytes and <= MaximumCandidateBytes)
                .OrderByDescending(entry => entry.Bytes)
                .ThenByDescending(entry => entry.ArticleNumber)
                .Take(20);
            foreach (var candidate in candidates)
            {
                var stat = await client.StatAsync(candidate.SegmentId, ct).ConfigureAwait(false);
                if (!stat.ArticleExists)
                    continue;
                lock (_gate)
                    _articles[providerName] = (candidate.SegmentId, time.GetUtcNow());
                return candidate.SegmentId;
            }
        }
        return null;
    }

    private async Task<Outcome> TransferAsync(IReadOnlyList<ConnectionLock<INntpClient>> locks, IReadOnlyList<SegmentId> articles, TimeSpan duration, long maxBytes)
    {
        var next = -1;
        long total = 0;
        long firstByteTicks = 0;
        var withBytes = 0;
        Exception? firstError = null;
        using var measure = new CancellationTokenSource(duration);
        using var drain = new CancellationTokenSource(duration + DrainTimeout);
        var watch = Stopwatch.StartNew();
        long stoppedTicks = 0;

        var workers = locks.Select(connection => Task.Run(async () =>
        {
            var buffer = new byte[128 * 1024];
            var counted = false;
            try
            {
                while (!measure.IsCancellationRequested)
                {
                    var article = articles[(int)((uint)Interlocked.Increment(ref next) % (uint)articles.Count)];
                    var response = await connection.Connection.DecodedBodyAsync(article, drain.Token).ConfigureAwait(false);
                    await using var body = response.Stream;
                    int read;
                    // the current article is read to its end so the connection goes back to the pool clean
                    while ((read = await body.ReadAsync(buffer, drain.Token).ConfigureAwait(false)) > 0)
                    {
                        if (measure.IsCancellationRequested)
                            continue;
                        if (!counted)
                        {
                            counted = true;
                            Interlocked.Increment(ref withBytes);
                        }
                        Interlocked.CompareExchange(ref firstByteTicks, watch.ElapsedTicks, 0);
                        if (Interlocked.Add(ref total, read) >= maxBytes)
                        {
                            Interlocked.CompareExchange(ref stoppedTicks, watch.ElapsedTicks, 0);
                            await measure.CancelAsync().ConfigureAwait(false);
                        }
                    }
                }
            }
            catch (Exception e)
            {
                if (!measure.IsCancellationRequested || e is not OperationCanceledException)
                    Interlocked.CompareExchange(ref firstError, e, null);
                connection.Replace();
            }
        })).ToArray();

        await Task.WhenAll(workers).ConfigureAwait(false);
        var elapsedTicks = Interlocked.Read(ref stoppedTicks) is > 0 and var stopped
            ? stopped
            : Math.Min(watch.ElapsedTicks, (long)(duration.TotalSeconds * Stopwatch.Frequency));
        var seconds = Math.Max(elapsedTicks / (double)Stopwatch.Frequency, 0.001);
        var bytes = Interlocked.Read(ref total);
        if (bytes <= 0)
            return firstError is null ? new Outcome("no_data") : Failure(firstError);

        return new Outcome("ok")
        {
            MegabitsPerSecond = bytes * 8d / seconds / 1_000_000d,
            Bytes = bytes,
            DurationMilliseconds = (int)Math.Round(seconds * 1000),
            FirstByteMilliseconds = firstByteTicks == 0 ? 0 : (int)Math.Round(firstByteTicks * 1000d / Stopwatch.Frequency),
            Connections = withBytes,
        };
    }

    /// <summary>
    /// The admin's test of one stored provider: borrows only its live pool's free connections (<see cref="ConnectionTarget"/>,
    /// up to the configured maximum when idle). Without a pool entry (a disabled provider) it opens its own, capped at the maximum
    /// minus what other entries on the same account hold open. Never runs next to another speed test.
    /// </summary>
    public async Task<ProviderSpeedTestResult> TestProviderAsync(
        ProviderSpeedTarget target, string? messageId, int durationSeconds, CancellationToken ct)
    {
        var requested = Math.Clamp(target.Provider.MaxConnections, 1, 100);
        var articleSource = string.IsNullOrWhiteSpace(messageId) ? "automatic" : "manual";
        if (!await _measureGate.WaitAsync(0, ct).ConfigureAwait(false))
            return ProviderFailure(requested, articleSource, "A speed test is already running; try again in a few seconds.");

        MultiConnectionNntpClient? own = null;
        try
        {
            var live = target.Live;
            var streams = live is null ? 0 : Math.Max(0, activeStreams());
            var busy = (live?.ActiveConnections ?? 0) + target.BusyElsewhere;
            var free = Math.Clamp(Math.Min(live?.AvailableConnections ?? requested, requested - target.OpenElsewhere), 0, requested);
            var granted = ConnectionTarget(requested, free, streams, busy, idleLimit: requested);
            var notice = ProviderNotice(requested, granted, requested - free, streams, target.OpenElsewhere);
            ProviderSpeedTestResult Failed(string error, Outcome? outcome = null) => ProviderFailure(requested, articleSource, error, outcome) with
            {
                ConnectionsGranted = granted, ConnectionsInUse = requested - free, ActiveStreams = streams, Notice = notice,
            };
            if (granted < 1)
                return Failed(notice!);

            SegmentId? manual = null;
            if (articleSource == "manual")
            {
                try
                {
                    manual = new SegmentId(messageId!.Trim());
                }
                catch (ArgumentException)
                {
                    return Failed("The supplied NNTP message-id is invalid.");
                }
            }

            var client = live ?? (own = UsenetStreamingClient.CreateProviderClient(
                target.Provider with { MaxConnections = granted, Type = UsenetProviderType.Pooled }));
            var outcome = await MeasureProviderAsync(
                client, granted, manual, TimeSpan.FromSeconds(Math.Clamp(durationSeconds, 1, 15)), ProviderTestMaximumBytes).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
            logger.LogInformation(
                "Provider speed test {Provider}: {Code} {Mbps:F1} Mbit/s over {Used}/{Granted} of {Max} connections ({Streams} active streams, own pool {Own})",
                target.Provider.Name, outcome.Code, outcome.MegabitsPerSecond, outcome.Connections, granted, requested, streams, own is not null);
            if (outcome.Code != "ok")
            {
                return Failed(outcome.Code switch
                {
                    "no_article" when manual is null =>
                        "No usable article was found among recently streamed articles, recently cached NZBs or the provider's binary test groups. Stream something first, or supply a message-id from a recent NZB, and try again.",
                    "no_free_connections" => notice ?? "No connection of this provider was free; try again when playback has stopped.",
                    "no_data" => "The provider returned no article bytes.",
                    _ => outcome.Error ?? outcome.Code,
                }, outcome);
            }

            // keep 30% headroom for latency variation, retries and player bursts
            var recommended = outcome.MegabitsPerSecond * 0.70d;
            return new ProviderSpeedTestResult
            {
                Success = true,
                MegabitsPerSecond = Math.Round(outcome.MegabitsPerSecond, 2),
                MegabytesPerSecond = Math.Round(outcome.MegabitsPerSecond / 8d, 2),
                BytesDownloaded = outcome.Bytes,
                DurationMilliseconds = outcome.DurationMilliseconds,
                SetupMilliseconds = outcome.SetupMilliseconds,
                FirstByteMilliseconds = outcome.FirstByteMilliseconds,
                ConnectionsUsed = outcome.Connections,
                RequestedConnections = requested,
                ConnectionsGranted = granted,
                ConnectionsInUse = requested - free,
                ActiveStreams = streams,
                Notice = notice,
                RecommendedVideoBitrateMbps = Math.Round(recommended, 2),
                Estimated4KStreams = Math.Max(0, (int)Math.Floor(recommended / 50d)),
                Estimated1080pStreams = Math.Max(0, (int)Math.Floor(recommended / 15d)),
                StreamingTier = recommended switch { >= 50 => "4k", >= 15 => "1080p", >= 8 => "720p", >= 3 => "sd", _ => "insufficient" },
                ArticleSource = outcome.ArticleSource ?? articleSource,
            };
        }
        finally
        {
            own?.Dispose();
            _measureGate.Release();
        }
    }

    /// <summary>Why the admin test uses fewer connections than the provider's maximum; null when it gets all of them.</summary>
    internal static string? ProviderNotice(int requested, int granted, int inUse, int streams, int openElsewhere)
    {
        if (granted >= requested)
            return null;
        var why = streams > 0
            ? $"{(inUse > 0 ? $"{inUse} in use, " : "")}{streams} active stream{(streams == 1 ? "" : "s")}"
            : openElsewhere > 0
                ? $"{inUse} open through another provider entry on the same account"
                : $"{inUse} in use by playback or pre-downloads";
        return granted < 1
            ? $"No free connection of {requested} ({why}); the rest is kept for playback. Try again when playback has stopped."
            : $"Measured with {granted} of {requested} connections ({why}); the rest stays free for playback, so the result reads low.";
    }

    private static ProviderSpeedTestResult ProviderFailure(int requested, string articleSource, string error, Outcome? outcome = null) => new()
    {
        Success = false,
        MegabitsPerSecond = 0,
        MegabytesPerSecond = 0,
        BytesDownloaded = 0,
        DurationMilliseconds = outcome?.DurationMilliseconds ?? 0,
        SetupMilliseconds = outcome?.SetupMilliseconds ?? 0,
        FirstByteMilliseconds = 0,
        ConnectionsUsed = outcome?.Connections ?? 0,
        RequestedConnections = requested,
        ConnectionsGranted = 0,
        ConnectionsInUse = 0,
        ActiveStreams = 0,
        RecommendedVideoBitrateMbps = 0,
        Estimated4KStreams = 0,
        Estimated1080pStreams = 0,
        StreamingTier = "insufficient",
        ArticleSource = outcome?.ArticleSource ?? articleSource,
        Error = error,
    };

    private static Outcome Failure(Exception e) => new(Classify(e), e.Message);

    internal static string Classify(Exception e) => e switch
    {
        CouldNotLoginToUsenetException => "auth_failed",
        UsenetArticleNotFoundException => "no_article",
        TimeoutException or OperationCanceledException => "timeout",
        CouldNotConnectToUsenetException or SocketException or IOException or UsenetConnectionException => "connect_failed",
        _ => "error",
    };
}

/// <summary>Maps results onto the API shape; <c>redact</c> drops provider names and error texts.</summary>
public static class UsenetSpeedMapping
{
    public static Contracts.UsenetSpeedTestResponse Response(UsenetSpeedResult result, bool redact, bool reused = false, bool joined = false) => new()
    {
        Status = result.Status,
        Code = result.Code,
        MeasuredAt = result.MeasuredAt,
        MegabitsPerSecond = result.Status == "ok" ? result.MegabitsPerSecond : null,
        Provider = result.Provider is { } provider ? Provider(provider, redact) : null,
        FallbackUsed = result.FallbackUsed,
        Attempts = result.Attempts.Select(a => Provider(a, redact)).ToList(),
        ConnectionsUsed = result.ConnectionsUsed,
        ConnectionsMax = result.ConnectionsMax,
        ActiveStreams = result.ActiveStreams,
        BytesDownloaded = result.BytesDownloaded,
        DurationMs = result.DurationMilliseconds,
        FirstByteMs = result.FirstByteMilliseconds,
        ArticleSource = result.ArticleSource,
        Reused = reused,
        Joined = joined,
        FreshUntil = UsenetSpeedTestService.FreshUntil(result),
    };

    private static Contracts.UsenetSpeedProviderDto Provider(UsenetSpeedAttempt attempt, bool redact) => new()
    {
        Index = attempt.Index,
        Role = attempt.Role,
        Name = redact ? null : attempt.Name,
        Code = attempt.Code,
        Error = redact ? null : attempt.Error,
    };
}
