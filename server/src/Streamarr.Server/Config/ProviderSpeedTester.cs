using System.Collections.Concurrent;
using System.Diagnostics;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Server.Config;

/// <summary>Real NNTP payload-throughput result translated into video-streaming headroom.</summary>
public sealed record ProviderSpeedTestResult
{
    public required bool Success { get; init; }
    public required double MegabitsPerSecond { get; init; }
    public required double MegabytesPerSecond { get; init; }
    public required long BytesDownloaded { get; init; }
    public required int DurationMilliseconds { get; init; }
    public required int SetupMilliseconds { get; init; }
    public required int FirstByteMilliseconds { get; init; }
    public required int ConnectionsUsed { get; init; }
    public required int RequestedConnections { get; init; }
    public required double RecommendedVideoBitrateMbps { get; init; }
    public required int Estimated4KStreams { get; init; }
    public required int Estimated1080pStreams { get; init; }

    /// <summary>One of insufficient, sd, 720p, 1080p, or 4k.</summary>
    public required string StreamingTier { get; init; }

    /// <summary>Whether the article was found in a test group or supplied by the operator.</summary>
    public required string ArticleSource { get; init; }
    public string? Error { get; init; }
}

/// <summary>
/// Measures a stored provider with real BODY transfers over its configured connection count.
/// A recent binary article is discovered through GROUP/OVER, or callers can supply a known
/// message-id when a provider disables overview access. Tests are time- and byte-bounded.
/// </summary>
public sealed class ProviderSpeedTester(Func<NntpConnection>? connectionFactory = null) : IDisposable
{
    private const int OverviewWindow = 500;
    private const long MinimumCandidateBytes = 64 * 1024;
    private const long MaximumCandidateBytes = 63L * 1024 * 1024;
    private readonly Func<NntpConnection> _connectionFactory = connectionFactory ?? (() => new NntpConnection());
    private readonly SemaphoreSlim _runGate = new(1, 1);

    public TimeSpan PerConnectionTimeout { get; init; } = TimeSpan.FromSeconds(15);
    public long MaximumDownloadedBytes { get; init; } = 512L * 1024 * 1024;
    public IReadOnlyList<string> DiscoveryGroups { get; init; } =
        ["alt.binaries.test", "alt.binaries.misc", "alt.binaries.boneless"];

