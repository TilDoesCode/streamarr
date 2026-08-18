using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Serilog.Events;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Logging;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>Bounded, sanitized diagnostics from Core and the optional Jellyfin integration.</summary>
[ApiController]
[Route("api/v1/logs")]
[Authorize(Policy = AuthRoles.AdminPolicy)]
public sealed class LogsController(
    CoreLogStore coreLogs,
    IJellyfinLogSource jellyfinLogs,
    SessionManager sessions,
    StreamHistoryRecorder streamHistory,
    IConfiguration configuration,
    TimeProvider time) : ControllerBase
{
    private const int DefaultLimit = 200;
    private const int MaximumLimit = 500;

    [HttpGet]
    [ProducesResponseType(typeof(LogFeedResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<LogFeedResponse>> Get(
        [FromQuery] string source = "all",
        [FromQuery] string minimumLevel = "information",
        [FromQuery] string? search = null,
        [FromQuery] string? streamToken = null,
        [FromQuery] int limit = DefaultLimit,
        CancellationToken ct = default)
    {
        if (!TryParseSource(source, out var selectedSource))
        {
            return BadRequest(ErrorResponse.Of(
                "invalid_log_source",
                "source must be one of: all, core, jellyfin."));
        }

        if (!TryParseLevel(minimumLevel, out var selectedLevel))
        {
            return BadRequest(ErrorResponse.Of(
                "invalid_log_level",
                "minimumLevel must be one of: trace, debug, information, warning, error."));
        }

        if (search?.Length > 256 || streamToken?.Length > 512)
        {
            return BadRequest(ErrorResponse.Of(
                "invalid_log_filter",
                "search and streamToken exceed the permitted length."));
        }

        var take = Math.Clamp(limit <= 0 ? DefaultLimit : limit, 1, MaximumLimit);
        var generatedAt = time.GetUtcNow();
        var correlation = string.IsNullOrWhiteSpace(streamToken)
            ? null
            : await ResolveCorrelationAsync(streamToken.Trim(), ct);
        var cleanSearch = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
        var entries = new List<LogEntryResponse>(take * 2);
        var hasMore = false;

        if (selectedSource is SelectedSource.All or SelectedSource.Core)
        {
            var snapshot = coreLogs.Read(
                new CoreLogQuery(selectedLevel, cleanSearch, correlation),
                take);
            entries.AddRange(snapshot.Entries.Select(ToResponse));
            hasMore |= snapshot.HasMore;
        }

        JellyfinLogSnapshot? jellyfinSnapshot = null;
        if (selectedSource is SelectedSource.All or SelectedSource.Jellyfin)
        {
            jellyfinSnapshot = await jellyfinLogs.GetSnapshotAsync(ct);
            if (jellyfinSnapshot.Status == JellyfinLogFetchStatus.Available)
            {
                var matching = new List<JellyfinFeedCandidate>();
                var duplicateOrdinals = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var entry in jellyfinSnapshot.Entries)
                {
                    if (JellyfinLevel(entry.Level) < selectedLevel
                        || (cleanSearch is not null
                            && !entry.Message.Contains(cleanSearch, StringComparison.OrdinalIgnoreCase))
                        || (correlation is not null && !Matches(entry, correlation)))
                    {
                        continue;
                    }

                    var identity = JellyfinIdentity(entry, jellyfinSnapshot);
                    duplicateOrdinals.TryGetValue(identity, out var duplicateOrdinal);
                    duplicateOrdinals[identity] = duplicateOrdinal + 1;
                    matching.Add(new JellyfinFeedCandidate(entry, duplicateOrdinal));
                }

                matching.Sort((left, right) =>
                    (right.Entry.Timestamp ?? jellyfinSnapshot.CheckedAtUtc)
                    .CompareTo(left.Entry.Timestamp ?? jellyfinSnapshot.CheckedAtUtc));
                hasMore |= matching.Count > take || jellyfinSnapshot.IsTruncated;
                entries.AddRange(matching.Take(take).Select(candidate =>
                    ToResponse(
                        candidate.Entry,
                        jellyfinSnapshot,
                        correlation,
                        candidate.DuplicateOrdinal)));
            }
        }

        var ordered = entries
            .OrderByDescending(entry => entry.AtUtc)
            .ThenByDescending(entry => entry.Id, StringComparer.Ordinal)
            .ToList();
        if (ordered.Count > take)
        {
            ordered.RemoveRange(take, ordered.Count - take);
            hasMore = true;
        }

        return Ok(new LogFeedResponse
        {
            Entries = ordered,
            Sources =
            [
                new LogSourceStatusResponse
                {
                    Source = "core",
                    Configured = true,
                    Available = true,
                    LastCheckedAt = generatedAt,
                },
                JellyfinStatus(jellyfinSnapshot),
            ],
            GeneratedAt = generatedAt,
            HasMore = hasMore,
        });
    }

    private async Task<LogCorrelation> ResolveCorrelationAsync(string token, CancellationToken ct)
    {
        if (sessions.TryGetSession(token, out var active))
        {
            return new LogCorrelation(
                active.StreamAttemptId,
                active.Session.ReleaseId,
                active.Session.WorkId,
                LogSanitizer.FingerprintToken(token));
        }

        var record = await streamHistory.GetCorrelationAsync(token, ct);
        return new LogCorrelation(
            record?.AttemptId,
            record?.ReleaseId,
            record?.WorkId,
            LogSanitizer.FingerprintToken(token));
    }

    private LogSourceStatusResponse JellyfinStatus(JellyfinLogSnapshot? snapshot)
    {
        if (snapshot is not null)
        {
            return new LogSourceStatusResponse
            {
                Source = "jellyfin",
                Configured = snapshot.Status != JellyfinLogFetchStatus.Disabled,
                Available = snapshot.Status == JellyfinLogFetchStatus.Available,
                Message = snapshot.Detail,
                LastCheckedAt = snapshot.CheckedAtUtc,
            };
        }

        var baseUrl = configuration["Streamarr:Jellyfin:BaseUrl"];
        var apiKey = configuration["Streamarr:Jellyfin:ApiKey"];
        var configured = !string.IsNullOrWhiteSpace(baseUrl) || !string.IsNullOrWhiteSpace(apiKey);
        return new LogSourceStatusResponse
        {
            Source = "jellyfin",
            Configured = configured,
            Available = false,
            Message = configured
                ? "Jellyfin was not checked because this request selected only Core logs."
                : "Jellyfin log retrieval is not configured.",
        };
    }

    private static bool Matches(JellyfinLogEntry entry, LogCorrelation correlation)
        => Contains(entry.Message, correlation.ReleaseId)
           || Contains(entry.Message, correlation.WorkId);

    private static bool Contains(string message, string? value)
        => !string.IsNullOrWhiteSpace(value)
           && message.Contains(value, StringComparison.OrdinalIgnoreCase);

    private static LogEntryResponse ToResponse(CoreLogRecord entry) => new()
    {
        Id = $"core-{entry.Sequence}",
        AtUtc = entry.AtUtc,
        Level = ApiLevel(entry.Level),
        Source = "core",
        Category = entry.Category,
        Message = entry.Message,
        Exception = entry.Exception,
        ReleaseId = entry.ReleaseId,
        WorkId = entry.WorkId,
    };

    private static LogEntryResponse ToResponse(
        JellyfinLogEntry entry,
        JellyfinLogSnapshot snapshot,
        LogCorrelation? correlation,
        int duplicateOrdinal)
    {
        var at = entry.Timestamp ?? snapshot.CheckedAtUtc;
        var hashInput = string.Concat(JellyfinIdentity(entry, snapshot), "\n", duplicateOrdinal);
        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(hashInput)).AsSpan(0, 12))
            .ToLowerInvariant();
        return new LogEntryResponse
        {
            Id = "jellyfin-" + id,
            AtUtc = at,
            Level = ApiLevel(JellyfinLevel(entry.Level)),
            Source = "jellyfin",
            Category = snapshot.SourceFileName ?? "Jellyfin.Server",
            Message = entry.Message,
            ReleaseId = correlation?.ReleaseId,
            WorkId = correlation?.WorkId,
        };
    }

    private static string JellyfinIdentity(JellyfinLogEntry entry, JellyfinLogSnapshot snapshot)
        => string.Concat(
            snapshot.SourceFileName,
            "\n",
            entry.Timestamp?.ToString("O") ?? string.Empty,
            "\n",
            entry.Level,
            "\n",
            entry.Message);

    private static bool TryParseSource(string? value, out SelectedSource source)
    {
        source = value?.Trim().ToLowerInvariant() switch
        {
            "all" => SelectedSource.All,
            "core" => SelectedSource.Core,
            "jellyfin" => SelectedSource.Jellyfin,
            _ => SelectedSource.Invalid,
        };
        return source != SelectedSource.Invalid;
    }

    private static bool TryParseLevel(string? value, out LogEventLevel level)
    {
        level = value?.Trim().ToLowerInvariant() switch
        {
            "trace" => LogEventLevel.Verbose,
            "debug" => LogEventLevel.Debug,
            "information" => LogEventLevel.Information,
            "warning" => LogEventLevel.Warning,
            "error" => LogEventLevel.Error,
            _ => (LogEventLevel)(-1),
        };
        return (int)level >= 0;
    }

    private static LogEventLevel JellyfinLevel(string level) => level.ToLowerInvariant() switch
    {
        "trace" or "verbose" => LogEventLevel.Verbose,
        "debug" => LogEventLevel.Debug,
        "warning" or "warn" => LogEventLevel.Warning,
        "error" or "fatal" => LogEventLevel.Error,
        _ => LogEventLevel.Information,
    };

    private static string ApiLevel(LogEventLevel level) => level switch
    {
        LogEventLevel.Verbose => "trace",
        LogEventLevel.Debug => "debug",
        LogEventLevel.Warning => "warning",
        LogEventLevel.Error or LogEventLevel.Fatal => "error",
        _ => "information",
    };

    private enum SelectedSource
    {
        Invalid,
        All,
        Core,
        Jellyfin,
    }

    private sealed record JellyfinFeedCandidate(JellyfinLogEntry Entry, int DuplicateOrdinal);
}
