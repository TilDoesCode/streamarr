using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services;

public sealed record ArticleManifestEntry(
    string MessageId,
    string? FileName = null,
    int? ArticleNumber = null,
    long ExpectedBytes = 0);

public sealed record NntpProviderAttempt(
    string Provider,
    string Outcome,
    double DurationMs,
    int? ResponseCode = null,
    string? ErrorType = null,
    string? ErrorMessage = null);

public sealed class ArticleDownloadTracker
{
    public const int DefaultMaxAttemptsPerArticle = 16;
    public const int MaxTrackedArticles = 250_000;

    private const int MaxMessageIdChars = 1_000;
    private const int MaxFileNameChars = 512;
    private const int MaxProviderChars = 128;
    private const int MaxOperationChars = 64;
    private const int MaxOutcomeChars = 32;
    private const int MaxErrorTypeChars = 128;
    private const int MaxErrorMessageChars = 512;
    private const int MaxTrackedProviders = 64;
    private const int MaxProviderAttemptsPerRecord = 128;
    private const double MaxDurationMs = 2_592_000_000d;
    private const int IngestBucketCount = 16;
    private const int IngestWindowSeconds = 10;
    private static readonly TimeSpan ActiveSnapshotRefreshInterval = TimeSpan.FromSeconds(1);

    private readonly string _releaseId;
    private readonly TimeProvider _time;
    private readonly TrackedArticle[] _articles;
    private readonly Dictionary<string, ArticleLookup> _articlesByMessageId;
    private readonly int _totalArticles;
    private readonly int _maxAttemptsPerArticle;
    private readonly object _providerGate = new();
    private readonly object _snapshotGate = new();
    private readonly object _ingestGate = new();
    private readonly long[] _ingestBucketBytes = new long[IngestBucketCount];
    private readonly long[] _ingestBucketSeconds = new long[IngestBucketCount];
    private readonly Dictionary<string, ProviderAggregate> _providers = new(StringComparer.OrdinalIgnoreCase);
    private long _updatedAtUtcTicks;
    private long _version;
    private long _cachedSnapshotVersion = -1;
    private long _cachedSnapshotBuiltAtUtcTicks;
    private bool _cachedSnapshotHasDownloadingArticles;
    private ArticleMapResponse? _cachedSnapshot;

    public ArticleDownloadTracker(
        string releaseId,
        IEnumerable<ArticleManifestEntry> manifestEntries,
        TimeProvider time,
        int maxAttemptsPerArticle = DefaultMaxAttemptsPerArticle,
        int maxTrackedArticles = MaxTrackedArticles)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(releaseId);
        ArgumentNullException.ThrowIfNull(manifestEntries);
        ArgumentNullException.ThrowIfNull(time);
        if (maxAttemptsPerArticle is < 1 or > 128)
            throw new ArgumentOutOfRangeException(nameof(maxAttemptsPerArticle));
        if (maxTrackedArticles is < 0 or > MaxTrackedArticles)
            throw new ArgumentOutOfRangeException(nameof(maxTrackedArticles));

        _releaseId = releaseId;
        _time = time;
        _maxAttemptsPerArticle = maxAttemptsPerArticle;

        var hasKnownCount = manifestEntries.TryGetNonEnumeratedCount(out var manifestCount);
        var entries = manifestEntries.Take(maxTrackedArticles + (hasKnownCount ? 0 : 1)).ToArray();
        _totalArticles = hasKnownCount ? manifestCount : entries.Length;
        if (entries.Length > maxTrackedArticles)
            entries = entries[..maxTrackedArticles];

