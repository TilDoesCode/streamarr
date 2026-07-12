namespace Streamarr.Server.Contracts;

/// <summary>Request body of POST /api/v1/resolve (BRIEF §6.2).</summary>
public sealed record ResolveRequest
{
    public required string ReleaseId { get; init; }

    /// <summary>Originating front-end ("jellyfin", "web", …) for session attribution.</summary>
    public string? Client { get; init; }
}

/// <summary>
/// Neutral media stream shape — deliberately NOT Jellyfin's MediaStream schema
/// (BRIEF §6.2): the plugin maps this onto Jellyfin's model, other front-ends
/// consume it as-is.
/// </summary>
public sealed record MediaStreamInfo
{
    /// <summary>"Video", "Audio" or "Subtitle".</summary>
    public required string Type { get; init; }

    public string? Codec { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public int? Channels { get; init; }
    public string? Language { get; init; }
}

/// <summary>Response of POST /api/v1/resolve — the exact shape from BRIEF §6.2.</summary>
public sealed record ResolveResponse
{
    public required string ReleaseId { get; init; }

    /// <summary>"ready" | "degraded" | "dead".</summary>
    public required string Status { get; init; }

    /// <summary>Absolute stream URL; null when the release is dead.</summary>
    public string? StreamUrl { get; init; }

    public string? Container { get; init; }
    public long? SizeBytes { get; init; }
    public long? RunTimeTicks { get; init; }
    public IReadOnlyList<MediaStreamInfo> MediaStreams { get; init; } = [];
    public int SessionTtlSeconds { get; init; }

    /// <summary>Next-best release of the same work, set when this one is dead.</summary>
    public string? SuggestedFallbackReleaseId { get; init; }
}

/// <summary>One live session as listed by GET /api/v1/sessions.</summary>
public sealed record SessionResponse
{
    public required string Token { get; init; }
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public required string State { get; init; }
    public string? Container { get; init; }
    public long SizeBytes { get; init; }
    public long BytesServed { get; init; }
    public int NntpConnectionsInFlight { get; init; }
    public long NntpCommandsTotal { get; init; }
    public string? Client { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset LastAccessedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
}

/// <summary>Typed error envelope rendered consistently by every endpoint.</summary>
public sealed record ErrorResponse
{
    public required ErrorDetail Error { get; init; }

    public static ErrorResponse Of(string code, string message)
        => new() { Error = new ErrorDetail { Code = code, Message = message } };
}

public sealed record ErrorDetail
{
    public required string Code { get; init; }
    public required string Message { get; init; }
}
