using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nzb;
using Streamarr.Usenet.Par2;

namespace Streamarr.Server.Services.Repair;

/// <summary>Marker wrapper for the low-priority NNTP client the repair pipeline uses.</summary>
public sealed record RepairNntpClient(INntpClient Client);

public enum RepairTrigger
{
    Resolve,
    Runtime,
    Manual,
}

/// <summary>A caller's handle on a (possibly shared) repair job.</summary>
public sealed class RepairJobHandle
{
    internal RepairJobHandle(RepairJob job)
    {
        Job = job;
    }

    internal RepairJob Job { get; }

    public string JobId => Job.JobId;
    public string Fingerprint => Job.Fingerprint;
    public RepairJobSnapshot Snapshot() => Job.Snapshot();

    /// <summary>
    /// Waits for the shared job under this caller's own timeout/token. Cancelling the
    /// wait never cancels the job itself.
    /// </summary>
    public async Task<RepairArtifact> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        Job.AddWaiter();
        try
        {
            return await Job.Completion.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        finally
        {
            Job.RemoveWaiter();
        }
    }
}

/// <summary>
/// The central repair orchestrator: exactly one active job per content fingerprint,
/// any number of waiters, bounded concurrency, per-job event log, failure backoff,
/// and artifact-first serving. All PAR2 work runs through the low-priority NNTP path.
/// </summary>
public sealed class RepairCoordinator(
    IReleaseStore releaseStore,
    NzbFetcher nzbFetcher,
    RepairNntpClient repairClient,
    RepairWorkspace workspace,
    RepairArtifactCache artifactCache,
    IPar2RepairEngine engine,
    IRepairMediaVerifier mediaVerifier,
    IOptions<StreamarrOptions> options,
    ILogger<RepairCoordinator> logger,
    StreamarrMetrics? metrics = null,
    TimeProvider? time = null)
{
    private const int MaxPar2IndexCandidates = 16;
    private const int MaxDecodedLengthProbes = 16;

    private readonly ConcurrentDictionary<string, RepairJob> _activeByFingerprint = new(StringComparer.Ordinal);
    private readonly RepairCoordinatorBookkeeping _bookkeeping = new(
        options.Value.ReleaseStoreMaxEntries,
        time ?? TimeProvider.System);
    private readonly ConcurrentDictionary<string, long> _lastProgressNotify = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<RepairJob> _finished = new();
    private readonly SemaphoreSlim _jobSlots = new(
        Math.Max(1, options.Value.Repair.MaxConcurrentJobs),
        Math.Max(1, options.Value.Repair.MaxConcurrentJobs));
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly object _startGate = new();
    private int _artifactEventsSubscribed;

    public bool Enabled => options.Value.Repair.Enabled;

    public event Action<RepairJobSnapshot>? JobChanged;

    // ------------------------------------------------------------------ lookup surface

    public RepairJobSnapshot? GetJob(string jobId)
    {
        EnsureArtifactEventsSubscribed();
        return AllJobs().FirstOrDefault(j => string.Equals(j.JobId, jobId, StringComparison.Ordinal))?.Snapshot();
    }

    public RepairJobSnapshot? GetJobByRelease(string releaseId)
    {
        EnsureArtifactEventsSubscribed();
        if (_bookkeeping.TryGetFingerprint(releaseId, out var fingerprint)
            && _activeByFingerprint.TryGetValue(fingerprint, out var active))
        {
            return active.Snapshot();
        }
        return AllJobs()
            .Where(j => string.Equals(j.ReleaseId, releaseId, StringComparison.Ordinal))
            .MaxBy(j => j.Snapshot().CreatedAtUtc)
            ?.Snapshot();
    }

    public IReadOnlyList<RepairJobSnapshot> ListJobs()
    {
        EnsureArtifactEventsSubscribed();
        return AllJobs().Select(j => j.Snapshot()).OrderByDescending(s => s.CreatedAtUtc).ToList();
    }

    public string? FingerprintForRelease(string releaseId)
        => _bookkeeping.TryGetFingerprint(releaseId, out var fingerprint) ? fingerprint : null;

    public void RegisterReleaseFingerprint(string releaseId, string fingerprint)
        => _bookkeeping.RegisterRelease(
            releaseId,
            fingerprint,
            activeFingerprint => _activeByFingerprint.ContainsKey(activeFingerprint));

    /// <summary>
    /// True while sessions of this (origin-dead) release must be kept alive: a verified
    /// local artifact exists or an active repair job may still produce one.
    /// </summary>
    public bool AllowsPlaybackWhileDead(string releaseId)
    {
        if (!Enabled || !_bookkeeping.TryGetFingerprint(releaseId, out var fingerprint))
            return false;
        if (artifactCache.TryGetReady(fingerprint) is not null)
            return true;
        return _activeByFingerprint.TryGetValue(fingerprint, out var job) && !job.Snapshot().IsTerminal;
    }

    public int ActiveJobCount => _activeByFingerprint.Count(p => !p.Value.Snapshot().IsTerminal);

    // ------------------------------------------------------------------ job admission

    public bool CancelJob(string jobId)
    {
        var job = _activeByFingerprint.Values.FirstOrDefault(
            j => string.Equals(j.JobId, jobId, StringComparison.Ordinal));
        if (job is null)
            return false;
        job.Cancel("cancelled by operator");
        return true;
    }

    /// <summary>
    /// Deduplicating job admission. Returns null when repair is disabled or the failure
    /// backoff blocks a retry. The same fingerprint always shares one running job.
    /// </summary>
    public async Task<RepairJobHandle?> GetOrStartJobAsync(
        string releaseId,
        string? workId,
        string? releaseTitle,
        RepairTrigger trigger,
        CancellationToken ct)
    {
        if (!Enabled)
            return null;
        EnsureArtifactEventsSubscribed();

        RepairJobContext context;
        try
        {
            context = await BuildContextAsync(releaseId, workId, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (ReleaseNotFoundException)
        {
            throw;
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "Repair admission for release {ReleaseId} could not analyze the NZB ({FailureType})",
                releaseId, e.GetType().Name);
            return null;
        }

        RegisterReleaseFingerprint(releaseId, context.Fingerprint);

        // A verified artifact wins immediately: hand back a pre-completed handle
        // instead of spawning a redundant job.
        if (artifactCache.TryAcquire(context.Fingerprint) is { } readyLease)
        {
            using (readyLease)
            {
                lock (_startGate)
                {
                    var retained = _finished
                        .Where(j => string.Equals(j.Fingerprint, context.Fingerprint, StringComparison.Ordinal)
                                    && j.Snapshot().State == RepairState.Ready)
                        .MaxBy(j => j.Snapshot().CreatedAtUtc);
                    if (retained is not null)
                    {
                        metrics?.RepairCacheHit();
                        return new RepairJobHandle(retained);
                    }

                    var completed = new RepairJob(context, releaseId, workId, releaseTitle,
                        options.Value.Repair.MaxJobEvents, _time);
                    completed.Succeed(readyLease.Artifact);
                    RetainFinished(completed);
                    NotifyChanged(completed);
                    metrics?.RepairCacheHit();
                    return new RepairJobHandle(completed);
                }
            }
        }

        lock (_startGate)
        {
            if (_activeByFingerprint.TryGetValue(context.Fingerprint, out var existing)
                && !existing.Snapshot().IsTerminal)
            {
                RegisterReleaseFingerprint(releaseId, context.Fingerprint);
                return new RepairJobHandle(existing);
            }

            if (trigger != RepairTrigger.Manual
                && _bookkeeping.IsFailureBlocked(context.Fingerprint))
            {
                return null;
            }
            _bookkeeping.ClearFailure(context.Fingerprint);

            var job = new RepairJob(
                context,
                releaseId,
                workId,
                releaseTitle,
                options.Value.Repair.MaxJobEvents,
                _time);
            _activeByFingerprint[context.Fingerprint] = job;
            RegisterReleaseFingerprint(releaseId, context.Fingerprint);
            metrics?.RepairAttempted();

            // Known synchronously from the NZB analysis already done above (no I/O left to
            // do) — fail inline instead of via the backgrounded pipeline. RunJobSafelyAsync
            // deliberately yields before its first state transition, so a caller reading
            // this job's Events right after admission (ResolveService copies them into the
            // stream's permanent history) would otherwise race the background task and
            // almost always observe an empty log instead of this failure.
            if (context.Par2 is null)
            {
                job.Fail(RepairDisposition.Unsupported, "the release carries no PAR2 set");
                FinishJob(job);
                return new RepairJobHandle(job);
            }

            _ = RunJobSafelyAsync(job);
            return new RepairJobHandle(job);
        }
    }

    /// <summary>Resolves a ready artifact for a release, if one exists (no I/O beyond NZB cache).</summary>
    public RepairArtifactLease? TryAcquireReadyArtifact(string fingerprint)
        => Enabled ? artifactCache.TryAcquire(fingerprint) : null;

    // ------------------------------------------------------------------ context analysis

    /// <summary>Deterministic NZB analysis shared by resolve- and runtime-triggered repair.</summary>
    public async Task<RepairJobContext> BuildContextAsync(string releaseId, CancellationToken ct)
        => await BuildContextAsync(releaseId, workId: null, ct).ConfigureAwait(false);

    public async Task<RepairJobContext> BuildContextAsync(
        string releaseId,
        string? workId,
        CancellationToken ct)
    {
        var registered = releaseStore.Get(releaseId, workId)
            ?? throw new ReleaseNotFoundException(releaseId);
        var nzbUrl = registered.Release.NzbUrl
            ?? throw new NoPlayableFileException("The release has no NZB location on record.");
        var cached = await nzbFetcher.FetchAsync(
            new NzbCacheDescriptor(
                registered.Release.ReleaseId,
                registered.WorkId,
                registered.Release.Title,
                registered.Release.Indexer,
                registered.Release.SizeBytes),
            nzbUrl,
            registered.Release.IndexerId ?? registered.Release.Indexer,
            ct).ConfigureAwait(false);
        var candidate = MediaFileSelector.SelectPrimary(cached.Document)
            ?? throw new NoPlayableFileException("The NZB contains no playable media file.");
        return new RepairJobContext
        {
            ReleaseId = releaseId,
            Document = cached.Document,
            Candidate = candidate,
            Par2 = RepairNzbAnalyzer.SelectPar2Files(cached.Document),
            Fingerprint = RepairNzbAnalyzer.ComputeFingerprint(candidate),
        };
    }

    // ------------------------------------------------------------------ pipeline

    private async Task RunJobSafelyAsync(RepairJob job)
    {
        await Task.Yield();
        try
        {
            await RunJobAsync(job).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            logger.LogError(
                "Repair job {JobId} crashed outside its pipeline ({FailureType})",
                job.JobId,
                e.GetType().Name);
        }
        finally
        {
            FinishJob(job);
        }
    }

    private async Task RunJobAsync(RepairJob job)
    {
        using var timeout = new CancellationTokenSource(
            TimeSpan.FromSeconds(options.Value.Repair.JobTimeoutSeconds));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, job.CancelToken);
        var ct = linked.Token;

        var queuedAt = _time.GetUtcNow();
        var acquiredSlot = false;
        try
        {
            job.Transition(RepairState.Queued, "waiting for a job slot");
            NotifyChanged(job);
            await _jobSlots.WaitAsync(ct).ConfigureAwait(false);
            acquiredSlot = true;

            var repair = options.Value.Repair;
            var context = job.Context;

            // ---------------------------------------------------------- planning
            job.Transition(RepairState.Planning, "loading and validating the PAR2 index");
            NotifyChanged(job);
            if (context.Par2 is null)
            {
                job.Fail(RepairDisposition.Unsupported, "the release carries no PAR2 set");
                return;
            }

            var limits = new Par2ParserLimits
            {
                MaxPacketBytes = repair.MaxPar2PacketBytes,
                MaxSliceSize = repair.MaxPar2SliceBytes,
                MaxFiles = repair.MaxPar2Files,
            };
            var materializer = new RepairSourceMaterializer(repairClient.Client);
            var selection = await SelectPar2SetAsync(
                context, context.Par2, materializer, limits, repair, job, ct).ConfigureAwait(false);
            if (selection.Set is null)
            {
                job.Fail(selection.FailureDisposition, selection.FailureReason!);
                return;
            }
            var set = selection.Set;
            var recoveryFiles = selection.RecoveryFiles;

            // Map every candidate file into the recovery set by declared name.
            var candidateToSet = new int[context.Candidate.Files.Count];
            for (var i = 0; i < context.Candidate.Files.Count; i++)
            {
                var name = context.Candidate.Files[i].GetSubjectFileName();
                var setIndex = FindSetFile(set, name);
                if (setIndex < 0)
                {
                    job.Fail(RepairDisposition.Unsupported, "a media file is not covered by the PAR2 set");
                    return;
                }
                candidateToSet[i] = setIndex;
            }

            long totalSetBytes;
            long workspaceReservationBytes;
            long maxRecoveryWorkspaceBytes;
            try
            {
                totalSetBytes = set.Files.Aggregate(
                    0L,
                    (sum, file) => checked(sum + file.Description.FileLength));
                var worstCaseParityBytes = checked(set.TotalSlices * set.SliceSize);
                var workspaceOverhead = Math.Max(
                    checked(set.SliceSize * 4),
                    repair.MaxPar2IndexBytes);
                maxRecoveryWorkspaceBytes = checked(worstCaseParityBytes + workspaceOverhead);
                workspaceReservationBytes = checked(totalSetBytes + maxRecoveryWorkspaceBytes);
            }
            catch (OverflowException)
            {
                job.Fail(RepairDisposition.LimitsExceeded, "the recovery set exceeds workspace accounting limits");
                return;
            }
            job.SetTotals(totalSetBytes);
            if (totalSetBytes > repair.MaxArtifactBytes)
            {
                job.Fail(RepairDisposition.LimitsExceeded, "the recovery set exceeds the artifact size limit");
                return;
            }
            using var workspaceReservation = workspace.TryReserve(
                workspaceReservationBytes,
                repair.MinFreeDiskBytes);
            if (workspaceReservation is null)
            {
                job.Fail(RepairDisposition.LimitsExceeded, "not enough free disk space in the repair workspace");
                return;
            }

            job.SetDisposition(RepairDisposition.Repairable);
            NotifyChanged(job);

            // ---------------------------------------------------------- materialize sources
            job.Transition(RepairState.MaterializingSources, "downloading available source articles");
            NotifyChanged(job);
            using var staging = workspace.CreateStaging(context.Fingerprint, workspaceReservation);
            var sourceBySetIndex = new SparseRepairFile?[set.Files.Count];
            var damaged = new SortedSet<int>();

            for (var setIndex = 0; setIndex < set.Files.Count; setIndex++)
            {
                ct.ThrowIfCancellationRequested();
                var setFile = set.Files[setIndex];
                var nzbFile = FindNzbFile(context, set, setIndex);
                var sparse = staging.OpenFile(RepairWorkspace.SourceFileName(setIndex), setFile.Description.FileLength);
                sourceBySetIndex[setIndex] = sparse;
                if (nzbFile is null)
                {
                    // A set member missing from the NZB entirely: all of its slices are damage.
                    for (var s = 0; s < setFile.SliceCount; s++)
                        damaged.Add(checked((int)(setFile.GlobalSliceOffset + s)));
                    job.AddEvent("a PAR2 set member is absent from the NZB; treating it as fully damaged");
                    continue;
                }

                var result = await materializer.MaterializeAsync(
                    nzbFile, sparse, repair.MaxConnections,
                    onBytes: b => { job.AddSourceBytes(b); NotifyProgress(job); },
                    ct).ConfigureAwait(false);
                if (result.MissingArticles > 0 || result.CorruptArticles > 0)
                {
                    job.AddEvent(
                        $"source file {setIndex}: {result.MissingArticles} missing / {result.CorruptArticles} corrupt articles");
                }
                foreach (var slice in RepairSourceMaterializer.FindDamagedSlices(set, setIndex, sparse, ct))
                    damaged.Add(slice);
            }

            job.SetDamage(damaged.Count);
            if (damaged.Count > 0)
            {
                var first = damaged.Min;
                var ownerIndex = Enumerable.Range(0, set.Files.Count)
                    .First(i => first < set.Files[i].GlobalSliceOffset + set.Files[i].SliceCount);
                if (!context.Candidate.IsRarWrapped
                    && context.Candidate.Files.Count == 1
                    && ownerIndex == candidateToSet[0])
                {
                    var owner = set.Files[ownerIndex];
                    job.SetFirstDamagedByte((first - owner.GlobalSliceOffset) * set.SliceSize);
                }
            }
            NotifyChanged(job);

            if (damaged.Count == 0)
            {
                job.AddEvent("no damaged slices found after verification");
            }
            else
            {
                // ------------------------------------------------------ recovery slices
                job.Transition(
                    RepairState.DownloadingRecovery,
                    $"{damaged.Count} damaged slice(s); fetching the smallest sufficient parity");
                NotifyChanged(job);

                var recovery = new Dictionary<uint, (SparseRepairFile Volume, Par2RecoverySliceRef Slice)>();
                var volumeIndex = 0;
                long stagedRecoveryBytes = 0;
                foreach (var volume in recoveryFiles)
                {
                    ct.ThrowIfCancellationRequested();
                    var index = volumeIndex++;
                    var length = await ProbeDecodedLengthAsync(volume, ct).ConfigureAwait(false);
                    if (length is null or <= 0)
                    {
                        job.AddEvent($"recovery volume {index} is unreadable; trying the next one");
                        continue;
                    }
                    try
                    {
                        stagedRecoveryBytes = checked(stagedRecoveryBytes + length.Value);
                    }
                    catch (OverflowException)
                    {
                        job.Fail(RepairDisposition.LimitsExceeded, "recovery volume accounting overflowed");
                        return;
                    }
                    if (stagedRecoveryBytes > maxRecoveryWorkspaceBytes)
                    {
                        job.Fail(RepairDisposition.LimitsExceeded, "recovery volumes exceed the workspace budget");
                        return;
                    }
                    var sparse = staging.OpenFile(RepairWorkspace.VolumeFileName(index), length.Value);
                    var result = await materializer.MaterializeAsync(
                        volume, sparse, repair.MaxConnections,
                        onBytes: b => { job.AddParityBytes(b); NotifyProgress(job); },
                        ct).ConfigureAwait(false);
                    var slices = Par2VolumeScanner.ScanRecoverySlices(sparse, set.SetId, set.SliceSize, limits, ct);
                    foreach (var slice in slices)
                    {
                        if (slice.Verified)
                            recovery.TryAdd(slice.Exponent, (sparse, slice));
                    }
                    job.AddEvent(
                        $"recovery volume {index}: {slices.Count} intact slice(s), {result.MissingArticles} missing articles");
                    if (recovery.Count >= damaged.Count
                        && ReedSolomon16.TrySelectIndependentRecoveryExponents(
                            [.. damaged], recovery.Keys.OrderBy(e => e).ToArray(), out _, ct))
                    {
                        break;
                    }
                }

                if (recovery.Count < damaged.Count)
                {
                    job.Fail(
                        RepairDisposition.InsufficientParity,
                        $"only {recovery.Count} intact recovery slice(s) for {damaged.Count} damaged slice(s)");
                    return;
                }

                if (!ReedSolomon16.TrySelectIndependentRecoveryExponents(
                        [.. damaged], recovery.Keys.OrderBy(e => e).ToArray(), out var usedExponents, ct))
                {
                    job.Fail(
                        RepairDisposition.InsufficientParity,
                        "the available recovery slices are not independent for this damage pattern");
                    return;
                }

                // ------------------------------------------------------ reconstruct
                job.SetRecoveryUsed(usedExponents.Length);
                job.Transition(RepairState.Reconstructing, "running GF(2^16) Reed-Solomon reconstruction");
                NotifyChanged(job);
                var io = new WorkspaceBlockIo(set, sourceBySetIndex!.Select(f => f!).ToList(), recovery);
                await engine.ReconstructAsync(
                    set,
                    [.. damaged],
                    usedExponents,
                    io,
                    new Progress<Par2ReconstructionProgress>(p => job.SetReconstruction(p.ProcessedBytes, p.TotalBytes)),
                    ct).ConfigureAwait(false);
            }

            // ---------------------------------------------------------- verify
            job.Transition(RepairState.Verifying, "verifying slices, file hashes and the media projection");
            NotifyChanged(job);
            foreach (var slice in damaged)
            {
                ct.ThrowIfCancellationRequested();
                if (!VerifySlice(set, sourceBySetIndex!, slice))
                {
                    job.Fail(RepairDisposition.InsufficientParity, "a reconstructed slice failed its checksum");
                    return;
                }
            }

            var artifactFiles = new List<RepairArtifactFile>();
            for (var i = 0; i < context.Candidate.Files.Count; i++)
            {
                var setIndex = candidateToSet[i];
                var setFile = set.Files[setIndex];
                var sparse = sourceBySetIndex[setIndex]!;
                var md5 = await Md5OfFileAsync(sparse, ct).ConfigureAwait(false);
                if (!md5.AsSpan().SequenceEqual(setFile.Description.FileMd5))
                {
                    job.Fail(RepairDisposition.InsufficientParity, "a repaired file failed its whole-file MD5");
                    return;
                }
                artifactFiles.Add(new RepairArtifactFile
                {
                    DisplayName = setFile.Description.FileName,
                    RelativePath = RepairWorkspace.SourceFileName(setIndex),
                    Length = setFile.Description.FileLength,
                    Md5Hex = Convert.ToHexString(md5).ToLowerInvariant(),
                });
            }

            var probe = await mediaVerifier.VerifyAsync(
                staging.Directory, artifactFiles, context.Candidate, ct).ConfigureAwait(false);
            if (!probe.Ok)
            {
                job.Fail(RepairDisposition.Unsupported, $"media verification failed: {probe.Reason}");
                return;
            }

            // ---------------------------------------------------------- publish
            var manifest = new RepairArtifactManifest
            {
                Fingerprint = context.Fingerprint,
                ReleaseTitle = job.ReleaseTitle ?? job.ReleaseId,
                SetIdHex = Convert.ToHexString(set.SetId).ToLowerInvariant(),
                SliceSize = set.SliceSize,
                Files = artifactFiles,
                MediaFileDisplayName = probe.MediaFileName ?? context.Candidate.DisplayName,
                IsRarWrapped = context.Candidate.IsRarWrapped,
                MediaSizeBytes = probe.MediaSizeBytes,
                CreatedUtc = _time.GetUtcNow(),
            };
            staging.CloseFiles();
            PruneStagingExtras(staging.Directory, artifactFiles);
            var artifact = artifactCache.Publish(context.Fingerprint, staging.Directory, manifest, ct);
            job.Succeed(artifact);
            metrics?.RepairSucceeded();
            logger.LogInformation(
                "Repair job {JobId} for release {ReleaseId} is ready ({DamagedBlocks} block(s) repaired, {SourceMiB} MiB source, {ParityMiB} MiB parity, {Seconds:F0}s)",
                job.JobId,
                job.ReleaseId,
                job.Snapshot().DamagedBlocks,
                job.Snapshot().SourceBytesDownloaded / 1024 / 1024,
                job.Snapshot().ParityBytesDownloaded / 1024 / 1024,
                (_time.GetUtcNow() - queuedAt).TotalSeconds);
        }
        catch (OperationCanceledException) when (job.CancelToken.IsCancellationRequested)
        {
            job.SetCancelled();
        }
        catch (OperationCanceledException)
        {
            job.Fail(RepairDisposition.LimitsExceeded, "the job exceeded its time budget");
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "Repair job {JobId} failed ({FailureType})",
                job.JobId,
                e.GetType().Name);
            job.Fail(job.Snapshot().Disposition is RepairDisposition.Unknown or RepairDisposition.Repairable
                ? RepairDisposition.LimitsExceeded
                : job.Snapshot().Disposition,
                $"unexpected {e.GetType().Name}");
        }
        finally
        {
            if (acquiredSlot)
                _jobSlots.Release();
        }
    }

    private void FinishJob(RepairJob job)
    {
        var snapshot = job.Snapshot();
        if (!snapshot.IsTerminal)
        {
            job.Fail(RepairDisposition.LimitsExceeded, "the job ended without a terminal state");
            snapshot = job.Snapshot();
        }
        if (snapshot.State == RepairState.Failed)
        {
            metrics?.RepairFailed(snapshot.Disposition.ToString());
            _bookkeeping.RecordFailure(
                job.Fingerprint,
                TimeSpan.FromSeconds(options.Value.Repair.FailureBackoffSeconds));
        }
        else if (snapshot.State == RepairState.Cancelled)
        {
            metrics?.RepairCancelled();
        }
        _activeByFingerprint.TryRemove(new KeyValuePair<string, RepairJob>(job.Fingerprint, job));
        _bookkeeping.TrimReleaseMappings(
            activeFingerprint => _activeByFingerprint.ContainsKey(activeFingerprint));
        _lastProgressNotify.TryRemove(job.JobId, out _);
        RetainFinished(job);
        NotifyChanged(job);
    }

    private void RetainFinished(RepairJob job)
    {
        _finished.Enqueue(job);
        while (_finished.Count > options.Value.Repair.MaxFinishedJobs && _finished.TryDequeue(out _))
        {
        }
    }

    private void EnsureArtifactEventsSubscribed()
    {
        if (Interlocked.Exchange(ref _artifactEventsSubscribed, 1) == 0)
            artifactCache.ArtifactEvicted += MarkArtifactEvicted;
    }

    private void MarkArtifactEvicted(string fingerprint)
    {
        foreach (var job in AllJobs().Where(j => string.Equals(j.Fingerprint, fingerprint, StringComparison.Ordinal)))
        {
            if (job.SetEvicted())
                NotifyChanged(job);
        }
    }

    private void NotifyChanged(RepairJob job)
    {
        try
        {
            JobChanged?.Invoke(job.Snapshot());
        }
        catch
        {
            // observers must never break the pipeline
        }
    }

    private void NotifyProgress(RepairJob job)
    {
        var now = _time.GetTimestamp();
        if (!_lastProgressNotify.TryGetValue(job.JobId, out var last))
        {
            if (_lastProgressNotify.TryAdd(job.JobId, now))
                NotifyChanged(job);
            return;
        }
        if (_time.GetElapsedTime(last, now) < TimeSpan.FromSeconds(1))
            return;
        if (_lastProgressNotify.TryUpdate(job.JobId, now, last))
            NotifyChanged(job);
    }

    private IEnumerable<RepairJob> AllJobs()
        => _activeByFingerprint.Values.Concat(_finished);

    private async Task<Par2SelectionResult> SelectPar2SetAsync(
        RepairJobContext context,
        Par2CompanionFiles companions,
        RepairSourceMaterializer materializer,
        Par2ParserLimits limits,
        RepairOptions repair,
        RepairJob job,
        CancellationToken ct)
    {
        var candidates = companions.IndexCandidates.Count > 0
            ? companions.IndexCandidates
            : [companions.IndexFile];
        var standaloneCandidates = candidates
            .Where(candidate => !RepairNzbAnalyzer.IsRecoveryVolume(candidate))
            .ToList();
        var volumeGroups = candidates
            .Where(RepairNzbAnalyzer.IsRecoveryVolume)
            .GroupBy(RepairNzbAnalyzer.SetStem, StringComparer.OrdinalIgnoreCase)
            .Select(group => new
            {
                Stem = group.Key,
                Members = group
                    .GroupBy(
                        candidate => candidate.GetSubjectFileName(),
                        StringComparer.OrdinalIgnoreCase)
                    .Select(names => names.First())
                    .OrderBy(candidate => candidate.GetTotalYencodedSize())
                    .ThenBy(candidate => candidate.GetSubjectFileName(), StringComparer.OrdinalIgnoreCase)
                    .ToList(),
            })
            .OrderBy(group => group.Members[0].GetTotalYencodedSize())
            .ThenBy(group => group.Stem, StringComparer.OrdinalIgnoreCase)
            .ToList();
        long cumulativeLimit;
        try
        {
            cumulativeLimit = checked(repair.MaxPar2IndexBytes * 4);
        }
        catch (OverflowException)
        {
            return Par2SelectionResult.Failed(
                RepairDisposition.LimitsExceeded,
                "the PAR2 index candidate budget is invalid");
        }

        var parsedAny = false;
        var retrievedAny = false;
        var unavailableAny = false;
        var invalidAny = false;
        var attempts = 0;
        long cumulativeBytes = 0;
        var seenSetIds = new HashSet<string>(StringComparer.Ordinal);
        var knownLengths = new Dictionary<NzbFile, long?>();
        var coveringSets = new List<CoveringPar2Set>();
        var successfullyParsedStems = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        async Task<(bool BoundExceeded, Par2SetInfo? Parsed)> TryParseCandidateAsync(NzbFile candidate)
        {
            if (attempts >= MaxPar2IndexCandidates)
                return (true, null);
            var remaining = cumulativeLimit - cumulativeBytes;
            if (remaining <= 0)
                return (true, null);

            attempts++;
            var candidateLimit = Math.Min(repair.MaxPar2IndexBytes, remaining);
            byte[] indexBytes;
            try
            {
                indexBytes = await materializer.DownloadSmallFileAsync(
                    candidate, candidateLimit, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (UsenetArticleNotFoundException)
            {
                unavailableAny = true;
                return (false, null);
            }
            catch (InvalidOperationException) when (candidateLimit < repair.MaxPar2IndexBytes)
            {
                return (true, null);
            }
            catch (Exception e) when (e is InvalidDataException or InvalidOperationException or OverflowException)
            {
                invalidAny = true;
                return (false, null);
            }
            catch (Exception e) when (e is UsenetException or TimeoutException or IOException)
            {
                unavailableAny = true;
                return (false, null);
            }

            retrievedAny = true;
            cumulativeBytes = checked(cumulativeBytes + indexBytes.LongLength);
            job.AddParityBytes(indexBytes.Length);

            Par2SetInfo parsed;
            try
            {
                parsed = Par2SetParser.Parse(indexBytes, limits, ct);
            }
            catch (Par2FormatException)
            {
                invalidAny = true;
                return (false, null);
            }

            parsedAny = true;
            return (false, parsed);
        }

        async Task RecordParsedSetAsync(Par2SetInfo parsed, NzbFile candidate)
        {
            var setId = Convert.ToHexString(parsed.SetId);
            if (!seenSetIds.Add(setId))
                return;
            var coverage = await GetCandidateCoverageAsync(
                parsed, context.Candidate, knownLengths, ct).ConfigureAwait(false);
            if (coverage is null)
                return;
            coveringSets.Add(new CoveringPar2Set(
                parsed,
                candidate,
                coverage.ExactLengthMatch,
                coverage.Identity));
        }

        var boundExceeded = false;
        foreach (var candidate in standaloneCandidates)
        {
            var attempt = await TryParseCandidateAsync(candidate).ConfigureAwait(false);
            if (attempt.BoundExceeded)
            {
                boundExceeded = true;
                break;
            }
            if (attempt.Parsed is null)
                continue;
            successfullyParsedStems.Add(RepairNzbAnalyzer.SetStem(candidate));
            await RecordParsedSetAsync(attempt.Parsed, candidate).ConfigureAwait(false);
        }

        if (!boundExceeded)
        {
            foreach (var group in volumeGroups)
            {
                if (successfullyParsedStems.Contains(group.Stem))
                    continue;

                foreach (var candidate in group.Members)
                {
                    var attempt = await TryParseCandidateAsync(candidate).ConfigureAwait(false);
                    if (attempt.BoundExceeded)
                    {
                        boundExceeded = true;
                        break;
                    }
                    if (attempt.Parsed is null)
                        continue;
                    successfullyParsedStems.Add(group.Stem);
                    await RecordParsedSetAsync(attempt.Parsed, candidate).ConfigureAwait(false);
                    break;
                }

                if (boundExceeded)
                    break;
            }
        }

        if (boundExceeded)
        {
            return Par2SelectionResult.Failed(
                RepairDisposition.LimitsExceeded,
                "the PAR2 index candidate budget was exhausted");
        }

        if (coveringSets.Count > 0)
        {
            var exact = coveringSets.Where(item => item.ExactLengthMatch).ToList();
            var eligible = exact.Count > 0 ? exact : coveringSets;
            if (eligible.Select(item => item.Identity).Distinct(StringComparer.Ordinal).Take(2).Count() > 1)
            {
                return Par2SelectionResult.Failed(
                    RepairDisposition.Unsupported,
                    "multiple incompatible PAR2 sets cover the selected media files");
            }
            var selected = eligible[0];
            return Par2SelectionResult.Succeeded(
                selected.Set,
                RepairNzbAnalyzer.OrderRecoveryFiles(companions.AllFiles, selected.IndexFile));
        }

        if (parsedAny)
        {
            return Par2SelectionResult.Failed(
                RepairDisposition.Unsupported,
                "no PAR2 set covers the selected media files");
        }
        if (retrievedAny || invalidAny)
        {
            return Par2SelectionResult.Failed(
                RepairDisposition.Unsupported,
                "the available PAR2 indexes are invalid");
        }
        return Par2SelectionResult.Failed(
            RepairDisposition.Unsupported,
            unavailableAny
                ? "the PAR2 indexes are not retrievable"
                : "the release carries no usable PAR2 index");
    }

    private async Task<Par2CandidateCoverage?> GetCandidateCoverageAsync(
        Par2SetInfo set,
        MediaFileCandidate candidate,
        Dictionary<NzbFile, long?> knownLengths,
        CancellationToken ct)
    {
        var exactLengthMatch = true;
        var identity = new List<string>(candidate.Files.Count);
        foreach (var file in candidate.Files)
        {
            var setIndex = FindSetFile(set, file.GetSubjectFileName());
            if (setIndex < 0)
                return null;
            if (!knownLengths.TryGetValue(file, out var decodedLength))
            {
                decodedLength = await ProbeDecodedLengthAsync(file, ct).ConfigureAwait(false);
                knownLengths[file] = decodedLength;
            }
            var description = set.Files[setIndex].Description;
            if (decodedLength is > 0 && decodedLength.Value != description.FileLength)
            {
                return null;
            }
            if (decodedLength is null or <= 0)
                exactLengthMatch = false;
            identity.Add(string.Join(
                ':',
                description.FileLength,
                description.FileId.ToString(),
                Convert.ToHexString(description.FileMd5)));
        }
        return new Par2CandidateCoverage(exactLengthMatch, string.Join('|', identity));
    }

    private sealed record Par2CandidateCoverage(bool ExactLengthMatch, string Identity);

    private sealed record CoveringPar2Set(
        Par2SetInfo Set,
        NzbFile IndexFile,
        bool ExactLengthMatch,
        string Identity);

    private sealed record Par2SelectionResult(
        Par2SetInfo? Set,
        IReadOnlyList<NzbFile> RecoveryFiles,
        RepairDisposition FailureDisposition,
        string? FailureReason)
    {
        public static Par2SelectionResult Succeeded(
            Par2SetInfo set,
            IReadOnlyList<NzbFile> recoveryFiles)
            => new(set, recoveryFiles, RepairDisposition.Unknown, null);

        public static Par2SelectionResult Failed(RepairDisposition disposition, string reason)
            => new(null, [], disposition, reason);
    }

    private static int FindSetFile(Par2SetInfo set, string? name)
    {
        if (string.IsNullOrEmpty(name))
            return -1;
        for (var i = 0; i < set.Files.Count; i++)
        {
            if (string.Equals(set.Files[i].Description.FileName, name, StringComparison.OrdinalIgnoreCase))
                return i;
        }
        return -1;
    }

    private static NzbFile? FindNzbFile(RepairJobContext context, Par2SetInfo set, int setIndex)
    {
        var name = set.Files[setIndex].Description.FileName;
        return context.Document.Files.FirstOrDefault(
            f => string.Equals(f.GetSubjectFileName(), name, StringComparison.OrdinalIgnoreCase));
    }

    private async Task<long?> ProbeDecodedLengthAsync(NzbFile file, CancellationToken ct)
        => await ProbeDecodedLengthAsync(file, repairClient.Client, ct).ConfigureAwait(false);

    internal static async Task<long?> ProbeDecodedLengthAsync(
        NzbFile file,
        INntpClient client,
        CancellationToken ct)
    {
        foreach (var segment in SelectDecodedLengthProbeSegments(file))
        {
            try
            {
                var headers = await client.GetYencHeadersAsync(segment.MessageId, ct).ConfigureAwait(false);
                if (headers.FileSize > 0)
                    return headers.FileSize;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception e) when (e is UsenetException or TimeoutException or IOException)
            {
            }
        }
        return null;
    }

    internal static IReadOnlyList<NzbSegment> SelectDecodedLengthProbeSegments(
        NzbFile file,
        int maxProbes = MaxDecodedLengthProbes)
    {
        if (maxProbes <= 0 || file.Segments.Count == 0)
            return [];
        if (file.Segments.Count <= maxProbes)
            return [.. file.Segments];

        var selected = new List<NzbSegment>(maxProbes);
        var leading = Math.Min(3, maxProbes);
        for (var i = 0; i < leading; i++)
            selected.Add(file.Segments[i]);

        var remaining = maxProbes - leading;
        var tailLength = file.Segments.Count - leading;
        for (var i = 0; i < remaining; i++)
        {
            var offset = (int)((checked((long)(i + 1) * tailLength) - 1) / remaining);
            selected.Add(file.Segments[leading + offset]);
        }
        return selected;
    }

    private static bool VerifySlice(Par2SetInfo set, SparseRepairFile?[] files, int globalIndex)
    {
        for (var i = 0; i < set.Files.Count; i++)
        {
            var file = set.Files[i];
            if (globalIndex >= file.GlobalSliceOffset + file.SliceCount)
                continue;
            var slice = (int)(globalIndex - file.GlobalSliceOffset);
            var buffer = new byte[set.SliceSize];
            var start = slice * set.SliceSize;
            var length = (int)Math.Min(set.SliceSize, file.Description.FileLength - start);
            files[i]!.ReadAt(start, buffer.AsSpan(0, length));
            return System.Security.Cryptography.MD5.HashData(buffer).AsSpan()
                .SequenceEqual(file.Checksums.Slices[slice].Md5);
        }
        return false;
    }

    private static async Task<byte[]> Md5OfFileAsync(SparseRepairFile file, CancellationToken ct)
    {
        using var md5 = System.Security.Cryptography.IncrementalHash.CreateHash(
            System.Security.Cryptography.HashAlgorithmName.MD5);
        var buffer = new byte[1024 * 1024];
        long offset = 0;
        while (offset < file.Length)
        {
            ct.ThrowIfCancellationRequested();
            var take = (int)Math.Min(buffer.Length, file.Length - offset);
            file.ReadAt(offset, buffer.AsSpan(0, take));
            md5.AppendData(buffer.AsSpan(0, take));
            offset += take;
        }
        await Task.CompletedTask;
        return md5.GetHashAndReset();
    }

    private void PruneStagingExtras(string stagingDirectory, IReadOnlyList<RepairArtifactFile> keep)
    {
        var keepNames = keep.Select(f => f.RelativePath)
            .Append(RepairWorkspace.ManifestFileName)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var path in Directory.EnumerateFiles(stagingDirectory))
        {
            if (!keepNames.Contains(Path.GetFileName(path)))
                File.Delete(path);
        }
    }
}

/// <summary>Everything a job needs, derived deterministically from the NZB.</summary>
public sealed record RepairJobContext
{
    public required string ReleaseId { get; init; }
    public required NzbDocument Document { get; init; }
    public required MediaFileCandidate Candidate { get; init; }
    public required Par2CompanionFiles? Par2 { get; init; }
    public required string Fingerprint { get; init; }
}
