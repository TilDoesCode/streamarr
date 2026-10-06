using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Watch;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Viewers.Playback;

/// <summary>Who asks: playbacks belong to one viewer session (device).</summary>
public sealed record ViewerCaller(string ViewerId, string SessionId, string Username, string DeviceName);

/// <summary>What a progress report with a server <c>playbackId</c> fills in.</summary>
public sealed record PlaybackLink(string? ReleaseId, string? StreamToken, IReadOnlyList<PlaybackDeliveryIssueDto> DeliveryIssues);

/// <summary>Poll and retry pacing; tests shorten it.</summary>
public sealed record PlaybackTimings(
    TimeSpan RepairPoll, TimeSpan CapacityRetry, TimeSpan CapacityWait, TimeSpan SwitchGrace, TimeSpan SweepInterval, TimeSpan? StartBudget = null)
{
    public static PlaybackTimings Default { get; } = new(
        TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(500), TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(15));

    /// <summary>Longest a revision may stay in <c>starting</c> (all remux/transcode attempts together) before it fails with <c>start_timeout</c>.</summary>
    public TimeSpan StartLimit => StartBudget ?? TimeSpan.FromSeconds(60);
}

/// <summary>Viewer playbacks: per-playback async state machine over resolve and HLS sessions, plus switch, stop, heartbeat, idle expiry and the stream limit.</summary>
public sealed class ViewerPlaybackService(
    IPlaybackResolver resolver,
    IPlaybackMedia media,
    ViewerCatalogService catalog,
    ViewerContentPolicy policy,
    WatchStateService watch,
    IReleaseStore releases,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ILogger<ViewerPlaybackService> logger,
    PlaybackTimings? timings = null) : BackgroundService, IHlsDeliveryIssueSink
{
    public const int MaxPlaybacksPerViewer = 16;
    public const int MaxPlaybacks = 1024;
    internal const int MaxDeliveryIssues = 16;
    internal static readonly TimeSpan DeliveryIssueRetention = TimeSpan.FromSeconds(60);
    internal static readonly TimeSpan DeliveryIssueWindow = TimeSpan.FromSeconds(30);
    private static readonly string[] PreparingStates = [States.Queued, States.Resolving, States.Fallback, States.Repairing, States.Planning, States.Starting];

    private readonly ConcurrentDictionary<string, Playback> _playbacks = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Playback> _byHls = new(StringComparer.Ordinal);
    private readonly object _admission = new();
    private readonly PlaybackTimings _timings = timings ?? PlaybackTimings.Default;
    private TimeSpan HeartbeatWindow => TimeSpan.FromSeconds(options.Value.ViewerPlaybackHeartbeatSeconds);
    private TimeSpan IdleTimeout => TimeSpan.FromSeconds(options.Value.ViewerPlaybackIdleSeconds);

    public static class States
    {
        public const string Queued = "queued";
        public const string Resolving = "resolving";
        public const string Fallback = "fallback";
        public const string Repairing = "repairing";
        public const string Planning = "planning";
        public const string Starting = "starting";
        public const string Ready = "ready";
        public const string Failed = "failed";
    }

    internal int Count => _playbacks.Count;

    public async Task<PlaybackResponse> StartAsync(ViewerCaller caller, ViewerEntity viewer, PlaybackStartRequest request, CancellationToken ct)
    {
        if (request is null)
            throw Invalid("A request body is required.");
        var work = ViewerMappings.RequireWork(request.WorkId, playableOnly: true);
        var releaseId = ReleaseId(request.ReleaseId);
        var start = Position(request.StartPositionTicks, "startPositionTicks") ?? 0;
        ValidateIndexes(request.AudioStreamIndex, request.SubtitleStreamIndex);
        var device = DeviceCaps.Parse(request.Device);
        var preferences = PlaybackPreferences.Merge(request.Preferences, PlaybackPreferences.Default);
        await EnsureAllowedAsync(viewer, work, ct);
        var saved = (await watch.GetAsync(viewer.Id, [work.WorkId], ct)).FirstOrDefault();

        var now = time.GetUtcNow();
        var playback = new Playback
        {
            Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            ViewerId = viewer.Id,
            SessionId = caller.SessionId,
            Username = caller.Username,
            DeviceName = caller.DeviceName,
            Work = work,
            CreatedAt = now,
            Viewer = viewer,
            RequestedReleaseId = releaseId,
            Device = device,
            Preferences = preferences,
            AudioIndex = request.AudioStreamIndex,
            SubtitleIndex = request.SubtitleStreamIndex,
            StartTicks = start,
            ResumeTicks = saved is { PositionTicks: > 0 } ? saved.PositionTicks : null,
            State = States.Queued,
            UpdatedAt = now,
            LastActivity = now,
        };

        var superseded = new List<Playback>();
        lock (_admission)
        {
            var mine = _playbacks.Values.Where(p => p.ViewerId == viewer.Id && !p.Stopped).OrderBy(p => p.CreatedAt).ToList();
            if (viewer.MaxConcurrentStreams is { } limit)
            {
                var active = mine.Where(p => IsActive(p, now)).ToList();
                foreach (var own in active.Where(p => p.SessionId == caller.SessionId).ToList())
                {
                    if (active.Count < limit)
                        break;
                    active.Remove(own);
                    superseded.Add(own);
                }
                if (active.Count >= limit)
                {
                    var other = active.OrderByDescending(LastActive).First();
                    var otherDevice = other.DeviceName.Length > 0 ? other.DeviceName : null;
                    throw new ViewerProblem(StatusCodes.Status409Conflict, "too_many_streams",
                        $"This profile may play {limit} stream(s) at a time and {(otherDevice is null ? "another device" : $"'{otherDevice}'")} is already playing.",
                        TrackSelector.Params(("limit", limit), ("device", otherDevice), ("workId", other.Work.WorkId), ("releaseName", other.Version?.Name)));
                }
            }
            foreach (var old in mine.Except(superseded).Where(p => !IsActive(p, now)).Take(Math.Max(0, mine.Count - superseded.Count - (MaxPlaybacksPerViewer - 1))))
                superseded.Add(old);
            if (mine.Count - superseded.Count >= MaxPlaybacksPerViewer || _playbacks.Count >= MaxPlaybacks)
                throw new ViewerProblem(StatusCodes.Status429TooManyRequests, "too_many_playbacks", "Too many playbacks are being prepared; stop one first.");
            foreach (var old in superseded)
                Detach(old);
            _playbacks[playback.Id] = playback;
        }
        foreach (var old in superseded)
            await CloseMediaAsync(old, "superseded by a new playback on the same device");

        Launch(playback, 0, resolve: true, playback.Cancellation.Token);
        logger.LogInformation("Viewer playback {PlaybackId} of {WorkId} started for {Viewer} on {Device}", playback.Id, work.WorkId, caller.Username, caller.DeviceName);
        return Snapshot(playback, touch: false);
    }

    public const int MaxWaitMs = 10_000;

    /// <summary>The playback's state; with <paramref name="waitMs"/> it first waits until the playback changes or reaches <c>ready</c>/<c>failed</c>.</summary>
    public async Task<PlaybackResponse> GetAsync(ViewerCaller caller, string playbackId, int waitMs, CancellationToken ct)
    {
        if (waitMs is < 0 or > MaxWaitMs)
            throw Invalid($"'waitMs' must be between 0 and {MaxWaitMs}.");
        var playback = Find(caller, playbackId) ?? throw NotFound();
        if (waitMs > 0)
        {
            Task changed;
            lock (playback.Gate)
                changed = playback.State is States.Ready or States.Failed ? Task.CompletedTask : playback.Changed.Task;
            try
            {
                await changed.WaitAsync(TimeSpan.FromMilliseconds(waitMs), ct);
            }
            catch (TimeoutException)
            {
            }
            playback = Find(caller, playbackId) ?? throw NotFound();
        }
        return Snapshot(playback, touch: true);
    }

    public async Task<PlaybackResponse> SwitchAsync(ViewerCaller caller, ViewerEntity viewer, string playbackId, PlaybackSwitchRequest request, CancellationToken ct)
    {
        var playback = Find(caller, playbackId) ?? throw NotFound();
        if (request is null)
            throw Invalid("A request body is required.");
        var releaseId = ReleaseId(request.ReleaseId);
        var position = Position(request.PositionTicks, "positionTicks");
        ValidateIndexes(request.AudioStreamIndex, request.SubtitleStreamIndex);
        await EnsureAllowedAsync(viewer, playback.Work, ct);

        bool resolve;
        int revision;
        CancellationToken run;
        lock (playback.Gate)
        {
            if (playback.Stopped)
                throw NotFound();
            var preferences = PlaybackPreferences.Merge(request.Preferences, playback.Preferences);
            var otherRelease = releaseId is not null && releaseId != playback.ResolvedReleaseId;
            if (!otherRelease && playback.Media is { } known)
                ValidateTracks(known, request.AudioStreamIndex, request.SubtitleStreamIndex);
            resolve = playback.StreamToken is null || otherRelease;
            if (otherRelease)
            {
                playback.RequestedReleaseId = releaseId;
                playback.Excluded.Clear();
                playback.Attempts.Clear();
                playback.FallbackFrom = null;
                playback.Version = null;
                playback.Repair = null;
                playback.StreamToken = null;
                playback.ResolvedReleaseId = null;
                playback.Media = null;
                playback.AudioIndex = null;
                playback.SubtitleIndex = null;
            }
            if (request.StepDown && playback.PlayingKey is { } playing)
                playback.Excluded.Add(playing);
            playback.Preferences = preferences;
            playback.AudioIndex = request.AudioStreamIndex ?? playback.AudioIndex;
            playback.AudioFallback = request.AudioFallback ?? playback.AudioFallback;
            playback.SubtitleIndex = request.SubtitleStreamIndex ?? playback.SubtitleIndex;
            playback.StartTicks = position ?? playback.PositionTicks ?? playback.StartTicks;
            playback.Viewer = viewer;
            revision = ++playback.Revision;
            playback.Cancellation.Cancel();
            playback.Cancellation = new CancellationTokenSource();
            run = playback.Cancellation.Token;
            if (playback.CurrentHls is { } current)
                playback.PreviousHls.Add(new PreviousRendition(current, null));
            SetCurrentHls(playback, null);
            playback.Issues.Clear();
            playback.Ready = null;
            playback.Failure = null;
            playback.Decision = null;
            playback.State = resolve ? States.Resolving : States.Planning;
            var now = time.GetUtcNow();
            playback.UpdatedAt = now;
            playback.LastActivity = now;
            playback.LastSwitchAt = now;
            Signal(playback);
        }
        Launch(playback, revision, resolve, run);
        return Snapshot(playback, touch: false);
    }

    public async Task StopAsync(ViewerCaller caller, string playbackId, string reason)
    {
        var playback = Find(caller, playbackId) ?? throw NotFound();
        await EndAsync(playback, reason);
    }

    /// <summary>Records a progress report of a server playback; null when the id is not a live playback of this device for this work.</summary>
    public PlaybackLink? Heartbeat(ViewerCaller caller, string playbackId, string workId, long positionTicks)
    {
        var playback = Find(caller, playbackId);
        if (playback is null || playback.Work.WorkId != workId)
            return null;
        List<string> hls;
        IReadOnlyList<PlaybackDeliveryIssueDto> issues;
        lock (playback.Gate)
        {
            var now = time.GetUtcNow();
            playback.LastHeartbeat = now;
            playback.LastActivity = now;
            playback.PositionTicks = positionTicks;
            hls = OpenRenditions(playback).ToList();
            // Each issue is told once: recorded after the previous heartbeat answer, at most 30 s ago.
            issues = DeliveryIssues(playback, now, playback.IssuesTold);
            playback.IssuesTold = playback.IssueSequence;
        }
        foreach (var id in hls)
            media.TouchHls(id);
        return new PlaybackLink(playback.ResolvedReleaseId, playback.StreamToken, issues);
    }

    /// <summary>Remembers a failed answer on the playback's current HLS session (bounded; equal issues collapse to the latest).</summary>
    public void Report(string sessionId, HlsDeliveryIssue issue)
    {
        if (!_byHls.TryGetValue(sessionId, out var playback))
            return;
        lock (playback.Gate)
        {
            if (playback.Stopped || playback.CurrentHls != sessionId)
                return;
            playback.Issues.RemoveAll(i => issue.At - i.Issue.At > DeliveryIssueRetention || Same(i.Issue, issue));
            playback.Issues.Add((issue, ++playback.IssueSequence));
            if (playback.Issues.Count > MaxDeliveryIssues)
                playback.Issues.RemoveAt(0);
        }
    }

    /// <summary>Sets the playback's current HLS session and keeps the session → playback index for <see cref="Report"/>; call under the playback's gate.</summary>
    private void SetCurrentHls(Playback playback, string? sessionId)
    {
        if (playback.CurrentHls is { } previous)
            _byHls.TryRemove(new KeyValuePair<string, Playback>(previous, playback));
        playback.CurrentHls = sessionId;
        if (sessionId is not null)
            _byHls[sessionId] = playback;
    }

    internal int IndexedHlsSessions => _byHls.Count;

    private static bool Same(HlsDeliveryIssue a, HlsDeliveryIssue b)
        => a.Kind == b.Kind && a.RenditionId == b.RenditionId && a.SubtitleStreamIndex == b.SubtitleStreamIndex && a.Code == b.Code && a.Status == b.Status;

    /// <summary>Issues of the last 30 s recorded after sequence <paramref name="after"/>, oldest first; call under the playback's gate.</summary>
    private static List<PlaybackDeliveryIssueDto> DeliveryIssues(Playback playback, DateTimeOffset now, long after = 0)
    {
        playback.Issues.RemoveAll(i => now - i.Issue.At > DeliveryIssueRetention);
        return playback.Issues.Where(i => i.Sequence > after && now - i.Issue.At <= DeliveryIssueWindow).Select(e => e.Issue).Select(i => new PlaybackDeliveryIssueDto
        {
            Kind = i.Kind switch
            {
                HlsDeliveryKind.AudioRendition => "audioRendition",
                HlsDeliveryKind.SubtitleRendition => "subtitleRendition",
                _ => "segment",
            },
            RenditionId = i.RenditionId,
            SubtitleStreamIndex = i.SubtitleStreamIndex,
            Code = i.Code,
            Status = i.Status,
            At = i.At,
        }).ToList();
    }

    /// <summary>Stops idle playbacks and closes renditions replaced by a switch once their grace period is over.</summary>
    internal async Task SweepAsync()
    {
        var now = time.GetUtcNow();
        foreach (var playback in _playbacks.Values.ToList())
        {
            DateTimeOffset lastActivity;
            lock (playback.Gate)
                lastActivity = playback.LastActivity > HlsAccess(playback) ? playback.LastActivity : HlsAccess(playback);
            if (now - lastActivity > IdleTimeout)
            {
                logger.LogInformation("Viewer playback {PlaybackId} expired after {Idle} without activity", playback.Id, IdleTimeout);
                await EndAsync(playback, "idle");
                continue;
            }
            List<string> due;
            lock (playback.Gate)
            {
                due = playback.PreviousHls.Where(r => r.CloseAt is { } at && at <= now).Select(r => r.Id).ToList();
                playback.PreviousHls.RemoveAll(r => due.Contains(r.Id));
            }
            foreach (var id in due)
                await media.CloseHlsAsync(id, "replaced by a playback switch");
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(_timings.SweepInterval, stoppingToken);
                try
                {
                    await SweepAsync();
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    logger.LogWarning(e, "Viewer playback sweep failed");
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        foreach (var playback in _playbacks.Values.ToList())
            await EndAsync(playback, "server stopping");
    }

    private async Task EndAsync(Playback playback, string reason)
    {
        lock (_admission)
            Detach(playback);
        await CloseMediaAsync(playback, reason);
    }

    private void Detach(Playback playback)
    {
        _playbacks.TryRemove(new KeyValuePair<string, Playback>(playback.Id, playback));
        lock (playback.Gate)
        {
            playback.Stopped = true;
            playback.Cancellation.Cancel();
            if (playback.CurrentHls is { } current)
                _byHls.TryRemove(new KeyValuePair<string, Playback>(current, playback));
            Signal(playback);
        }
    }

    private async Task CloseMediaAsync(Playback playback, string reason)
    {
        List<string> renditions;
        lock (playback.Gate)
        {
            renditions = [.. playback.PreviousHls.Select(r => r.Id)];
            if (playback.CurrentHls is { } current)
                renditions.Add(current);
            playback.PreviousHls.Clear();
            SetCurrentHls(playback, null);
        }
        foreach (var id in renditions)
            await media.CloseHlsAsync(id, $"viewer playback ended ({reason})");
    }

    private void Launch(Playback playback, int revision, bool resolve, CancellationToken ct)
        => _ = Task.Run(() => RunAsync(playback, revision, resolve, ct), CancellationToken.None);

    private async Task RunAsync(Playback playback, int revision, bool resolve, CancellationToken ct)
    {
        try
        {
            if (resolve || !media.StreamAlive(playback.StreamToken!))
                await ResolveAsync(playback, revision, ct);
            await PlanAndStartAsync(playback, revision, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (PlaybackFailure failure)
        {
            Fail(playback, revision, failure);
        }
        catch (ViewerProblem problem)
        {
            Fail(playback, revision, new PlaybackFailure(problem.Code, problem.Message, problem.Parameters, ProblemActions(problem)));
        }
        catch (Exception e)
        {
            Fail(playback, revision, Map(e));
        }
    }

    private async Task<PlayContext> PlayContextAsync(Playback playback, CancellationToken ct)
    {
        DeviceCaps device;
        PlaybackPreferences preferences;
        lock (playback.Gate)
            (device, preferences) = (playback.Device, playback.Preferences);
        return new PlayContext(device, preferences, await media.ServerAsync(ct));
    }

    private async Task ResolveAsync(Playback playback, int revision, CancellationToken ct)
    {
        Update(playback, revision, p => p.State = States.Resolving);
        string releaseId;
        lock (playback.Gate)
            releaseId = playback.RequestedReleaseId ?? string.Empty;
        if (releaseId.Length == 0)
        {
            var recommended = await catalog.RecommendedAsync(playback.Viewer, playback.Work, await PlayContextAsync(playback, ct), ct)
                              ?? throw new PlaybackFailure("no_versions", "No version of this title is available right now.", null, [SuggestedActions.Retry]);
            releaseId = recommended.ReleaseId;
            Update(playback, revision, p => p.RequestedReleaseId = releaseId);
        }
        else if (releases.Get(releaseId, playback.Work.WorkId) is null)
        {
            try
            {
                await catalog.RecommendedAsync(playback.Viewer, playback.Work, null, ct);
            }
            catch (ViewerProblem e)
            {
                logger.LogDebug("Re-ranking {WorkId} for playback {PlaybackId} failed: {Code}", playback.Work.WorkId, playback.Id, e.Code);
            }
            if (releases.Get(releaseId, playback.Work.WorkId) is null)
            {
                throw new PlaybackFailure("release_not_found", "This version is not known for the title (any more).",
                    TrackSelector.Params(("releaseId", releaseId)), [SuggestedActions.OtherVersion]);
            }
        }

        var observer = new HopObserver(this, playback, revision, releaseId);
        var response = await ResolveQueuedAsync(playback, revision, new PlaybackResolveCall(releaseId, playback.Work.WorkId, playback.ViewerId, playback.Username, true), observer, ct);
        var repaired = false;
        while (response.Status == "dead")
        {
            if (!repaired && response.Repair is { } repair && !IsTerminal(repair.State))
            {
                repaired = true;
                response = await RepairAsync(playback, revision, response.ReleaseId, observer, ct);
                continue;
            }
            Update(playback, revision, p => p.Attempts = Attempts(response, p));
            throw new PlaybackFailure("release_dead",
                response.Repair is { } failed && IsTerminal(failed.State) && failed.State != "ready"
                    ? "This version is missing data on Usenet and could not be repaired."
                    : "This version is missing data on Usenet and no other version could stand in.",
                TrackSelector.Params(("releaseId", response.ReleaseId), ("attempts", response.Attempts.Count), ("suggestedReleaseId", response.SuggestedFallbackReleaseId)),
                [SuggestedActions.OtherVersion, SuggestedActions.Retry]);
        }

        var token = TokenOf(response.StreamUrl) ?? throw new PlaybackFailure("resolve_failed", "The resolve returned no stream.", null, [SuggestedActions.Retry]);
        var version = await catalog.VersionAsync(playback.Viewer, playback.Work, response.ReleaseId, ct);
        Update(playback, revision, p =>
        {
            p.StreamToken = token;
            p.ResolvedReleaseId = response.ReleaseId;
            p.Playability = response.Playability;
            p.ResolvedStatus = response.Status;
            p.Repair = response.Repair ?? p.Repair;
            p.Attempts = Attempts(response, p);
            p.FallbackFrom = response.FallbackFromReleaseId is { } from ? new PlaybackReleaseDto { ReleaseId = from, Name = NameOf(from, p.Work.WorkId) } : null;
            p.Version = version;
        });
    }

    private async Task<ResolveResponse> ResolveQueuedAsync(
        Playback playback, int revision, PlaybackResolveCall call, IResolveObserver observer, CancellationToken ct)
    {
        var started = time.GetUtcNow();
        while (true)
        {
            try
            {
                return await resolver.ResolveAsync(call, observer, ct);
            }
            catch (ResourceCapacityException) when (time.GetUtcNow() - started < _timings.CapacityWait)
            {
                Update(playback, revision, p => p.State = States.Queued);
                await Task.Delay(_timings.CapacityRetry, ct);
                Update(playback, revision, p => p.State = p.FallbackFrom is null ? States.Resolving : States.Fallback);
            }
        }
    }

    private async Task<ResolveResponse> RepairAsync(Playback playback, int revision, string releaseId, IResolveObserver observer, CancellationToken ct)
    {
        while (true)
        {
            var status = resolver.RepairStatus(releaseId)
                         ?? throw new PlaybackFailure("repair_failed", "The repair of this version stopped.", TrackSelector.Params(("releaseId", releaseId)),
                             [SuggestedActions.OtherVersion, SuggestedActions.Retry]);
            Update(playback, revision, p =>
            {
                p.State = States.Repairing;
                p.Repair = status;
            });
            if (status.State == "ready")
                return await ResolveQueuedAsync(playback, revision, new PlaybackResolveCall(releaseId, playback.Work.WorkId, playback.ViewerId, playback.Username, false), observer, ct);
            if (IsTerminal(status.State))
            {
                throw new PlaybackFailure("repair_failed", "This version could not be repaired.",
                    TrackSelector.Params(("releaseId", releaseId), ("state", status.State), ("reason", status.FailureReason)),
                    [SuggestedActions.OtherVersion, SuggestedActions.Retry]);
            }
            await Task.Delay(_timings.RepairPoll, ct);
        }
    }

    private async Task PlanAndStartAsync(Playback playback, int revision, CancellationToken ct)
    {
        Update(playback, revision, p => p.State = States.Planning);
        string token;
        DeviceCaps device;
        PlaybackPreferences preferences;
        int? audioIndex, subtitleIndex;
        long startTicks;
        bool allowTranscoding, audioFallback;
        IReadOnlySet<string> excluded;
        lock (playback.Gate)
        {
            token = playback.StreamToken!;
            device = playback.Device;
            preferences = playback.Preferences;
            audioIndex = playback.AudioIndex;
            audioFallback = playback.AudioFallback;
            subtitleIndex = playback.SubtitleIndex;
            startTicks = playback.StartTicks;
            allowTranscoding = playback.Viewer.AllowTranscoding;
            excluded = playback.Excluded.ToHashSet(StringComparer.Ordinal);
        }

        SourceMediaInfo? probe;
        try
        {
            probe = await media.ProbeAsync(token, ct);
        }
        catch (TranscodeException e) when (e.Code == "unknown_stream")
        {
            throw new PlaybackFailure("stream_expired", "The stream of this version expired; start the playback again.", null, [SuggestedActions.Retry]);
        }
        if (probe is null)
        {
            if (device.Vlc is not null && !excluded.Contains(PlaybackDecider.Key(DeliveryMode.Direct, EngineCaps.Vlc)))
            {
                var notes = new List<PlanReason> { PlanReason.Of("probe_failed", "The server could not read the file's streams; VLC plays the original file.") };
                MarkReady(playback, revision, new ReadyState(DeliveryMode.Direct, EngineCaps.Vlc, $"/api/v1/stream/{token}", null, null,
                    new PlaybackDecisionDto { Method = "direct", Engine = EngineCaps.Vlc, Reasons = notes.Select(Reason).ToList(), Skipped = [] }), null);
                return;
            }
            throw new PlaybackFailure("probe_failed", "The server could not read the streams of this version.", null,
                [SuggestedActions.Retry, SuggestedActions.OtherVersion]);
        }
        string? resolvedRelease;
        lock (playback.Gate)
            resolvedRelease = playback.ResolvedReleaseId;
        catalog.RecordContainer(resolvedRelease, probe.Container);

        var server = await media.ServerAsync(ct);
        var decision = PlaybackDecider.Decide(probe, device, preferences, allowTranscoding, server, audioIndex, subtitleIndex, excluded, audioFallback);
        if (decision.Failure is { } impossible)
        {
            Update(playback, revision, p =>
            {
                p.Media = probe;
                p.Decision = DecisionDto(null, decision, decision.Skipped, ResolveNotes(p));
            });
            throw impossible;
        }

        Update(playback, revision, p =>
        {
            p.Media = probe;
            p.State = States.Starting;
        });
        var skipped = decision.Skipped.ToList();
        TranscodeException? lastError = null;
        DeliveryMode? lastMethod = null;
        using var budget = new CancellationTokenSource(_timings.StartLimit);
        using var startToken = CancellationTokenSource.CreateLinkedTokenSource(budget.Token, ct);
        foreach (var candidate in decision.Viable)
        {
            if (budget.IsCancellationRequested)
            {
                (lastError, lastMethod) = (StartTimeout(), candidate.Method);
                break;
            }
            ct.ThrowIfCancellationRequested();
            if (candidate.Method == DeliveryMode.Direct)
            {
                var ready = Ready(playback, candidate, candidate.Plan, probe, $"/api/v1/stream/{token}", decision, skipped);
                MarkReady(playback, revision, ready, null);
                return;
            }
            HlsRendition rendition;
            try
            {
                rendition = await media.StartHlsAsync(token, candidate.Client, candidate.Limits, Label(playback), startTicks / (double)TimeSpan.TicksPerSecond,
                    candidate.Method == DeliveryMode.Remux ? ModePreference.Remux : ModePreference.Transcode, startToken.Token);
            }
            catch (OperationCanceledException) when (budget.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                logger.LogWarning("Playback {PlaybackId}: {Method} on {Engine} did not start within {Budget}",
                    playback.Id, candidate.Method.ToApi(), candidate.Engine.Name, _timings.StartLimit);
                var timeout = StartTimeout();
                skipped.Add(new SkippedCandidate(candidate.Method, candidate.Engine.Name, [PlanReason.Of(timeout.Code, timeout.Message)]));
                (lastError, lastMethod) = (timeout, candidate.Method);
                break;
            }
            catch (TranscodeException e)
            {
                logger.LogInformation("Playback {PlaybackId}: {Method} on {Engine} could not start ({Code}); trying the next method",
                    playback.Id, candidate.Method.ToApi(), candidate.Engine.Name, e.Code);
                skipped.Add(new SkippedCandidate(candidate.Method, candidate.Engine.Name, [PlanReason.Of(e.Code, e.Message)]));
                (lastError, lastMethod) = (e, candidate.Method);
                continue;
            }
            var hlsReady = Ready(playback, candidate, rendition.Plan, rendition.Media, $"/api/v1/transcode/{rendition.Id}/master.m3u8", decision, skipped);
            if (!MarkReady(playback, revision, hlsReady, rendition.Id))
                await media.CloseHlsAsync(rendition.Id, "playback switched or stopped while starting");
            return;
        }

        var (code, parameters) = lastError is null ? ("playback_failed", null) : StartError(lastError, lastMethod);
        var suggestions = new List<string> { SuggestedActions.Retry };
        if (code is "segment_timeout" or "transcode_failed" or "start_timeout")
            suggestions.Add(SuggestedActions.LowerQuality);
        if (device.Vlc is not null && preferences.Engine != EnginePreference.Vlc && !excluded.Contains(PlaybackDecider.Key(DeliveryMode.Direct, EngineCaps.Vlc)))
            suggestions.Add(SuggestedActions.UseVlc);
        suggestions.Add(SuggestedActions.OtherVersion);
        Update(playback, revision, p => p.Decision = DecisionDto(null, decision, skipped, ResolveNotes(p)));
        throw new PlaybackFailure(code, lastError?.Message ?? "The playback could not be started.", parameters, suggestions);
    }

    private ReadyState Ready(
        Playback playback, PlaybackCandidate candidate, TranscodePlan plan, SourceMediaInfo source, string url, PlaybackDecision decision, IReadOnlyList<SkippedCandidate> skipped)
    {
        List<PlanReason> resolveNotes;
        lock (playback.Gate)
            resolveNotes = ResolveNotes(playback);
        var dto = DecisionDto(candidate with { Plan = plan }, decision, skipped, resolveNotes);
        return new ReadyState(candidate.Method, candidate.Engine.Name, url, MediaInfo(source, plan, candidate), plan, dto);
    }

    private bool MarkReady(Playback playback, int revision, ReadyState ready, string? rendition)
    {
        var now = time.GetUtcNow();
        return Update(playback, revision, p =>
        {
            p.Ready = ready;
            p.PlayingKey = PlaybackDecider.Key(ready.Method, ready.Engine);
            p.Decision = ready.Decision;
            p.State = States.Ready;
            p.ReadyAt = now;
            SetCurrentHls(p, rendition);
            for (var i = 0; i < p.PreviousHls.Count; i++)
                p.PreviousHls[i] = p.PreviousHls[i] with { CloseAt = p.PreviousHls[i].CloseAt ?? now + _timings.SwitchGrace };
            logger.LogInformation("Viewer playback {PlaybackId} ready: {Method} on {Engine}", p.Id, ready.Method.ToApi(), ready.Engine);
        });
    }

    private void Fail(Playback playback, int revision, PlaybackFailure failure)
    {
        if (Update(playback, revision, p =>
            {
                p.Failure = failure;
                p.State = States.Failed;
            }))
        {
            logger.LogInformation("Viewer playback {PlaybackId} failed: {Code}", playback.Id, failure.Code);
        }
    }

    /// <summary>Applies a change when the revision is still current; false once switched or stopped.</summary>
    private bool Update(Playback playback, int revision, Action<Playback> change)
    {
        lock (playback.Gate)
        {
            if (playback.Stopped || playback.Revision != revision)
                return false;
            change(playback);
            playback.UpdatedAt = time.GetUtcNow();
            Signal(playback);
            return true;
        }
    }

    /// <summary>Wakes long-polls waiting for this playback; call under its gate.</summary>
    private static void Signal(Playback p)
    {
        var waiting = p.Changed;
        p.Changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        waiting.TrySetResult();
    }

    private PlaybackResponse Snapshot(Playback p, bool touch)
    {
        lock (p.Gate)
        {
            if (touch)
                p.LastActivity = time.GetUtcNow();
            var ready = p.State == States.Ready ? p.Ready : null;
            var failed = p.State == States.Failed ? p.Failure : null;
            return new PlaybackResponse
            {
                PlaybackId = p.Id,
                Revision = p.Revision,
                State = p.State,
                WorkId = p.Work.WorkId,
                CreatedAt = p.CreatedAt,
                UpdatedAt = p.UpdatedAt,
                PollAfterMs = p.State switch
                {
                    States.Ready or States.Failed => 0,
                    States.Repairing => (p.Repair?.RetryAfterSeconds ?? 2) * 1000,
                    _ => 500,
                },
                Attempts = p.Attempts.ToList(),
                FallbackFrom = p.FallbackFrom,
                Version = p.Version,
                Repair = p.Repair,
                StartPositionTicks = p.StartTicks,
                ResumePositionTicks = p.ResumeTicks,
                Method = ready?.Method.ToApi(),
                Engine = ready?.Engine,
                Url = ready?.Url,
                StreamToken = ready is null ? null : p.StreamToken,
                MediaInfo = ready?.MediaInfo,
                InSessionAudioSwitch = ready?.Plan is { DemuxedAudio: true } && ready.Method != DeliveryMode.Direct,
                AudioRenditions = ready is null ? null : ready.Method == DeliveryMode.Direct || ready.Plan is null ? [] : AudioRenditions(ready.Plan),
                Decision = p.State is States.Ready or States.Failed ? p.Decision : null,
                Error = failed is null ? null : new PlaybackErrorDto { Code = failed.Code, Message = failed.Message, Params = failed.Parameters },
                SuggestedActions = failed?.SuggestedActions,
                AudioFallback = p.AudioFallback,
                DeliveryIssues = DeliveryIssues(p, time.GetUtcNow()),
            };
        }
    }

    private Playback? Find(ViewerCaller caller, string playbackId)
        => playbackId.Length <= 64 && _playbacks.TryGetValue(playbackId, out var playback)
           && playback.ViewerId == caller.ViewerId && playback.SessionId == caller.SessionId && !playback.Stopped
            ? playback
            : null;

    private bool IsActive(Playback p, DateTimeOffset now)
    {
        lock (p.Gate)
        {
            if (p.Stopped || (p.State == States.Failed && p.PlayingKey is null))
                return false;
            return PreparingStates.Contains(p.State) || now - LastActive(p) <= HeartbeatWindow;
        }
    }

    /// <summary>Ready, heartbeat, switch or the player fetching the playback's HLS rendition, whichever is latest.</summary>
    private DateTimeOffset LastActive(Playback p)
        => new[] { p.CreatedAt, p.ReadyAt ?? default, p.LastHeartbeat ?? default, p.LastSwitchAt ?? default, HlsAccess(p) }.Max();

    private DateTimeOffset HlsAccess(Playback p)
        => OpenRenditions(p).Select(media.HlsLastAccess).OfType<DateTimeOffset>().DefaultIfEmpty().Max();

    /// <summary>The current rendition plus a replaced one the device may still play (a switch that has not become ready); call under the gate.</summary>
    private static IEnumerable<string> OpenRenditions(Playback p)
        => p.PreviousHls.Where(r => r.CloseAt is null).Select(r => r.Id).Append(p.CurrentHls).OfType<string>();

    private async Task EnsureAllowedAsync(ViewerEntity viewer, WorkKey work, CancellationToken ct)
    {
        var access = await policy.EvaluateAsync(viewer, work, ct);
        if (!access.Allowed)
            throw ViewerContentPolicy.AgeRestricted(access);
    }

    private List<PlaybackAttemptDto> Attempts(ResolveResponse response, Playback p)
        => response.Attempts.Count == 0
            ? p.Attempts
            : response.Attempts.Select(a => new PlaybackAttemptDto { ReleaseId = a.ReleaseId, Name = NameOf(a.ReleaseId, p.Work.WorkId), Status = a.Status }).ToList();

    private string? NameOf(string releaseId, string workId) => releases.Get(releaseId, workId)?.Release.Title;

    private static List<PlanReason> ResolveNotes(Playback p)
    {
        var notes = new List<PlanReason>();
        if (p.FallbackFrom is { } from)
            notes.Add(PlanReason.Of("fallback_used", "The requested version is missing data; the next best version plays instead.", ("from", from.ReleaseId)));
        if (p.Playability == "repairedReady")
            notes.Add(PlanReason.Of("repaired_copy", "A locally repaired copy of this version plays."));
        else if (p.Playability == "progressive")
            notes.Add(PlanReason.Of("repair_progressive", "This version is being repaired while it plays."));
        else if (p.ResolvedStatus == "degraded")
            notes.Add(PlanReason.Of("release_degraded", "Some data of this version could not be checked; playback may stall."));
        return notes;
    }

    private static PlaybackDecisionDto DecisionDto(PlaybackCandidate? chosen, PlaybackDecision decision, IReadOnlyList<SkippedCandidate> skipped, IReadOnlyList<PlanReason> resolveNotes)
    {
        var reasons = new List<PlanReason>(resolveNotes);
        reasons.AddRange(decision.Notes);
        if (chosen is not null)
        {
            reasons.AddRange(chosen.Notes);
            reasons.AddRange(chosen.Plan.Reasons.Where(r => r.Code != "transcode_requested"));
        }
        else if (decision.Failure is { } failure)
        {
            reasons.Add(new PlanReason(failure.Code, failure.Message, failure.Parameters));
        }
        return new PlaybackDecisionDto
        {
            Method = chosen?.Method.ToApi(),
            Engine = chosen?.Engine.Name,
            Reasons = reasons.Select(Reason).ToList(),
            Skipped = skipped.Select(s => new PlaybackSkippedDto { Method = s.Method.ToApi(), Engine = s.Engine, Reasons = s.Reasons.Select(Reason).ToList() }).ToList(),
        };
    }

    private static PlanReasonResponse Reason(PlanReason r) => new(r.Code, r.Message, r.Params);

    private static List<PlaybackAudioRenditionDto> AudioRenditions(TranscodePlan plan)
        => plan.AudioRenditions.Select(r => new PlaybackAudioRenditionDto
        {
            Id = r.Id,
            StreamIndex = r.Target.SourceIndex,
            Language = r.Language,
            Label = r.Name,
            Channels = r.Target.Channels,
            Codec = r.Target.Codec,
            Default = r.IsDefault,
        }).ToList();

    private static PlaybackMediaInfoDto MediaInfo(SourceMediaInfo source, TranscodePlan plan, PlaybackCandidate candidate)
    {
        var direct = candidate.Method == DeliveryMode.Direct;
        var subtitlePlans = plan.Subtitles.ToDictionary(s => s.Stream.Index);
        return new PlaybackMediaInfoDto
        {
            Container = TranscodePlanner.ContainerFamily(source.Container),
            DurationTicks = (long)(source.DurationSeconds * TimeSpan.TicksPerSecond),
            BitrateKbps = source.BitRate is { } bps ? (int)(bps / 1000) : null,
            Video = source.Video is not { } video ? null : new PlaybackVideoDto
            {
                Index = video.Index,
                Codec = video.Codec,
                Profile = video.Profile,
                BitDepth = video.BitDepth,
                Width = video.Width,
                Height = video.Height,
                Fps = video.FrameRate is { } fps ? Math.Round(fps, 3) : null,
                Hdr = video.Hdr.ToApi(),
                DolbyVisionProfile = video.DolbyVisionProfile,
                Interlaced = video.Interlaced,
                VideoRange = candidate.Method == DeliveryMode.Transcode ? "SDR" : plan.VideoRange,
                DeliveredCodec = plan.Video.Codec,
                DeliveredHeight = plan.Video.Height,
            },
            AudioTracks = source.Audio.Select(a =>
            {
                var rendition = direct ? null : plan.AudioRenditions.FirstOrDefault(r => r.Target.SourceIndex == a.Index);
                var delivered = direct ? null : rendition?.Target ?? (plan.Audio is { } target && target.SourceIndex == a.Index ? target : null);
                return new PlaybackAudioTrackDto
                {
                    Index = a.Index,
                    Codec = a.Codec,
                    Channels = a.Channels,
                    Language = TrackSelector.Lang(a.Language),
                    Title = a.Title,
                    Default = a.IsDefault,
                    Selected = a.Index == candidate.Limits.AudioStreamIndex,
                    DeliveredAs = direct ? "original" : delivered is null ? "none" : delivered.Copy ? "copy" : "converted",
                    DeliveredCodec = direct ? a.Codec : delivered?.Codec,
                    DeliveredChannels = direct ? a.Channels : delivered?.Channels,
                    RenditionId = rendition?.Id,
                };
            }).ToList(),
            SubtitleTracks = source.Subtitles.Select(s =>
            {
                var deliveredAs = direct
                    ? candidate.Engine.SubtitleFormats is null || candidate.Engine.RendersSubtitle(s.Codec) ? SubtitlePlan.Embedded : SubtitlePlan.None
                    : subtitlePlans.GetValueOrDefault(s.Index)?.DeliveredAs ?? SubtitlePlan.None;
                return new PlaybackSubtitleTrackDto
                {
                    Index = s.Index,
                    Codec = s.Codec,
                    Language = TrackSelector.Lang(s.Language),
                    Title = s.Title,
                    Forced = s.IsForced,
                    Default = s.IsDefault,
                    TextBased = s.TextBased,
                    Selected = s.Index == candidate.Limits.SubtitleStreamIndex && deliveredAs != SubtitlePlan.None,
                    DeliveredAs = deliveredAs,
                };
            }).ToList(),
        };
    }

    /// <summary>What can still help after a catalog problem: a missing or age-restricted title has no other version to pick.</summary>
    internal static IReadOnlyList<string> ProblemActions(ViewerProblem problem) => problem.Status switch
    {
        StatusCodes.Status429TooManyRequests or StatusCodes.Status503ServiceUnavailable => [SuggestedActions.Retry],
        StatusCodes.Status404NotFound or StatusCodes.Status403Forbidden => [],
        _ => [SuggestedActions.OtherVersion],
    };

    private static PlaybackFailure Map(Exception e) => e switch
    {
        ReleaseNotFoundException => new PlaybackFailure("release_not_found", "This version is not known to the server (any more).", null, [SuggestedActions.OtherVersion]),
        NoPlayableFileException => new PlaybackFailure("no_playable_file", "This version contains no playable video file.", null, [SuggestedActions.OtherVersion]),
        NzbOriginNotAllowedException => new PlaybackFailure("nzb_host_not_allowed", "This version's download host is not allowed.", null, [SuggestedActions.OtherVersion]),
        InvalidDataException => new PlaybackFailure("invalid_release", "This version could not be read.", null, [SuggestedActions.OtherVersion]),
        ResourceCapacityException => new PlaybackFailure("capacity_reached", "The server is busy with other streams; try again shortly.", null, [SuggestedActions.Retry]),
        NzbUnexpectedContentException or HttpRequestException or IOException => new PlaybackFailure("nzb_fetch_failed",
            "The version could not be fetched from its indexer.", null, [SuggestedActions.Retry, SuggestedActions.OtherVersion]),
        UsenetException => new PlaybackFailure("usenet_unreachable", "The Usenet provider could not be reached.", null, [SuggestedActions.Retry]),
        TranscodeException t when StartError(t, null) is var (code, parameters)
            => new PlaybackFailure(code, t.Message, parameters, [SuggestedActions.Retry, SuggestedActions.OtherVersion]),
        _ => new PlaybackFailure("playback_failed", "The playback could not be prepared.", null, [SuggestedActions.Retry, SuggestedActions.OtherVersion]),
    };

    /// <summary>The error of a start that ran out of the per-revision start budget.</summary>
    private TranscodeException StartTimeout()
        => new("start_timeout", $"The stream did not start within {_timings.StartLimit.TotalSeconds:0} s.", 504);

    /// <summary>Maps a remux/transcode start error onto the documented failed-playback codes; a mapped code keeps the original in <c>params.reason</c>.</summary>
    internal static (string Code, IReadOnlyDictionary<string, string>? Parameters) StartError(TranscodeException e, DeliveryMode? method)
    {
        var reason = TrackSelector.Params(("reason", e.Code));
        return e.Code switch
        {
            "segment_timeout" or "transcode_failed" or "transcode_capacity" or "remux_capacity" or "probe_failed" or "start_timeout" => (e.Code, null),
            "too_many_sessions" or "insufficient_disk" => (method == DeliveryMode.Remux ? "remux_capacity" : "transcode_capacity", reason),
            "init_unavailable" or "segment_unavailable" or "end_of_stream" => ("transcode_failed", reason),
            "transcoding_disabled" or "ffmpeg_unavailable" or "no_local_listener" => ("transcoding_unavailable", reason),
            "unknown_stream" => ("stream_expired", null),
            _ => ("playback_failed", reason),
        };
    }

    private static bool IsTerminal(string state) => state is "ready" or "failed" or "cancelled" or "evicted";

    private static string? TokenOf(string? streamUrl)
        => streamUrl is { Length: > 0 } url ? Uri.UnescapeDataString(url[(url.LastIndexOf('/') + 1)..]) : null;

    private static string Label(Playback p)
    {
        var label = $"viewer:{p.Username}@{p.DeviceName}";
        return label.Length <= 64 ? label : label[..64];
    }

    private static string? ReleaseId(string? value)
    {
        if (value is null)
            return null;
        var trimmed = value.Trim();
        return trimmed.Length is > 0 and <= 256 && !trimmed.Any(char.IsControl)
            ? trimmed
            : throw Invalid("'releaseId' must be a release id from the versions list.");
    }

    private static long? Position(long? ticks, string field)
        => ticks is < 0 or > 10L * 24 * 3600 * TimeSpan.TicksPerSecond ? throw Invalid($"'{field}' must be between 0 and 10 days.") : ticks;

    private static void ValidateIndexes(int? audio, int? subtitle)
    {
        if (audio is < 0 or > 1_000)
            throw Invalid("'audioStreamIndex' must be a source stream index.");
        if (subtitle is < -1 or > 1_000)
            throw Invalid("'subtitleStreamIndex' must be a source stream index or -1.");
    }

    /// <summary>A switch to a track the playing version does not have is rejected up front, so the playback keeps playing and no bad index sticks.</summary>
    private static void ValidateTracks(SourceMediaInfo media, int? audio, int? subtitle)
    {
        if (audio is { } a && media.Audio.All(s => s.Index != a))
            throw new ViewerProblem(StatusCodes.Status400BadRequest, "unknown_audio_stream", $"Audio stream {a} does not exist in this version.", TrackSelector.Params(("index", a)));
        if (subtitle is { } t and >= 0 && media.Subtitles.All(s => s.Index != t))
            throw new ViewerProblem(StatusCodes.Status400BadRequest, "unknown_subtitle_stream", $"Subtitle stream {t} does not exist in this version.", TrackSelector.Params(("index", t)));
    }

    private static ViewerProblem Invalid(string message) => ViewerProblem.BadRequest("invalid_playback_request", message);

    private static ViewerProblem NotFound() => ViewerProblem.NotFound("playback_not_found", "No playback with this id exists for this device (stopped or expired).");

    private sealed class HopObserver(ViewerPlaybackService owner, Playback playback, int revision, string requested) : IResolveObserver
    {
        public void HopStarted(string releaseId, int hop)
            => owner.Update(playback, revision, p =>
            {
                if (hop == 0)
                    p.Attempts.RemoveAll(a => a.ReleaseId == releaseId && a.Status == "resolving");
                p.Attempts.Add(new PlaybackAttemptDto { ReleaseId = releaseId, Name = owner.NameOf(releaseId, p.Work.WorkId), Status = "resolving" });
                if (hop > 0)
                {
                    p.State = States.Fallback;
                    p.FallbackFrom ??= new PlaybackReleaseDto { ReleaseId = requested, Name = owner.NameOf(requested, p.Work.WorkId) };
                }
            });

        public void HopFinished(string releaseId, string status)
            => owner.Update(playback, revision, p =>
            {
                var index = p.Attempts.FindLastIndex(a => a.ReleaseId == releaseId);
                if (index >= 0)
                    p.Attempts[index] = p.Attempts[index] with { Status = status };
            });
    }

    private sealed record PreviousRendition(string Id, DateTimeOffset? CloseAt);

    private sealed record ReadyState(DeliveryMode Method, string Engine, string Url, PlaybackMediaInfoDto? MediaInfo, TranscodePlan? Plan, PlaybackDecisionDto Decision);

    private sealed class Playback
    {
        public readonly object Gate = new();
        public required string Id { get; init; }
        public required string ViewerId { get; init; }
        public required string SessionId { get; init; }
        public required string Username { get; init; }
        public required string DeviceName { get; init; }
        public required WorkKey Work { get; init; }
        public required DateTimeOffset CreatedAt { get; init; }
        public required ViewerEntity Viewer { get; set; }
        public string? RequestedReleaseId { get; set; }
        public required DeviceCaps Device { get; init; }
        public required PlaybackPreferences Preferences { get; set; }
        public int? AudioIndex { get; set; }
        public bool AudioFallback { get; set; }
        public int? SubtitleIndex { get; set; }
        public long StartTicks { get; set; }
        public long? ResumeTicks { get; init; }
        public long? PositionTicks { get; set; }
        public HashSet<string> Excluded { get; } = new(StringComparer.Ordinal);
        public int Revision { get; set; }
        public required string State { get; set; }
        public DateTimeOffset UpdatedAt { get; set; }
        public List<PlaybackAttemptDto> Attempts { get; set; } = [];
        public PlaybackReleaseDto? FallbackFrom { get; set; }
        public VersionDto? Version { get; set; }
        public RepairStatusInfo? Repair { get; set; }
        public string? StreamToken { get; set; }
        public string? ResolvedReleaseId { get; set; }
        public string? ResolvedStatus { get; set; }
        public string? Playability { get; set; }
        public ReadyState? Ready { get; set; }
        public PlaybackDecisionDto? Decision { get; set; }
        public PlaybackFailure? Failure { get; set; }
        public string? CurrentHls { get; set; }
        public List<PreviousRendition> PreviousHls { get; } = [];
        public DateTimeOffset LastActivity { get; set; }
        public DateTimeOffset? LastHeartbeat { get; set; }
        public DateTimeOffset? ReadyAt { get; set; }
        public DateTimeOffset? LastSwitchAt { get; set; }
        public CancellationTokenSource Cancellation { get; set; } = new();
        public bool Stopped { get; set; }
        public TaskCompletionSource Changed { get; set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public SourceMediaInfo? Media { get; set; }
        public List<(HlsDeliveryIssue Issue, long Sequence)> Issues { get; } = [];
        public long IssueSequence { get; set; }
        public long IssuesTold { get; set; }

        /// <summary>Method and engine of the last ready state: what the device plays until a switch becomes ready.</summary>
        public string? PlayingKey { get; set; }
    }
}
