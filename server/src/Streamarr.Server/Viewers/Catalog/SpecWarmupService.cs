using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>A version lookup the warm-up runs: a movie, or one season of a series (season null = the first regular season).</summary>
public sealed record SpecWarmupTarget(int TmdbId, bool Movie, int? Season)
{
    public string Key => Movie ? $"movie:{TmdbId}" : $"tv:{TmdbId}:{Season?.ToString() ?? "first"}";

    /// <summary>The lookup that fills a card's spec: movie → itself, series → its first season, episode → its season.</summary>
    public static SpecWarmupTarget? For(string workId) => WorkKey.TryParse(workId) switch
    {
        { Kind: WorkKind.Movie, TmdbId: { } id } => new(id, true, null),
        { Kind: WorkKind.Series, TmdbId: { } id } => new(id, false, null),
        { Kind: WorkKind.Season or WorkKind.Episode, TmdbId: { } id, Season: { } season } => new(id, false, season),
        _ => null,
    };
}

/// <summary>
/// Looks up versions in the background for titles shown in viewer lists without a spec yet, so the next list fetch carries it.
/// Never on the request path: <see cref="Request"/> only queues. Bounded by concurrency, a per-title cooldown and a daily cap.
/// </summary>
public sealed class SpecWarmupService(
    IServiceProvider services,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ILogger<SpecWarmupService> logger) : BackgroundService
{
    private const int QueueCapacity = 1_000;

    private readonly SpecWarmupOptions _options = options.Value.SpecWarmup;
    private readonly Channel<SpecWarmupTarget> _queue = Channel.CreateBounded<SpecWarmupTarget>(
        new BoundedChannelOptions(QueueCapacity) { FullMode = BoundedChannelFullMode.Wait });
    private readonly ConcurrentDictionary<string, DateTimeOffset> _attempts = new(StringComparer.Ordinal);
    private readonly object _dayLock = new();
    private readonly FailureLog _failures = new(logger);
    private DateOnly _day;
    private int _today;
    private int _queued;
    private int _done;

    /// <summary>The background lookup of one target; replaceable in tests.</summary>
    internal Func<SpecWarmupTarget, CancellationToken, Task> Lookup { get; init; } =
        (target, ct) => services.GetRequiredService<ViewerCatalogService>().WarmSpecAsync(target, ct);

    public bool Enabled => _options.Enabled && _options.DailyCap > 0 && _options.Concurrency > 0;

    /// <summary>Lookups started today (UTC); for tests and diagnostics.</summary>
    public int StartedToday
    {
        get
        {
            lock (_dayLock)
                return _day == Today() ? _today : 0;
        }
    }

    /// <summary>Targets queued so far; for tests.</summary>
    internal int Queued => Volatile.Read(ref _queued);

    /// <summary>Every queued target has been looked up (or skipped); for tests.</summary>
    internal bool Idle => Volatile.Read(ref _done) == Volatile.Read(ref _queued);

    /// <summary>Queue lookups for works whose card has no spec; cheap and non-blocking.</summary>
    public void Request(IEnumerable<string> workIds)
    {
        if (!Enabled)
            return;
        var now = time.GetUtcNow();
        var cooldown = TimeSpan.FromHours(Math.Max(0, _options.CooldownHours));
        foreach (var workId in workIds)
        {
            if (SpecWarmupTarget.For(workId) is not { } target)
                continue;
            if (_attempts.TryGetValue(target.Key, out var last) && now - last < cooldown)
                continue;
            if (!_attempts.TryAdd(target.Key, now) && !_attempts.TryUpdate(target.Key, now, last))
                continue;
            Interlocked.Increment(ref _queued);
            if (!_queue.Writer.TryWrite(target))
            {
                Interlocked.Decrement(ref _queued);
                _attempts.TryRemove(target.Key, out _);
            }
        }
        PruneAttempts(now, cooldown);
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
        => !Enabled
            ? Task.CompletedTask
            : Task.WhenAll(Enumerable.Range(0, Math.Clamp(_options.Concurrency, 1, 16)).Select(_ => WorkAsync(stoppingToken)));

    private async Task WorkAsync(CancellationToken ct)
    {
        await foreach (var target in _queue.Reader.ReadAllAsync(ct))
        {
            try
            {
                await LookupAsync(target, ct);
            }
            finally
            {
                Interlocked.Increment(ref _done);
            }
            if (ct.IsCancellationRequested)
                return;
        }
    }

    private async Task LookupAsync(SpecWarmupTarget target, CancellationToken ct)
    {
        if (!TryCount())
        {
            // Over the daily cap: forget the attempt so the title is queued again tomorrow.
            _attempts.TryRemove(target.Key, out _);
            return;
        }
        try
        {
            await Lookup(target, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (ViewerProblem e) when (e.Status == StatusCodes.Status429TooManyRequests)
        {
            _attempts.TryRemove(target.Key, out _);
        }
        catch (Exception e)
        {
            _failures.Log(e, "Spec warm-up of {Target} failed", target.Key);
        }
    }

    private bool TryCount()
    {
        lock (_dayLock)
        {
            var today = Today();
            if (_day != today)
                (_day, _today) = (today, 0);
            if (_today >= _options.DailyCap)
                return false;
            _today++;
            return true;
        }
    }

    private DateOnly Today() => DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);

    private void PruneAttempts(DateTimeOffset now, TimeSpan cooldown)
    {
        if (_attempts.Count < 20_000)
            return;
        foreach (var (key, at) in _attempts)
        {
            if (now - at >= cooldown)
                _attempts.TryRemove(key, out _);
        }
    }
}
