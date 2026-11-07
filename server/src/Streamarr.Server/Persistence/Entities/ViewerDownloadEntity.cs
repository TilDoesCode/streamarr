namespace Streamarr.Server.Persistence.Entities;

/// <summary>One version a viewer downloads (or downloaded) onto a device; the server keeps no file, only this record and the file capability.</summary>
public sealed class ViewerDownloadEntity
{
    public required string Id { get; set; }
    public string ViewerId { get; set; } = string.Empty;

    /// <summary>The viewer session (device) that prepared it; no foreign key, the record outlives a sign-out.</summary>
    public string SessionId { get; set; } = string.Empty;
    public string? DeviceName { get; set; }
    public string? DeviceId { get; set; }
    public string? ClientRef { get; set; }

    /// <summary>
    /// The normalized device of a prepare with <c>clientRef</c> (<c>d:</c> + ASCII-lowercased <c>deviceId</c>, else <c>s:</c> + session):
    /// (<see cref="ViewerId"/>, <see cref="DeviceKey"/>, <see cref="ClientRef"/>) is unique, so retries return one download. Null without
    /// a client reference, and on duplicates an upgrade found (the oldest keeps it).
    /// </summary>
    public string? DeviceKey { get; set; }

    public string WorkId { get; set; } = string.Empty;
    public string? SeriesWorkId { get; set; }
    public string? Title { get; set; }
    public string RequestedReleaseId { get; set; } = string.Empty;
    public string? ReleaseId { get; set; }
    public string? ReleaseName { get; set; }
    public string? FallbackFromReleaseId { get; set; }

    /// <summary><c>queued</c>, <c>resolving</c>, <c>probing</c>, <c>ready</c>, <c>failed</c> or <c>completed</c>.</summary>
    public string State { get; set; } = "queued";

    /// <summary>The device profile and engine preference of the prepare request (JSON), so a preparation resumes after a restart.</summary>
    public string RequestJson { get; set; } = "{}";

    public string? ErrorJson { get; set; }
    public string? AttemptsJson { get; set; }
    public string? VersionJson { get; set; }
    public string? MediaInfoJson { get; set; }
    public string? DecisionJson { get; set; }

    public string? Engine { get; set; }
    public string? FileName { get; set; }
    public string? Container { get; set; }
    public long? SizeBytes { get; set; }
    public string? ETag { get; set; }

    /// <summary>SHA-256 (hex) of the file capability: the only lookup key.</summary>
    public string? CapabilityHash { get; set; }

    /// <summary>The capability protected with ASP.NET Data Protection, so the owning device can read its URL again.</summary>
    public string? CapabilityProtected { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>SHA-256 of the file capability a security sign-out revoked (it answers 410 download_revoked until the next rotation).</summary>
    public string? RevokedCapabilityHash { get; set; }

    /// <summary>Set while the file capability is revoked and not renewed (also on a preparation a security sign-out covered).</summary>
    public DateTimeOffset? CapabilityRevokedAt { get; set; }

    /// <summary>The viewer's <see cref="ViewerEntity.SecurityGeneration"/> when the download was created or last renewed.</summary>
    public long SecurityGeneration { get; set; }

    /// <summary>Row version: every lifecycle change increments it and is saved only against the version it read.</summary>
    public long Revision { get; set; }

    public long BytesServed { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? ReadyAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public DateTimeOffset? LastTransferAt { get; set; }
}
