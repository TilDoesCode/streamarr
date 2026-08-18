using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Serilog.Core;
using Serilog.Events;

namespace Streamarr.Server.Logging;

/// <summary>
/// A bounded, process-local copy of the structured events Serilog emits. The sink keeps
/// only the fields needed by the management console; arbitrary structured properties are
/// deliberately not retained because they may contain credentials or capability tokens.
/// </summary>
public sealed class CoreLogStore(int capacity = CoreLogStore.DefaultCapacity) : ILogEventSink
{
    internal const int DefaultCapacity = 2_000;
    internal const int MaximumMessageLength = 4_096;
    internal const int MaximumExceptionLength = 8_192;

    private readonly object _gate = new();
    private readonly CoreLogRecord?[] _entries = new CoreLogRecord[Math.Clamp(capacity, 16, 20_000)];
    private int _nextIndex;
    private int _count;
    private long _sequence;

    public void Emit(LogEvent logEvent)
    {
        ArgumentNullException.ThrowIfNull(logEvent);

        try
        {
            var record = new CoreLogRecord(
                Sequence: Interlocked.Increment(ref _sequence),
                AtUtc: logEvent.Timestamp.ToUniversalTime(),
                Level: logEvent.Level,
                Category: LogSanitizer.SanitizeAndTruncate(
                    LogValue(logEvent, "SourceContext") ?? "Streamarr.Core",
                    256),
                Message: LogSanitizer.SanitizeAndTruncate(
                    logEvent.RenderMessage(CultureInfo.InvariantCulture),
                    MaximumMessageLength),
                Exception: logEvent.Exception is null
                    ? null
                    : LogSanitizer.SanitizeAndTruncate(logEvent.Exception.ToString(), MaximumExceptionLength),
                ReleaseId: SafeIdentifier(LogValue(logEvent, LogPropertyNames.ReleaseId)),
                WorkId: SafeIdentifier(LogValue(logEvent, LogPropertyNames.WorkId)),
                StreamAttemptId: SafeIdentifier(LogValue(logEvent, LogPropertyNames.StreamAttemptId)),
                StreamTokenFingerprint: SafeIdentifier(LogValue(logEvent, LogPropertyNames.StreamTokenFingerprint)));

            lock (_gate)
            {
                _entries[_nextIndex] = record;
                _nextIndex = (_nextIndex + 1) % _entries.Length;
                if (_count < _entries.Length)
                    _count++;
            }
        }
        catch
        {
            // A diagnostic sink must never break the application path that emitted a log.
        }
    }

    internal CoreLogSnapshot Read(CoreLogQuery query, int limit)
    {
        var take = Math.Clamp(limit, 1, 500);
        var matches = new List<CoreLogRecord>(take + 1);

        lock (_gate)
        {
            for (var offset = 0; offset < _count && matches.Count <= take; offset++)
            {
                var index = (_nextIndex - 1 - offset + _entries.Length) % _entries.Length;
                var entry = _entries[index];
                if (entry is not null && Matches(entry, query))
                    matches.Add(entry);
            }
        }

        var hasMore = matches.Count > take;
        if (hasMore)
            matches.RemoveAt(matches.Count - 1);
        return new CoreLogSnapshot(matches, hasMore);
    }

    private static bool Matches(CoreLogRecord entry, CoreLogQuery query)
    {
        if (entry.Level < query.MinimumLevel)
            return false;

        if (!string.IsNullOrWhiteSpace(query.Search)
            && !Contains(entry.Message, query.Search)
            && !Contains(entry.Exception, query.Search)
            && !Contains(entry.Category, query.Search)
            && !Contains(entry.ReleaseId, query.Search)
            && !Contains(entry.WorkId, query.Search))
        {
            return false;
        }

        if (query.Correlation is not { } correlation)
            return true;

        if (!string.IsNullOrEmpty(correlation.StreamAttemptId)
            && string.Equals(entry.StreamAttemptId, correlation.StreamAttemptId, StringComparison.Ordinal))
        {
            return true;
        }

        if (!string.IsNullOrEmpty(correlation.StreamTokenFingerprint)
            && string.Equals(
                entry.StreamTokenFingerprint,
                correlation.StreamTokenFingerprint,
                StringComparison.Ordinal))
        {
            return true;
        }

        // A structured correlation that explicitly belongs to another attempt must never
        // bleed into this stream merely because both attempts share a release/work.
        if (!string.IsNullOrEmpty(entry.StreamAttemptId)
            || !string.IsNullOrEmpty(entry.StreamTokenFingerprint))
        {
            return false;
        }

        // Older/background events may predate an attempt scope. Release/work matching is a
        // best-effort fallback so the stream console still surfaces relevant diagnostics.
        return (!string.IsNullOrEmpty(correlation.ReleaseId)
                && string.Equals(entry.ReleaseId, correlation.ReleaseId, StringComparison.Ordinal))
               || (!string.IsNullOrEmpty(correlation.WorkId)
                   && string.Equals(entry.WorkId, correlation.WorkId, StringComparison.Ordinal));
    }

