using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Transcoding;

public sealed class TranscodeException(string code, string message, int statusCode) : Exception(message)
{
    public string Code { get; } = code;
    public int StatusCode { get; } = statusCode;
}

/// <summary>
/// Owns live transcode sessions and their ffmpeg runs: serves segments that exist, waits for the ones being produced,
/// restarts ffmpeg on seeks, throttles runs that race ahead, and reaps idle work.
/// </summary>
public sealed class TranscodeSessionManager(
    TranscodingSettingsService settingsService,
    FfmpegCapabilityService capabilityService,
    SourceMediaProber prober,
    KeyframeIndexService keyframes,
    TranscodingWorkspace workspace,
    IOptions<TranscodingOptions> options,
    ILogger<TranscodeSessionManager> logger) : BackgroundService
{
    private const double SeekGapSeconds = 24;

    /// <summary>Another requester's request back into the replaced run's range waits until the current position was not requested for this long.</summary>
    internal static readonly TimeSpan ContendedWindow = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ContendedPoll = TimeSpan.FromMilliseconds(200);
    private const long MinimumFreeBytes = 2L * 1024 * 1024 * 1024;
    private static readonly TimeSpan ProbeCacheTtl = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, TranscodeSession> _sessions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, SourceMediaInfo Media)> _probeCache = new(StringComparer.Ordinal);
    private long _ticks;

    public IReadOnlyCollection<TranscodeSession> Sessions => _sessions.Values.ToList();

    public bool TryGet(string id, out TranscodeSession session)
    {
        if (id.Length is > 0 and <= 96 && _sessions.TryGetValue(id, out var found) && !found.Closed)
        {
            session = found;
            return true;
        }
        session = null!;
        return false;
    }

    public TranscodeSession? FindByHandle(string handle)
        => _sessions.Values.FirstOrDefault(s => string.Equals(s.Handle, handle, StringComparison.Ordinal));

    public int RunningJobs => _sessions.Values.Count(s => s.Job is { HasExited: false });

    /// <summary>Explains direct → remux → transcode for this client without starting ffmpeg (a remux candidate gets its keyframe index).</summary>
    public async Task<(SourceMediaInfo Media, TranscodePlan Plan, TranscodingSettings Settings, FfmpegCapabilities Capabilities)> PlanAsync(
        TranscodeSource source, ClientProfile client, TranscodeLimits limits, ModePreference preference, CancellationToken ct)
    {
        var planned = await PlanTimedAsync(source, client, limits, preference, allowDirect: true, ct);
        return (planned.Media, planned.Plan, planned.Settings, planned.Capabilities);
    }

    /// <summary>The full probe a plan uses (cached per source for 10 minutes); null when ffprobe cannot read it.</summary>
    public async Task<SourceMediaInfo?> ProbeSourceAsync(TranscodeSource source, CancellationToken ct)
    {
        try
        {
            return await ProbeAsync(source, ct);
        }
        catch (TranscodeException e) when (e.Code == "probe_failed")
        {
            return null;
        }
    }

    /// <summary>Runs the full probe for a resolve and keeps it for the plan; returns ffprobe's JSON (null when it failed).</summary>
    public async Task<string?> ProbeForResolveAsync(TranscodeSource source, CancellationToken ct)
    {
        var (media, json) = await prober.ProbeRawAsync(source, ct);
        if (media is not null)
            _probeCache[source.Input] = (DateTimeOffset.UtcNow, media);
        return media is null ? null : json;
    }

    private sealed record TimedPlan(
        SourceMediaInfo Media, TranscodePlan Plan, TranscodingSettings Settings, FfmpegCapabilities Capabilities,
        double CapabilitiesMs, double ProbeMs, bool ProbeCached, double PlanMs);

    private async Task<TimedPlan> PlanTimedAsync(
        TranscodeSource source, ClientProfile client, TranscodeLimits limits, ModePreference preference, bool allowDirect, CancellationToken ct)
    {
        var settings = settingsService.Current;
        if (!settings.Enabled)
            throw new TranscodeException("transcoding_disabled", "Server-side transcoding is disabled in the settings.", 409);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var capabilities = await capabilityService.GetAsync(ct);
        var capabilitiesMs = clock.Elapsed.TotalMilliseconds;
        if (!capabilities.Usable)
        {
            throw new TranscodeException("ffmpeg_unavailable",
                capabilities.Error ?? "The installed ffmpeg cannot transcode (needs ffmpeg ≥ 5 with libx264 and aac).", 503);
        }

        var cached = IsProbeCached(source);
        var media = await ProbeAsync(source, ct);
        var probeMs = clock.Elapsed.TotalMilliseconds - capabilitiesMs;
        try
        {
            var plan = TranscodePlanner.Decide(media, client, limits, settings, capabilities, preference, allowDirect);
            if (plan.Mode == DeliveryMode.Remux)
            {
                var index = await keyframes.GetAsync(source, media, ct);
                plan = index.Index is { } found
                    ? TranscodePlanner.FinalizeRemux(plan, media, found, found.Container.TotalBytes)
                    : TranscodePlanner.Decide(media, client, limits, settings, capabilities, preference, allowDirect,
                        PlanReason.Of("keyframe_index_unavailable", $"No keyframe index for a stream copy: {index.Error}.", ("detail", index.Error)));
            }
            var planMs = clock.Elapsed.TotalMilliseconds - capabilitiesMs - probeMs;
            return new TimedPlan(media, plan, settings, capabilities, capabilitiesMs, probeMs, cached, planMs);
        }
        catch (TranscodePlanningException e)
        {
            throw new TranscodeException(e.Code, e.Message, 422);
        }
    }

    public async Task<TranscodeSession> CreateAsync(
        TranscodeSource source,
        string title,
        ClientProfile client,
        TranscodeLimits limits,
        string clientLabel,
        double startPositionSeconds,
        CancellationToken ct,
        ModePreference preference = ModePreference.Transcode)
    {
        var requestedAt = DateTimeOffset.UtcNow;
        var planned = await PlanTimedAsync(source, client, limits, preference, allowDirect: false, ct);
        var (media, plan, settings, capabilities) = (planned.Media, planned.Plan, planned.Settings, planned.Capabilities);
        if (preference == ModePreference.Remux && plan.Mode != DeliveryMode.Remux)
        {
            throw new TranscodeException("remux_not_possible",
                $"A stream copy is not possible: {string.Join(" ", plan.RemuxBlockers.Select(r => r.Message))}", 422);
        }
        EnsureDiskSpace();
        await EnsureSessionSlotAsync();

        var timeline = plan.Mode == DeliveryMode.Remux && plan.RemuxTimeline is { } keyframeTimeline
            ? keyframeTimeline
            : SegmentTimeline.Create(plan.DurationSeconds, settings.SegmentLengthSeconds);
        var id = TranscodeSession.NewId();
        var session = new TranscodeSession(
            id, source, media, plan, timeline, settings, capabilities,
            workspace.CreateSessionDirectory(id), clientLabel, title);
        _sessions[id] = session;
        if (plan.Mode == DeliveryMode.Remux)
        {
            logger.LogInformation(
                "Remux session {Handle} created for {Client}: {Codecs} {Height}p {Range}, {Segments} keyframe-aligned segments from {Index}, audio {Audio}, {Subtitles} WebVTT rendition(s)",
                session.Handle, clientLabel, plan.CodecsAttribute, plan.SourceVideo.Height, plan.VideoRange, timeline.Count,
                plan.KeyframeIndex?.Source.ToApi(), plan.Audio is { } a ? (a.Copy ? $"copy {a.Codec}" : $"{a.SourceCodec} → {a.Codec} {a.Channels} ch") : "none",
                session.Subtitles.Count);
        }
        else
        {
            logger.LogInformation(
                "Transcode session {Handle} created for {Client}: {SourceCodec} {SourceHeight}p → {Codec} {Height}p @ {Bitrate} kbps via {Encoder} (hw decode {HwDecode}, tone map {ToneMap})",
                session.Handle, clientLabel, plan.SourceVideo.Codec, plan.SourceVideo.Height, plan.Video.Codec, plan.Video.Height,
                plan.Video.BitrateKbps, plan.Encoder, plan.HardwareDecode, plan.ToneMap);
        }

        var start = plan.Mode == DeliveryMode.Remux
            ? timeline.IndexAt(Math.Max(0, startPositionSeconds))
            : Math.Clamp((int)Math.Floor(Math.Max(0, startPositionSeconds) / timeline.SegmentLength), 0, timeline.Count - 1);
        await session.Gate.WaitAsync(CancellationToken.None);
        var spawnClock = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            // A caller that went away (superseded playback revision) must not take a run slot.
            ct.ThrowIfCancellationRequested();
            await StartJobLockedAsync(session, start);
            session.Startup = new TranscodeStartup(
                requestedAt, planned.CapabilitiesMs, planned.ProbeMs, planned.ProbeCached, planned.PlanMs,
                spawnClock.Elapsed.TotalMilliseconds);
        }
        catch
        {
            session.Gate.Release();
            await CloseAsync(session, "failed to start");
            throw;
        }
        session.Gate.Release();
        return session;
    }

    /// <param name="requester">Who asks (a player's playlist tag or its address); one requester's own seeks never wait for each other.</param>
    public async Task<string> GetSegmentAsync(TranscodeSession session, int index, CancellationToken ct, string requester = "")
    {
        if (index < 0 || index >= session.Timeline.Count)
            throw new TranscodeException("unknown_segment", "The segment is outside this rendition.", 404);
        session.NoteRequested(index);
        var ticket = session.NoteRequester(requester, index);
        var path = session.SegmentPath(index);
        var deadline = WaitDeadline();

        for (var attempt = 0; attempt < 4 && DateTimeOffset.UtcNow < deadline; attempt++)
        {
            if (File.Exists(path))
            {
                NoteFirstSegment(session);
                if (session.Job is { } current && index >= current.StartSegment)
                    session.UseRun(requester);
                await ResumeParkedAsync(session);
                return path;
            }

            TranscodeJob? job;
            await session.Gate.WaitAsync(ct);
            try
            {
                if (session.Closed)
                    throw new TranscodeException("session_closed", "The transcode session was closed.", 410);
                if (File.Exists(path))
                    return path;
                job = await EnsureJobForSegmentLockedAsync(session, index, requester, ticket);
            }
            finally
            {
                session.Gate.Release();
            }

            if (job is null)
            {
                attempt--;
                await Task.Delay(ContendedPoll, ct);
                continue;
            }
            if (await WaitForAsync(session, job, () => File.Exists(path), deadline, ct, requester))
                return path;
        }
        if (DateTimeOffset.UtcNow >= deadline)
            throw SegmentTimeout();
        throw new TranscodeException("segment_unavailable", "The segment could not be produced.", 503);
    }

    public async Task<byte[]> GetInitAsync(TranscodeSession session, CancellationToken ct)
    {
        var deadline = WaitDeadline();
        for (var attempt = 0; attempt < 4 && session.InitSegment is null && DateTimeOffset.UtcNow < deadline; attempt++)
        {
            TranscodeJob job;
            await session.Gate.WaitAsync(ct);
            try
            {
                if (session.Closed)
                    throw new TranscodeException("session_closed", "The transcode session was closed.", 410);
                if (session.InitSegment is not null)
                    break;
                job = session.Job is { } current && !current.Failed && (!current.HasExited || current.InitReady())
                    ? current
                    : await StartJobLockedAsync(session, Math.Max(0, session.LastRequestedSegment));
            }
            finally
            {
                session.Gate.Release();
            }

            if (await WaitForAsync(session, job, job.InitReady, deadline, ct))
            {
                NoteFirstSegment(session);
                var bytes = await File.ReadAllBytesAsync(Path.Combine(session.Directory, job.InitFileName), ct);
                if (bytes.Length > 0)
                    session.InitSegment ??= Fmp4.NormalizeInit(bytes);
            }
        }
        session.Touch();
        if (session.InitSegment is null && DateTimeOffset.UtcNow >= deadline)
            throw SegmentTimeout();
        return session.InitSegment ?? throw new TranscodeException("init_unavailable", "The initialization segment could not be produced.", 503);
    }

    public async Task CloseAsync(TranscodeSession session, string reason)
    {
        if (!_sessions.TryRemove(session.Id, out _))
            return;
        session.Closed = true;
        await session.Gate.WaitAsync();
        try
        {
            if (session.Job is { } job)
                await job.KillAsync();
        }
        finally
        {
            session.Gate.Release();
        }
        TranscodingWorkspace.TryDelete(session.Directory);
        logger.LogInformation("Transcode session {Handle} closed ({Reason})", session.Handle, reason);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            workspace.ResetVolatileState();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            logger.LogWarning(e, "Could not prepare the transcoding workspace at {Path}", workspace.Root);
        }

        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(Math.Max(100, options.Value.MaintenanceIntervalMilliseconds)));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await MaintainAsync();
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    logger.LogWarning(e, "Transcode maintenance pass failed");
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
        foreach (var session in _sessions.Values.ToList())
            await CloseAsync(session, "server stopping");
    }

    internal async Task MaintainAsync()
    {
        var settings = settingsService.Current;
        var now = DateTimeOffset.UtcNow;
        var retentionPass = Interlocked.Increment(ref _ticks) % 15 == 0;

        foreach (var session in _sessions.Values.ToList())
        {
            var idle = now - session.LastAccessAt;
            if (idle > TimeSpan.FromSeconds(settings.SessionIdleTimeoutSeconds))
            {
                await CloseAsync(session, "idle");
                continue;
            }

            if (session.Job is { HasExited: false } job)
            {
                job.SampleCpu();
                if (idle > TimeSpan.FromSeconds(settings.JobIdleTimeoutSeconds))
                {
                    await KillJobAsync(session, job, "no segment requests");
                }
                else if (settings.ThrottleEnabled && SecondsAhead(session, job) > settings.ThrottleBufferSeconds)
                {
                    await ParkAsync(session, job);
                }
            }
            else
            {
                await ResumeParkedAsync(session);
            }

            if (retentionPass)
                ApplyRetention(session, settings);
        }
        PruneProbeCache(now);
    }

    private static int Gap(TranscodeSession session) => Math.Max(2, (int)Math.Ceiling(SeekGapSeconds / session.Timeline.SegmentLength));

    /// <summary>The run serving <paramref name="index"/>, or null to wait (superseded by its own player, contended by another, or restart paced).</summary>
    private async Task<TranscodeJob?> EnsureJobForSegmentLockedAsync(TranscodeSession session, int index, string requester, long ticket)
    {
        var job = session.Job;
        var gap = Gap(session);
        if (job is not null && !job.HasExited && index >= job.StartSegment)
        {
            var front = job.Front();
            // A segment behind the front that is gone was evicted by retention: this run will never write it again.
            var evicted = index < front && !File.Exists(session.SegmentPath(index));
            if (!evicted && index <= front + gap)
            {
                session.UseRun(requester);
                return job;
            }
        }

        if (job is not null && !(job.Parked && index == job.Front()))
        {
            if (session.Superseded(requester, ticket, index, gap))
                return null;
            if (session.ReplacedRun is { } replaced && index >= replaced.Start - gap && index <= replaced.End + gap
                && session.RunRequester != requester && DateTimeOffset.UtcNow - session.RunRequestedAt < ContendedWindow)
            {
                return null;
            }
            if (!session.TryTakeRestart(DateTimeOffset.UtcNow))
                return null;
            session.ReplacedRun = (job.StartSegment, job.Front());
        }
        session.UseRun(requester);

        if (job is { Failed: true } failed && failed.StartSegment == index && (DateTimeOffset.UtcNow - failed.StartedAt) < TimeSpan.FromSeconds(30))
        {
            session.LastError = failed.ErrorSummary();
            throw new TranscodeException("transcode_failed", $"ffmpeg failed: {session.LastError}", 500);
        }
        return await StartJobLockedAsync(session, index);
    }

    private async Task<TranscodeJob> StartJobLockedAsync(TranscodeSession session, int startSegment)
    {
        var reserved = session.Job is { Parked: true } && session.Reserved(DateTimeOffset.UtcNow);
        session.ReleaseReservation();
        var continuation = PreviousSegmentEnds(session, startSegment);
        if (session.Job is { } previous)
        {
            CoverTranscodedSubtitles(session);
            await previous.KillAsync();
            // Resuming a parked run where it stopped is throttling, not a restart.
            if (!(previous.Parked && previous.Front() == startSegment))
                session.NoteRestart();
        }
        if (!reserved)
            await EnsureCapacityAsync(session);

        session.JobSequence++;
        var remux = session.Mode == DeliveryMode.Remux;
        var sourceAudio = session.Media.Audio.FirstOrDefault(a => a.Index == session.Plan.Audio?.SourceIndex);
        var spec = new FfmpegJobSpec
        {
            Plan = session.Plan,
            Source = session.Source,
            Settings = session.Settings,
            Capabilities = session.Capabilities,
            OutputDirectory = session.Directory,
            JobTag = session.JobSequence.ToString(System.Globalization.CultureInfo.InvariantCulture),
            SegmentLength = session.Timeline.SegmentLength,
            StartSegment = startSegment,
            SeekSeconds = remux && startSegment > 0 ? RemuxSeek(session, startSegment) : null,
            AudioStartSeconds = sourceAudio?.StartTime is { } audioStart ? Math.Max(0, audioStart - session.Media.StartTime) : 0,
            SourceAudioSampleRate = sourceAudio?.SampleRate,
            SeekMarginSeconds = continuation is null ? 0 : Math.Max(2, session.Timeline.SegmentLength),
            VideoContinueSeconds = continuation?.Video,
            AudioContinueSeconds = continuation?.Audio,
        };
        var job = remux
            ? TranscodeJob.Start(options.Value.FfmpegPath, FfmpegArgumentBuilder.Build(spec), session.Directory, spec.JobTag, startSegment,
                (running, stdout) => CreateSegmenter(session, spec, running).RunAsync(stdout, running.ExitedCleanlyAsync, CancellationToken.None))
            : TranscodeJob.Start(options.Value.FfmpegPath, FfmpegArgumentBuilder.Build(spec), session.Directory, spec.JobTag, startSegment);
        session.Job = job;
        logger.LogDebug("Transcode {Handle} run {Run} started at segment {Segment}", session.Handle, spec.JobTag, startSegment);
        return job;
    }

    /// <summary>Video trim point (half a frame past the last frame) and audio ends of the transcoded segment before <paramref name="segment"/>, or null.</summary>
    private (double Video, IReadOnlyList<double> Audio)? PreviousSegmentEnds(TranscodeSession session, int segment)
    {
        if (session.Mode != DeliveryMode.Transcode || segment <= 0)
            return null;
        try
        {
            var path = session.SegmentPath(segment - 1);
            var initPath = session.Job is { } job ? Path.Combine(session.Directory, job.InitFileName) : null;
            var initBytes = session.InitSegment ?? (initPath is not null && File.Exists(initPath) ? File.ReadAllBytes(initPath) : null);
            if (initBytes is null || !File.Exists(path))
                return null;
            var init = Fmp4.ParseInit(initBytes);
            var parsed = Fmp4.ParseSegment(File.ReadAllBytes(path), init);
            var fragments = parsed.Fragments;
            var expected = session.Plan.DemuxedAudio ? session.Plan.AudioRenditions.Count : session.Plan.Audio is null ? 0 : 1;
            var tracks = init.Tracks.Where(t => t.Handler == "soun" && t.Timescale > 0).OrderBy(t => t.TrackId).ToList();
            if (tracks.Count != expected
                || parsed.Timings(init).FirstOrDefault(t => t.Handler == "vide") is not { Samples: > 0 } video)
                return null;
            var start = session.Timeline.StartOf(segment);
            var cut = video.StartSeconds + video.DurationSeconds - video.DurationSeconds / video.Samples / 2;
            var ends = tracks.Select(t => fragments.Where(f => f.TrackId == t.TrackId)
                .Select(f => (double)(f.BaseDecodeTime + f.Duration) / t.Timescale).DefaultIfEmpty(double.NaN).Max()).ToList();
            // A plausible end lies within a frame or two of the boundary; anything else (or a wrapped negative time) keeps the plain restart.
            return Math.Abs(cut - start) < 1 && ends.All(e => Math.Abs(e - start) < 1) ? (cut, ends) : null;
        }
        catch (Exception e) when (e is IOException or InvalidDataException or ArgumentOutOfRangeException or IndexOutOfRangeException)
        {
            logger.LogDebug(e, "Transcode {Handle} could not read segment {Segment} to continue after it", session.Handle, segment - 1);
            return null;
        }
    }

    private RemuxSegmenter CreateSegmenter(TranscodeSession session, FfmpegJobSpec spec, TranscodeJob job)
    {
        var keyframes = OutputKeyframes(session);
        var minGap = keyframes.Zip(keyframes.Skip(1), (a, b) => b - a).Where(g => g > 0).DefaultIfEmpty(1).Min();
        var last = session.Timeline.Count - 1;
        return new RemuxSegmenter(
            session.Directory, spec.InitFileName, session.Timeline, spec.StartSegment, Math.Clamp(minGap * 0.4, 0.001, 0.05),
            session.AdoptRemuxInit,
            (runStart, segment) => session.CoverSubtitles(runStart, segment == last ? last : segment - 2),
            job.ReportOutput,
            logger);
    }

    /// <summary>A restart begins one keyframe early: open-GOP leading pictures of the target keyframe keep their references, and the segmenter drops the pre-roll.</summary>
    private static double RemuxSeek(TranscodeSession session, int segment)
    {
        var start = session.Timeline.StartOf(segment);
        var keyframes = OutputKeyframes(session);
        var previous = keyframes.LastOrDefault(k => k < start - 1e-6, double.NaN);
        return double.IsNaN(previous) || previous < 0
            ? FfmpegArgumentBuilder.RemuxSeekSeconds(start, keyframes.FirstOrDefault(k => k > start + 1e-6, double.NaN) is var next && double.IsNaN(next) ? null : next)
            : FfmpegArgumentBuilder.RemuxSeekSeconds(previous, start);
    }

    private static IReadOnlyList<double> OutputKeyframes(TranscodeSession session)
        => session.Plan.KeyframeIndex?.Keyframes.Select(k => k - session.Media.StartTime).ToList() ?? [];

    /// <summary>A WebVTT segment; like a video segment it starts or restarts the copy when no live run will demux its cues, then waits for them.</summary>
    /// <remarks>A transcode run is never restarted backwards for subtitles (an encoder restart costs seconds); such a segment gets the cues known so far.</remarks>
    public async Task<string> GetSubtitleSegmentAsync(TranscodeSession session, int streamIndex, int index, CancellationToken ct, string requester = "")
    {
        var track = session.Subtitles.FirstOrDefault(t => t.StreamIndex == streamIndex)
                    ?? throw new TranscodeException("unknown_subtitle_stream", "This session has no such subtitle rendition.", 404);
        if (index < 0 || index >= session.Timeline.Count)
            throw new TranscodeException("unknown_segment", "The segment is outside this rendition.", 404);
        session.Touch();
        var ticket = session.NoteRequester(requester, index);

        bool Covered()
        {
            CoverTranscodedSubtitles(session);
            return session.SubtitlesCovered(index);
        }

        var deadline = WaitDeadline();
        for (var attempt = 0; attempt < 4 && !Covered() && DateTimeOffset.UtcNow < deadline; attempt++)
        {
            TranscodeJob? job;
            await session.Gate.WaitAsync(ct);
            try
            {
                if (session.Closed)
                    throw new TranscodeException("session_closed", "The transcode session was closed.", 410);
                if (Covered())
                    break;
                if (session.Mode == DeliveryMode.Transcode && session.Job is { HasExited: false } running && index < running.StartSegment)
                    break;
                job = await EnsureJobForSegmentLockedAsync(session, index, requester, ticket);
            }
            finally
            {
                session.Gate.Release();
            }

            if (job is null)
            {
                attempt--;
                await Task.Delay(ContendedPoll, ct);
                continue;
            }
            try
            {
                if (await WaitForAsync(session, job, Covered, deadline, ct, requester))
                    break;
            }
            catch (TranscodeException e) when (e.Code == "end_of_stream")
            {
                break;
            }
        }
        track.Refresh(session.Directory);
        return WebVttSubtitles.Segment(track.Between(session.Timeline.StartOf(index), session.Timeline.EndOf(index)));
    }

    /// <summary>A transcode run has demuxed the cues of every segment two behind its front, and all of them once it ended cleanly.</summary>
    private static void CoverTranscodedSubtitles(TranscodeSession session)
    {
        if (session.Mode != DeliveryMode.Transcode || session.Subtitles.Count == 0 || session.Job is not { } job)
            return;
        var last = job is { HasExited: true, Killed: false, ExitCode: 0 } ? session.Timeline.Count - 1 : job.Front() - 2;
        session.CoverSubtitles(job.StartSegment, last);
    }

    /// <summary>One wait budget per request across restarts, so the answer comes before the player's own timeout.</summary>
    private DateTimeOffset WaitDeadline() => DateTimeOffset.UtcNow.AddSeconds(Math.Max(5, options.Value.SegmentWaitTimeoutSeconds));

    private static TranscodeException SegmentTimeout()
        => new("segment_timeout", "The transcoder did not produce the segment in time.", 504);

    private async Task<bool> WaitForAsync(
        TranscodeSession session, TranscodeJob job, Func<bool> ready, DateTimeOffset deadline, CancellationToken ct, string? requester = null)
    {
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (ready())
                return true;
            if (!ReferenceEquals(session.Job, job) || session.Closed)
                return false;
            // A request waiting on the current run keeps its position in use (see EnsureJobForSegmentLockedAsync).
            session.UseRun(requester);
            if (job.HasExited)
            {
                await Task.Delay(50, ct);
                if (ready())
                    return true;
                if (job.Killed && job.OutputError is null)
                    return false;
                if (job.ExitCode == 0)
                    throw new TranscodeException("end_of_stream", "The source ended before this segment.", 404);
                session.LastError = job.ErrorSummary();
                logger.LogWarning("Transcode {Handle} ffmpeg exited with {ExitCode}: {Error}", session.Handle, job.ExitCode, session.LastError);
                throw new TranscodeException("transcode_failed", $"ffmpeg failed: {session.LastError}", 500);
            }
            await Task.Delay(10, ct);
        }
        throw SegmentTimeout();
    }

    /// <summary>The throttle ends a run that is far enough ahead; segments, retention and seeks work as after any other ended run.</summary>
    private async Task ParkAsync(TranscodeSession session, TranscodeJob job)
    {
        if (!await session.Gate.WaitAsync(0))
            return;
        try
        {
            if (!ReferenceEquals(session.Job, job) || job.HasExited || session.Closed)
                return;
            CoverTranscodedSubtitles(session);
            session.Reserve(TimeSpan.FromSeconds(settingsService.Current.JobIdleTimeoutSeconds));
            await job.ParkAsync();
            logger.LogDebug("Transcode {Handle} run {Run} parked {Ahead:0}s ahead of the player at segment {Front}",
                session.Handle, job.Tag, SecondsAhead(session, job), job.Front());
        }
        finally
        {
            session.Gate.Release();
        }
    }

    /// <summary>Starts a new run at the parked run's front once the player is within half the throttle buffer of it.</summary>
    private async Task ResumeParkedAsync(TranscodeSession session)
    {
        if (session.Job is not { Parked: true } parked || session.Closed
            || SecondsAhead(session, parked) >= settingsService.Current.ThrottleBufferSeconds / 2d)
            return;
        if (!await session.Gate.WaitAsync(0))
            return;
        try
        {
            if (!ReferenceEquals(session.Job, parked) || session.Closed)
                return;
            var front = parked.Front();
            if (front < session.Timeline.Count)
            {
                await StartJobLockedAsync(session, front);
                logger.LogDebug("Transcode {Handle} resumed at segment {Front}", session.Handle, front);
            }
        }
        catch (TranscodeException e)
        {
            logger.LogDebug("Transcode {Handle} could not resume yet ({Code})", session.Handle, e.Code);
        }
        finally
        {
            session.Gate.Release();
        }
    }

    private static double SecondsAhead(TranscodeSession session, TranscodeJob job)
    {
        var reference = Math.Max(session.LastRequestedSegment, job.StartSegment - 1);
        return (job.Front() - reference - 1) * session.Timeline.SegmentLength;
    }

    private async Task KillJobAsync(TranscodeSession session, TranscodeJob job, string reason)
    {
        if (!await session.Gate.WaitAsync(0))
            return;
        try
        {
            if (ReferenceEquals(session.Job, job) && !job.HasExited)
            {
                await job.KillAsync();
                logger.LogDebug("Transcode {Handle} run stopped ({Reason})", session.Handle, reason);
            }
        }
        finally
        {
            session.Gate.Release();
        }
    }

    /// <summary>A run in progress, or a parked run whose reservation has not lapsed (see <see cref="TranscodeSession.Reserve"/>).</summary>
    private static bool HoldsSlot(TranscodeSession session, DateTimeOffset now)
        => session.Job is { HasExited: false } || (session.Job is { Parked: true } && session.Reserved(now));

    /// <summary>Separate remux and transcode pools; a reserved parked run counts, so others are refused before its resume is.</summary>
    private async Task EnsureCapacityAsync(TranscodeSession requester)
    {
        var remux = requester.Mode == DeliveryMode.Remux;
        var limit = remux ? settingsService.Current.MaxConcurrentRemuxes : settingsService.Current.MaxConcurrentTranscodes;
        bool SamePool(TranscodeSession s) => !ReferenceEquals(s, requester) && (s.Mode == DeliveryMode.Remux) == remux && HoldsSlot(s, DateTimeOffset.UtcNow);
        var running = _sessions.Values.Where(SamePool).ToList();
        if (running.Count < limit)
            return;

        var now = DateTimeOffset.UtcNow;
        var victims = running
            .Where(s => s.Job is { HasExited: false })
            .OrderBy(s => s.LastAccessAt)
            .Where(s => now - s.LastAccessAt > TimeSpan.FromSeconds(15));
        foreach (var victim in victims)
        {
            if (victim.Job is { } job)
                await KillJobAsync(victim, job, "capacity reclaimed");
            if (_sessions.Values.Count(SamePool) < limit)
                return;
        }
        throw remux
            ? new TranscodeException("remux_capacity", $"All {limit} remux slots are busy; raise 'maxConcurrentRemuxes' or stop another stream.", 503)
            : new TranscodeException("transcode_capacity",
                $"All {limit} transcode slots are busy; raise 'maxConcurrentTranscodes' or stop another stream.", 503);
    }

    private async Task EnsureSessionSlotAsync()
    {
        var max = Math.Max(1, options.Value.MaxSessions);
        if (_sessions.Count < max)
            return;
        var oldest = _sessions.Values.OrderBy(s => s.LastAccessAt).First();
        if (DateTimeOffset.UtcNow - oldest.LastAccessAt < TimeSpan.FromSeconds(60))
            throw new TranscodeException("too_many_sessions", $"At most {max} transcode sessions may exist at once.", 503);
        await CloseAsync(oldest, "evicted for a new session");
    }

    private void EnsureDiskSpace()
    {
        try
        {
            Directory.CreateDirectory(workspace.SessionsRoot);
            var free = new DriveInfo(workspace.SessionsRoot).AvailableFreeSpace;
            if (free < MinimumFreeBytes)
            {
                throw new TranscodeException("insufficient_disk",
                    $"Only {free / (1024 * 1024)} MiB are free under the transcoding workspace; at least 2 GiB are required.", 507);
            }
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            logger.LogDebug(e, "Could not determine free space for the transcoding workspace");
        }
    }

    private static void ApplyRetention(TranscodeSession session, TranscodingSettings settings)
    {
        var keep = (int)Math.Ceiling(settings.SegmentRetentionSeconds / session.Timeline.SegmentLength);
        var below = session.LastRequestedSegment - keep;
        if (below <= 0 || !Directory.Exists(session.Directory))
            return;
        foreach (var file in Directory.EnumerateFiles(session.Directory, "*.m4s"))
        {
            if (int.TryParse(Path.GetFileNameWithoutExtension(file), out var index) && index < below)
            {
                try
                {
                    File.Delete(file);
                }
                catch (IOException)
                {
                }
            }
        }
    }

    private static void NoteFirstSegment(TranscodeSession session)
    {
        if (session.FirstRunFirstSegmentAt is not null || session.Job is not { } job)
            return;
        job.Front();
        session.FirstRunFirstSegmentAt = job.FirstSegmentAt;
    }

    private bool IsProbeCached(TranscodeSource source)
        => _probeCache.TryGetValue(source.Input, out var cached) && DateTimeOffset.UtcNow - cached.At < ProbeCacheTtl;

    private async Task<SourceMediaInfo> ProbeAsync(TranscodeSource source, CancellationToken ct)
    {
        if (_probeCache.TryGetValue(source.Input, out var cached) && DateTimeOffset.UtcNow - cached.At < ProbeCacheTtl)
            return cached.Media;
        var media = await prober.ProbeAsync(source, ct)
                    ?? throw new TranscodeException("probe_failed", "ffprobe could not read the source media.", 502);
        _probeCache[source.Input] = (DateTimeOffset.UtcNow, media);
        return media;
    }

    private void PruneProbeCache(DateTimeOffset now)
    {
        foreach (var (key, value) in _probeCache)
        {
            if (now - value.At > ProbeCacheTtl)
                _probeCache.TryRemove(key, out _);
        }
    }
}
