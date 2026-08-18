using System.Text.Json.Serialization;

namespace Streamarr.Server.Contracts;

/// <summary>Combined, newest-first diagnostic feed from Core and configured integrations.</summary>
public sealed record LogFeedResponse
{
    public IReadOnlyList<LogEntryResponse> Entries { get; init; } = [];
    public IReadOnlyList<LogSourceStatusResponse> Sources { get; init; } = [];
    public DateTimeOffset GeneratedAt { get; init; }
    public bool HasMore { get; init; }
}

/// <summary>One sanitized diagnostic event suitable for display in the management UI.</summary>
public sealed record LogEntryResponse
{
    public required string Id { get; init; }
    public DateTimeOffset AtUtc { get; init; }

    /// <summary>trace | debug | information | warning | error.</summary>
    public required string Level { get; init; }

    /// <summary>core | jellyfin.</summary>
    public required string Source { get; init; }

    public required string Category { get; init; }
    public required string Message { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Exception { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ReleaseId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? WorkId { get; init; }
}

/// <summary>Availability of one log source at the time the feed was generated.</summary>
public sealed record LogSourceStatusResponse
{
    /// <summary>core | jellyfin.</summary>
    public required string Source { get; init; }

    public bool Configured { get; init; }
    public bool Available { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? LastCheckedAt { get; init; }
}
