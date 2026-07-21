using System.Diagnostics;

namespace Streamarr.Server.Services;

/// <summary>
/// One measured stage on the path from a resolve request to the first delivered media
/// frame. Offsets are milliseconds relative to the timeline's <c>t0</c> (the moment the
/// resolve request entered the server), so a set of spans renders directly as a flamegraph.
/// </summary>
public sealed record TtffSpan
{
    public required string Name { get; init; }

    /// <summary>Coarse bucket used for colouring the flamegraph (nzb, health, materialize, probe, session, stream, client, transcode…).</summary>
    public required string Category { get; init; }

    /// <summary>Milliseconds from timeline t0 to the start of this span.</summary>
    public required double StartMs { get; init; }

    public required double DurationMs { get; init; }

    /// <summary>Optional short human detail (never secrets — no tokens/URLs/credentials).</summary>
    public string? Detail { get; init; }

    /// <summary>"server" or "client" — which process observed the span (for the cross-process flamegraph).</summary>
    public string Source { get; init; } = "server";
}

/// <summary>
/// A thread-safe, monotonically-clocked timeline of <see cref="TtffSpan"/>s for a single
/// playback attempt. Created when a resolve request arrives; stages record themselves via
/// <see cref="Measure"/> (server-side) or <see cref="Add"/> (already-timed / client-reported).
/// The timeline is attached to the live session so the stream page can render a request→first
/// frame flamegraph, and every span is also emitted as a <c>[TTFF]</c> debug log line.
/// </summary>
public sealed class TtffTimeline
{
    // Guard rails so a hostile/buggy client can never grow the timeline without bound.
    internal const int MaxSpans = 200;
    internal const int MaxNameChars = 64;
    internal const int MaxDetailChars = 200;

    private readonly object _gate = new();
    private readonly List<TtffSpan> _spans = new();
    private readonly long _t0;
    private readonly ILogger? _logger;
    private readonly string _correlation;

    private TtffTimeline(DateTimeOffset startedAt, long t0, string correlation, ILogger? logger)
    {
        StartedAt = startedAt;
        _t0 = t0;
        _correlation = correlation;
        _logger = logger;
    }

    /// <summary>Wall-clock instant of t0 (used to align server and client spans).</summary>
    public DateTimeOffset StartedAt { get; }

    /// <summary>Milliseconds elapsed since t0 on the monotonic clock.</summary>
    public double ElapsedMs => Stopwatch.GetElapsedTime(_t0).TotalMilliseconds;

    public static TtffTimeline Start(string correlation, ILogger? logger = null)
        => new(DateTimeOffset.UtcNow, Stopwatch.GetTimestamp(), Truncate(correlation, MaxNameChars), logger);

    /// <summary>
    /// Times a stage: the returned handle records the span (and logs it) when disposed.
    /// Usage: <c>using (timeline.Measure("ffprobe", "probe")) { … }</c>.
    /// </summary>
    public Measurement Measure(string name, string category, string? detail = null)
        => new(this, name, category, detail, ElapsedMs);

    /// <summary>Records an already-timed span (e.g. two overlapping stages, or a client-reported one).</summary>
    public void Add(string name, string category, double startMs, double durationMs, string? detail = null, string source = "server")
    {
        var span = new TtffSpan
        {
            Name = Truncate(name, MaxNameChars),
            Category = Truncate(category, 24),
            StartMs = Clamp(startMs),
            DurationMs = Clamp(durationMs),
            Detail = detail is null ? null : Truncate(detail, MaxDetailChars),
            Source = source == "client" ? "client" : "server",
        };

        lock (_gate)
        {
            if (_spans.Count >= MaxSpans)
                return;
            _spans.Add(span);
        }

        _logger?.LogDebug(
            "[TTFF] {Correlation} {Source} {Category}/{Name} start={StartMs:F0}ms dur={DurationMs:F0}ms {Detail}",
            _correlation, span.Source, span.Category, span.Name, span.StartMs, span.DurationMs, span.Detail ?? "");
    }

    public IReadOnlyList<TtffSpan> Snapshot()
    {
        lock (_gate)
            return _spans.OrderBy(s => s.StartMs).ToList();
    }

    /// <summary>
    /// A one-line, human-scannable breakdown of the timeline so far, e.g.
    /// <c>total=1620ms nzb-fetch=12 health-check=980 materialize=610 ffprobe=15</c>.
    /// Emitted at Information level so a TTFF regression is visible in the console without
    /// enabling Debug logging.
    /// </summary>
    public string Summarize()
    {
        var spans = Snapshot();
        var parts = spans.Select(s => $"{s.Name}={s.DurationMs:F0}");
        return $"total={ElapsedMs:F0}ms {string.Join(' ', parts)}";
    }

    private static double Clamp(double value)
        => double.IsFinite(value) ? Math.Clamp(value, 0, 24 * 60 * 60 * 1000d) : 0;

    private static string Truncate(string value, int max)
    {
        value = (value ?? string.Empty).Trim();
        return value.Length <= max ? value : value[..max];
    }

    /// <summary>Handle returned by <see cref="Measure"/>; records the span on dispose.</summary>
    public readonly struct Measurement : IDisposable
    {
        private readonly TtffTimeline _timeline;
        private readonly string _name;
        private readonly string _category;
        private readonly string? _detail;
        private readonly double _startMs;

        internal Measurement(TtffTimeline timeline, string name, string category, string? detail, double startMs)
        {
            _timeline = timeline;
            _name = name;
            _category = category;
            _detail = detail;
            _startMs = startMs;
        }

        public void Dispose()
            => _timeline.Add(_name, _category, _startMs, _timeline.ElapsedMs - _startMs, _detail);
    }
}
