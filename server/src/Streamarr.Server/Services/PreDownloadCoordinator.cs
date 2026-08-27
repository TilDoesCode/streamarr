using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Threading.Channels;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services;

/// <summary>Turns trusted watch progress into deduplicated, low-priority ephemeral downloads.</summary>
public sealed class PreDownloadCoordinator(
    PreDownloadConfigService config,
    SessionManager sessions,
    NextEpisodeResolver nextEpisodes,
    ResolveService resolve,
    PreDownloadNntpClient lowPriorityClient,
    PreDownloadWorkspace workspace,
    IServer server,
    TimeProvider time,
    ILogger<PreDownloadCoordinator> logger) : BackgroundService
{
    private const int ObservationCapacity = 512;
    private const int MaximumRetainedJobs = 256;
    private static readonly TimeSpan FinishedJobLifetime = TimeSpan.FromHours(1);
    private readonly Channel<WatchEventWrite> _observations = Channel.CreateBounded<WatchEventWrite>(
        new BoundedChannelOptions(ObservationCapacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
    private readonly ConcurrentDictionary<string, PreDownloadJob> _jobs = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _triggerKeys = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task> _activeTasks = new(StringComparer.Ordinal);
    private readonly Queue<PendingJob> _pending = new();
    private readonly object _schedulerGate = new();
    private readonly object _playbackGate = new();
    private readonly Dictionary<PlaybackScope, PlaybackScopeState> _playbackSelections = [];
    private int _running;

    public bool Enqueue(WatchEventWrite observation)
    {
        ObservePlaybackLifecycle(observation, time.GetUtcNow());
        return _observations.Writer.TryWrite(observation);
    }

    public IReadOnlyList<PreDownloadJobResponse> List(string? sessionToken = null)
        => _jobs.Values
            .Select(job => job.Snapshot())
            .Where(job => string.IsNullOrWhiteSpace(sessionToken)
                          || string.Equals(job.SourceToken, sessionToken, StringComparison.Ordinal)
                          || string.Equals(job.TargetToken, sessionToken, StringComparison.Ordinal))
            .OrderByDescending(job => job.QueuedAt)
            .ToArray();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        workspace.CleanStaleFiles();
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                while (_observations.Reader.TryRead(out var observation))
                    ObservePreDownload(observation);
                Dispatch(stoppingToken);
                Prune();
                await Task.Delay(250, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            _observations.Writer.TryComplete();
            var active = _activeTasks.Values.ToArray();
            if (active.Length > 0)
            {
                try
                {
                    await Task.WhenAll(active).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                }
            }
        }
    }

    internal void Observe(WatchEventWrite observation)
    {
        Observe(observation, time.GetUtcNow());
    }

    internal void Observe(WatchEventWrite observation, DateTimeOffset observedAt)
    {
        ObservePlaybackLifecycle(observation, observedAt);
        ObservePreDownload(observation);
    }

    private void ObservePreDownload(WatchEventWrite observation)
    {
        var policy = config.Current;
        if (!policy.Enabled
            || !string.Equals(observation.Event, "progress", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var source = sessions.FindForPlaybackEvent(
            observation.SessionToken,
            observation.ReleaseId,
            observation.WorkId,
            observation.Source,
            observation.ExternalUserId);
        if (source is null)
            return;

        var playbackState = PlaybackState(source, observation.PlaybackSessionId);
        if (playbackState == PlaybackGraceState.Stale)
            return;

        var position = Math.Max(0, observation.PositionTicks ?? 0);
        var duration = observation.DurationTicks is > 0
            ? observation.DurationTicks.Value
            : source.RunTimeTicks;
        var watchPercent = duration > 0
            ? Math.Min(100, position * 100d / duration)
            : (double?)null;

        var currentFileGraceReached = playbackState switch
        {
            PlaybackGraceState.Reached => true,
            PlaybackGraceState.Pending => false,
            _ => position >= policy.CurrentFileThresholdSeconds * TimeSpan.TicksPerSecond,
        };
        if (policy.DownloadCurrentFile && currentFileGraceReached)
        {
            Queue(
                $"current:{source.Token}",
                "currentFile",
                $"Playback passed {policy.CurrentFileThresholdSeconds} seconds",
                source,
                observation,
                duration,
                watchPercent,
                policy.CurrentFileThresholdSeconds,
                "seconds",
                policy.PreferSimilarNextEpisodeRelease,
                policy.NextEpisodeReleaseSimilarityThresholdPercent);
        }

        if (policy.DownloadNextEpisode
            && NextEpisodeResolver.IsCanonicalEpisodeWorkId(source.Session.WorkId)
            && watchPercent is { } percent
            && percent >= policy.NextEpisodeThresholdPercent)
        {
            Queue(
                $"next:{source.Token}",
                "nextEpisode",
                $"Watch progress reached {policy.NextEpisodeThresholdPercent}%",
                source,
                observation,
                duration,
                watchPercent,
                policy.NextEpisodeThresholdPercent,
                "percent",
                policy.PreferSimilarNextEpisodeRelease,
                policy.NextEpisodeReleaseSimilarityThresholdPercent);
        }
    }

    private void ObservePlaybackLifecycle(
        WatchEventWrite observation,
        DateTimeOffset observedAt)
    {
        var eventKind = observation.Event?.ToLowerInvariant();
        if (eventKind is not ("start" or "progress" or "stop"))
            return;
        if (!TryResolveTrustedPlayback(observation, out var source))
            return;

        var requesterId = source.Session.RequestedById!;
        var client = source.Session.Client!;
        CanonicalTmdbWorkId.TryNormalize(source.Session.WorkId, out var canonicalWorkId);
        var scope = new PlaybackScope(canonicalWorkId, client, requesterId);
        var identity = new PlaybackIdentity(source.Token, observation.PlaybackSessionId);
        var position = Math.Max(0, observation.PositionTicks ?? 0);
        lock (_playbackGate)
        {
            if (!_playbackSelections.TryGetValue(scope, out var playback))
            {
                playback = new PlaybackScopeState();
                _playbackSelections[scope] = playback;
            }

            if (eventKind == "start")
            {
                playback.Select(
                    source.Token,
                    observation.PlaybackSessionId,
                    position,
                    observedAt,
                    explicitStart: true);
                return;
            }

            if (eventKind == "stop")
            {
                playback.Stop(identity);
                return;
            }

            var selection = playback.Current;
            if (selection is null || !selection.Matches(identity))
            {
                if (playback.IsRetired(identity))
                    return;
                selection = playback.Select(
                    source.Token,
                    observation.PlaybackSessionId,
                    position,
                    observedAt,
                    explicitStart: false);
                return;
            }

            selection.Observe(position, observedAt);

            var graceSeconds = config.Current.CurrentFileThresholdSeconds;
            var graceTicks = graceSeconds * TimeSpan.TicksPerSecond;
            if (selection.WatchedTicks < graceTicks)
                return;

            var removed = sessions.SupersedeOtherReleases(source, graceSeconds);
            CancelSupersededJobs(removed, source.Session.ReleaseId, graceSeconds);
        }
    }

    private bool TryResolveTrustedPlayback(WatchEventWrite observation, out ActiveSession source)
    {
        source = null!;
        if (string.IsNullOrWhiteSpace(observation.SessionToken)
            || string.IsNullOrWhiteSpace(observation.WorkId)
            || string.IsNullOrWhiteSpace(observation.ExternalUserId)
            || string.IsNullOrWhiteSpace(observation.Source)
            || !CanonicalTmdbWorkId.TryNormalize(observation.WorkId, out var eventWorkId)
            || !sessions.TryGetSession(observation.SessionToken, out var exact)
            || !CanonicalTmdbWorkId.TryNormalize(exact.Session.WorkId, out var sessionWorkId)
            || !string.Equals(exact.Session.ReleaseId, observation.ReleaseId, StringComparison.Ordinal)
            || !string.Equals(sessionWorkId, eventWorkId, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(exact.Session.Client)
            || !string.Equals(exact.Session.Client, observation.Source, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(exact.Session.RequestedById)
            || !string.Equals(
                exact.Session.RequestedById,
                observation.ExternalUserId,
                StringComparison.Ordinal))
        {
            return false;
        }

        source = exact;
        return true;
    }

    private PlaybackGraceState PlaybackState(ActiveSession source, string? playbackSessionId)
    {
        var requesterId = source.Session.RequestedById;
        if (string.IsNullOrWhiteSpace(requesterId)
            || string.IsNullOrWhiteSpace(source.Session.Client)
            || !CanonicalTmdbWorkId.TryNormalize(source.Session.WorkId, out var canonicalWorkId))
        {
            return PlaybackGraceState.Unknown;
        }

        lock (_playbackGate)
        {
            if (!_playbackSelections.TryGetValue(
                    new PlaybackScope(canonicalWorkId, source.Session.Client, requesterId),
                    out var playback)
                || playback.Current is not { } selection)
            {
                return PlaybackGraceState.Unknown;
            }
            if (!selection.Matches(new PlaybackIdentity(source.Token, playbackSessionId)))
                return PlaybackGraceState.Stale;
            var graceTicks = config.Current.CurrentFileThresholdSeconds * TimeSpan.TicksPerSecond;
            return selection.WatchedTicks >= graceTicks
                ? PlaybackGraceState.Reached
                : PlaybackGraceState.Pending;
        }
    }

    private void CancelSupersededJobs(
        IReadOnlyList<SupersededSession> removed,
        string replacementReleaseId,
        int graceSeconds)
    {
        if (removed.Count == 0)
            return;
        var removedTokens = removed.Select(item => item.Token).ToHashSet(StringComparer.Ordinal);
        var now = time.GetUtcNow();
        foreach (var job in _jobs.Values)
        {
            var snapshot = job.Snapshot();
            if ((snapshot.TargetToken is { } targetToken && removedTokens.Contains(targetToken))
                || (snapshot.Kind == "currentFile" && removedTokens.Contains(snapshot.SourceToken)))
            {
                job.CancelForReleaseSwitch(replacementReleaseId, graceSeconds, now);
            }
        }
    }

    private void Queue(
        string triggerKey,
        string kind,
        string reason,
        ActiveSession source,
        WatchEventWrite observation,
        long duration,
        double? watchPercent,
        double threshold,
        string triggerUnit,
        bool preferSimilarNextEpisodeRelease,
        int nextEpisodeReleaseSimilarityThresholdPercent)
    {
        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
        if (!_triggerKeys.TryAdd(triggerKey, id))
            return;

        var job = new PreDownloadJob(
            id,
            kind,
            reason,
            source,
            Math.Max(0, observation.PositionTicks ?? 0),
            Math.Max(0, duration),
            watchPercent,
            threshold,
            triggerUnit,
            time.GetUtcNow());
        if (!_jobs.TryAdd(id, job))
        {
            _triggerKeys.TryRemove(triggerKey, out _);
            return;
        }

        lock (_schedulerGate)
            _pending.Enqueue(new PendingJob(
                job,
                triggerKey,
                kind,
                observation,
                preferSimilarNextEpisodeRelease,
                nextEpisodeReleaseSimilarityThresholdPercent));
    }

    private void Dispatch(CancellationToken stoppingToken)
    {
        List<PendingJob> ready = [];
        lock (_schedulerGate)
        {
            var limit = Math.Clamp(
                config.Current.MaxConcurrentDownloads,
                1,
                Options.PreDownloadOptions.MaximumConcurrentDownloads);
            while (_running < limit && _pending.TryDequeue(out var pending))
            {
                _running++;
                ready.Add(pending);
            }
        }

        foreach (var pending in ready)
        {
            var task = Task.Run(() => RunJobAsync(pending, stoppingToken), CancellationToken.None);
            _activeTasks[pending.Job.Id] = task;
            _ = task.ContinueWith(
                _ => OnJobFinished(pending.Job.Id),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }

    private async Task RunJobAsync(PendingJob pending, CancellationToken stoppingToken)
    {
        var job = pending.Job;
        if (!job.TryStart(time.GetUtcNow()))
            return;
        try
        {
            if (!sessions.TryGetSession(job.SourceToken, out var source))
            {
                job.End("skipped", "source_expired", "The source session is no longer retained.", time.GetUtcNow());
                return;
            }

            if (pending.Kind == "currentFile")
            {
                job.SetTarget(source, source.Title, null, null, time.GetUtcNow());
                await DownloadAsync(job, source, stoppingToken).ConfigureAwait(false);
                return;
            }

            var target = await nextEpisodes.ResolveAsync(
                source.Session.WorkId,
                source.Title,
                pending.PreferSimilarNextEpisodeRelease,
                pending.NextEpisodeReleaseSimilarityThresholdPercent,
                stoppingToken).ConfigureAwait(false);
            if (target is null)
            {
                job.End(
                    "skipped",
                    "no_next_episode",
                    "No canonical next episode with an available release was found.",
                    time.GetUtcNow());
                return;
            }

            var response = await resolve.ResolveForPreDownloadAsync(
                target.ReleaseId,
                target.WorkId,
                source.Session.Client,
                source.Session.RequestedById,
                source.Session.RequestedByName,
                token => token,
                token => $"{LocalBaseUrl()}/api/v1/stream/{token}",
                stoppingToken).ConfigureAwait(false);
            if (response.StreamUrl is null
                || !sessions.TryGetSession(response.StreamUrl, out var targetSession))
            {
                job.End(
                    "skipped",
                    "target_unavailable",
                    "The next episode could not be prepared for playback.",
                    time.GetUtcNow());
                return;
            }

            job.SetTarget(
                targetSession,
                target.Title,
                target.SeasonNumber,
                target.EpisodeNumber,
                time.GetUtcNow());
            await DownloadAsync(job, targetSession, stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            job.End("cancelled", "cancelled", "The pre-download was cancelled.", time.GetUtcNow());
        }
        catch (ResourceCapacityException)
        {
            job.End(
                "skipped",
                "capacity",
                "The implicit download could not fit without displacing active content.",
                time.GetUtcNow());
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "Pre-download job {JobId} failed ({FailureType})",
                job.Id,
                e.GetType().Name);
            job.End(
                "failed",
                FailureCode(e),
                "The background download failed; playback remains available from the remote source.",
                time.GetUtcNow());
        }
        finally
        {
            CleanupUnusableImplicitTarget(job);
        }
    }

    private async Task DownloadAsync(
        PreDownloadJob job,
        ActiveSession target,
        CancellationToken stoppingToken)
    {
        if (!workspace.HasSpaceFor(target.File.SizeBytes))
        {
            job.End(
                "skipped",
                "disk_space",
                "The configured free-disk reserve would be crossed.",
                time.GetUtcNow());
            return;
        }

        var cache = new PreDownloadCacheFile(workspace, target.Token, target.File.SizeBytes);
        var snapshot = job.Snapshot();
        if (!target.AttachPreDownload(
                cache,
                job.Id,
                snapshot.Kind,
                snapshot.Reason,
                snapshot.SourceToken == target.Token ? null : snapshot.SourceToken))
        {
            cache.Dispose();
            var existing = target.PreDownloadCache;
            if (existing?.IsComplete == true)
            {
                job.Progress(existing.TotalBytes, existing.TotalBytes, time.GetUtcNow());
                job.Complete(time.GetUtcNow());
            }
            else
            {
                job.End(
                    "skipped",
                    "already_downloading",
                    "This file already has a pre-download in progress.",
                    time.GetUtcNow());
            }
            return;
        }

        try
        {
            await using var source = sessions.OpenPreDownloadSource(target, lowPriorityClient);
            await cache.DownloadAsync(
                source,
                bytes => job.Progress(bytes, cache.TotalBytes, time.GetUtcNow()),
                stoppingToken).ConfigureAwait(false);
            job.Complete(time.GetUtcNow());
        }
        catch
        {
            cache.Dispose();
            throw;
        }
    }

    private void OnJobFinished(string jobId)
    {
        _activeTasks.TryRemove(jobId, out _);
        lock (_schedulerGate)
            _running = Math.Max(0, _running - 1);
    }

    private void CleanupUnusableImplicitTarget(PreDownloadJob job)
    {
        var snapshot = job.Snapshot();
        if (snapshot.Kind != "nextEpisode"
            || snapshot.State == "completed"
            || snapshot.TargetToken is not { } targetToken
            || string.Equals(targetToken, snapshot.SourceToken, StringComparison.Ordinal)
            || !sessions.TryGetSession(targetToken, out var target)
            || target.RetentionPriority != EphemeralRetentionPriority.Background
            || (target.PreDownloadJobId is { } owner && owner != snapshot.Id)
            || target.PreDownloadCache?.IsComplete == true)
        {
            return;
        }

        sessions.PurgeBackgroundSession(targetToken);
    }

    private void Prune()
    {
        PrunePlaybackSelections();
        var cutoff = time.GetUtcNow() - FinishedJobLifetime;
        var candidates = _jobs.Values
            .Select(job => job.Snapshot())
            .Where(job => job.CompletedAt is { } completed
                          && completed < cutoff
                          && !HasRelatedLiveSession(job))
            .OrderBy(job => job.CompletedAt)
            .ToList();
        if (_jobs.Count - candidates.Count > MaximumRetainedJobs)
        {
            candidates.AddRange(_jobs.Values
                .Select(job => job.Snapshot())
                .Where(job => job.CompletedAt is not null && !candidates.Any(c => c.Id == job.Id))
                .OrderBy(job => job.CompletedAt)
                .Take(_jobs.Count - candidates.Count - MaximumRetainedJobs));
        }

        foreach (var candidate in candidates)
        {
            if (!_jobs.TryRemove(candidate.Id, out _))
                continue;
            foreach (var pair in _triggerKeys.Where(pair => pair.Value == candidate.Id).ToArray())
                _triggerKeys.TryRemove(pair.Key, out _);
        }
    }

    private void PrunePlaybackSelections()
    {
        lock (_playbackGate)
        {
            foreach (var (scope, playback) in _playbackSelections.ToArray())
            {
                playback.Prune(token => sessions.TryGetSession(token, out _));
                if (playback.IsEmpty)
                    _playbackSelections.Remove(scope);
            }
        }
    }

    private bool HasRelatedLiveSession(PreDownloadJobResponse job)
        => sessions.TryGetSession(job.SourceToken, out _)
           || (job.TargetToken is { } targetToken && sessions.TryGetSession(targetToken, out _));

    private string LocalBaseUrl()
    {
        var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses;
        var address = addresses?.FirstOrDefault(candidate => candidate.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                      ?? addresses?.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(address))
            return "http://127.0.0.1:1";
        var loopback = address
            .Replace("://+", "://127.0.0.1")
            .Replace("://*", "://127.0.0.1")
            .Replace("0.0.0.0", "127.0.0.1")
            .Replace("[::]", "127.0.0.1");
        return new Uri(loopback).GetLeftPart(UriPartial.Authority);
    }

    private static string FailureCode(Exception exception) => exception switch
    {
        EndOfStreamException => "incomplete_file",
        IOException => "storage_error",
        _ => "download_failed",
    };

    private sealed record PendingJob(
        PreDownloadJob Job,
        string TriggerKey,
        string Kind,
        WatchEventWrite Observation,
        bool PreferSimilarNextEpisodeRelease,
        int NextEpisodeReleaseSimilarityThresholdPercent);

    private readonly record struct PlaybackScope(
        string WorkId,
        string Client,
        string RequestedById);

    private readonly record struct PlaybackIdentity(string Token, string? PlaybackSessionId);

    private sealed class PlaybackScopeState
    {
        private readonly HashSet<PlaybackIdentity> _retired = [];

        public PlaybackSelection? Current { get; private set; }
        public bool IsEmpty => Current is null && _retired.Count == 0;

        public PlaybackSelection Select(
            string token,
            string? playbackSessionId,
            long positionTicks,
            DateTimeOffset observedAt,
            bool explicitStart)
        {
            var identity = new PlaybackIdentity(token, playbackSessionId);
            if (Current is { } current && !current.Matches(identity))
                _retired.Add(current.Identity);
            if (explicitStart)
                _retired.Remove(identity);
            Current = new PlaybackSelection(identity, positionTicks, observedAt);
            return Current;
        }

        public void Stop(PlaybackIdentity identity)
        {
            _retired.Add(identity);
            if (Current?.Matches(identity) == true)
                Current = null;
        }

        public bool IsRetired(PlaybackIdentity identity) => _retired.Contains(identity);

        public void Prune(Func<string, bool> isLive)
        {
            if (Current is { } current && !isLive(current.Identity.Token))
                Current = null;
            _retired.RemoveWhere(identity => !isLive(identity.Token));
        }
    }

    private sealed class PlaybackSelection(
        PlaybackIdentity identity,
        long positionTicks,
        DateTimeOffset observedAt)
    {
        public PlaybackIdentity Identity { get; } = identity;
        public long LastPositionTicks { get; private set; } = positionTicks;
        public DateTimeOffset LastObservedAt { get; private set; } = observedAt;
        public long WatchedTicks { get; private set; }

        public bool Matches(PlaybackIdentity candidate)
            => string.Equals(Identity.Token, candidate.Token, StringComparison.Ordinal)
               && (string.IsNullOrWhiteSpace(Identity.PlaybackSessionId)
                   || string.IsNullOrWhiteSpace(candidate.PlaybackSessionId)
                   || string.Equals(
                       Identity.PlaybackSessionId,
                       candidate.PlaybackSessionId,
                       StringComparison.Ordinal));

        public void Observe(long positionTicks, DateTimeOffset observedAt)
        {
            if (positionTicks > LastPositionTicks)
            {
                var positionDelta = positionTicks - LastPositionTicks;
                var elapsed = observedAt > LastObservedAt
                    ? (observedAt - LastObservedAt).Ticks
                    : 0;
                var delta = Math.Min(positionDelta, elapsed);
                WatchedTicks = WatchedTicks > long.MaxValue - delta
                    ? long.MaxValue
                    : WatchedTicks + delta;
            }
            LastPositionTicks = positionTicks;
            LastObservedAt = observedAt;
        }
    }

    private enum PlaybackGraceState
    {
        Unknown,
        Pending,
        Reached,
        Stale,
    }
}
