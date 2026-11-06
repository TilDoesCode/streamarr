using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Playback;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>Retry pacing of download preparation; tests shorten it.</summary>
public sealed record DownloadTimings(TimeSpan CapacityRetry, TimeSpan CapacityWait)
{
    public static DownloadTimings Default { get; } = new(TimeSpan.FromSeconds(2), TimeSpan.FromMinutes(10));
}

/// <summary>Viewer device downloads: candidates, similarity plan, asynchronous preparation with a hard direct-play check, and the persisted records.</summary>
public sealed class ViewerDownloadService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerCatalogService catalog,
    ViewerContentPolicy policy,
    IPlaybackResolver resolver,
    IPlaybackMedia media,
    IReleaseStore releases,
    ITmdbClient tmdb,
    ViewerAccountService accounts,
    ViewerSettingsService settings,
    DownloadTransferGovernor governor,
    IDownloadFileSource files,
    IDataProtectionProvider protection,
    TimeProvider time,
    ILogger<ViewerDownloadService> logger,
    DownloadTimings? timings = null) : BackgroundService, IViewerAccessListener
{
    public const int MaxStoredPerViewer = 200;
    public const int MaxWaitMs = 10_000;
    public const int MaxPlanTargets = 100;

    public static class States
    {
        public const string Queued = "queued";
        public const string Resolving = "resolving";
        public const string Probing = "probing";
        public const string Ready = "ready";
        public const string Failed = "failed";
        public const string Completed = "completed";
    }

    private static readonly string[] Preparing = [States.Queued, States.Resolving, States.Probing];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly ConcurrentDictionary<string, Run> _runs = new(StringComparer.Ordinal);
    private readonly DynamicSemaphore _prepares = new(() => settings.Current.Downloads.MaxConcurrentPrepares);
    private readonly IDataProtector _protector = protection.CreateProtector("Streamarr.ViewerDownloads.Capability");
    private readonly DownloadTimings _timings = timings ?? DownloadTimings.Default;
    private readonly KeyedAsyncLock _viewerLocks = new();
    private readonly KeyedAsyncLock _downloadLocks = new();

    /// <summary>Test seam: runs inside a lifecycle transaction (operation, download id) right before it commits.</summary>
    internal Func<string, string, Task>? BeforeLifecycleCommit { get; set; }

    /// <summary>How often open transfers are checked against their capability's expiry.</summary>
    internal static readonly TimeSpan ExpirySweep = TimeSpan.FromMilliseconds(500);

    /// <summary>What a prepare needs again after a restart.</summary>
    private sealed record PrepareSpec(DeviceProfileDto Device, string? Engine, string? AudioLanguage);

    private sealed class Run(string viewerId, string workId)
    {
        public string ViewerId { get; } = viewerId;
        public string WorkId { get; } = workId;
        public CancellationTokenSource Cancellation { get; } = new();
        public TaskCompletionSource Changed { get; set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    // ---- candidates and plan ----

    public async Task<DownloadCandidatesResponse> CandidatesAsync(ViewerEntity viewer, DownloadCandidatesRequest request, string? acceptLanguage, CancellationToken ct)
    {
        if (request is null)
            throw Invalid("A request body is required.");
        RequireAllowed(viewer);
        var key = ViewerMappings.RequireWork(request.WorkId, playableOnly: true);
        var (play, languages) = await ContextAsync(request.Device, request.Engine, request.AudioLanguages, acceptLanguage, ct);
        return await catalog.DownloadCandidatesAsync(viewer, key, play, languages, request.Refresh, ct);
    }

    public async Task<DownloadSeasonCandidatesResponse> SeasonCandidatesAsync(
        ViewerEntity viewer, DownloadSeasonCandidatesRequest request, string? acceptLanguage, CancellationToken ct)
    {
        if (request is null)
            throw Invalid("A request body is required.");
        RequireAllowed(viewer);
        var key = WorkKey.TryParse(request.WorkId);
        if (key is not { Kind: WorkKind.Season, TmdbId: { } tmdbId, Season: { } season })
            throw ViewerProblem.BadRequest("invalid_work_id", "Expected a season work id such as tmdb-tv-1396-s02.");
        var (play, languages) = await ContextAsync(request.Device, request.Engine, request.AudioLanguages, acceptLanguage, ct);
        return await catalog.DownloadSeasonAsync(viewer, tmdbId, season, play, languages, request.Refresh, request.IncludeEpisodes, ct);
    }

    public async Task<DownloadPlanResponse> PlanAsync(ViewerEntity viewer, DownloadPlanRequest request, string? acceptLanguage, CancellationToken ct)
    {
        if (request is null)
            throw Invalid("A request body is required.");
        RequireAllowed(viewer);
        var anchor = ViewerMappings.RequireWork(request.AnchorWorkId, playableOnly: true);
        if (anchor is not { Kind: WorkKind.Episode, SeriesWorkId: { } series })
            throw ViewerProblem.BadRequest("invalid_work_id", "'anchorWorkId' must be an episode id.");
        var releaseId = ReleaseId(request.AnchorReleaseId, "anchorReleaseId");
        if (request.WorkIds is not { Count: > 0 and <= MaxPlanTargets } ids)
            throw Invalid($"'workIds' must list 1 to {MaxPlanTargets} episode ids.");
        var targets = ids.Select(id => WorkKey.TryParse(id) is { Kind: WorkKind.Episode } key && key.SeriesWorkId == series ? key
                : throw ViewerProblem.BadRequest("invalid_work_id", $"'{id}' is not an episode of the anchor's series."))
            .DistinctBy(k => k.WorkId)
            .ToList();
        var (play, languages) = await ContextAsync(request.Device, request.Engine, request.AudioLanguages, acceptLanguage, ct);
        return await catalog.DownloadPlanAsync(viewer, anchor, releaseId, targets, play, languages, ct);
    }

    private async Task<(PlayContext Play, IReadOnlyList<string>? Languages)> ContextAsync(
        DeviceProfileDto? device, string? engine, IReadOnlyList<string>? audioLanguages, string? acceptLanguage, CancellationToken ct)
    {
        var caps = DeviceCaps.Parse(device);
        var preferences = PlaybackPreferences.Default with { Engine = Engine(engine) };
        var requested = audioLanguages is null ? null : ViewerAudioLanguages.Parse(string.Join(',', audioLanguages));
        var languages = ViewerAudioLanguages.Resolve(requested, ViewerAudioLanguages.FromAcceptLanguage(acceptLanguage));
        return (new PlayContext(caps, preferences, await media.ServerAsync(ct)), languages);
    }

    // ---- preparation ----

    public async Task<DownloadResponse> PrepareAsync(ViewerCaller caller, ViewerEntity viewer, DownloadPrepareRequest request, CancellationToken ct)
    {
        if (request is null)
            throw Invalid("A request body is required.");
        var work = ViewerMappings.RequireWork(request.WorkId, playableOnly: true);
        var releaseId = ReleaseId(request.ReleaseId, "releaseId");
        _ = DeviceCaps.Parse(request.Device);
        var engine = Engine(request.Engine);
        var deviceName = Text(request.DeviceName, "deviceName") ?? (caller.DeviceName.Length > 0 ? caller.DeviceName : null);
        var deviceId = Text(request.DeviceId, "deviceId");
        var clientRef = Text(request.ClientRef, "clientRef");
        RequireAllowed(viewer);
        await EnsureAllowedAsync(viewer, work, ct);

        var deviceKey = clientRef is null ? null : DeviceKey(deviceId, caller.SessionId);
        var title = await TitleAsync(work, ct);
        ViewerDownloadEntity entity;
        // Lookup, quota and insert of one viewer are serialized, in one write transaction with the session check (atomic with a
        // security sign-out); the unique (viewer, device key, clientRef) index catches a second server process.
        using (await _viewerLocks.AcquireAsync(viewer.Id, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            if (!await SessionAliveAsync(db, caller.ViewerId, caller.SessionId, ct))
                throw SignedOut();
            if (deviceKey is not null
                && await db.ViewerDownloads.AsNoTracking()
                    .FirstOrDefaultAsync(d => d.ViewerId == viewer.Id && d.DeviceKey == deviceKey && d.ClientRef == clientRef, ct) is { } existing)
                return Snapshot(existing, caller, deviceId);
            if (await db.ViewerDownloads.CountAsync(d => d.ViewerId == viewer.Id && d.State != States.Completed, ct) >= MaxStoredPerViewer)
                throw ViewerProblem.Conflict("too_many_downloads_stored", $"This profile keeps at most {MaxStoredPerViewer} downloads that are not completed; remove some first.");

            var now = time.GetUtcNow();
            entity = new ViewerDownloadEntity
            {
                Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
                ViewerId = viewer.Id,
                SessionId = caller.SessionId,
                DeviceName = deviceName,
                DeviceId = deviceId,
                ClientRef = clientRef,
                DeviceKey = deviceKey,
                SecurityGeneration = await ViewerGenerationAsync(db, viewer.Id, ct),
                WorkId = work.WorkId,
                SeriesWorkId = work.SeriesWorkId,
                Title = title,
                RequestedReleaseId = releaseId,
                ReleaseName = releases.Get(releaseId, work.WorkId)?.Release.Title,
                State = States.Queued,
                RequestJson = JsonSerializer.Serialize(new PrepareSpec(request.Device!, engine.ToString().ToLowerInvariant(), null), Json),
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.ViewerDownloads.Add(entity);
            try
            {
                await db.SaveChangesAsync(ct);
                await transaction.CommitAsync(ct);
            }
            catch (DbUpdateException) when (deviceKey is not null)
            {
                await transaction.RollbackAsync(CancellationToken.None);
                await using var again = await dbFactory.CreateDbContextAsync(ct);
                var winner = await again.ViewerDownloads.AsNoTracking()
                    .FirstOrDefaultAsync(d => d.ViewerId == viewer.Id && d.DeviceKey == deviceKey && d.ClientRef == clientRef, ct);
                if (winner is null)
                    throw;
                return Snapshot(winner, caller, deviceId);
            }
        }
        Launch(entity.Id, entity.ViewerId, entity.WorkId);
        logger.LogInformation("Viewer download {DownloadId} of {WorkId} ({ReleaseId}) queued for {Viewer} on {Device}",
            entity.Id, work.WorkId, releaseId, caller.Username, deviceName ?? "unknown device");
        return Snapshot(entity, caller, deviceId);
    }

    private void Launch(string id, string viewerId, string workId)
    {
        var run = new Run(viewerId, workId);
        if (!_runs.TryAdd(id, run))
            return;
        _ = Task.Run(() => RunAsync(id, run), CancellationToken.None);
    }

    private async Task RunAsync(string id, Run run)
    {
        var ct = run.Cancellation.Token;
        try
        {
            await _prepares.WaitAsync(ct);
            try
            {
                await PrepareCoreAsync(id, run, ct);
            }
            finally
            {
                _prepares.Release();
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Viewer download {DownloadId} failed unexpectedly", id);
            await FailAsync(id, run, new PlaybackFailure("download_failed", "The download could not be prepared.",
                TrackSelector.Params(("reason", e.GetType().Name)), [SuggestedActions.Retry]));
        }
        finally
        {
            _runs.TryRemove(new KeyValuePair<string, Run>(id, run));
            run.Changed.TrySetResult();
        }
    }

    private async Task PrepareCoreAsync(string id, Run run, CancellationToken ct)
    {
        ViewerDownloadEntity? entity;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
            entity = await db.ViewerDownloads.AsNoTracking().FirstOrDefaultAsync(d => d.Id == id, ct);
        if (entity is null || !Preparing.Contains(entity.State))
            return;
        var viewer = await accounts.GetAsync(entity.ViewerId, ct);
        var work = WorkKey.TryParse(entity.WorkId)!;
        var spec = JsonSerializer.Deserialize<PrepareSpec>(entity.RequestJson, Json) ?? throw new InvalidDataException("The prepare request is missing.");
        var device = DeviceCaps.Parse(spec.Device);
        var engine = Engine(spec.Engine);

        try
        {
            await UpdateAsync(id, run, d => d.State = States.Resolving, ct);
            var requested = entity.RequestedReleaseId;
            if (releases.Get(requested, work.WorkId) is null)
            {
                try
                {
                    await catalog.RecommendedAsync(viewer, work, null, null, ct);
                }
                catch (ViewerProblem e)
                {
                    logger.LogDebug("Re-ranking {WorkId} for download {DownloadId} failed: {Code}", work.WorkId, id, e.Code);
                }
                if (releases.Get(requested, work.WorkId) is null)
                {
                    var otherTitle = releases.Get(requested) is not null;
                    throw new PlaybackFailure("release_not_found",
                        otherTitle ? "This version belongs to another title." : "This version is not known for the title (any more).",
                        TrackSelector.Params(("releaseId", requested), ("reason", otherTitle ? "otherTitle" : "unknown")), [SuggestedActions.OtherVersion]);
                }
            }

            var attempts = new List<PlaybackAttemptDto>();
            ResolveResponse? resolved = null;
            foreach (var copy in new[] { requested }.Concat(catalog.CopiesOf(work, requested)))
            {
                attempts.Add(new PlaybackAttemptDto { ReleaseId = copy, Name = NameOf(copy, work.WorkId), Status = "resolving" });
                await UpdateAsync(id, run, d => d.AttemptsJson = JsonSerializer.Serialize(attempts, Json), ct);
                var response = await ResolveQueuedAsync(id, run, new PlaybackResolveCall(copy, work.WorkId, viewer.Id, viewer.Username, false, SessionManager.TransferClient), ct);
                attempts[^1] = attempts[^1] with { Status = response.Status };
                await UpdateAsync(id, run, d => d.AttemptsJson = JsonSerializer.Serialize(attempts, Json), ct);
                if (response.Status != "dead")
                {
                    resolved = response;
                    break;
                }
            }
            if (resolved is null)
            {
                throw new PlaybackFailure("release_dead", "This version (and every copy of it) is missing data on Usenet.",
                    TrackSelector.Params(("releaseId", requested), ("attempts", attempts.Count)), [SuggestedActions.OtherVersion, SuggestedActions.Retry]);
            }

            var token = TokenOf(resolved.StreamUrl) ?? throw new PlaybackFailure("download_failed", "The resolve returned no stream.", null, [SuggestedActions.Retry]);
            var releaseId = resolved.ReleaseId;
            await UpdateAsync(id, run, d =>
            {
                d.State = States.Probing;
                d.ReleaseId = releaseId;
                d.ReleaseName = NameOf(releaseId, work.WorkId) ?? d.ReleaseName;
                d.FallbackFromReleaseId = releaseId == requested ? null : requested;
            }, ct);

            SourceMediaInfo? probe;
            try
            {
                using (DownloadPreparation.Enter())
                    probe = await media.ProbeAsync(token, ct);
            }
            catch (TranscodeException e) when (e.Code == "unknown_stream")
            {
                throw new PlaybackFailure("stream_expired", "The stream of this version expired; prepare the download again.", null, [SuggestedActions.Retry]);
            }
            if (probe is null)
                throw new PlaybackFailure("probe_failed", "The server could not read the streams of this version.", null, [SuggestedActions.Retry, SuggestedActions.OtherVersion]);
            catalog.RecordContainer(releaseId, probe.Container);

            var verdict = OfflinePlayback.Evaluate(probe, device, engine, await media.ServerAsync(ct));
            var resolveNotes = releaseId == requested ? [] : new List<PlanReason> { PlanReason.Of("fallback_used", "The requested copy is missing data; another copy of the same release is downloaded.", ("from", requested)) };
            if (verdict.Candidate is not { } candidate)
            {
                var decision = ViewerPlaybackService.DecisionDto(null, verdict.Decision with { Failure = null }, verdict.SkippedDirect, resolveNotes);
                await UpdateAsync(id, run, d => d.DecisionJson = JsonSerializer.Serialize(decision with { Reasons = [.. decision.Reasons, .. verdict.Reasons.Select(Reason)] }, Json), ct);
                files.Release(releaseId, work.WorkId, viewer.Id);
                throw new PlaybackFailure("not_direct_playable", "This version's file does not play as it is on this device (it would need a remux or transcode).",
                    TrackSelector.Params(("reasons", string.Join(',', verdict.Reasons.Select(r => r.Code)))), [SuggestedActions.OtherVersion]);
            }

            var file = media.StreamFile(token)
                       ?? throw new PlaybackFailure("stream_expired", "The stream of this version expired; prepare the download again.", null, [SuggestedActions.Retry]);
            var mediaInfo = OfflineMediaInfo(ViewerPlaybackService.MediaInfo(probe, candidate.Plan, candidate), candidate.Engine, device);
            var ready = ViewerPlaybackService.DecisionDto(candidate, verdict.Decision, verdict.SkippedDirect, resolveNotes);
            var languages = ViewerAudioLanguages.ForPlayback(null, null);
            var version = await catalog.VersionAsync(viewer, work, releaseId, ct, languages,
                new PlayContext(device, PlaybackPreferences.Default with { Engine = engine }, await media.ServerAsync(ct)));
            var now = time.GetUtcNow();
            var revoked = false;
            await PublishReadyAsync(id, run, d =>
            {
                d.State = States.Ready;
                d.Engine = verdict.Engine;
                d.FileName = file.FileName;
                d.Container = TranscodePlanner.ContainerFamily(probe.Container) ?? file.Container;
                d.SizeBytes = file.SizeBytes;
                d.ETag = ETag(releaseId, work.WorkId, file.FileName, file.SizeBytes);
                d.MediaInfoJson = JsonSerializer.Serialize(mediaInfo, Json);
                d.DecisionJson = JsonSerializer.Serialize(ready, Json);
                d.VersionJson = version is null ? null : JsonSerializer.Serialize(version, Json);
                d.ExpiresAt = now.AddDays(settings.Current.Downloads.CapabilityDays);
                d.ReadyAt = now;
                d.ErrorJson = null;
            }, published => revoked = published, ct);
            logger.LogInformation("Viewer download {DownloadId} is ready: {FileName} ({SizeBytes} bytes, {Engine}){Revoked}", id, file.FileName, file.SizeBytes,
                verdict.Engine, revoked ? ", file URL revoked by a security sign-out meanwhile" : "");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (PlaybackFailure failure)
        {
            await FailAsync(id, run, failure);
        }
        catch (ViewerProblem problem)
        {
            await FailAsync(id, run, new PlaybackFailure(problem.Code, problem.Message, problem.Parameters, ViewerPlaybackService.ProblemActions(problem)));
        }
        catch (Exception e)
        {
            var mapped = ViewerPlaybackService.Map(e);
            await FailAsync(id, run, mapped.Code == "playback_failed"
                ? new PlaybackFailure("download_failed", mapped.Message, mapped.Parameters, mapped.SuggestedActions)
                : mapped);
        }
    }

    private async Task<ResolveResponse> ResolveQueuedAsync(string id, Run run, PlaybackResolveCall call, CancellationToken ct)
    {
        var started = time.GetUtcNow();
        while (true)
        {
            try
            {
                using (DownloadPreparation.Enter())
                    return await resolver.ResolveAsync(call, NoObserver.Instance, ct);
            }
            catch (ResourceCapacityException) when (time.GetUtcNow() - started < _timings.CapacityWait)
            {
                await UpdateAsync(id, run, d => d.State = States.Queued, ct);
                await Task.Delay(_timings.CapacityRetry, ct);
                await UpdateAsync(id, run, d => d.State = States.Resolving, ct);
            }
        }
    }

    /// <summary>Image subtitles the chosen engine shows as they are; <c>vlcOnly</c> marks the ones only VLC renders.</summary>
    private static PlaybackMediaInfoDto OfflineMediaInfo(PlaybackMediaInfoDto info, EngineCaps engine, DeviceCaps device)
        => info with
        {
            SubtitleTracks = info.SubtitleTracks.Select(s =>
            {
                var nativeRenders = device.Native is { } native && (native.SubtitleFormats is null ? s.TextBased : native.RendersSubtitle(s.Codec));
                var vlcRenders = device.Vlc?.RendersSubtitle(s.Codec) == true;
                var rendered = engine.Name == EngineCaps.Vlc ? vlcRenders : nativeRenders;
                return s with
                {
                    Selected = false,
                    DeliveredAs = rendered ? SubtitlePlan.Embedded : SubtitlePlan.None,
                    VlcOnly = !nativeRenders && vlcRenders,
                };
            }).ToList(),
            AudioTracks = info.AudioTracks.Select(a => a with { Selected = false }).ToList(),
        };

    // ---- records ----

    public async Task<DownloadListResponse> ListAsync(ViewerCaller caller, ViewerEntity viewer, string? device, string? deviceId, CancellationToken ct)
    {
        var scope = device?.Trim().ToLowerInvariant() switch
        {
            null or "" or "all" => "all",
            "this" => "this",
            _ => throw ViewerProblem.BadRequest("invalid_query", "'device' must be this or all."),
        };
        deviceId = Text(deviceId, "deviceId");
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var query = db.ViewerDownloads.AsNoTracking().Where(d => d.ViewerId == caller.ViewerId);
        if (scope == "this")
            query = query.Where(d => d.SessionId == caller.SessionId || (deviceId != null && d.DeviceId == deviceId));
        var items = await query.OrderByDescending(d => d.CreatedAt).Take(500).ToListAsync(ct);
        await RequireLiveSessionAsync(caller, ct);
        return new DownloadListResponse
        {
            Items = items.Select(d => Snapshot(d, caller, deviceId)).ToList(),
            Limits = new DownloadLimitsDto
            {
                Allowed = viewer.AllowDownloads && !viewer.IsDisabled,
                MaxConcurrentDownloads = viewer.MaxConcurrentDownloads ?? settings.Current.Downloads.MaxActivePerViewer,
                ActiveDownloads = governor.ActiveFor(viewer.Id),
            },
        };
    }

    public async Task<DownloadResponse> GetAsync(ViewerCaller caller, string downloadId, int waitMs, string? deviceId, CancellationToken ct)
    {
        if (waitMs is < 0 or > MaxWaitMs)
            throw Invalid($"'waitMs' must be between 0 and {MaxWaitMs}.");
        deviceId = Text(deviceId, "deviceId");
        var entity = await FindAsync(caller.ViewerId, downloadId, ct);
        if (waitMs > 0 && Preparing.Contains(entity.State) && _runs.TryGetValue(entity.Id, out var run))
        {
            try
            {
                await run.Changed.Task.WaitAsync(TimeSpan.FromMilliseconds(waitMs), ct);
            }
            catch (TimeoutException)
            {
            }
            entity = await FindAsync(caller.ViewerId, downloadId, ct);
        }
        // Checked after the wait and after reading the record: a sign-out from here on revokes the file URL itself.
        await RequireLiveSessionAsync(caller, ct);
        return Snapshot(entity, caller, deviceId);
    }

    public async Task<DownloadResponse> RenewAsync(ViewerCaller caller, ViewerEntity viewer, string downloadId, string? deviceId, CancellationToken ct)
    {
        deviceId = Text(deviceId, "deviceId");
        var entity = await FindAsync(caller.ViewerId, downloadId, ct);
        if (entity.State != States.Ready)
            throw ViewerProblem.Conflict("download_not_ready", "Only a ready download has a file URL to renew.");
        RequireAllowed(viewer);
        await EnsureAllowedAsync(viewer, WorkKey.TryParse(entity.WorkId)!, ct);
        var expires = time.GetUtcNow().AddDays(settings.Current.Downloads.CapabilityDays);
        var rotated = false;
        // One renewal or rotation of a download at a time, and its checks and write in one write transaction: concurrent renewals
        // return the first one's URL, and a security sign-out either sees the renewed URL (and revokes it) or refuses the renewal.
        using (await _downloadLocks.AcquireAsync(entity.Id, ct))
        {
            entity = await LifecycleAsync(entity.Id, "renew", async (db, d) =>
            {
                if (d.ViewerId != caller.ViewerId)
                    throw NotFound();
                if (d.State != States.Ready)
                    throw ViewerProblem.Conflict("download_not_ready", "Only a ready download has a file URL to renew.");
                if (!await SessionAliveAsync(db, caller.ViewerId, caller.SessionId, ct))
                    throw SignedOut();
                d.SecurityGeneration = await ViewerGenerationAsync(db, d.ViewerId, ct);
                d.ExpiresAt = expires;
                rotated = false;
                if (d.CapabilityRevokedAt is null && d.CapabilityHash is not null)
                    return true;
                // A revoked file URL is replaced, and the download moves to the device that renewed it.
                var capability = NewCapability();
                (d.CapabilityHash, d.CapabilityProtected, d.CapabilityRevokedAt) = (Hash(capability), _protector.Protect(capability), null);
                d.SessionId = caller.SessionId;
                d.DeviceId = deviceId ?? d.DeviceId;
                rotated = true;
                return true;
            }, ct) ?? throw NotFound();
        }
        governor.SetDeadline(entity.Id, expires);
        if (rotated)
            logger.LogInformation("Viewer download {DownloadId} got a new file URL after a security sign-out", entity.Id);
        await RequireLiveSessionAsync(caller, ct);
        return Snapshot(entity, caller, deviceId);
    }

    public async Task<DownloadResponse> CompleteAsync(ViewerCaller caller, string downloadId, DownloadCompleteRequest request, CancellationToken ct)
    {
        var entity = await FindAsync(caller.ViewerId, downloadId, ct);
        if (entity.State == States.Completed)
            return Snapshot(entity, caller, null);
        if (entity.State != States.Ready)
            throw ViewerProblem.Conflict("download_not_ready", "Only a ready download can be completed.");
        if (request.BytesReceived is { } received && received != entity.SizeBytes)
        {
            throw new ViewerProblem(StatusCodes.Status409Conflict, "size_mismatch", "The device holds a different number of bytes than the file has.",
                TrackSelector.Params(("bytesReceived", received), ("sizeBytes", entity.SizeBytes)));
        }
        var now = time.GetUtcNow();
        using (await _downloadLocks.AcquireAsync(entity.Id, ct))
        {
            entity = await MutateAsync(entity.Id, d =>
            {
                d.State = States.Completed;
                d.CompletedAt = now;
                d.CapabilityHash = null;
                d.CapabilityProtected = null;
            }, ct) ?? throw NotFound();
        }
        governor.Abort(entity.Id);
        await ReleaseSourceAsync(entity, ct);
        logger.LogInformation("Viewer download {DownloadId} completed on the device", entity.Id);
        return Snapshot(entity, caller, null);
    }

    public async Task DeleteAsync(ViewerCaller caller, string downloadId, CancellationToken ct)
        => await RemoveAsync(await FindAsync(caller.ViewerId, downloadId, ct), ct);

    public async Task<DownloadAdminListResponse> AdminListAsync(string? viewerId, bool activeOnly, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var query = db.ViewerDownloads.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(viewerId))
            query = query.Where(d => d.ViewerId == viewerId);
        var items = await query.OrderByDescending(d => d.CreatedAt).Take(500).ToListAsync(ct);
        if (activeOnly)
            items = items.Where(d => governor.IsTransferring(d.Id)).ToList();
        var ids = items.Select(d => d.ViewerId).Distinct().ToList();
        var names = await db.Viewers.AsNoTracking().Where(v => ids.Contains(v.Id)).ToDictionaryAsync(v => v.Id, v => v.Username, ct);
        return new DownloadAdminListResponse
        {
            Items = items.Select(d => new DownloadAdminItemDto
            {
                DownloadId = d.Id,
                ViewerId = d.ViewerId,
                Username = names.GetValueOrDefault(d.ViewerId, d.ViewerId),
                DeviceName = d.DeviceName,
                State = d.State,
                WorkId = d.WorkId,
                Title = d.Title,
                ReleaseName = d.ReleaseName,
                FileName = d.FileName,
                SizeBytes = d.SizeBytes,
                BytesServed = d.BytesServed,
                Transferring = governor.IsTransferring(d.Id),
                BytesPerSecond = governor.Speed(d.Id),
                CreatedAt = d.CreatedAt,
                CompletedAt = d.CompletedAt,
                LastTransferAt = d.LastTransferAt,
                ExpiresAt = d.ExpiresAt,
                FileUrlRevoked = d.State == States.Ready && d.CapabilityRevokedAt is not null,
                ErrorCode = d.ErrorJson is null ? null : JsonSerializer.Deserialize<PlaybackErrorDto>(d.ErrorJson, Json)?.Code,
            }).ToList(),
            ActiveTransfers = governor.ActiveTransfers,
            Throttled = governor.Throttled,
            LiveStreams = governor.LiveStreams,
            BytesPerSecond = governor.TotalSpeed,
        };
    }

    public async Task AdminDeleteAsync(string downloadId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = await db.ViewerDownloads.AsNoTracking().FirstOrDefaultAsync(d => d.Id == downloadId, ct) ?? throw NotFound();
        await RemoveAsync(entity, ct);
    }

    /// <summary>The download whose current or last revoked file capability has this hash; null when none.</summary>
    public async Task<ViewerDownloadEntity?> FindByCapabilityHashAsync(string hash, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerDownloads.AsNoTracking().FirstOrDefaultAsync(d => d.CapabilityHash == hash || d.RevokedCapabilityHash == hash, ct);
    }

    public async Task<ViewerDownloadEntity?> FindByIdAsync(string downloadId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerDownloads.AsNoTracking().FirstOrDefaultAsync(d => d.Id == downloadId, ct);
    }

    // ---- access changes ----

    /// <summary>Permissions, the disabled flag or the account changed: authorizations in flight go stale, transfers no longer allowed end.</summary>
    public async Task AccessChangedAsync(string viewerId, CancellationToken ct)
    {
        governor.RevokeViewer(viewerId, endTransfers: false);
        ViewerEntity? viewer;
        try
        {
            viewer = await accounts.GetAsync(viewerId, ct);
        }
        catch (ViewerProblem e) when (e.Code == "viewer_not_found")
        {
            viewer = null;
        }
        if (viewer is null || viewer.IsDisabled || !viewer.AllowDownloads)
        {
            governor.RevokeViewer(viewerId, endTransfers: true);
            await CancelPreparationsAsync(viewerId, null, "downloads_not_allowed", "Downloads were turned off for this profile.");
            return;
        }
        var works = governor.ActiveOf(viewerId).Select(a => a.WorkId)
            .Concat(_runs.Values.Where(r => r.ViewerId == viewerId).Select(r => r.WorkId))
            .Distinct(StringComparer.Ordinal);
        foreach (var workId in works)
        {
            if (WorkKey.TryParse(workId) is not { } work || (await policy.EvaluateAsync(viewer, work, ct)).Allowed)
                continue;
            foreach (var (downloadId, _) in governor.ActiveOf(viewerId).Where(a => a.WorkId == workId))
                governor.Abort(downloadId);
            await CancelPreparationsAsync(viewerId, workId, "age_restricted", "This title is no longer allowed for this profile.");
        }
    }

    /// <summary>
    /// A security sign-out: the file URLs of the downloads bound to the ended sessions stop at once (410 <c>download_revoked</c>) and
    /// their transfers end; a preparation of such a session becomes ready with a revoked file URL. The records stay, and a renew from the
    /// signed-in device issues new URLs. The session revocation and the viewer's security generation committed before this runs, so every
    /// renewal or publication that passed its own checks is visible here; each row is rotated under its download lock.
    /// </summary>
    public async Task SessionsRevokedAsync(ViewerSessionRevocation revocation, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        List<string> candidates;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            candidates = (await db.ViewerDownloads.AsNoTracking()
                    .Where(d => d.ViewerId == revocation.ViewerId && (d.State == States.Ready || Preparing.Contains(d.State)))
                    .Select(d => new { d.Id, d.SessionId })
                    .ToListAsync(ct))
                .Where(d => revocation.Covers(d.SessionId))
                .Select(d => d.Id)
                .ToList();
        }
        var rotated = 0;
        foreach (var id in candidates)
        {
            var ended = false;
            using (await _downloadLocks.AcquireAsync(id, ct))
            {
                await LifecycleAsync(id, "rotate", (_, d) =>
                {
                    ended = false;
                    if (!revocation.Covers(d.SessionId))
                        return Task.FromResult(false);
                    if (d.State == States.Ready && d.CapabilityHash is not null)
                    {
                        (d.RevokedCapabilityHash, d.CapabilityHash, d.CapabilityProtected) = (d.CapabilityHash, null, null);
                        d.CapabilityRevokedAt = now;
                        ended = true;
                        return Task.FromResult(true);
                    }
                    if (Preparing.Contains(d.State) && d.CapabilityRevokedAt is null)
                    {
                        d.CapabilityRevokedAt = now;
                        return Task.FromResult(true);
                    }
                    return Task.FromResult(false);
                }, ct);
            }
            if (!ended)
                continue;
            governor.Abort(id);
            rotated++;
        }
        if (rotated > 0)
            logger.LogInformation("Revoked the file URLs of {Count} download(s) of viewer {ViewerId} ({Reason})", rotated, revocation.ViewerId, revocation.Reason);
    }

    private async Task CancelPreparationsAsync(string viewerId, string? workId, string code, string message)
    {
        foreach (var (id, run) in _runs.Where(r => r.Value.ViewerId == viewerId && (workId is null || r.Value.WorkId == workId)).ToList())
        {
            await run.Cancellation.CancelAsync();
            await FailAsync(id, run, new PlaybackFailure(code, message, null, []));
        }
    }

    private async Task RemoveAsync(ViewerDownloadEntity entity, CancellationToken ct)
    {
        if (_runs.TryRemove(entity.Id, out var run))
        {
            await run.Cancellation.CancelAsync();
            run.Changed.TrySetResult();
        }
        using (await _downloadLocks.AcquireAsync(entity.Id, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await db.ViewerDownloads.Where(d => d.Id == entity.Id).ExecuteDeleteAsync(ct);
        }
        governor.Abort(entity.Id);
        governor.Forget(entity.Id);
        await ReleaseSourceAsync(entity, ct);
        logger.LogInformation("Viewer download {DownloadId} removed", entity.Id);
    }

    /// <summary>Lets the stream session go when no other ready download of the viewer needs the same file.</summary>
    private async Task ReleaseSourceAsync(ViewerDownloadEntity entity, CancellationToken ct)
    {
        if (entity.ReleaseId is not { } releaseId)
            return;
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var shared = await db.ViewerDownloads.AnyAsync(d => d.Id != entity.Id && d.ViewerId == entity.ViewerId && d.ReleaseId == releaseId
                                                           && d.WorkId == entity.WorkId && d.State == States.Ready, ct);
        if (!shared)
            files.Release(releaseId, entity.WorkId, entity.ViewerId);
    }

    // ---- lifecycle ----

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            List<(string Id, string ViewerId, string WorkId)> pending;
            await using (var db = await dbFactory.CreateDbContextAsync(stoppingToken))
            {
                pending = (await db.ViewerDownloads.Where(d => Preparing.Contains(d.State)).Select(d => new { d.Id, d.ViewerId, d.WorkId }).ToListAsync(stoppingToken))
                    .Select(d => (d.Id, d.ViewerId, d.WorkId)).ToList();
            }
            foreach (var (id, viewerId, workId) in pending)
                Launch(id, viewerId, workId);
            if (pending.Count > 0)
                logger.LogInformation("Resumed {Count} viewer download preparation(s) after a restart", pending.Count);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception e) when (e is DbUpdateException or Microsoft.Data.Sqlite.SqliteException or InvalidOperationException)
        {
            logger.LogWarning(e, "Could not resume viewer download preparations");
        }

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(ExpirySweep, stoppingToken);
                await SweepTransfersAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    /// <summary>Ends open transfers whose download expired, left the ready state or lost its file URL, also when only the database says so.</summary>
    internal async Task SweepTransfersAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var ended = governor.ExpireDue(now);
        var active = governor.ActiveDownloadIds();
        if (active.Count > 0)
        {
            try
            {
                await using var db = await dbFactory.CreateDbContextAsync(ct);
                var rows = (await db.ViewerDownloads.AsNoTracking().Where(d => active.Contains(d.Id))
                        .Select(d => new { d.Id, d.State, d.CapabilityHash, d.ExpiresAt }).ToListAsync(ct))
                    .ToDictionary(d => d.Id, StringComparer.Ordinal);
                foreach (var id in active)
                {
                    var row = rows.GetValueOrDefault(id);
                    if (row is { State: States.Ready, CapabilityHash: not null } && (row.ExpiresAt is not { } expires || expires > now))
                    {
                        governor.SetDeadline(id, row.ExpiresAt);
                        continue;
                    }
                    governor.Abort(id);
                    ended++;
                }
            }
            catch (Exception e) when (e is DbUpdateException or Microsoft.Data.Sqlite.SqliteException or InvalidOperationException)
            {
                logger.LogDebug(e, "Checking the open download transfers failed");
            }
        }
        if (ended > 0)
            logger.LogInformation("Ended {Count} download transfer(s) whose file URL expired or was revoked", ended);
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        foreach (var run in _runs.Values)
            await run.Cancellation.CancelAsync();
        await base.StopAsync(cancellationToken);
    }

    // ---- helpers ----

    private DownloadResponse Snapshot(ViewerDownloadEntity d, ViewerCaller caller, string? deviceId)
    {
        var thisDevice = d.SessionId == caller.SessionId || (deviceId is not null && d.DeviceId == deviceId);
        var error = d.ErrorJson is null ? null : JsonSerializer.Deserialize<StoredError>(d.ErrorJson, Json);
        return new DownloadResponse
        {
            DownloadId = d.Id,
            State = d.State,
            WorkId = d.WorkId,
            Title = d.Title,
            RequestedReleaseId = d.RequestedReleaseId,
            ReleaseId = d.ReleaseId,
            CreatedAt = d.CreatedAt,
            UpdatedAt = d.UpdatedAt,
            ReadyAt = d.ReadyAt,
            CompletedAt = d.CompletedAt,
            PollAfterMs = Preparing.Contains(d.State) ? 1000 : 0,
            DeviceName = d.DeviceName,
            ThisDevice = thisDevice,
            Attempts = d.AttemptsJson is null ? [] : JsonSerializer.Deserialize<List<PlaybackAttemptDto>>(d.AttemptsJson, Json) ?? [],
            FallbackFrom = d.FallbackFromReleaseId is { } from ? new PlaybackReleaseDto { ReleaseId = from, Name = NameOf(from, d.WorkId) } : null,
            Version = d.VersionJson is null ? null : JsonSerializer.Deserialize<VersionDto>(d.VersionJson, Json),
            FileUrl = thisDevice && d.State == States.Ready && d.CapabilityRevokedAt is null && Unprotect(d.CapabilityProtected) is { } capability
                ? $"/api/v1/offline/{capability}"
                : null,
            FileUrlRevoked = d.State == States.Ready && d.CapabilityRevokedAt is not null,
            SizeBytes = d.SizeBytes,
            FileName = d.FileName,
            Container = d.Container,
            ContentType = d.Container is null ? null : ContainerContentTypes.For(d.Container),
            ETag = d.ETag,
            Engine = d.Engine,
            MediaInfo = d.MediaInfoJson is null ? null : JsonSerializer.Deserialize<PlaybackMediaInfoDto>(d.MediaInfoJson, Json),
            Decision = d.DecisionJson is null ? null : JsonSerializer.Deserialize<PlaybackDecisionDto>(d.DecisionJson, Json),
            ExpiresAt = d.State == States.Ready ? d.ExpiresAt : null,
            BytesServed = d.BytesServed,
            LastTransferAt = d.LastTransferAt,
            Transferring = governor.IsTransferring(d.Id),
            Error = error is null ? null : new PlaybackErrorDto { Code = error.Code, Message = error.Message, Params = error.Params },
            SuggestedActions = error?.SuggestedActions,
        };
    }

    private sealed record StoredError(string Code, string Message, IReadOnlyDictionary<string, string>? Params, IReadOnlyList<string> SuggestedActions);

    private async Task FailAsync(string id, Run run, PlaybackFailure failure)
    {
        logger.LogInformation("Viewer download {DownloadId} failed: {Code}", id, failure.Code);
        try
        {
            await UpdateAsync(id, run, d =>
            {
                d.State = States.Failed;
                d.ErrorJson = JsonSerializer.Serialize(new StoredError(failure.Code, failure.Message, failure.Parameters, failure.SuggestedActions), Json);
            }, CancellationToken.None);
        }
        catch (Exception e) when (e is DbUpdateException or InvalidOperationException)
        {
            logger.LogWarning(e, "Could not record the failure of viewer download {DownloadId}", id);
        }
    }

    private async Task UpdateAsync(string id, Run run, Action<ViewerDownloadEntity> change, CancellationToken ct)
    {
        _ = await MutateAsync(id, change, ct);
        var changed = run.Changed;
        run.Changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        changed.TrySetResult();
    }

    private Task<ViewerDownloadEntity?> MutateAsync(string id, Action<ViewerDownloadEntity> change, CancellationToken ct)
        => LifecycleAsync(id, "update", (_, d) =>
        {
            change(d);
            return Task.FromResult(true);
        }, ct);

    /// <summary>
    /// Changes one record in a write transaction (SQLite <c>BEGIN IMMEDIATE</c>: reads inside see every committed write) and saves it
    /// against the revision it read; <paramref name="change"/> answers whether it changed anything and runs again after a conflict.
    /// Null when the record is gone.
    /// </summary>
    private async Task<ViewerDownloadEntity?> LifecycleAsync(
        string id, string operation, Func<StreamarrDbContext, ViewerDownloadEntity, Task<bool>> change, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var entity = await db.ViewerDownloads.FirstOrDefaultAsync(d => d.Id == id, ct);
            if (entity is null)
                return null;
            if (!await change(db, entity))
                return entity;
            entity.Revision++;
            entity.UpdatedAt = time.GetUtcNow();
            if (BeforeLifecycleCommit is { } hook)
                await hook(operation, id);
            try
            {
                await db.SaveChangesAsync(ct);
                await transaction.CommitAsync(ct);
                return entity;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 5)
            {
                logger.LogDebug("Viewer download {DownloadId} changed meanwhile ({Operation}); trying again", id, operation);
            }
        }
    }

    /// <summary>
    /// Publishes a finished preparation under its download lock: with a fresh file URL, or — when a security sign-out covered it meanwhile
    /// (marked by the rotation, or the viewer's security generation moved on while the preparing session is gone) — as ready with a
    /// revoked file URL that the device renews after signing in again.
    /// </summary>
    private async Task PublishReadyAsync(string id, Run run, Action<ViewerDownloadEntity> apply, Action<bool> published, CancellationToken ct)
    {
        using (await _downloadLocks.AcquireAsync(id, ct))
        {
            await LifecycleAsync(id, "publish", async (db, d) =>
            {
                if (!Preparing.Contains(d.State))
                    return false;
                var generation = await ViewerGenerationAsync(db, d.ViewerId, ct);
                var revoked = d.CapabilityRevokedAt is not null
                              || (generation != d.SecurityGeneration && !await SessionAliveAsync(db, d.ViewerId, d.SessionId, ct));
                apply(d);
                if (revoked)
                {
                    (d.CapabilityHash, d.CapabilityProtected) = (null, null);
                    d.CapabilityRevokedAt ??= time.GetUtcNow();
                }
                else
                {
                    var capability = NewCapability();
                    (d.CapabilityHash, d.CapabilityProtected, d.CapabilityRevokedAt) = (Hash(capability), _protector.Protect(capability), null);
                    d.SecurityGeneration = generation;
                }
                published(revoked);
                return true;
            }, ct);
        }
        var changed = run.Changed;
        run.Changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        changed.TrySetResult();
    }

    private static Task<long> ViewerGenerationAsync(StreamarrDbContext db, string viewerId, CancellationToken ct)
        => db.Viewers.Where(v => v.Id == viewerId).Select(v => v.SecurityGeneration).FirstOrDefaultAsync(ct);

    private Task<bool> SessionAliveAsync(StreamarrDbContext db, string viewerId, string sessionId, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        return db.ViewerSessions.AnyAsync(s => s.Id == sessionId && s.ViewerId == viewerId && s.RevokedAt == null && s.RefreshExpiresAt > now, ct);
    }

    /// <summary>The caller's session at response time: a capability-bearing answer never goes to a session signed out meanwhile.</summary>
    private async Task RequireLiveSessionAsync(ViewerCaller caller, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        if (!await SessionAliveAsync(db, caller.ViewerId, caller.SessionId, ct))
            throw SignedOut();
    }

    private static ViewerProblem SignedOut() => ViewerProblem.Unauthorized("unauthorized", "This session was signed out; sign in again.");

    private async Task<ViewerDownloadEntity> FindAsync(string viewerId, string downloadId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(downloadId) || downloadId.Length > 64)
            throw NotFound();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerDownloads.AsNoTracking().FirstOrDefaultAsync(d => d.Id == downloadId && d.ViewerId == viewerId, ct) ?? throw NotFound();
    }

    private async Task EnsureAllowedAsync(ViewerEntity viewer, WorkKey work, CancellationToken ct)
    {
        var access = await policy.EvaluateAsync(viewer, work, ct);
        if (!access.Allowed)
            throw ViewerContentPolicy.AgeRestricted(access);
    }

    public static void RequireAllowed(ViewerEntity viewer)
    {
        if (!viewer.AllowDownloads)
            throw ViewerProblem.Forbidden("downloads_not_allowed", "Downloads are turned off for this profile.");
    }

    private async Task<string?> TitleAsync(WorkKey work, CancellationToken ct)
    {
        try
        {
            using var language = TmdbLanguage.Use(null);
            switch (work)
            {
                case { Kind: WorkKind.Movie, TmdbId: { } movieId }:
                    return (await tmdb.GetMovieAsync(movieId, ct))?.Title;
                case { Kind: WorkKind.Episode, TmdbId: { } seriesId, Season: { } season, Episode: { } episode }:
                {
                    var series = (await tmdb.GetTvSeriesCatalogAsync(seriesId, ct))?.Series.Title;
                    var name = (await tmdb.GetTvSeasonCatalogAsync(seriesId, season, ct))?.Episodes.FirstOrDefault(e => e.EpisodeNumber == episode)?.Title;
                    var code = $"S{season:00}E{episode:00}";
                    return string.Join(" · ", new[] { series, code, name }.Where(p => !string.IsNullOrWhiteSpace(p)));
                }
            }
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Title lookup for {WorkId} failed", work.WorkId);
        }
        return null;
    }

    private string? NameOf(string releaseId, string workId) => releases.Get(releaseId, workId)?.Release.Title;

    private string? Unprotect(string? value)
    {
        if (value is null)
            return null;
        try
        {
            return _protector.Unprotect(value);
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    /// <summary>A strong entity tag of the file: the same for the same release, work and file across sessions and restarts.</summary>
    public static string ETag(string releaseId, string workId, string fileName, long sizeBytes)
        => $"\"{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{releaseId}\n{workId}\n{fileName}\n{sizeBytes}")))[..32].ToLowerInvariant()}\"";

    /// <summary>
    /// The device of an idempotent prepare: <c>d:</c> + the (already trimmed) <c>deviceId</c> with ASCII letters lowercased, else <c>s:</c> +
    /// the session. The migration computes the same with SQLite's ASCII-only <c>lower()</c>; viewer and clientRef are separate index columns.
    /// </summary>
    internal static string DeviceKey(string? deviceId, string sessionId)
        => deviceId is { } device ? "d:" + AsciiLower(device) : "s:" + sessionId;

    private static string AsciiLower(string value)
        => string.Create(value.Length, value, static (span, source) =>
        {
            for (var i = 0; i < source.Length; i++)
                span[i] = source[i] is >= 'A' and <= 'Z' ? (char)(source[i] | 0x20) : source[i];
        });

    private static string NewCapability() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    public static string Hash(string capability) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(capability))).ToLowerInvariant();

    private static PlanReasonResponse Reason(PlanReason r) => new(r.Code, r.Message, r.Params);

    private static string? TokenOf(string? streamUrl)
        => streamUrl is { Length: > 0 } url ? Uri.UnescapeDataString(url[(url.LastIndexOf('/') + 1)..]) : null;

    private static EnginePreference Engine(string? engine) => engine?.Trim().ToLowerInvariant() switch
    {
        null or "" or "auto" => EnginePreference.Auto,
        "native" => EnginePreference.Native,
        "vlc" => EnginePreference.Vlc,
        _ => throw Invalid("'engine' must be auto, native or vlc."),
    };

    private static string ReleaseId(string? value, string field)
    {
        var trimmed = value?.Trim();
        return trimmed is { Length: > 0 and <= 200 } && !trimmed.Any(char.IsControl) ? trimmed : throw Invalid($"'{field}' is required.");
    }

    private static string? Text(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        var trimmed = value.Trim();
        return trimmed.Length <= 64 && !trimmed.Any(char.IsControl) ? trimmed : throw Invalid($"'{field}' must be at most 64 printable characters.");
    }

    private static ViewerProblem Invalid(string message) => ViewerProblem.BadRequest("invalid_download_request", message);

    private static ViewerProblem NotFound() => ViewerProblem.NotFound("download_not_found", "No download with this id exists for this profile.");

    private sealed class NoObserver : IResolveObserver
    {
        public static readonly NoObserver Instance = new();

        public void HopStarted(string releaseId, int hop)
        {
        }

        public void HopFinished(string releaseId, string status)
        {
        }
    }
}
