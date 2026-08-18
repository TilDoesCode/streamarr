using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Streamarr.Server.Logging;

internal static partial class JellyfinLogParser
{
    internal const int MaximumEntries = 500;
    internal const int MaximumMessageCharacters = 4_096;

    public static (IReadOnlyList<JellyfinLogEntry> Entries, bool IsTruncated) Parse(
        string rawLog,
        string apiKey)
    {
        ArgumentNullException.ThrowIfNull(rawLog);
        ArgumentNullException.ThrowIfNull(apiKey);

        var entries = new Queue<JellyfinLogEntry>(MaximumEntries);
        var truncated = false;
        PendingEntry? pending = null;

        using var reader = new StringReader(rawLog);
        while (reader.ReadLine() is { } line)
        {
            var level = DetectLevel(line);
            var isWarningOrWorse = level is "Warning" or "Error" or "Fatal";
            var referencesStreamarr = line.Contains(
                "Streamarr",
                StringComparison.OrdinalIgnoreCase);

            if (IsLabeledEntryStart(line))
            {
                FlushPending(ref pending, entries, ref truncated);
                if (isWarningOrWorse || referencesStreamarr)
                {
                    pending = new PendingEntry(
                        ParseTimestamp(line),
                        level ?? "Information");
                    AppendLine(pending, line, apiKey, ref truncated);
                }

                // Every labelled line is an event boundary. In particular, an
                // unrelated [INF]/[DBG] entry ends the preceding warning's stack trace.
                continue;
            }

            if (pending is not null)
            {
                // Jellyfin writes exceptions and stack traces as unlabelled continuation
                // lines. Keep all of them until the next labelled log event.
                AppendLine(pending, line, apiKey, ref truncated);
                continue;
            }

            // Be permissive for non-standard/plain-text logs which do not use
            // Jellyfin's normal [timestamp] [level] prefix.
            if (isWarningOrWorse || referencesStreamarr)
            {
                pending = new PendingEntry(ParseTimestamp(line), level ?? "Information");
                AppendLine(pending, line, apiKey, ref truncated);
            }
        }

        FlushPending(ref pending, entries, ref truncated);
        return (entries.ToArray(), truncated);
    }

    private static void AppendLine(
        PendingEntry pending,
        string line,
        string apiKey,
        ref bool truncated)
    {
        if (pending.WasTruncated)
            return;

        var sanitized = Redact(line, apiKey);
        var separatorLength = pending.Message.Length == 0 ? 0 : Environment.NewLine.Length;
        var remaining = MaximumMessageCharacters - pending.Message.Length - separatorLength;
        if (remaining <= 0)
        {
            pending.WasTruncated = true;
            truncated = true;
            return;
        }

        if (separatorLength > 0)
            pending.Message.AppendLine();

        if (sanitized.Length <= remaining)
        {
            pending.Message.Append(sanitized);
            return;
        }

        pending.Message.Append(sanitized.AsSpan(0, remaining));
        pending.WasTruncated = true;
        truncated = true;
    }

    private static void FlushPending(
        ref PendingEntry? pending,
        Queue<JellyfinLogEntry> entries,
        ref bool truncated)
    {
        if (pending is null)
            return;

        var message = pending.Message.ToString();
        if (pending.WasTruncated)
            message = string.Concat(message, "… [truncated]");

        if (entries.Count == MaximumEntries)
        {
            entries.Dequeue();
            truncated = true;
        }

        entries.Enqueue(new JellyfinLogEntry(pending.Timestamp, pending.Level, message));
        pending = null;
    }

    private static bool IsLabeledEntryStart(string line)
        => BracketedLevelMarkerRegex().IsMatch(line);

    private static string? DetectLevel(string line)
    {
        var match = LevelMarkerRegex().Match(line);
        if (!match.Success)
            return null;

        return match.Groups["level"].Value.ToUpperInvariant() switch
        {
            "FTL" or "FATAL" => "Fatal",
            "ERR" or "ERROR" => "Error",
            "WRN" or "WARN" or "WARNING" => "Warning",
            "INF" or "INFORMATION" => "Information",
            "DBG" or "DEBUG" => "Debug",
            "VRB" or "VERBOSE" or "TRACE" => "Trace",
            _ => null,
        };
    }

    private static DateTimeOffset? ParseTimestamp(string line)
    {
        var match = TimestampRegex().Match(line);
        if (!match.Success)
            return null;

        return DateTimeOffset.TryParse(
            match.Groups["timestamp"].Value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AllowWhiteSpaces | DateTimeStyles.AssumeUniversal,
            out var timestamp)
            ? timestamp
            : null;
    }

    private static string Redact(string value, string apiKey)
    {
        if (!string.IsNullOrEmpty(apiKey))
            value = value.Replace(apiKey, "[REDACTED]", StringComparison.Ordinal);

        // Jellyfin and ffmpeg output can include both query-string credentials and
        // canonical/legacy authorization headers. Preserve the field name so the
        // resulting diagnostic remains useful while removing its value.
        value = AuthorizationRegex().Replace(value, "${prefix}[REDACTED]");
        value = CredentialRegex().Replace(value, "${prefix}[REDACTED]");
        return CapabilityPathRegex().Replace(value, "${prefix}{capability}");
    }

    [GeneratedRegex(
        @"(?:\[(?<level>FTL|ERR|WRN|INF|DBG|VRB|FATAL|ERROR|WARN|WARNING|INFORMATION|DEBUG|VERBOSE|TRACE)\])|(?:\b(?<level>Fatal|Error|Warning)\b)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LevelMarkerRegex();

    [GeneratedRegex(
        @"\[(?:FTL|ERR|WRN|INF|DBG|VRB|FATAL|ERROR|WARN|WARNING|INFORMATION|DEBUG|VERBOSE|TRACE)\]",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BracketedLevelMarkerRegex();

    [GeneratedRegex(
        @"^\s*\[(?<timestamp>\d{4}-\d{2}-\d{2}[^\]]*)\]",
        RegexOptions.CultureInvariant)]
    private static partial Regex TimestampRegex();

    [GeneratedRegex(
        @"(?<prefix>\b(?:api[_-]?key|access[_-]?token|token|x-emby-token|x-mediabrowser-token|password|passwd|secret)\b\s*(?:=|:)\s*)(?:\""[^\""\r\n]*\""|'[^'\r\n]*'|[^\s&,;]+)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CredentialRegex();

    [GeneratedRegex(
        @"(?<prefix>\bauthorization\b\s*(?:=|:)\s*)(?:bearer\s+|mediabrowser\s+)?[^\r\n]+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AuthorizationRegex();

    [GeneratedRegex(
        @"(?<prefix>/api/v1/(?:stream|streams|sessions|ephemeral-files|playback-sessions)/)[a-z0-9_-]{24,}(?=/|[?#\s]|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CapabilityPathRegex();

    private sealed class PendingEntry(DateTimeOffset? timestamp, string level)
    {
        public DateTimeOffset? Timestamp { get; } = timestamp;
        public string Level { get; } = level;
        public StringBuilder Message { get; } = new();
        public bool WasTruncated { get; set; }
    }
}
