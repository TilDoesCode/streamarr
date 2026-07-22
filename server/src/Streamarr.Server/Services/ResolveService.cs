using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

/// <summary>
/// The /resolve pipeline (BRIEF §6.2): look up the release, fetch + parse its NZB,
/// identify the primary media file (unwrapping RAR), STAT-sample its segments,
/// open a session, and ffprobe the stream URL so front-ends get pre-probed media
/// info. A release that resolves dead is recorded in the health cache (feeding
/// deadness back into ranking + fallback) and, unless the caller opted out,
/// transparently retries the next-best release of the same work — bounded — so a
/// dead upload falls back automatically (BRIEF §10-M7).
/// </summary>
public sealed class ResolveService(
    IReleaseStore releaseStore,
    IReleaseHealthCache healthCache,
    NzbFetcher nzbFetcher,
    HealthChecker healthChecker,
    MediaFileMaterializer materializer,
    MediaMaterializationCache materializationCache,
    SessionManager sessionManager,
    FfprobeClient ffprobe,
    MediaProbeCache mediaProbeCache,
    IOptions<StreamarrOptions> options,
    ILogger<ResolveService> logger)
{
    private readonly SemaphoreSlim _resolveGate = new(Math.Max(1, options.Value.MaxConcurrentResolves));

    /// <param name="streamUrlForToken">Builds the public stream URL returned to the client.</param>
    /// <param name="localStreamUrlForToken">
    /// Builds a loopback stream URL for the in-process ffprobe run (the public
    /// host may not be reachable from the server itself, e.g. behind a proxy).
    /// </param>
    public Task<ResolveResponse> ResolveAsync(
        string releaseId,
        string? client,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
        => ResolveAsync(releaseId, client, null, null, streamUrlForToken, localStreamUrlForToken, ct);

    public async Task<ResolveResponse> ResolveAsync(
        string releaseId,
        string? client,
        string? requestedById,
        string? requestedByName,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
        => await ResolveAsync(releaseId, workId: null, client, requestedById, requestedByName, autoFallback: true, streamUrlForToken, localStreamUrlForToken, ct);

    public Task<ResolveResponse> ResolveAsync(
        string releaseId,
        string? client,
        bool autoFallback,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
        => ResolveAsync(releaseId, client, null, null, autoFallback, streamUrlForToken, localStreamUrlForToken, ct);

    public async Task<ResolveResponse> ResolveAsync(
        string releaseId,
        string? client,
        string? requestedById,
        string? requestedByName,
        bool autoFallback,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
        => await ResolveAsync(releaseId, workId: null, client, requestedById, requestedByName, autoFallback, streamUrlForToken, localStreamUrlForToken, ct);

    public Task<ResolveResponse> ResolveAsync(
        string releaseId,
        string? workId,
        string? client,
        bool autoFallback,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
        => ResolveAsync(releaseId, workId, client, null, null, autoFallback, streamUrlForToken, localStreamUrlForToken, ct);

    public async Task<ResolveResponse> ResolveAsync(
        string releaseId,
        string? workId,
        string? client,
        string? requestedById,
        string? requestedByName,
        bool autoFallback,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
    {
        if (!await _resolveGate.WaitAsync(0, ct))
            throw new ResourceCapacityException("The concurrent resolve limit has been reached.");

        try
        {
            return await ResolveCoreAsync(
                releaseId,
                workId,
                client,
                requestedById,
                requestedByName,
                autoFallback,
                streamUrlForToken,
                localStreamUrlForToken,
                ct);
        }
        finally
        {
            _resolveGate.Release();
        }
    }

    private async Task<ResolveResponse> ResolveCoreAsync(
        string releaseId,
        string? requestedWorkId,
        string? client,
        string? requestedById,
        string? requestedByName,
        bool autoFallback,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
    {
        var maxHops = Math.Max(0, options.Value.MaxFallbackHops);
        var attempts = new List<ResolveAttempt>();
        var visited = new HashSet<string>(StringComparer.Ordinal);

        var currentId = releaseId;
        var workId = requestedWorkId;

        for (var hop = 0; ; hop++)
        {
            // guard against a cycle in fallback selection
            if (!visited.Add(currentId))
                break;

            var single = await ResolveSingleAsync(
                currentId,
                workId,
                client,
                requestedById,
                requestedByName,
                streamUrlForToken,
                localStreamUrlForToken,
                ct);
            workId = single.WorkId;
            attempts.Add(new ResolveAttempt { ReleaseId = currentId, Status = single.Response.Status });

            if (single.Response.Status != "dead")
            {
                // ready or degraded — return the healthy release, noting the fallback chain.
                return single.Response with
                {
                    Attempts = attempts,
                    FallbackFromReleaseId = currentId == releaseId ? null : releaseId,
                };
            }

            // Dead: remember it (demotes it in ranking + skips it as a future fallback).
            healthCache.Record(currentId, ReleaseHealth.Dead);

            var next = autoFallback && hop < maxHops
                ? releaseStore.FindFallback(workId, currentId)
                : null;

            if (next is null)
            {
                // Auto-fallback disabled/exhausted: surface a manual suggestion (only when
                // we haven't already tried it in this chain) and the full attempt trail.
                var suggestion = releaseStore.FindFallback(workId, currentId);
                logger.LogInformation(
                    "Resolve of {ReleaseId} dead after {Attempts} attempt(s); fallback {Fallback}",
                    releaseId, attempts.Count, suggestion?.Release.ReleaseId ?? "none");

                return single.Response with
                {
                    ReleaseId = releaseId,
                    SuggestedFallbackReleaseId =
                        suggestion is not null && !visited.Contains(suggestion.Release.ReleaseId)
                            ? suggestion.Release.ReleaseId
                            : null,
                    FallbackFromReleaseId = currentId == releaseId ? null : releaseId,
                    Attempts = attempts,
                };
            }

            logger.LogInformation(
                "Release {ReleaseId} is dead; auto-falling back to {Fallback} (hop {Hop})",
                currentId, next.Release.ReleaseId, hop + 1);
            currentId = next.Release.ReleaseId;
        }

        // Reached only if the fallback chain looped; report the last dead classification.
        return new ResolveResponse
        {
            ReleaseId = releaseId,
            Status = "dead",
            SessionTtlSeconds = options.Value.SessionTtlSeconds,
            Attempts = attempts,
        };
    }

    /// <summary>Resolve exactly one release (no fallback). Dead releases return no session.</summary>
    private async Task<SingleResolve> ResolveSingleAsync(
        string releaseId,
        string? workId,
        string? client,
        string? requestedById,
        string? requestedByName,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
    {
        var registered = releaseStore.Get(releaseId, workId)
            ?? throw new ReleaseNotFoundException(releaseId);
        var nzbUrl = registered.Release.NzbUrl
            ?? throw new NoPlayableFileException("The release has no NZB location on record.");

        // Pause/resume and Jellyfin source reopens resolve the same release again. A retained
        // capability already owns the immutable materialized file and can open a fresh ranged
        // stream, so reuse it before repeating NZB, health, materialization, or ffprobe work.
        if (sessionManager.FindReusableSession(
                releaseId,
                registered.WorkId,
                client,
                requestedById) is { } retained)
        {
            var reused = await TryBuildReuseResponseAsync(retained, streamUrlForToken, ct);
            if (reused is not null)
                return new SingleResolve(registered.WorkId, reused);
        }

        // Request→first-frame timeline (BRIEF §11 diagnostics). t0 is the moment resolve begins;
        // every stage below records itself and is emitted as a [TTFF] debug log line.
        var timeline = TtffTimeline.Start(releaseId.Length >= 8 ? releaseId[..8] : releaseId, logger);

        CachedNzb cachedNzb;
        using (timeline.Measure("nzb-fetch", "nzb"))
            cachedNzb = await nzbFetcher.FetchAsync(
                new NzbCacheDescriptor(
                    registered.Release.ReleaseId,
                    registered.WorkId,
                    registered.Release.Title,
                    registered.Release.Indexer,
                    registered.Release.SizeBytes,
                    ReleaseRegistrationSerializer.Serialize(registered)),
                nzbUrl,
                registered.Release.IndexerId ?? registered.Release.Indexer,
                ct);
        var nzb = cachedNzb.Document;
        var candidate = MediaFileSelector.SelectPrimary(nzb)
            ?? throw new NoPlayableFileException("The NZB contains no playable media file.");

        using var startupCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // Preserve the exact ready/degraded/dead contract: all configured samples are
        // still checked, but their NNTP round trips overlap media materialization.
        var healthStartMs = timeline.ElapsedMs;
        var healthTask = healthChecker.CheckAsync(candidate.HealthSegmentIds, startupCts.Token);
        var materializeStartMs = timeline.ElapsedMs;
        var mediaTask = materializationCache.GetOrCreateAsync(
            releaseId,
            candidate,
            token => materializer.MaterializeAsync(candidate, token),
            startupCts.Token);

        HealthCheckResult health;
        try
        {
            health = await healthTask;
        }
        catch
        {
            startupCts.Cancel();
            _ = ObserveMaterializationAsync(mediaTask);
            throw;
        }
        timeline.Add("health-check", "health", healthStartMs, timeline.ElapsedMs - healthStartMs,
            detail: $"{health.MissingCount}/{health.SampledCount} missing");
        logger.LogInformation(
            "Health check for release {ReleaseId}: {Status} ({Missing}/{Sampled} sampled segments missing)",
            releaseId, health.StatusLabel, health.MissingCount, health.SampledCount);

        var ttlSeconds = options.Value.SessionTtlSeconds;

        if (health.Health == ReleaseHealth.Dead)
        {
            startupCts.Cancel();
            _ = ObserveMaterializationAsync(mediaTask);
            return new SingleResolve(registered.WorkId, new ResolveResponse
            {
                ReleaseId = releaseId,
                Status = health.StatusLabel,
                SessionTtlSeconds = ttlSeconds,
            });
        }

        // Cache a healthy classification too, so search can prefer proven-good releases.
        healthCache.Record(releaseId, health.Health);

        var media = await mediaTask;
        timeline.Add("materialize", "materialize", materializeStartMs, timeline.ElapsedMs - materializeStartMs,
            detail: $"{media.SegmentIds.Count} segments");
        ActiveSession session;
        while (true)
        {
            var admission = sessionManager.GetOrCreateOpeningSession(
                releaseId,
                registered.WorkId,
                media,
                health.StatusLabel,
                client,
                requestedById,
                requestedByName,
                registered.Release.Title,
                timeline);
            session = admission.Session;
            if (admission.Created)
                break;

            // Another resolve admitted this release while our health/materialization work was in
            // flight. Await its single ffprobe rather than minting a second capability/file row.
            var reused = await TryBuildReuseResponseAsync(session, streamUrlForToken, ct);
            if (reused is not null)
                return new SingleResolve(registered.WorkId, reused);
        }

        FfprobeResult? probe;
        try
        {
            // The loopback URL itself is a narrowly-scoped capability; never put an
            // admin JWT or machine key in ffprobe's command line or HTTP headers.
            using (timeline.Measure("ffprobe", "probe"))
                probe = await mediaProbeCache.GetOrCreateAsync(
                    releaseId,
                    media,
                    token => ffprobe.ProbeAsync(localStreamUrlForToken(session.Token), token),
                    ct);
        }
        catch
        {
            // Cancellation/failure before a response must not strand an unreachable
            // capability session until its TTL expires.
            sessionManager.CloseSession(session.Token);
            throw;
        }
        if (probe == null)
        {
            logger.LogWarning(
                "ffprobe could not read the stream for release {ReleaseId}; returning without media info",
                releaseId);
        }

        // The capability must exist before ffprobe can read its loopback URL. Once probing has
        // supplied duration, raise this session's pacing ceiling when necessary so Jellyfin's
        // HLS remux can always produce segments ahead of realtime for high-bitrate media.
        session.SetRunTimeTicks(probe?.RunTimeTicks);

        // Always-visible TTFF breakdown for the server console (per-span detail is at Debug).
        logger.LogInformation("[TTFF] resolve {ReleaseId} {Summary}", releaseId, timeline.Summarize());

        try
        {
            var response = new ResolveResponse
            {
                ReleaseId = releaseId,
                Status = health.StatusLabel,
                StreamUrl = streamUrlForToken(session.Token),
                Container = media.Container,
                SizeBytes = media.SizeBytes,
                RunTimeTicks = probe?.RunTimeTicks,
                MediaStreams = probe?.MediaStreams ?? [],
                SessionTtlSeconds = ttlSeconds,
            };
            if (!session.CompleteOpening(probe))
                throw new SessionUnavailableException(
                    "The capability session closed or expired while the release was opening.");
            return new SingleResolve(registered.WorkId, response);
        }
        catch
        {
            // URL projection and response construction happen after the capability is admitted.
            // Any failure here must obey the same cleanup rule as ffprobe failures.
            sessionManager.CloseSession(session.Token);
            throw;
        }
    }

    private sealed record SingleResolve(string WorkId, ResolveResponse Response);

    private async Task<ResolveResponse?> TryBuildReuseResponseAsync(
        ActiveSession session,
        Func<string, string> streamUrlForToken,
        CancellationToken ct)
    {
        if (!await session.WaitUntilReadyAsync(ct))
            return null;
        if (!sessionManager.TryGetSession(session.Token, out var retained)
            || !ReferenceEquals(session, retained))
        {
            return null;
        }

        retained.Touch();
        var probe = retained.Probe;
        logger.LogInformation(
            "Resolve reused retained capability {Token} for release {ReleaseId}",
            retained.Token[..8],
            retained.Session.ReleaseId);
        return new ResolveResponse
        {
            ReleaseId = retained.Session.ReleaseId,
            Status = retained.Status,
            StreamUrl = streamUrlForToken(retained.Token),
            Container = retained.File.Container,
            SizeBytes = retained.File.SizeBytes,
            RunTimeTicks = probe?.RunTimeTicks,
            MediaStreams = probe?.MediaStreams ?? [],
            SessionTtlSeconds = options.Value.SessionTtlSeconds,
        };
    }

    internal static Task ObserveMaterializationAsync(Task<ResolvedMediaFile> task)
        => task.ContinueWith(
            static completed =>
            {
                if (completed.IsFaulted)
                    _ = completed.Exception;
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
}