    private static string? LogValue(LogEvent logEvent, string propertyName)
        => logEvent.Properties.TryGetValue(propertyName, out var value)
           && value is ScalarValue { Value: not null } scalar
            ? Convert.ToString(scalar.Value, CultureInfo.InvariantCulture)
            : null;

    private static string? SafeIdentifier(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? null
            : LogSanitizer.SanitizeAndTruncate(value, 256);

    private static bool Contains(string? haystack, string needle)
        => haystack?.Contains(needle, StringComparison.OrdinalIgnoreCase) == true;
}

internal sealed record CoreLogRecord(
    long Sequence,
    DateTimeOffset AtUtc,
    LogEventLevel Level,
    string Category,
    string Message,
    string? Exception,
    string? ReleaseId,
    string? WorkId,
    string? StreamAttemptId,
    string? StreamTokenFingerprint);

internal sealed record CoreLogSnapshot(IReadOnlyList<CoreLogRecord> Entries, bool HasMore);

internal sealed record CoreLogQuery(
    LogEventLevel MinimumLevel,
    string? Search,
    LogCorrelation? Correlation = null);

internal sealed record LogCorrelation(
    string? StreamAttemptId,
    string? ReleaseId,
    string? WorkId,
    string? StreamTokenFingerprint);

internal static class LogPropertyNames
{
    internal const string StreamAttemptId = "StreamAttemptId";
    internal const string ReleaseId = "ReleaseId";
    internal const string WorkId = "WorkId";
    internal const string StreamTokenFingerprint = "StreamTokenFingerprint";
}

internal static partial class LogSanitizer
{
    private const string Redacted = "[redacted]";

    [GeneratedRegex("(?i)(authorization\\s*[:=]\\s*(?:bearer|mediabrowser)?\\s*)[^\\s,;]+", RegexOptions.CultureInvariant)]
    private static partial Regex AuthorizationRegex();

    [GeneratedRegex("(?i)(token|api[_-]?key|apikey|password|passwd|secret)(\\s*[=:]\\s*|\\s*=\\s*\\\")[^\\s&,;\\\"]+", RegexOptions.CultureInvariant)]
    private static partial Regex NamedSecretRegex();

    [GeneratedRegex("(?i)([?&](?:token|api[_-]?key|apikey|password|secret)=)[^&#\\s]+", RegexOptions.CultureInvariant)]
    private static partial Regex QuerySecretRegex();

    [GeneratedRegex("(?i)(/api/v1/(?:stream|streams|sessions|ephemeral-files|playback-sessions)/)[a-z0-9_-]{24,}(?=/|[?#\\s]|$)", RegexOptions.CultureInvariant)]
    private static partial Regex CapabilityPathRegex();

    internal static string SanitizeAndTruncate(string value, int maximumLength)
    {
        if (string.IsNullOrEmpty(value))
            return value;

        var sanitized = AuthorizationRegex().Replace(value, "$1" + Redacted);
        sanitized = NamedSecretRegex().Replace(sanitized, "$1$2" + Redacted);
        sanitized = QuerySecretRegex().Replace(sanitized, "$1" + Redacted);
        sanitized = CapabilityPathRegex().Replace(sanitized, "$1{capability}");
        return sanitized.Length <= maximumLength
            ? sanitized
            : string.Concat(sanitized.AsSpan(0, maximumLength), "…");
    }

    internal static string FingerprintToken(string token)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(hash.AsSpan(0, 12)).ToLowerInvariant();
    }
}