        _articles = new TrackedArticle[entries.Length];
        var firstByMessageId = new Dictionary<string, TrackedArticle>(StringComparer.Ordinal);
        Dictionary<string, List<TrackedArticle>>? duplicatesByMessageId = null;
        for (var index = 0; index < entries.Length; index++)
        {
            var entry = entries[index];
            var messageId = ValidateMessageId(entry.MessageId, nameof(manifestEntries));
            var article = new TrackedArticle(
                index,
                messageId,
                Sanitize(entry.FileName, MaxFileNameChars),
                entry.ArticleNumber is > 0 ? entry.ArticleNumber : null,
                Math.Max(0, entry.ExpectedBytes));
            _articles[index] = article;
            if (!firstByMessageId.TryAdd(messageId, article))
            {
                duplicatesByMessageId ??= new Dictionary<string, List<TrackedArticle>>(StringComparer.Ordinal);
                if (!duplicatesByMessageId.TryGetValue(messageId, out var duplicates))
                {
                    duplicates = [];
                    duplicatesByMessageId.Add(messageId, duplicates);
                }
                duplicates.Add(article);
            }
        }

        _articlesByMessageId = firstByMessageId.ToDictionary(
            pair => pair.Key,
            pair => new ArticleLookup(
                pair.Value,
                duplicatesByMessageId?.GetValueOrDefault(pair.Key)?.ToArray()),
            StringComparer.Ordinal);
        Touch(time.GetUtcNow());
    }

    public int TrackedArticleCount => _articles.Length;

    public bool MarkQueued(string messageId)
        => Update(messageId, static (article, now) => article.MarkQueued(now));

    public bool MarkDownloading(
        string messageId,
        string? provider = null,
        long? bytes = null,
        double? durationMs = null)
    {
        var safeDuration = NormalizeDuration(durationMs);
        return Update(messageId, (article, now) => article.MarkDownloading(now, bytes, safeDuration));
    }

    public bool MarkCached(
        string messageId,
        long? bytes = null,
        double? durationMs = null,
        string? provider = null)
    {
        var safeProvider = Sanitize(provider, MaxProviderChars);
        var safeDuration = NormalizeDuration(durationMs);
        return Update(messageId, (article, now) =>
            article.MarkCompleted(
                ArticleState.Cached,
                now,
                bytes,
                safeDuration,
                safeProvider));
    }

    public bool MarkDownloaded(
        string messageId,
        long bytes,
        double? durationMs = null,
        string? provider = null)
    {
        var safeProvider = Sanitize(provider, MaxProviderChars);
        var safeDuration = NormalizeDuration(durationMs);
        RecordIngest(bytes);
        return Update(messageId, (article, now) =>
            article.MarkCompleted(
                ArticleState.Downloaded,
                now,
                bytes,
                safeDuration,
                safeProvider));
    }

    public bool MarkPartial(
        string messageId,
        long bytes,
        string? provider = null,
        double? durationMs = null)
    {
        var safeDuration = NormalizeDuration(durationMs);
        return Update(messageId, (article, now) => article.MarkPartial(now, bytes, safeDuration));
    }

    public bool MarkFailed(
        string messageId,
        string? errorType,
        string? errorMessage = null,
        long? bytes = null,
        double? durationMs = null,
        string? provider = null)
    {
        var safeType = Sanitize(errorType, MaxErrorTypeChars);
        var safeMessage = Sanitize(errorMessage, MaxErrorMessageChars);
        var safeDuration = NormalizeDuration(durationMs);
        return Update(messageId, (article, now) =>
            article.MarkFailed(now, safeType, safeMessage, bytes, safeDuration));
    }

    public bool RecordProviderAttempts(
        string messageId,
        string operation,
        IReadOnlyList<NntpProviderAttempt> attempts)
    {
        ArgumentNullException.ThrowIfNull(attempts);
        if (!TryGetArticles(messageId, out var articles))
            return false;

        var safeOperation = Sanitize(operation, MaxOperationChars) ?? "unknown";
        var first = Math.Max(0, attempts.Count - MaxProviderAttemptsPerRecord);
        var safeAttempts = new List<ArticleProviderAttemptResponse>(Math.Min(_maxAttemptsPerArticle, attempts.Count - first));
        for (var i = first; i < attempts.Count; i++)
        {
            var attempt = attempts[i];
            var provider = Sanitize(attempt.Provider, MaxProviderChars) ?? "unknown";
            var outcome = NormalizeOutcome(attempt.Outcome, attempt.ResponseCode);
            var duration = NormalizeDuration(attempt.DurationMs) ?? 0;
            var response = new ArticleProviderAttemptResponse
            {
                Provider = provider,
                Operation = safeOperation,
                Outcome = outcome,
                DurationMs = duration,
                ResponseCode = attempt.ResponseCode,
                ErrorType = Sanitize(attempt.ErrorType, MaxErrorTypeChars),
                ErrorMessage = Sanitize(attempt.ErrorMessage, MaxErrorMessageChars),
            };
            safeAttempts.Add(response);
            var transferBytes = response.Outcome == "success" && safeOperation is "BODY" or "ARTICLE"
                ? articles.First.ExpectedBytes
                : 0;
            RecordProvider(response, transferBytes);
        }

        if (safeAttempts.Count == 0)
            return true;

        var now = _time.GetUtcNow();
        articles.Apply(article => article.AddAttempts(safeAttempts, _maxAttemptsPerArticle));
        Touch(now);
        return true;
    }

    public ArticleMapResponse Snapshot()
    {
        var version = Interlocked.Read(ref _version);
        lock (_snapshotGate)
        {
            var now = _time.GetUtcNow();
            if (_cachedSnapshot is not null && _cachedSnapshotVersion == version)
            {
                var cacheAgeTicks = now.UtcDateTime.Ticks - _cachedSnapshotBuiltAtUtcTicks;
                if (!_cachedSnapshotHasDownloadingArticles
                    || cacheAgeTicks < ActiveSnapshotRefreshInterval.Ticks)
                {
                    return _cachedSnapshot;
                }
            }

            var snapshot = BuildSnapshot(now, out var hasDownloadingArticles);
            if (Interlocked.Read(ref _version) == version)
            {
                _cachedSnapshot = snapshot;
                _cachedSnapshotVersion = version;
                _cachedSnapshotBuiltAtUtcTicks = now.UtcDateTime.Ticks;
                _cachedSnapshotHasDownloadingArticles = hasDownloadingArticles;
            }
            return snapshot;
        }
    }

    private ArticleMapResponse BuildSnapshot(DateTimeOffset now, out bool hasDownloadingArticles)
    {
        hasDownloadingArticles = false;
        var articles = new ArticleTelemetryResponse[_articles.Length];
        var pending = 0;
        var active = 0;
        var partial = 0;
        var downloaded = 0;
        var cached = 0;
        var failed = 0;
        var missing = 0;
        long downloadedBytes = 0;
        double totalDurationMs = 0;
        var durationCount = 0;
        double transferDurationMs = 0;
        long byteOffset = 0;
        long bufferedBytes = 0;
        var bufferedIntervals = new List<(long Start, long End)>();

        for (var i = 0; i < _articles.Length; i++)
        {
            var article = _articles[i].Snapshot(now);
            articles[i] = article;
            var weight = ArticleWeight(article);
            if (article.State is "downloaded" or "cached")
            {
                bufferedBytes = SaturatingAdd(bufferedBytes, weight);
                if (bufferedIntervals.Count > 0 && bufferedIntervals[^1].End == byteOffset)
                    bufferedIntervals[^1] = (bufferedIntervals[^1].Start, byteOffset + weight);
                else
                    bufferedIntervals.Add((byteOffset, byteOffset + weight));
            }
            byteOffset = SaturatingAdd(byteOffset, weight);
            switch (article.State)
            {
                case "failed":
                    failed++;
                    if (LooksMissing(article))
                        missing++;
                    break;
                case "queued":
                case "downloading":
                    active++;
                    hasDownloadingArticles |= article.State == "downloading";
                    break;
                case "partial":
                    partial++;
                    break;
                case "downloaded":
                    downloaded++;
                    downloadedBytes = SaturatingAdd(downloadedBytes, article.Bytes);
                    break;
                case "cached":
                    cached++;
                    downloadedBytes = SaturatingAdd(downloadedBytes, article.Bytes);
                    break;
                default:
                    pending++;
                    break;
            }

            if (article.CompletedAt is not null && article.DurationMs is { } duration)
            {
                totalDurationMs += duration;
                durationCount++;
                if (article.State == "downloaded" && article.Bytes > 0)
                    transferDurationMs += duration;
            }
        }

        var effectiveBytes = articles
            .Where(article => article.State == "downloaded")
            .Aggregate(0L, (total, article) => SaturatingAdd(total, article.Bytes));
        double? effectiveRate = transferDurationMs > 0 && effectiveBytes > 0
            ? effectiveBytes / (transferDurationMs / 1_000d)
            : null;

        return new ArticleMapResponse
        {
            ReleaseId = _releaseId,
            TotalArticles = _totalArticles,
            TrackedArticles = articles.Length,
            TruncatedArticles = Math.Max(0, _totalArticles - articles.Length),
            PendingArticles = pending,
            ActiveArticles = active,
            PartialArticles = partial,
            DownloadedArticles = downloaded,
            CachedArticles = cached,
            FailedArticles = failed,
            MissingArticles = missing,
            DownloadedBytes = downloadedBytes,
            AverageDurationMs = durationCount == 0 ? null : totalDurationMs / durationCount,
            EffectiveBytesPerSecond = effectiveRate,
            RecentBytesPerSecond = RecentDownloadBytesPerSecond,
            UpdatedAt = UpdatedAt,
            TotalExpectedBytes = byteOffset,
            BufferedBytes = bufferedBytes,
            BufferedRanges = ToFractionRanges(bufferedIntervals, byteOffset, maxRanges: 128),
            Articles = articles,
            Providers = ProviderSnapshots(),
        };
    }

    /// <summary>Byte weight used for timeline mapping; falls back so zero-size manifests still map.</summary>
    private static long ArticleWeight(ArticleTelemetryResponse article)
        => article.ExpectedBytes > 0 ? article.ExpectedBytes : Math.Max(article.Bytes, 1);

    /// <summary>Byte intervals → payload fractions, coarsened by joining the smallest gaps.</summary>
    internal static IReadOnlyList<ByteRangeResponse> ToFractionRanges(
        List<(long Start, long End)> intervals,
        long totalBytes,
        int maxRanges)
    {
        if (totalBytes <= 0 || intervals.Count == 0)
            return [];
        while (intervals.Count > maxRanges)
        {
            var victim = 1;
            var smallest = long.MaxValue;
            for (var i = 1; i < intervals.Count; i++)
            {
                var gap = intervals[i].Start - intervals[i - 1].End;
                if (gap < smallest)
                {
                    smallest = gap;
                    victim = i;
                }
            }
            intervals[victim - 1] = (intervals[victim - 1].Start, Math.Max(intervals[victim - 1].End, intervals[victim].End));
            intervals.RemoveAt(victim);
        }
        return intervals
            .Select(interval => new ByteRangeResponse
            {
                Start = Math.Clamp(interval.Start / (double)totalBytes, 0, 1),
                End = Math.Clamp(interval.End / (double)totalBytes, 0, 1),
            })
            .Where(range => range.End > range.Start)
            .ToList();
    }

    /// <summary>Coarsen fraction ranges for compact list payloads (e.g. the sessions overview).</summary>
    public static IReadOnlyList<ByteRangeResponse> Coarsen(IReadOnlyList<ByteRangeResponse> ranges, int maxRanges)
    {
        if (ranges.Count <= maxRanges)
            return ranges;
        const long Scale = 1_000_000;
        var intervals = ranges
            .Select(range => ((long)(range.Start * Scale), (long)(range.End * Scale)))
            .ToList();
        return ToFractionRanges(intervals, Scale, maxRanges);
    }

    /// <summary>
    /// Recent network ingest rate: bytes of completed article downloads over a rolling
    /// 10-second window. Null when nothing finished downloading inside the window.
    /// </summary>
    public double? RecentDownloadBytesPerSecond
    {
        get
        {
            var nowSecond = _time.GetUtcNow().ToUnixTimeSeconds();
            long total = 0;
            var any = false;
            lock (_ingestGate)
            {
                for (var i = 0; i < IngestBucketCount; i++)
                {
                    var age = nowSecond - _ingestBucketSeconds[i];
                    if (age is >= 0 and < IngestWindowSeconds && _ingestBucketBytes[i] > 0)
                    {
                        total = SaturatingAdd(total, _ingestBucketBytes[i]);
                        any = true;
                    }
                }
            }
            return any ? total / (double)IngestWindowSeconds : null;
        }
    }

    private void RecordIngest(long bytes)
    {
        if (bytes <= 0)
            return;
        var second = _time.GetUtcNow().ToUnixTimeSeconds();
        var slot = (int)((second % IngestBucketCount + IngestBucketCount) % IngestBucketCount);
        lock (_ingestGate)
        {
            if (_ingestBucketSeconds[slot] != second)
            {
                _ingestBucketSeconds[slot] = second;
                _ingestBucketBytes[slot] = 0;
            }
            _ingestBucketBytes[slot] = SaturatingAdd(_ingestBucketBytes[slot], bytes);
        }
    }

    private static bool LooksMissing(ArticleTelemetryResponse article)
    {
        if (article.ErrorType is { } errorType
            && errorType.Contains("NotFound", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        foreach (var attempt in article.Attempts)
        {
            if (attempt.Outcome == "missing" || attempt.ResponseCode == 430)
                return true;
        }
        return false;
    }

    private DateTimeOffset UpdatedAt
        => new(Interlocked.Read(ref _updatedAtUtcTicks), TimeSpan.Zero);

    private bool Update(string messageId, Action<TrackedArticle, DateTimeOffset> update)
    {
        if (!TryGetArticles(messageId, out var articles))
            return false;

        var now = _time.GetUtcNow();
        articles.Apply(article => update(article, now));
        Touch(now);
        return true;
    }

    private bool TryGetArticles(string messageId, out ArticleLookup articles)
    {
        if (string.IsNullOrWhiteSpace(messageId))
        {
            articles = default;
            return false;
        }
        return _articlesByMessageId.TryGetValue(messageId, out articles!);
    }

    private void RecordProvider(ArticleProviderAttemptResponse attempt, long transferBytes)
    {
        lock (_providerGate)
        {
            var key = attempt.Provider;
            if (!_providers.TryGetValue(key, out var aggregate))
            {
                if (_providers.Count >= MaxTrackedProviders)
                    key = "other";
                if (!_providers.TryGetValue(key, out aggregate))
                {
                    aggregate = new ProviderAggregate(key);
                    _providers.Add(key, aggregate);
                }
            }
            aggregate.Record(attempt.Outcome, attempt.DurationMs, transferBytes);
        }
    }

    private IReadOnlyList<ArticleProviderSummaryResponse> ProviderSnapshots()
    {
        lock (_providerGate)
            return [.. _providers.Values
                .OrderBy(provider => provider.Provider, StringComparer.OrdinalIgnoreCase)
                .Select(provider => provider.Snapshot())];
    }

    private void Touch(DateTimeOffset at)
    {
        Interlocked.Increment(ref _version);
        var ticks = at.UtcDateTime.Ticks;
        while (true)
        {
            var current = Interlocked.Read(ref _updatedAtUtcTicks);
            if (ticks <= current || Interlocked.CompareExchange(ref _updatedAtUtcTicks, ticks, current) == current)
                return;
        }
    }

    private static string ValidateMessageId(string messageId, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(messageId)
            || messageId.Length > MaxMessageIdChars
            || messageId.Any(char.IsControl))
        {
            throw new ArgumentException("Article message IDs must be non-empty, bounded, and free of control characters.", parameterName);
        }
        return messageId;
    }

    private static double? NormalizeDuration(double? durationMs)
        => durationMs is { } value && double.IsFinite(value)
            ? Math.Clamp(value, 0, MaxDurationMs)
            : null;

    private static string NormalizeOutcome(string? outcome, int? responseCode)
    {
        var normalized = Sanitize(outcome, MaxOutcomeChars)?.ToLowerInvariant();
        if (responseCode == 430 || normalized is "missing" or "notfound" or "not_found")
            return "missing";
        if (normalized is "success" or "succeeded" or "retrieved" or "downloaded" or "cached")
            return "success";
        return normalized is "error" or "failed" or "failure" ? "error" : normalized ?? "error";
    }

    private static string? Sanitize(string? value, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        var buffer = value.Trim().Select(character => char.IsControl(character) ? ' ' : character).ToArray();
        var sanitized = new string(buffer).Trim();
        if (sanitized.Length == 0)
            return null;
        return sanitized.Length <= maxChars ? sanitized : sanitized[..maxChars];
    }

    private static long SaturatingAdd(long left, long right)
        => right > 0 && left > long.MaxValue - right ? long.MaxValue : left + Math.Max(0, right);

    private enum ArticleState
    {
        Pending,
        Queued,
        Downloading,
        Partial,
        Downloaded,
        Cached,
        Failed,
    }

    private readonly record struct ArticleLookup(
        TrackedArticle First,
        TrackedArticle[]? Additional)
    {
        public void Apply(Action<TrackedArticle> action)
        {
            action(First);
            if (Additional is null)
                return;
            foreach (var article in Additional)
                action(article);
        }
    }

    private sealed class TrackedArticle(
        int index,
        string messageId,
        string? fileName,
        int? articleNumber,
        long expectedBytes)
    {
        private List<ArticleProviderAttemptResponse>? _attempts;
        private ArticleState _state;
        private long _bytes;
        private double? _durationMs;
        private DateTimeOffset? _startedAt;
        private DateTimeOffset? _completedAt;
        private string? _successfulProvider;
        private string? _errorType;
        private string? _errorMessage;
        private long _providerAttemptCount;

        public long ExpectedBytes => expectedBytes;

        public void MarkQueued(DateTimeOffset now)
        {
            lock (this)
            {
                if (_state is ArticleState.Failed or ArticleState.Partial)
                {
                    _state = ArticleState.Queued;
                    _bytes = 0;
                    _durationMs = null;
                    _startedAt = null;
                    _completedAt = null;
                    _successfulProvider = null;
                    _errorType = null;
                    _errorMessage = null;
                }
                else if (_state == ArticleState.Pending)
                    _state = ArticleState.Queued;
            }
        }

        public void MarkDownloading(DateTimeOffset now, long? bytes, double? durationMs)
        {
            lock (this)
            {
                if (_state == ArticleState.Failed)
                    return;
                if (_state is ArticleState.Downloaded or ArticleState.Cached)
                    return;
                _state = ArticleState.Downloading;
                _startedAt ??= durationMs is { } duration
                    ? now - TimeSpan.FromMilliseconds(duration)
                    : now;
                _bytes = Math.Max(_bytes, Math.Max(0, bytes ?? 0));
            }
        }

        public void MarkPartial(DateTimeOffset now, long bytes, double? durationMs)
        {
            lock (this)
            {
                if (_state == ArticleState.Failed)
                    return;
                if (_state is ArticleState.Downloaded or ArticleState.Cached)
                    return;
                _state = ArticleState.Partial;
                _startedAt ??= durationMs is { } duration
                    ? now - TimeSpan.FromMilliseconds(duration)
                    : now;
                _completedAt = now;
                _durationMs = durationMs ?? Math.Max(0, (now - _startedAt.Value).TotalMilliseconds);
                _bytes = Math.Max(_bytes, Math.Max(0, bytes));
            }
        }

        public void MarkCompleted(
            ArticleState completedState,
            DateTimeOffset now,
            long? bytes,
            double? durationMs,
            string? provider)
        {
            lock (this)
            {
                if (_state == ArticleState.Failed)
                    return;
                if (_state == ArticleState.Downloaded && completedState == ArticleState.Cached)
                    return;
                if (_state == completedState && _completedAt is not null)
                    return;
                _state = completedState;
                _startedAt ??= durationMs is { } duration
                    ? now - TimeSpan.FromMilliseconds(duration)
                    : now;
                _completedAt = now;
                _durationMs = durationMs ?? Math.Max(0, (now - _startedAt.Value).TotalMilliseconds);
                _bytes = Math.Max(_bytes, Math.Max(0, bytes ?? expectedBytes));
                if (provider is not null)
                    _successfulProvider = provider;
                _errorType = null;
                _errorMessage = null;
            }
        }

        public void MarkFailed(
            DateTimeOffset now,
            string? errorType,
            string? errorMessage,
            long? bytes,
            double? durationMs)
        {
            lock (this)
            {
                if (_state is ArticleState.Downloaded or ArticleState.Cached)
                    return;
                _state = ArticleState.Failed;
                _startedAt ??= durationMs is { } duration
                    ? now - TimeSpan.FromMilliseconds(duration)
                    : now;
                _completedAt = now;
                _durationMs = durationMs ?? Math.Max(0, (now - _startedAt.Value).TotalMilliseconds);
                _bytes = Math.Max(_bytes, Math.Max(0, bytes ?? 0));
                _errorType = errorType;
                _errorMessage = errorMessage;
            }
        }

        public void AddAttempts(IReadOnlyList<ArticleProviderAttemptResponse> attempts, int maxAttempts)
        {
            lock (this)
            {
                _providerAttemptCount = SaturatingAdd(_providerAttemptCount, attempts.Count);
                _attempts ??= [];
                _attempts.AddRange(attempts);
                if (_attempts.Count > maxAttempts)
                    _attempts.RemoveRange(0, _attempts.Count - maxAttempts);
                var successful = attempts.LastOrDefault(attempt => attempt.Outcome == "success");
                if (successful is not null)
                    _successfulProvider = successful.Provider;
            }
        }

        public ArticleTelemetryResponse Snapshot(DateTimeOffset now)
        {
            lock (this)
            {
                var duration = _durationMs;
                if (_state == ArticleState.Downloading && _startedAt is { } started)
                    duration = Math.Max(0, (now - started).TotalMilliseconds);
                double? throughput = duration is > 0 && _bytes > 0
                    ? _bytes / (duration.Value / 1_000d)
                    : null;
                return new ArticleTelemetryResponse
                {
                    Index = index,
                    FileName = fileName,
                    ArticleNumber = articleNumber,
                    ExpectedBytes = expectedBytes,
                    MessageId = messageId,
                    State = _state.ToString().ToLowerInvariant(),
                    Bytes = _bytes,
                    DurationMs = duration,
                    ThroughputBytesPerSecond = throughput,
                    StartedAt = _startedAt,
                    CompletedAt = _completedAt,
                    SuccessfulProvider = _successfulProvider,
                    ErrorType = _errorType,
                    ErrorMessage = _errorMessage,
                    ProviderAttemptCount = _providerAttemptCount,
                    AttemptsTruncated = _providerAttemptCount > (_attempts?.Count ?? 0),
                    Attempts = _attempts?.ToArray() ?? [],
                };
            }
        }
    }

    private sealed class ProviderAggregate(string provider)
    {
        private long _successes;
        private long _missing;
        private long _errors;
        private long _durationCount;
        private double _durationTotalMs;
        private long _bytesDownloaded;
        private double _transferDurationMs;

        public string Provider { get; } = provider;

        public void Record(string outcome, double durationMs, long transferBytes)
        {
            if (outcome == "success")
                _successes++;
            else if (outcome == "missing")
                _missing++;
            else
                _errors++;
            _durationCount++;
            _durationTotalMs += durationMs;
            if (transferBytes > 0)
            {
                _bytesDownloaded = SaturatingAdd(_bytesDownloaded, transferBytes);
                _transferDurationMs += durationMs;
            }
        }

        public ArticleProviderSummaryResponse Snapshot() => new()
        {
            Provider = Provider,
            Successes = _successes,
            Missing = _missing,
            Errors = _errors,
            AverageDurationMs = _durationCount == 0 ? null : _durationTotalMs / _durationCount,
            BytesDownloaded = _bytesDownloaded,
            BytesPerSecond = _transferDurationMs > 0 && _bytesDownloaded > 0
                ? _bytesDownloaded / (_transferDurationMs / 1_000d)
                : null,
        };
    }
}