    public async Task<ProviderSpeedTestResult> TestAsync(
        UsenetProvider provider,
        string? messageId,
        int durationSeconds,
        CancellationToken ct)
    {
        var requestedConnections = Math.Clamp(provider.MaxConnections, 1, 100);
        if (!await _runGate.WaitAsync(0, ct).ConfigureAwait(false))
        {
            return Failure(requestedConnections, "A provider speed test is already running.");
        }

        var clients = new List<NntpConnection>(requestedConnections);
        try
        {
            var setupWatch = Stopwatch.StartNew();
            var firstConnection = await TryConnectAsync(provider, ct).ConfigureAwait(false);
            if (firstConnection.Client is null)
                return Failure(requestedConnections, firstConnection.Error ?? "Could not connect to the provider.");
            clients.Add(firstConnection.Client);

            SegmentId segmentId;
            var articleSource = "manual";
            if (string.IsNullOrWhiteSpace(messageId))
            {
                articleSource = "automatic";
                var discovered = await DiscoverArticleAsync(firstConnection.Client, ct).ConfigureAwait(false);
                if (discovered is null)
                {
                    return Failure(
                        requestedConnections,
                        "No suitable recent article was found in the provider's binary test groups. " +
                        "Supply a message-id from a recent NZB and try again.",
                        setupMilliseconds: ElapsedMilliseconds(setupWatch));
                }

                segmentId = discovered.Value;
            }
            else
            {
                try
                {
                    segmentId = new SegmentId(messageId.Trim());
                }
                catch (ArgumentException)
                {
                    return Failure(
                        requestedConnections,
                        "The supplied NNTP message-id is invalid.",
                        setupMilliseconds: ElapsedMilliseconds(setupWatch));
                }
            }

            if (requestedConnections > 1)
            {
                using var connectConcurrency = new SemaphoreSlim(10, 10);
                var connections = Enumerable.Range(1, requestedConnections - 1).Select(async _ =>
                {
                    await connectConcurrency.WaitAsync(ct).ConfigureAwait(false);
                    try
                    {
                        return await TryConnectAsync(provider, ct).ConfigureAwait(false);
                    }
                    finally
                    {
                        connectConcurrency.Release();
                    }
                });

                foreach (var outcome in await Task.WhenAll(connections).ConfigureAwait(false))
                {
                    if (outcome.Client is not null)
                        clients.Add(outcome.Client);
                }
            }

            setupWatch.Stop();
            return await MeasureAsync(
                clients,
                segmentId,
                articleSource,
                requestedConnections,
                Math.Clamp(durationSeconds, 1, 15),
                ElapsedMilliseconds(setupWatch),
                ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            return Failure(requestedConnections, e.Message);
        }
        finally
        {
            foreach (var client in clients)
                client.Dispose();
            _runGate.Release();
        }
    }

    private async Task<(NntpConnection? Client, string? Error)> TryConnectAsync(
        UsenetProvider provider,
        CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(PerConnectionTimeout);
        var client = _connectionFactory();
        try
        {
            await client.ConnectAsync(provider.Host, provider.Port, provider.UseSsl, timeoutCts.Token)
                .ConfigureAwait(false);
            if (!string.IsNullOrEmpty(provider.Username))
            {
                var auth = await client.AuthenticateAsync(provider.Username, provider.Password, timeoutCts.Token)
                    .ConfigureAwait(false);
                if (!auth.Success)
                {
                    client.Dispose();
                    return (null, $"Authentication failed (NNTP {auth.ResponseCode}).");
                }
            }

            return (client, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            client.Dispose();
            throw;
        }
        catch (Exception e)
        {
            client.Dispose();
            return (null, e.Message);
        }
    }

    private async Task<SegmentId?> DiscoverArticleAsync(NntpConnection client, CancellationToken ct)
    {
        foreach (var groupName in DiscoveryGroups)
        {
            var group = await client.GroupAsync(groupName, ct).ConfigureAwait(false);
            if (group.ResponseType != NntpResponseType.GroupSelected ||
                group.EstimatedArticleCount <= 0 ||
                group.HighArticleNumber < group.LowArticleNumber)
            {
                continue;
            }

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
                if (stat.ArticleExists)
                    return candidate.SegmentId;
            }
        }

        return null;
    }

    private async Task<ProviderSpeedTestResult> MeasureAsync(
        IReadOnlyList<NntpConnection> clients,
        SegmentId segmentId,
        string articleSource,
        int requestedConnections,
        int durationSeconds,
        int setupMilliseconds,
        CancellationToken ct)
    {
        long totalBytes = 0;
        long firstByteTicks = 0;
        var connectionsWithBytes = 0;
        var errors = new ConcurrentQueue<string>();
        using var testCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        testCts.CancelAfter(TimeSpan.FromSeconds(durationSeconds));
        var watch = Stopwatch.StartNew();

        var workers = clients.Select(client => Task.Run(async () =>
        {
            var buffer = new byte[128 * 1024];
            var countedConnection = false;
            try
            {
                while (!testCts.IsCancellationRequested)
                {
                    var response = await client.BodyAsync(segmentId, testCts.Token).ConfigureAwait(false);
                    if (response.ResponseType != NntpResponseType.ArticleRetrievedBodyFollows || response.Stream is null)
                    {
                        errors.Enqueue($"Article unavailable (NNTP {response.ResponseCode}).");
                        return;
                    }

                    await using var body = response.Stream;
                    while (!testCts.IsCancellationRequested)
                    {
                        var read = await body.ReadAsync(buffer, testCts.Token).ConfigureAwait(false);
                        if (read == 0)
                            break;
                        if (!countedConnection)
                        {
                            countedConnection = true;
                            Interlocked.Increment(ref connectionsWithBytes);
                        }
                        Interlocked.CompareExchange(ref firstByteTicks, watch.ElapsedTicks, 0);
                        var bytes = Interlocked.Add(ref totalBytes, read);
                        if (bytes >= MaximumDownloadedBytes)
                        {
                            await testCts.CancelAsync().ConfigureAwait(false);
                            break;
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (testCts.IsCancellationRequested)
            {
                // Expected when the time/byte bound ends the sample.
            }
            catch (Exception e)
            {
                errors.Enqueue(e.Message);
            }
        }, CancellationToken.None)).ToArray();

        await Task.WhenAll(workers).ConfigureAwait(false);
        watch.Stop();
        ct.ThrowIfCancellationRequested();

        var elapsedSeconds = Math.Max(watch.Elapsed.TotalSeconds, 0.001);
        var durationMilliseconds = ElapsedMilliseconds(watch);
        if (totalBytes <= 0)
        {
            errors.TryPeek(out var error);
            return Failure(
                requestedConnections,
                error ?? "The provider returned no article bytes.",
                clients.Count,
                setupMilliseconds,
                durationMilliseconds,
                articleSource);
        }

        var megabitsPerSecond = totalBytes * 8d / elapsedSeconds / 1_000_000d;
        var megabytesPerSecond = totalBytes / elapsedSeconds / 1_000_000d;
        // Keep 30% headroom for yEnc overhead, latency variation, retries, and player bursts.
        var recommendedBitrate = megabitsPerSecond * 0.70d;

        return new ProviderSpeedTestResult
        {
            Success = true,
            MegabitsPerSecond = Math.Round(megabitsPerSecond, 2),
            MegabytesPerSecond = Math.Round(megabytesPerSecond, 2),
            BytesDownloaded = totalBytes,
            DurationMilliseconds = durationMilliseconds,
            SetupMilliseconds = setupMilliseconds,
            FirstByteMilliseconds = firstByteTicks == 0
                ? 0
                : (int)Math.Clamp(firstByteTicks * 1000d / Stopwatch.Frequency, 0, int.MaxValue),
            ConnectionsUsed = connectionsWithBytes,
            RequestedConnections = requestedConnections,
            RecommendedVideoBitrateMbps = Math.Round(recommendedBitrate, 2),
            Estimated4KStreams = Math.Max(0, (int)Math.Floor(recommendedBitrate / 50d)),
            Estimated1080pStreams = Math.Max(0, (int)Math.Floor(recommendedBitrate / 15d)),
            StreamingTier = TierFor(recommendedBitrate),
            ArticleSource = articleSource,
        };
    }

    private static string TierFor(double recommendedBitrate) => recommendedBitrate switch
    {
        >= 50 => "4k",
        >= 15 => "1080p",
        >= 8 => "720p",
        >= 3 => "sd",
        _ => "insufficient",
    };

    private static ProviderSpeedTestResult Failure(
        int requestedConnections,
        string error,
        int connectionsUsed = 0,
        int setupMilliseconds = 0,
        int durationMilliseconds = 0,
        string articleSource = "automatic") => new()
    {
        Success = false,
        MegabitsPerSecond = 0,
        MegabytesPerSecond = 0,
        BytesDownloaded = 0,
        DurationMilliseconds = durationMilliseconds,
        SetupMilliseconds = setupMilliseconds,
        FirstByteMilliseconds = 0,
        ConnectionsUsed = connectionsUsed,
        RequestedConnections = requestedConnections,
        RecommendedVideoBitrateMbps = 0,
        Estimated4KStreams = 0,
        Estimated1080pStreams = 0,
        StreamingTier = "insufficient",
        ArticleSource = articleSource,
        Error = error,
    };

    private static int ElapsedMilliseconds(Stopwatch watch)
        => (int)Math.Clamp(watch.ElapsedMilliseconds, 0, int.MaxValue);

    public void Dispose()
    {
        _runGate.Dispose();
    }
}
