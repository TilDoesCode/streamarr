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

    /// <summary>The requester (player) that last needed the current run's position.</summary>
    internal string? RunRequester { get; private set; }

    private const int MaxRequesters = 32;
    private readonly Dictionary<string, (long Ticket, int Index)> _latest = new(StringComparer.Ordinal);
    private long _tickets;
    private int _players;

    /// <summary>Tag of one player's playlists (one per master playlist fetch), so its requests are told apart from another player's.</summary>
    internal int NextPlayerTag() => Interlocked.Increment(ref _players);

    /// <summary>Records a request of <paramref name="requester"/> for <paramref name="segment"/> and returns its ticket (newer requests get higher ones).</summary>
    internal long NoteRequester(string requester, int segment)
    {
        lock (_latest)
        {
            if (_latest.Count >= MaxRequesters && !_latest.ContainsKey(requester))
                _latest.Clear();
            var ticket = ++_tickets;
            _latest[requester] = (ticket, segment);
            return ticket;
        }
    }

    /// <summary>True when the same requester has since asked for a position more than <paramref name="gap"/> segments away (it seeked on).</summary>
    internal bool Superseded(string requester, long ticket, int segment, int gap)
    {
        lock (_latest)
            return _latest.TryGetValue(requester, out var latest) && latest.Ticket > ticket && Math.Abs(latest.Index - segment) > gap;
    }

    /// <summary>A request needs the current run's position now.</summary>
    internal void UseRun(string? requester)
    {
        RunRequestedAt = DateTimeOffset.UtcNow;
        if (requester is not null)
            RunRequester = requester;
    }

    internal void Touch()
    {
        var now = DateTimeOffset.UtcNow.UtcTicks;
        Interlocked.Exchange(ref _lastAccessTicks, now);
        var until = Volatile.Read(ref _reservedUntilTicks);
        if (until > now)
            Interlocked.CompareExchange(ref _reservedUntilTicks, now + Volatile.Read(ref _reservationTicks), until);
    }

    private long _reservedUntilTicks;
    private long _reservationTicks;

    /// <summary>A parked run keeps its pool slot while the player keeps asking within <paramref name="length"/>; once lapsed it never returns.</summary>
    internal void Reserve(TimeSpan length)
    {
        Volatile.Write(ref _reservationTicks, length.Ticks);
        Volatile.Write(ref _reservedUntilTicks, DateTimeOffset.UtcNow.UtcTicks + length.Ticks);
    }

    internal void ReleaseReservation() => Volatile.Write(ref _reservedUntilTicks, 0);

    internal bool Reserved(DateTimeOffset now) => Volatile.Read(ref _reservedUntilTicks) > now.UtcTicks;

    private const double RestartBurst = 2;
    private double _restartTokens = RestartBurst;
    private DateTimeOffset _restartTokensAt = DateTimeOffset.MinValue;

    /// <summary>Paces request-driven restarts: a burst of two (a seek and straight back), then one per second.</summary>
    internal bool TryTakeRestart(DateTimeOffset now)
    {
        lock (_latest)
        {
            if (_restartTokensAt != DateTimeOffset.MinValue)
                _restartTokens = Math.Min(RestartBurst, _restartTokens + (now - _restartTokensAt).TotalSeconds);
            _restartTokensAt = now;
            if (_restartTokens < 1)
                return false;
            _restartTokens--;
            return true;
        }
    }

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
