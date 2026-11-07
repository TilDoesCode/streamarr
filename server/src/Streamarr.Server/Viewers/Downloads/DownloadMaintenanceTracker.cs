using Streamarr.Server.Logging;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>Failure run of one download maintenance component: a warning at the 3rd consecutive failure (then at most every 5 min), an information line on recovery.</summary>
public sealed class DownloadMaintenanceTracker(string component, string label, ILogger logger, TimeProvider time)
{
    public const int DegradedAfter = 3;
    public static readonly TimeSpan WarningInterval = TimeSpan.FromMinutes(5);
    private const int MaxErrorLength = 256;

    private readonly object _lock = new();
    private int _consecutive;
    private DateTimeOffset? _lastSuccess;
    private DateTimeOffset? _lastFailure;
    private DateTimeOffset? _failingSince;
    private DateTimeOffset? _lastWarning;
    private string? _lastError;

    public string Component => component;

    public void Failure(Exception error)
    {
        var now = time.GetUtcNow();
        var description = Describe(error);
        int count;
        DateTimeOffset since;
        bool warn;
        lock (_lock)
        {
            count = ++_consecutive;
            _lastFailure = now;
            _failingSince ??= now;
            _lastError = description;
            since = _failingSince.Value;
            warn = count == DegradedAfter || count > DegradedAfter && _lastWarning is { } last && now - last >= WarningInterval;
            if (warn)
                _lastWarning = now;
        }
        if (warn)
        {
            logger.LogWarning("Download maintenance ({Component}) is failing: {Count} consecutive failures since {Since:u}; last error {Error}",
                label, count, since, description);
        }
    }

    public void Success()
    {
        var now = time.GetUtcNow();
        int count;
        lock (_lock)
        {
            count = _consecutive;
            _consecutive = 0;
            _failingSince = null;
            _lastWarning = null;
            _lastSuccess = now;
        }
        if (count >= DegradedAfter)
            logger.LogInformation("Download maintenance ({Component}) recovered after {Count} consecutive failures", label, count);
        else if (count > 0)
            logger.LogDebug("Download maintenance ({Component}) recovered after {Count} consecutive failure(s)", label, count);
    }

    public DownloadMaintenanceDto Snapshot()
    {
        lock (_lock)
        {
            return new DownloadMaintenanceDto
            {
                Component = component,
                ConsecutiveFailures = _consecutive,
                Degraded = _consecutive >= DegradedAfter,
                LastSuccessAt = _lastSuccess,
                LastFailureAt = _lastFailure,
                FailingSince = _failingSince,
                LastError = _lastError,
            };
        }
    }

    /// <summary>The exception's type and message, capability-redacted and bounded.</summary>
    private static string Describe(Exception error)
        => LogSanitizer.SanitizeAndTruncate($"{error.GetType().Name}: {error.Message}", MaxErrorLength);
}
