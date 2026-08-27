using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;
using Streamarr.Server.Logging;
using Streamarr.Server.Options;
using Streamarr.Server.Services.Repair;

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
    ILogger<ResolveService> logger,
    RepairCoordinator? repairCoordinator = null,
    RepairStreamGateway? repairGateway = null,
    IStreamHistoryRecorder? historyRecorder = null)
{
    private readonly SemaphoreSlim _resolveGate = new(Math.Max(1, options.Value.MaxConcurrentResolves));
    private readonly AsyncLocal<EphemeralRetentionPriority?> _retentionPriority = new();
    private EphemeralRetentionPriority RequestedRetentionPriority
        => _retentionPriority.Value ?? EphemeralRetentionPriority.Normal;

    public async Task<ResolveResponse> ResolveForPreDownloadAsync(
        string releaseId,
        string workId,
        string? client,
        string? requestedById,
        string? requestedByName,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
    {
        var prior = _retentionPriority.Value;
        _retentionPriority.Value = EphemeralRetentionPriority.Background;
        try
        {
            return await ResolveAsync(
                releaseId,
                workId,
                client,
                requestedById,
                requestedByName,
                autoFallback: true,
                streamUrlForToken,
                localStreamUrlForToken,
                ct).ConfigureAwait(false);
        }
        finally
        {
            _retentionPriority.Value = prior;
        }
    }

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

        // Begun only once the gate admits the attempt — a rejected-at-the-gate call never
        // started real work and isn't a "stream" worth a permanent history row. Everything
        // past this point (thrown or graceful) is captured, so a crash mid-resolve still
        // leaves a debuggable trace (BRIEF §11 console).
        var requestedRegistration = releaseStore.Get(releaseId, workId);
        var streamAttemptId = historyRecorder?.BeginAttempt(new StreamAttemptBegin
        {
            ReleaseId = releaseId,
            WorkId = requestedRegistration?.WorkId ?? workId,
            Title = requestedRegistration?.Release.Title,
            Client = client,
            RequestedById = requestedById,
            RequestedByName = requestedByName,
        });

        var scopeProperties = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            [LogPropertyNames.ReleaseId] = releaseId,
        };
        if (!string.IsNullOrWhiteSpace(workId))
            scopeProperties[LogPropertyNames.WorkId] = workId;
        if (!string.IsNullOrWhiteSpace(streamAttemptId))
            scopeProperties[LogPropertyNames.StreamAttemptId] = streamAttemptId;
        using var resolveScope = logger.BeginScope(scopeProperties);

        try
        {
            var response = await ResolveCoreAsync(
                releaseId,
                workId,
                client,
                requestedById,
                requestedByName,
                autoFallback,
                streamUrlForToken,
                localStreamUrlForToken,
                streamAttemptId,
                ct);

            // A session was minted somewhere along the way (fresh or reused): SessionManager
            // owns finalizing that row when the session itself eventually closes. No session at
            // all means this attempt never got a capability — finalize it here, now.
            if (streamAttemptId is not null && response.StreamUrl is null)
            {
                historyRecorder!.Finalize(streamAttemptId, new StreamRecordFinalize
                {
                    FinalState = response.Status,
                    CloseReason = response.SuggestedFallbackReleaseId is { } fallback
                        ? $"fallback available: {fallback}"
                        : null,
                });
            }

            return response;
        }
        catch (Exception e)
        {
            if (e is OperationCanceledException && ct.IsCancellationRequested)
            {
                logger.LogDebug(
                    "Resolve for release {ReleaseId} was cancelled by the caller",
                    releaseId);
            }
            else
            {
                logger.LogError(
                    e,
                    "Resolve failed for release {ReleaseId} during {FailureType}",
                    releaseId,
                    e.GetType().Name);
            }

            if (streamAttemptId is not null)
            {
                historyRecorder!.AppendEvents(streamAttemptId,
                [
                    new StreamEventWrite(
                        DateTimeOffset.UtcNow,
                        "error",
                        "resolve",
                        e.GetType().Name,
                        LogSanitizer.SanitizeAndTruncate(e.Message, 1_024)),
                ]);
                historyRecorder!.Finalize(streamAttemptId, new StreamRecordFinalize
                {
                    FinalState = "error",
                    CloseReason = e.GetType().Name, // never e.Message — may carry paths/ids
                });
            }
            throw;
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
        string? streamAttemptId,
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
                streamAttemptId,
                ct);
            workId = single.WorkId;
            using var hopScope = logger.BeginScope(new Dictionary<string, object>(StringComparer.Ordinal)
            {
                [LogPropertyNames.ReleaseId] = currentId,
                [LogPropertyNames.WorkId] = workId,
            });
            attempts.Add(new ResolveAttempt { ReleaseId = currentId, Status = single.Response.Status });

            // This hop died without ever minting a session — its TtffTimeline would otherwise be
            // silently discarded. Persist what was measured before moving on (BRIEF §11 console).
            if (single.Timeline is not null)
                historyRecorder?.AppendEvents(streamAttemptId, StreamHistoryRecorder.EventsFromTimeline(single.Timeline));

            if (single.Response.Status != "dead")
            {
                // ready or degraded — return the healthy release, noting the fallback chain.
                return single.Response with
                {
                    Attempts = attempts,
                    FallbackFromReleaseId = currentId == releaseId ? null : releaseId,
                    OriginHealth = single.Response.OriginHealth ?? single.Response.Status,
                    Playability = single.Response.Playability ?? RepairPlayability.RemoteReady.ToApi(),
                };
            }

            // Dead: remember it (demotes it in ranking + skips it as a future fallback).
            healthCache.Record(currentId, ReleaseHealth.Dead);

            // A verified local repair artifact for the now-dead release wins immediately.
            var localSingle = await TryResolveFromArtifactAsync(
                currentId, workId, client, requestedById, requestedByName,
                streamUrlForToken, localStreamUrlForToken, streamAttemptId, ct);
            if (localSingle is not null)
            {
                attempts[^1] = new ResolveAttempt { ReleaseId = currentId, Status = localSingle.Response.Status };
                return localSingle.Response with
                {
                    Attempts = attempts,
                    FallbackFromReleaseId = currentId == releaseId ? null : releaseId,
                };
            }

            var preferRepair = options.Value.Repair.Policy == RepairPolicy.PreferRepair
                && repairCoordinator is { Enabled: true };
            var next = autoFallback && hop < maxHops && !preferRepair
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

                // Default policy (whenNoFallback): repair engages only when no healthy way
                // out exists. PreferRepair keeps the originally chosen release regardless.
                (RepairStatusInfo Info, string Playability)? repairInfo = null;
                if (suggestion is null || preferRepair)
                    repairInfo = await TryEngageRepairAsync(releaseId, workId, ct);

                // Copy the repair job's own state-transition log into this stream's permanent
                // history — this is what makes "went into repair, worked, then later didn't"
                // inspectable later: the job is keyed by content fingerprint, not by this
                // stream, so its history must be copied in rather than referenced.
                if (repairInfo is { Info.JobId: { } jobId })
                {
                    var repairEvents = repairCoordinator?.GetJob(jobId)?.Events;
                    if (repairEvents is { Count: > 0 })
                    {
                        historyRecorder?.AppendEvents(streamAttemptId, [.. repairEvents.Select(re =>
                            new StreamEventWrite(re.AtUtc, Source: "repair", Category: re.State.ToString(), Name: re.State.ToString(), Detail: re.Message))]);
                    }
                }

                if (repairInfo is { } engaged && engaged.Info.ProgressiveEligible)
                {
                    var progressive = await TryResolveProgressiveAsync(
                        releaseId, workId, client, requestedById, requestedByName,
                        streamUrlForToken, localStreamUrlForToken, engaged.Info, streamAttemptId, ct);
                    if (progressive is not null)
                    {
                        return progressive.Response with
                        {
                            Attempts = attempts,
                            FallbackFromReleaseId = null,
                        };
                    }
                }

                return single.Response with
                {
                    ReleaseId = releaseId,
                    SuggestedFallbackReleaseId =
                        suggestion is not null && !visited.Contains(suggestion.Release.ReleaseId)
                            ? suggestion.Release.ReleaseId
                            : null,
                    FallbackFromReleaseId = currentId == releaseId ? null : releaseId,
                    Attempts = attempts,
                    OriginHealth = "dead",
                    Playability = repairInfo?.Playability ?? RepairPlayability.Unavailable.ToApi(),
                    Repair = repairInfo?.Info,
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
        string? streamAttemptId,
        CancellationToken ct)
    {
        var registered = releaseStore.Get(releaseId, workId)
            ?? throw new ReleaseNotFoundException(releaseId);
        using var releaseScope = logger.BeginScope(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            [LogPropertyNames.ReleaseId] = registered.Release.ReleaseId,
            [LogPropertyNames.WorkId] = registered.WorkId,
        });
        if (healthCache.IsDead(releaseId))
        {
            // A verified local repair artifact wins immediately; the origin stays dead.
            var local = await TryResolveFromArtifactAsync(
                releaseId, workId, client, requestedById, requestedByName,
                streamUrlForToken, localStreamUrlForToken, streamAttemptId, ct);
            return local ?? DeadSingle(registered.WorkId, releaseId);
        }

        var nzbUrl = registered.Release.NzbUrl
            ?? throw new NoPlayableFileException("The release has no NZB location on record.");

        // Pause/resume and Jellyfin source reopens resolve the same release again. A retained
        // capability already owns the immutable materialized file and can open a fresh ranged
        // stream, so reuse it before repeating NZB, health, materialization, or ffprobe work.
        if (sessionManager.FindReusableSession(
                releaseId,
                registered.WorkId,
                client,
                requestedById,
                RequestedRetentionPriority) is { } retained)
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
        // Season pack support: an episode work resolved against a multi-episode release
        // must stream that episode's payload, not the pack's largest file.
        var target = EpisodeTarget.FromWorkId(registered.WorkId);
        var strictEpisodeMatch = target is not null && IsMultiEpisodeRelease(registered.Release.Title);
        var candidate = (target is { } episodeTarget
                ? MediaFileSelector.SelectForEpisode(nzb, episodeTarget, strictEpisodeMatch)
                : MediaFileSelector.SelectPrimary(nzb))
            ?? throw new NoPlayableFileException(strictEpisodeMatch && target is { } missing
                ? $"The NZB carries multiple payloads but none is identifiable as {missing}."
                : "The NZB contains no playable media file.");

        using var startupCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // Preserve the exact ready/degraded/dead contract: all configured samples are
        // still checked, but their NNTP round trips overlap media materialization.
        var healthStartMs = timeline.ElapsedMs;
        var healthTask = healthChecker.CheckAsync(candidate.HealthSegmentIds, startupCts.Token);
        var materializeStartMs = timeline.ElapsedMs;
        var mediaTask = materializationCache.GetOrCreateAsync(
            releaseId,
            candidate,
            token => materializer.MaterializeAsync(candidate, target, strictEpisodeMatch, token),
            startupCts.Token,
            variant: target?.CacheDiscriminator);

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
            detail: $"{health.ConfirmedMissingCount}/{health.SampledCount} missing, {health.IndeterminateCount} indeterminate");
        logger.LogInformation(
            "Health check for release {ReleaseId}: {Status} ({Missing}/{Sampled} sampled segments missing, {Indeterminate} indeterminate)",
            releaseId,
            health.StatusLabel,
            health.ConfirmedMissingCount,
            health.SampledCount,
            health.IndeterminateCount);

        var ttlSeconds = options.Value.SessionTtlSeconds;

        if (health.Health == ReleaseHealth.Dead)
        {
            startupCts.Cancel();
            _ = ObserveMaterializationAsync(mediaTask);
            return DeadSingle(registered.WorkId, releaseId) with { Timeline = timeline };
        }

        // Cache a healthy classification too, so search can prefer proven-good releases.
        healthCache.Record(releaseId, health.Health);
        if (healthCache.IsDead(releaseId))
        {
            startupCts.Cancel();
            _ = ObserveMaterializationAsync(mediaTask);
            return DeadSingle(registered.WorkId, releaseId) with { Timeline = timeline };
        }

        var media = await mediaTask;
        if (healthCache.IsDead(releaseId))
            return DeadSingle(registered.WorkId, releaseId) with { Timeline = timeline };

        timeline.Add("materialize", "materialize", materializeStartMs, timeline.ElapsedMs - materializeStartMs,
            detail: $"{media.SegmentIds.Count} segments");
        ActiveSession session;
        while (true)
        {
            SessionAdmission admission;
            try
            {
                admission = sessionManager.GetOrCreateOpeningSession(
                    releaseId,
                    registered.WorkId,
                    media,
                    health.StatusLabel,
                    client,
                    requestedById,
                    requestedByName,
                    registered.Release.Title,
                    timeline,
                    streamAttemptId,
                    RequestedRetentionPriority);
            }
            catch (SessionUnavailableException) when (healthCache.IsDead(releaseId))
            {
                return DeadSingle(registered.WorkId, releaseId) with { Timeline = timeline };
            }
            session = admission.Session;
            if (admission.Created)
                break;

            // Another resolve admitted this release while our health/materialization work was in
            // flight. Await its single ffprobe rather than minting a second capability/file row.
            var reused = await TryBuildReuseResponseAsync(session, streamUrlForToken, ct);
            if (reused is not null)
                return new SingleResolve(registered.WorkId, reused);
            if (healthCache.IsDead(releaseId))
                return DeadSingle(registered.WorkId, releaseId) with { Timeline = timeline };
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
        if (healthCache.IsDead(releaseId))
        {
            sessionManager.CloseSession(session.Token);
            return DeadSingle(registered.WorkId, releaseId) with { Timeline = timeline };
        }

        // The capability must exist before ffprobe can read its loopback URL. Once probing has
        // supplied duration, raise this session's pacing ceiling when necessary so Jellyfin's
        // HLS remux can always produce segments ahead of realtime for high-bitrate media.
        session.SetRunTimeTicks(probe?.RunTimeTicks);
        // Undo the loopback ffprobe's playback-only retention promotion before publishing.
        session.SetRetentionPriority(RequestedRetentionPriority);

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
        catch (SessionUnavailableException) when (healthCache.IsDead(releaseId))
        {
            sessionManager.CloseSession(session.Token);
            return DeadSingle(registered.WorkId, releaseId) with { Timeline = timeline };
        }
        catch
        {
            // URL projection and response construction happen after the capability is admitted.
            // Any failure here must obey the same cleanup rule as ffprobe failures.
            sessionManager.CloseSession(session.Token);
            throw;
        }
    }

    /// <summary>
    /// Serves a resolve from a verified local repair artifact: same capability/stream
    /// plumbing, but the media projection reads pinned local files. The origin remains
    /// dead in the health cache; only playability turns "repairedReady".
    /// </summary>
    private async Task<SingleResolve?> TryResolveFromArtifactAsync(
        string releaseId,
        string? workId,
        string? client,
        string? requestedById,
        string? requestedByName,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        string? streamAttemptId,
        CancellationToken ct)
    {
        if (repairCoordinator is not { Enabled: true } || repairGateway is null)
            return null;
        var registered = releaseStore.Get(releaseId, workId);
        if (registered is null)
            return null;

        RepairJobContext context;
        try
        {
            context = await repairCoordinator.BuildContextAsync(releaseId, workId, ct);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            logger.LogDebug(
                "Artifact lookup for release {ReleaseId} could not analyze the NZB ({FailureType})",
                releaseId, e.GetType().Name);
            return null;
        }

        repairCoordinator.RegisterReleaseFingerprint(releaseId, context.Fingerprint);
        using var artifactLease = repairCoordinator.TryAcquireReadyArtifact(context.Fingerprint);
        if (artifactLease is null)
            return null;
        var artifact = artifactLease.Artifact;

        LocalMediaProjection projection;
        try
        {
            projection = await LocalArtifactProjector.BuildAsync(
                artifact.Directory, artifact.Manifest.Files, context.Candidate.Password, ct);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "Local repair artifact for release {ReleaseId} could not be projected ({FailureType})",
                releaseId, e.GetType().Name);
            return null;
        }

        // Season pack guard: a repair artifact pins ONE media file of the release. If an
        // episode work asks for a different episode of a multi-episode release, serving
        // the pinned file would play the wrong content — fall through to dead/fallback.
        if (EpisodeTarget.FromWorkId(registered.WorkId) is { } artifactTarget
            && IsMultiEpisodeRelease(registered.Release.Title)
            && !artifactTarget.MatchesFileName(projection.MediaFileName))
        {
            logger.LogInformation(
                "Repair artifact for release {ReleaseId} pins a different episode than {Target}; skipping artifact playback",
                releaseId, artifactTarget);
            return null;
        }

        var media = new ResolvedMediaFile
        {
            FileName = projection.MediaFileName,
            Container = projection.Container,
            SizeBytes = projection.MediaSizeBytes,
            SegmentIds = [],
            OpenStream = _ => repairGateway.OpenPinnedProjectionStream(projection, context.Fingerprint),
        };

        var timeline = TtffTimeline.Start(releaseId.Length >= 8 ? releaseId[..8] : releaseId, logger);
        timeline.Add("repair-artifact", "materialize", 0, timeline.ElapsedMs, detail: "local artifact");

        ActiveSession session;
        while (true)
        {
            var admission = sessionManager.GetOrCreateOpeningSession(
                releaseId,
                registered.WorkId,
                media,
                "ready",
                client,
                requestedById,
                requestedByName,
                registered.Release.Title,
                timeline,
                streamAttemptId,
                RequestedRetentionPriority);
            session = admission.Session;
            if (admission.Created)
                break;
            var reused = await TryBuildReuseResponseAsync(session, streamUrlForToken, ct);
            if (reused is not null)
                return new SingleResolve(registered.WorkId, DecorateRepairedReady(reused));
        }

        FfprobeResult? probe;
        try
        {
            using (timeline.Measure("ffprobe", "probe"))
                probe = await mediaProbeCache.GetOrCreateAsync(
                    releaseId,
                    media,
                    token => ffprobe.ProbeAsync(localStreamUrlForToken(session.Token), token),
                    ct);
        }
        catch
        {
            sessionManager.CloseSession(session.Token);
            throw;
        }

        session.SetRunTimeTicks(probe?.RunTimeTicks);
        session.SetRetentionPriority(RequestedRetentionPriority);
        logger.LogInformation("[TTFF] resolve {ReleaseId} from local repair artifact {Summary}",
            releaseId, timeline.Summarize());

        try
        {
            var response = DecorateRepairedReady(new ResolveResponse
            {
                ReleaseId = releaseId,
                Status = "ready",
                StreamUrl = streamUrlForToken(session.Token),
                Container = media.Container,
                SizeBytes = media.SizeBytes,
                RunTimeTicks = probe?.RunTimeTicks,
                MediaStreams = probe?.MediaStreams ?? [],
                SessionTtlSeconds = options.Value.SessionTtlSeconds,
            });
            if (!session.CompleteOpening(probe))
                throw new SessionUnavailableException(
                    "The capability session closed or expired while the release was opening.");
            return new SingleResolve(registered.WorkId, response);
        }
        catch
        {
            sessionManager.CloseSession(session.Token);
            throw;
        }
    }

    private ResolveResponse DecorateRepairedReady(ResolveResponse response)
        => response with
        {
            OriginHealth = "dead",
            Playability = RepairPlayability.RepairedReady.ToApi(),
        };

    /// <summary>
    /// Progressive admission (opt-in): the origin is dead but the damage sits far enough
    /// behind an intact prefix that streaming can start while the shared repair job runs.
    /// Reads that reach the hole wait on the job instead of failing. No health check runs
    /// here — deadness is already proven; the capability is created against the remote
    /// source and the RepairAwareStream handles the gap.
    /// </summary>
    private async Task<SingleResolve?> TryResolveProgressiveAsync(
        string releaseId,
        string? workId,
        string? client,
        string? requestedById,
        string? requestedByName,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        RepairStatusInfo repairInfo,
        string? streamAttemptId,
        CancellationToken ct)
    {
        if (repairGateway is null)
            return null;
        var registered = releaseStore.Get(releaseId, workId);
        var nzbUrl = registered?.Release.NzbUrl;
        if (registered is null || nzbUrl is null)
            return null;

        try
        {
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
            var target = EpisodeTarget.FromWorkId(registered.WorkId);
            var strictEpisodeMatch = target is not null && IsMultiEpisodeRelease(registered.Release.Title);
            var candidate = target is { } episodeTarget
                ? MediaFileSelector.SelectForEpisode(cachedNzb.Document, episodeTarget, strictEpisodeMatch)
                : MediaFileSelector.SelectPrimary(cachedNzb.Document);
            if (candidate is null)
                return null;

            ResolvedMediaFile media;
            using (timeline.Measure("materialize", "materialize"))
                media = await materializationCache.GetOrCreateAsync(
                    releaseId,
                    candidate,
                    token => materializer.MaterializeAsync(candidate, target, strictEpisodeMatch, token),
                    ct,
                    variant: target?.CacheDiscriminator);

            var admission = sessionManager.GetOrCreateOpeningSession(
                releaseId,
                registered.WorkId,
                media,
                "degraded",
                client,
                requestedById,
                requestedByName,
                registered.Release.Title,
                timeline,
                streamAttemptId,
                RequestedRetentionPriority);
            var session = admission.Session;
            if (!admission.Created)
            {
                var reused = await TryBuildReuseResponseAsync(session, streamUrlForToken, ct);
                if (reused is null)
                    return null;
                return new SingleResolve(registered.WorkId, reused with
                {
                    OriginHealth = "dead",
                    Playability = RepairPlayability.Progressive.ToApi(),
                    Repair = repairInfo,
                });
            }

            FfprobeResult? probe;
            try
            {
                using (timeline.Measure("ffprobe", "probe"))
                    probe = await mediaProbeCache.GetOrCreateAsync(
                        releaseId,
                        media,
                        token => ffprobe.ProbeAsync(localStreamUrlForToken(session.Token), token),
                        ct);
            }
            catch
            {
                sessionManager.CloseSession(session.Token);
                throw;
            }

            session.SetRunTimeTicks(probe?.RunTimeTicks);
            session.SetRetentionPriority(RequestedRetentionPriority);
            var response = new ResolveResponse
            {
                ReleaseId = releaseId,
                Status = "degraded",
                StreamUrl = streamUrlForToken(session.Token),
                Container = media.Container,
                SizeBytes = media.SizeBytes,
                RunTimeTicks = probe?.RunTimeTicks,
                MediaStreams = probe?.MediaStreams ?? [],
                SessionTtlSeconds = options.Value.SessionTtlSeconds,
                OriginHealth = "dead",
                Playability = RepairPlayability.Progressive.ToApi(),
                Repair = repairInfo,
            };
            if (!session.CompleteOpening(probe))
            {
                sessionManager.CloseSession(session.Token);
                return null;
            }
            logger.LogInformation("[TTFF] progressive resolve {ReleaseId} {Summary}", releaseId, timeline.Summarize());
            return new SingleResolve(registered.WorkId, response);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "Progressive admission for release {ReleaseId} failed ({FailureType}); falling back to the repair-status response",
                releaseId, e.GetType().Name);
            return null;
        }
    }

    /// <summary>
    /// Engages (or reports) a repair job when a dead resolve has no healthy way out.
    /// Returns the additive repair fields for the response, or null when repair stays out.
    /// </summary>
    private async Task<(RepairStatusInfo Info, string Playability)?> TryEngageRepairAsync(
        string releaseId,
        string? workId,
        CancellationToken ct)
    {
        if (repairCoordinator is not { Enabled: true })
            return null;

        var registered = releaseStore.Get(releaseId, workId);
        RepairJobHandle? handle;
        try
        {
            handle = await repairCoordinator.GetOrStartJobAsync(
                releaseId, workId, registered?.Release.Title, RepairTrigger.Resolve, ct);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "Repair engagement for release {ReleaseId} failed ({FailureType})",
                releaseId, e.GetType().Name);
            return null;
        }

        var snapshot = handle?.Snapshot() ?? repairCoordinator.GetJobByRelease(releaseId);
        if (snapshot is null)
            return null;

        var repair = options.Value.Repair;
        var progressiveEligible = repair.ProgressiveEnabled
            && !snapshot.IsTerminal
            && snapshot.FirstDamagedByte is { } firstDamaged
            && firstDamaged >= repair.ProgressiveMinIntactPrefixBytes;
        var playability = snapshot.State switch
        {
            RepairState.Ready => RepairPlayability.RepairedReady.ToApi(),
            RepairState.Failed or RepairState.Cancelled or RepairState.Evicted => RepairPlayability.Unavailable.ToApi(),
            _ => RepairPlayability.Repairing.ToApi(),
        };
        return (snapshot.ToStatusInfo(progressiveEligible, retryAfterSeconds: snapshot.IsTerminal ? null : 5),
            playability);
    }

    /// <summary>
    /// <paramref name="Timeline"/> is attached only for a "dead" result that measured real work
    /// before failing (never for a live session — that timeline lives on the session itself and
    /// is persisted at close time instead), so the caller can flush it to permanent history
    /// before it would otherwise be silently discarded.
    /// </summary>
    private sealed record SingleResolve(string WorkId, ResolveResponse Response, TtffTimeline? Timeline = null);

    private SingleResolve DeadSingle(string workId, string releaseId)
        => new(workId, new ResolveResponse
        {
            ReleaseId = releaseId,
            Status = "dead",
            SessionTtlSeconds = options.Value.SessionTtlSeconds,
        });

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
        if (healthCache.IsDead(retained.Session.ReleaseId)
            && repairGateway?.AllowsPlaybackWhileDead(retained.Session.ReleaseId) != true)
        {
            sessionManager.CloseSession(retained.Token);
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

    /// <summary>A release whose name declares a season pack or multiple episodes.</summary>
    internal static bool IsMultiEpisodeRelease(string title)
    {
        var parsed = Streamarr.Core.Parser.ReleaseParser.Parse(title);
        return parsed.SeasonPack || parsed.Episodes.Count > 1;
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
