using System.Collections.Concurrent;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// Bounded background observer for Core PAR2 repair status (transport only — the Core owns
/// every repair decision). While a tracked capability session is actively played, its
/// token-bound status endpoint is polled at a low rate; state transitions become
/// deduplicated native DisplayMessage notifications on sessions that support the command.
/// Everything is fail-open: an error, timeout, unsupported client or older Core never
/// affects playback, and capability tokens are never logged.
/// </summary>
public sealed class RepairStatusObserver(
    ISessionManager sessionManager,
    PlaybackSessionTracker tracker,
    StreamarrApiClient api,
    ILogger<RepairStatusObserver> logger) : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan DefaultStatusRequestTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan DefaultNotificationTimeout = TimeSpan.FromSeconds(3);
    // Leave half of the shared eight-connection Core handler free for playback and discovery.
    private const int MaxPolledSessionsPerTick = 4;
    // PlaybackSessionTracker admits at most 512 live attributions, so this remains bounded
    // without evicting active clients and repeating their transition notifications.
    private const int MaxRememberedStates = 512;

    private sealed record NotifyState(string JobId, string LastPlayability);
    private sealed record PollCandidate(SessionInfo Session, PlaybackSessionTracker.Attribution Attribution);

    private readonly ConcurrentDictionary<string, NotifyState> _notified = new(StringComparer.Ordinal);
    private readonly TimeSpan _statusRequestTimeout = DefaultStatusRequestTimeout;
    private readonly TimeSpan _notificationTimeout = DefaultNotificationTimeout;
    private int _nextCandidateIndex;

    internal RepairStatusObserver(
        ISessionManager sessionManager,
        PlaybackSessionTracker tracker,
        StreamarrApiClient api,
        ILogger<RepairStatusObserver> logger,
        TimeSpan statusRequestTimeout,
        TimeSpan? notificationTimeout = null)
        : this(sessionManager, tracker, api, logger)
    {
        if (statusRequestTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(statusRequestTimeout));
        if (notificationTimeout is { } configuredTimeout && configuredTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(notificationTimeout));
        _statusRequestTimeout = statusRequestTimeout;
        _notificationTimeout = notificationTimeout ?? DefaultNotificationTimeout;
    }

    private static PluginConfiguration Config
        => Plugin.Instance?.Configuration ?? new PluginConfiguration();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(PollInterval);
        while (await WaitSafelyAsync(timer, stoppingToken).ConfigureAwait(false))
        {
            try
            {
                await ObserveOnceAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                logger.LogDebug("Repair status observation tick failed ({FailureType})", e.GetType().Name);
            }
        }
    }

    private static async Task<bool> WaitSafelyAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try
        {
            return await timer.WaitForNextTickAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    internal async Task ObserveOnceAsync(CancellationToken ct)
    {
        if (!Config.RepairNotificationsEnabled)
        {
            _notified.Clear();
            return;
        }

        // Zero I/O while nothing Streamarr-owned is actively playing.
        var attributions = tracker.All();
        if (attributions.Count == 0)
        {
            _notified.Clear();
            return;
        }

        var playingSessions = sessionManager.Sessions
            .Where(s => s.NowPlayingItem is not null)
            .GroupBy(s => s.Id, StringComparer.Ordinal)
            .Select(group => group.First())
            .ToArray();
        if (playingSessions.Length == 0)
        {
            _notified.Clear();
            return;
        }

        // A Jellyfin item can have multiple simultaneous Streamarr releases. Attribute every
        // client session through the exact media-source alias Jellyfin says it is playing;
        // item-only correlation would leak one release's status to the other client's session.
        var candidates = new List<PollCandidate>();
        foreach (var session in playingSessions)
        {
            var attribution = tracker.Resolve(session.PlayState?.MediaSourceId);
            if (attribution is not null
                && !string.IsNullOrEmpty(attribution.SessionToken)
                && attribution.ItemId == session.NowPlayingItem!.Id)
            {
                candidates.Add(new PollCandidate(session, attribution));
            }
        }

        var orderedCandidates = candidates
            .OrderBy(candidate => candidate.Session.Id, StringComparer.Ordinal)
            .ToArray();

        if (orderedCandidates.Length == 0)
        {
            _notified.Clear();
            return;
        }

        var selected = SelectFairCandidates(orderedCandidates);
        await Task.WhenAll(selected.Select(candidate => PollAsync(candidate, ct))).ConfigureAwait(false);

        PruneStates(orderedCandidates.Select(candidate => candidate.Session.Id));
    }

    private IReadOnlyList<PollCandidate> SelectFairCandidates(IReadOnlyList<PollCandidate> candidates)
    {
        var start = _nextCandidateIndex % candidates.Count;
        var count = Math.Min(MaxPolledSessionsPerTick, candidates.Count);
        var selected = new PollCandidate[count];
        for (var index = 0; index < count; index++)
            selected[index] = candidates[(start + index) % candidates.Count];
        _nextCandidateIndex = (start + count) % candidates.Count;
        return selected;
    }

    private async Task PollAsync(PollCandidate candidate, CancellationToken stoppingToken)
    {
        using var request = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        request.CancelAfter(_statusRequestTimeout);
        try
        {
            var status = await api.GetSessionRepairStatusAsync(
                    candidate.Attribution.SessionToken!,
                    request.Token)
                .ConfigureAwait(false);
            var current = RefreshCandidate(candidate);
            if (status is not null && current is not null)
                await NotifyTransitionsAsync(current, status, stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
        {
            logger.LogDebug("Repair status request timed out");
        }
    }

    private PollCandidate? RefreshCandidate(PollCandidate original)
    {
        var session = sessionManager.Sessions.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, original.Session.Id, StringComparison.Ordinal));
        if (session?.NowPlayingItem is null)
            return null;
        var attribution = tracker.Resolve(session.PlayState?.MediaSourceId);
        return attribution is not null
               && attribution.TrackingId == original.Attribution.TrackingId
               && attribution.ItemId == session.NowPlayingItem.Id
            ? new PollCandidate(session, attribution)
            : null;
    }

    private async Task NotifyTransitionsAsync(
        PollCandidate candidate,
        SessionRepairStatusDto status,
        CancellationToken ct)
    {
        var jobId = status.Repair?.JobId;
        if (jobId is null || status.Playability is not ("repairing" or "repairedReady" or "unavailable"))
            return;
        if (candidate.Session.Capabilities?.SupportedCommands?.Contains(GeneralCommandType.DisplayMessage) != true)
            return;

        var key = candidate.Session.Id;
        var previous = _notified.TryGetValue(key, out var state) && state.JobId == jobId
            ? state.LastPlayability
            : null;
        if (previous == status.Playability)
            return;

        // First observation of an already-terminal state carries no user value.
        if (previous is null && status.Playability is not "repairing")
        {
            _notified[key] = new NotifyState(jobId, status.Playability);
            return;
        }

        var message = status.Playability switch
        {
            "repairing" => new MessageCommand
            {
                Header = "Streamarr",
                Text = status.Repair?.ProgressPercent is > 0 and < 100
                    ? $"Quelle beschädigt – Reparatur läuft ({status.Repair.ProgressPercent} %)"
                    : "Quelle beschädigt – Reparatur läuft",
                TimeoutMs = 8000,
            },
            "repairedReady" => new MessageCommand
            {
                Header = "Streamarr",
                Text = "Reparatur abgeschlossen – Wiedergabe wird fortgesetzt",
                TimeoutMs = 6000,
            },
            _ => new MessageCommand
            {
                Header = "Streamarr",
                Text = "Reparatur fehlgeschlagen – Quelle nicht verfügbar",
                TimeoutMs = 8000,
            },
        };

        using var delivery = CancellationTokenSource.CreateLinkedTokenSource(ct);
        delivery.CancelAfter(_notificationTimeout);
        try
        {
            await sessionManager.SendMessageCommand(
                    candidate.Session.Id,
                    candidate.Session.Id,
                    message,
                    delivery.Token)
                .ConfigureAwait(false);
            _notified[key] = new NotifyState(jobId, status.Playability);
            logger.LogInformation(
                "Repair status '{Playability}' shown on client session for item {ItemId}",
                status.Playability,
                candidate.Attribution.ItemId);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger.LogDebug("DisplayMessage delivery timed out");
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogDebug("DisplayMessage delivery failed ({FailureType})", e.GetType().Name);
        }
    }

    private void PruneStates(IEnumerable<string> liveSessionIds)
    {
        var liveKeys = liveSessionIds.ToHashSet(StringComparer.Ordinal);
        foreach (var key in _notified.Keys.Where(k => !liveKeys.Contains(k)).ToArray())
            _notified.TryRemove(key, out _);

        foreach (var key in _notified.Keys
                     .OrderBy(key => key, StringComparer.Ordinal)
                     .Take(Math.Max(0, _notified.Count - MaxRememberedStates))
                     .ToArray())
        {
            _notified.TryRemove(key, out _);
        }
    }
}
