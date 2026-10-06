using System.Security.Cryptography;

namespace Streamarr.Server.Transcoding;

/// <summary>Where the time between the create request and ffmpeg's start went.</summary>
public sealed record TranscodeStartup(
    DateTimeOffset RequestedAt,
    double CapabilitiesMs,
    double ProbeMs,
    bool ProbeCached,
    double PlanMs,
    double SpawnMs);

/// <summary>One playback's HLS rendition: immutable plan and timeline plus the mutable ffmpeg run producing it.</summary>
public sealed class TranscodeSession
{
    private long _lastAccessTicks;
    private long _segmentsServed;
    private long _bytesServed;
    private int _restarts;
    private int _lastRequested = -1;
    private readonly bool[] _subtitleCovered;
    private readonly object _initLock = new();
    private Fmp4Init? _servedInit;

    public TranscodeSession(
        string id,
        TranscodeSource source,
        SourceMediaInfo media,
        TranscodePlan plan,
        SegmentTimeline timeline,
        TranscodingSettings settings,
        FfmpegCapabilities capabilities,
        string directory,
        string client,
        string title)
    {
        Id = id;
        Handle = Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();
        Source = source;
        Media = media;
        Plan = plan;
        Timeline = timeline;
        Settings = settings;
        Capabilities = capabilities;
        Directory = directory;
        Client = client;
        Title = title;
        CreatedAt = DateTimeOffset.UtcNow;
        Subtitles = plan.Subtitles.Where(s => s.Delivered).Select(s => new SubtitleTrackStore(s.Stream.Index)).ToList();
        _subtitleCovered = new bool[timeline.Count];
        Touch();
    }

    /// <summary>Unguessable capability; never listed or logged.</summary>
    public string Id { get; }

    /// <summary>Public, non-capability identifier for operator views.</summary>
    public string Handle { get; }

    public TranscodeSource Source { get; }
    public SourceMediaInfo Media { get; }
    public TranscodePlan Plan { get; }
    public SegmentTimeline Timeline { get; }
    public TranscodingSettings Settings { get; }
    public FfmpegCapabilities Capabilities { get; }
    public string Directory { get; }
    public string Client { get; }
    public string Title { get; }
    public DeliveryMode Mode => Plan.Mode;

    /// <summary>WebVTT renditions of a remux or transcode session, one per delivered text subtitle stream.</summary>
    public IReadOnlyList<SubtitleTrackStore> Subtitles { get; }
    public DateTimeOffset CreatedAt { get; }
    public DateTimeOffset LastAccessAt => new(Interlocked.Read(ref _lastAccessTicks), TimeSpan.Zero);
    public long SegmentsServed => Interlocked.Read(ref _segmentsServed);
    public long BytesServed => Interlocked.Read(ref _bytesServed);
    public int Restarts => Volatile.Read(ref _restarts);
    public int LastRequestedSegment => Volatile.Read(ref _lastRequested);
    public DateTimeOffset? FirstSegmentServedAt { get; private set; }
    public string? LastError { get; internal set; }
    public TranscodeStartup? Startup { get; internal set; }
    public DateTimeOffset? FirstRunFirstSegmentAt { get; internal set; }
    public byte[]? InitSegment { get; internal set; }
    public bool Closed { get; internal set; }

    internal SemaphoreSlim Gate { get; } = new(1, 1);
    internal TranscodeJob? Job { get; set; }
    internal int JobSequence { get; set; }

    /// <summary>Segment range of the run a request restart replaced; a request back into it waits while the new position is in use.</summary>
    internal (int Start, int End)? ReplacedRun { get; set; }

    /// <summary>Last time a request needed the current run's position (served by it or restarting it there).</summary>
    internal DateTimeOffset RunRequestedAt
    {
        get => new(Volatile.Read(ref _runRequestedTicks), TimeSpan.Zero);
        set => Volatile.Write(ref _runRequestedTicks, value.UtcTicks);
    }

    private long _runRequestedTicks;

    internal void Touch() => Interlocked.Exchange(ref _lastAccessTicks, DateTimeOffset.UtcNow.UtcTicks);

    internal void NoteRequested(int segment)
    {
        Touch();
        Volatile.Write(ref _lastRequested, segment);
    }

    internal void NoteServed(long bytes)
    {
        FirstSegmentServedAt ??= DateTimeOffset.UtcNow;
        Interlocked.Increment(ref _segmentsServed);
        Interlocked.Add(ref _bytesServed, bytes);
    }

    internal void NoteRestart() => Interlocked.Increment(ref _restarts);

    /// <summary>Marks segments whose subtitle cues a run has fully demuxed (it started at or before them and read past them).</summary>
    internal void CoverSubtitles(int from, int to)
    {
        lock (_subtitleCovered)
        {
            for (var i = Math.Max(0, from); i <= Math.Min(to, _subtitleCovered.Length - 1); i++)
                _subtitleCovered[i] = true;
        }
    }

    /// <summary>The first remux run's init becomes the served one; later runs align their decode times to its edit lists.</summary>
    internal Fmp4Init AdoptRemuxInit(byte[] init)
    {
        lock (_initLock)
        {
            if (_servedInit is null)
            {
                InitSegment ??= Fmp4.NormalizeInit(init);
                _servedInit = Fmp4.ParseInit(InitSegment);
            }
            return _servedInit;
        }
    }

    public bool SubtitlesCovered(int segment)
    {
        lock (_subtitleCovered)
            return segment >= 0 && segment < _subtitleCovered.Length && _subtitleCovered[segment];
    }

    public string SegmentPath(int index) => Path.Combine(Directory, $"{index}.m4s");

    public static string NewId() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
