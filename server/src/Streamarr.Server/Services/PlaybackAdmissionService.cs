using System.Collections.Concurrent;
using System.Security.Cryptography;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services;

/// <summary>
/// Two-phase playback admission (repair spec): a fast POST validates the request and
/// starts the full resolve (health check, materialization, ffprobe, repair analysis)
/// in the background under the admission's own lifetime — never the caller's HTTP
/// token. The POST answers within a hard budget with phase=ready (fast path) or
/// phase=preparing plus a pollable admission id. This decouples Core work from one
/// HTTP request and gives the plugin a bounded deadline; Jellyfin's live-stream lock
/// remains held until OpenMediaSource returns.
/// </summary>
public sealed class PlaybackAdmissionService(
    ResolveService resolveService,
    SessionManager sessionManager,
    ILogger<PlaybackAdmissionService> logger,
    TimeProvider? time = null,
    TimeSpan? completedLifetime = null,
    TimeSpan? sweepInterval = null) : BackgroundService
{
    private static readonly TimeSpan PendingLifetime = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan CompletedLifetime = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan ClaimedCleanupGrace = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan SweepInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan ResolveBudget = TimeSpan.FromMinutes(10);
    private const int MaxAdmissions = 512;

    private readonly ConcurrentDictionary<string, Admission> _admissions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ClaimedAdmission> _claimed = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _capacity = new(MaxAdmissions, MaxAdmissions);
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly TimeSpan _completedLifetime = completedLifetime ?? CompletedLifetime;
    private readonly TimeSpan _sweepInterval = sweepInterval ?? SweepInterval;
    private int _disposed;

    private sealed class CapabilityHolder
    {
        public string? Token;
    }

    private sealed record ClaimedAdmission(string Token, DateTimeOffset ExpiresAt);

    private sealed record Admission(
        string Id,
        DateTimeOffset CreatedAt,
        Task<ResolveResponse> Work,
        CancellationTokenSource Lifetime,
        CapabilityHolder Capability)
    {
        public long CompletedAtTicks;
        public int Abandoned;
        public int LifetimeDisposed;
        public int CleanupCompleted;
    }

    public async Task<PlaybackAdmissionResponse> AdmitAsync(
        ResolveRequest request,
        string? requestedById,
        string? requestedByName,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        TimeSpan budget,
        CancellationToken ct)
    {
        Sweep();
        if (!_capacity.Wait(0))
            throw new ResourceCapacityException("Too many playback admissions are in flight.");

        Admission admission;
        try
        {
            var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant();
            var lifetime = new CancellationTokenSource(ResolveBudget, _time);
            var capability = new CapabilityHolder();
            var work = Task.Run(() => resolveService.ResolveAsync(
                request.ReleaseId,
                request.WorkId,
                request.Client,
                requestedById,
                requestedByName,
                request.AutoFallback,
                token =>
                {
                    Volatile.Write(ref capability.Token, token);
                    return streamUrlForToken(token);
                },
                localStreamUrlForToken,
                lifetime.Token), CancellationToken.None);
            admission = new Admission(id, _time.GetUtcNow(), work, lifetime, capability);
            if (!_admissions.TryAdd(id, admission))
                throw new InvalidOperationException("Could not allocate a unique playback admission id.");
            _ = work.ContinueWith(
                _ => OnWorkCompleted(admission),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
        catch
        {
            _capacity.Release();
            throw;
        }

        try
        {
            var response = await admission.Work.WaitAsync(budget, ct).ConfigureAwait(false);
            return Ready(admission, response);
        }
        catch (TimeoutException)
        {
            logger.LogInformation(
                "A playback admission is still preparing after its {BudgetMs}ms budget",
                (int)budget.TotalMilliseconds);
            return Preparing(admission);
        }
        catch (OperationCanceledException) when (admission.Work.IsCanceled && !ct.IsCancellationRequested)
        {
            return Failed(admission);
        }
        catch (Exception) when (admission.Work.IsCompleted)
        {
            return Failed(admission);
        }
    }

    public PlaybackAdmissionResponse? GetStatus(string admissionId)
    {
        Sweep();
        if (admissionId.Length > 64 || !_admissions.TryGetValue(admissionId, out var admission))
            return null;
        if (!admission.Work.IsCompleted)
            return Preparing(admission);
        EnsureCompletedAt(admission);
        return admission.Work.IsCompletedSuccessfully
            ? Ready(admission, admission.Work.Result)
            : Failed(admission);
    }

    public PlaybackAdmissionClaimOutcome TryClaim(
        string admissionId,
        out PlaybackAdmissionResponse? response)
    {
        response = null;
        Sweep();
        if (admissionId.Length > 64 || !_admissions.TryGetValue(admissionId, out var admission))
            return PlaybackAdmissionClaimOutcome.Unknown;
        if (!admission.Work.IsCompleted)
            return PlaybackAdmissionClaimOutcome.Preparing;
        if (!_admissions.TryRemove(new KeyValuePair<string, Admission>(admissionId, admission)))
            return PlaybackAdmissionClaimOutcome.Unknown;

        _capacity.Release();
        EnsureCompletedAt(admission);
        response = admission.Work.IsCompletedSuccessfully
            ? Ready(admission, admission.Work.Result)
            : Failed(admission);
        var token = Volatile.Read(ref admission.Capability.Token);
        if (response.Phase == "ready" && !string.IsNullOrEmpty(token))
        {
            // Retain a brief cleanup handle in case the successful claim response is lost.
            _claimed[admissionId] = new ClaimedAdmission(
                token,
                _time.GetUtcNow() + ClaimedCleanupGrace);
        }
        else if (!string.IsNullOrEmpty(token))
        {
            sessionManager.CloseSession(token);
        }
        DisposeLifetime(admission);
        return PlaybackAdmissionClaimOutcome.Claimed;
    }

    public void Cancel(string admissionId)
    {
        if (admissionId.Length > 64)
            return;
        if (_admissions.TryRemove(admissionId, out var admission))
        {
            _capacity.Release();
            Abandon(admission);
            return;
        }
        if (_claimed.TryRemove(admissionId, out var claimed))
        {
            // PurgeSession atomically protects a capability whose HTTP stream already started.
            _ = sessionManager.PurgeSession(claimed.Token);
        }
    }

    private PlaybackAdmissionResponse Preparing(Admission admission)
        => new()
        {
            AdmissionId = admission.Id,
            Phase = "preparing",
            RetryAfterSeconds = 2,
        };

    private void OnWorkCompleted(Admission admission)
    {
        EnsureCompletedAt(admission);
        if (admission.Work.IsFaulted)
            _ = admission.Work.Exception;
        if (Volatile.Read(ref admission.Abandoned) != 0)
            CleanupAbandoned(admission);
    }

    private void EnsureCompletedAt(Admission admission)
        => Interlocked.CompareExchange(
            ref admission.CompletedAtTicks,
            _time.GetUtcNow().UtcTicks,
            0);

    private void Abandon(Admission admission)
    {
        Interlocked.Exchange(ref admission.Abandoned, 1);
        try
        {
            admission.Lifetime.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        if (admission.Work.IsCompleted)
            CleanupAbandoned(admission);
    }

    private void CleanupAbandoned(Admission admission)
    {
        if (Interlocked.Exchange(ref admission.CleanupCompleted, 1) != 0)
            return;
        var token = Volatile.Read(ref admission.Capability.Token);
        if (!string.IsNullOrEmpty(token))
            sessionManager.CloseSession(token);
        DisposeLifetime(admission);
    }

    private static void DisposeLifetime(Admission admission)
    {
        if (Interlocked.Exchange(ref admission.LifetimeDisposed, 1) == 0)
            admission.Lifetime.Dispose();
    }

    private static PlaybackAdmissionResponse Ready(Admission admission, ResolveResponse response)
        => new()
        {
            AdmissionId = admission.Id,
            Phase = response.Status == "dead" ? "failed" : "ready",
            Resolve = response,
        };

    private static PlaybackAdmissionResponse Failed(Admission admission)
    {
        var reason = admission.Work.IsCanceled
            ? "prepare_timeout"
            : admission.Work.Exception?.InnerException switch
            {
                ReleaseNotFoundException => "unknown_release",
                NoPlayableFileException => "no_playable_file",
                ResourceCapacityException => "capacity_reached",
                _ => "prepare_failed",
            };
        return new PlaybackAdmissionResponse
        {
            AdmissionId = admission.Id,
            Phase = "failed",
            Error = reason,
        };
    }

    internal void Sweep()
    {
        var now = _time.GetUtcNow();
        foreach (var (id, admission) in _admissions)
        {
            var completedTicks = Volatile.Read(ref admission.CompletedAtTicks);
            if (admission.Work.IsCompleted && completedTicks == 0)
            {
                EnsureCompletedAt(admission);
                completedTicks = Volatile.Read(ref admission.CompletedAtTicks);
            }
            var completedAt = completedTicks == 0
                ? (DateTimeOffset?)null
                : new DateTimeOffset(completedTicks, TimeSpan.Zero);
            if (!IsExpired(admission.CreatedAt, completedAt, now, _completedLifetime))
                continue;
            if (_admissions.TryRemove(new KeyValuePair<string, Admission>(id, admission)))
            {
                _capacity.Release();
                Abandon(admission);
            }
        }

        foreach (var (id, claimed) in _claimed)
        {
            if (!sessionManager.TryGetSession(claimed.Token, out var session) || session.IsStreaming)
            {
                _claimed.TryRemove(new KeyValuePair<string, ClaimedAdmission>(id, claimed));
                continue;
            }
            if (now > claimed.ExpiresAt)
                _claimed.TryRemove(new KeyValuePair<string, ClaimedAdmission>(id, claimed));
        }
    }

    internal static bool IsExpired(
        DateTimeOffset createdAt,
        DateTimeOffset? completedAt,
        DateTimeOffset now,
        TimeSpan? completedLifetime = null)
        => now > (completedAt is null
            ? createdAt + PendingLifetime
            : completedAt.Value + (completedLifetime ?? CompletedLifetime));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            using var timer = new PeriodicTimer(_sweepInterval, _time);
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
                Sweep();
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Host shutdown.
        }
    }

    public override void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
            return;
        base.Dispose();
        foreach (var (id, admission) in _admissions)
        {
            if (!_admissions.TryRemove(new KeyValuePair<string, Admission>(id, admission)))
                continue;
            _capacity.Release();
            Abandon(admission);
        }
        _claimed.Clear();
        _capacity.Dispose();
    }
}

public enum PlaybackAdmissionClaimOutcome
{
    Unknown,
    Preparing,
    Claimed,
}
