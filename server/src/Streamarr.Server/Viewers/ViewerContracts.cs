using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Viewers;

public sealed record ViewerAuthOptionsResponse
{
    public required string ServerName { get; init; }
    public required bool PasswordLogin { get; init; }
    public required bool EmailCodeLogin { get; init; }
    public required bool PasswordReset { get; init; }
    public required bool TwoFactor { get; init; }
    public required int PasswordMinLength { get; init; }
}

public sealed record ViewerLoginRequest
{
    /// <summary>Username or verified email address.</summary>
    public string? Login { get; init; }
    public string? Password { get; init; }
    public string? DeviceName { get; init; }
    public string? ClientName { get; init; }
    /// <summary>Browser clients: keep tokens in HttpOnly cookies instead of the response body.</summary>
    public bool UseCookies { get; init; }
}

public sealed record ViewerSecondFactorRequest
{
    public string? MfaToken { get; init; }
    /// <summary>6-digit authenticator code or a recovery code.</summary>
    public string? Code { get; init; }
    public string? DeviceName { get; init; }
    public string? ClientName { get; init; }
    public bool UseCookies { get; init; }
}

public sealed record ViewerCodeRequest
{
    public string? Login { get; init; }
}

public sealed record ViewerCodeLoginRequest
{
    public string? Login { get; init; }
    public string? Code { get; init; }
    public string? DeviceName { get; init; }
    public string? ClientName { get; init; }
    public bool UseCookies { get; init; }
}

public sealed record ViewerPasswordResetRequest
{
    public string? Login { get; init; }
    public string? Code { get; init; }
    public string? NewPassword { get; init; }
}

public sealed record ViewerRefreshRequest
{
    public string? RefreshToken { get; init; }
}

/// <summary>Either a second-factor challenge or a signed-in session.</summary>
public sealed record ViewerAuthResponse
{
    /// <summary>"authenticated" or "mfa_required".</summary>
    public required string Status { get; init; }
    public string? MfaToken { get; init; }
    public DateTimeOffset? MfaExpiresAt { get; init; }
    public ViewerSessionTokensResponse? Session { get; init; }
    public ViewerProfileResponse? Viewer { get; init; }
}

public sealed record ViewerSessionTokensResponse
{
    public required string SessionId { get; init; }
    public string TokenType { get; init; } = "Bearer";
    /// <summary>Omitted in cookie mode.</summary>
    public string? AccessToken { get; init; }
    public required DateTimeOffset AccessExpiresAt { get; init; }
    /// <summary>Omitted in cookie mode.</summary>
    public string? RefreshToken { get; init; }
    public required DateTimeOffset RefreshExpiresAt { get; init; }
    public required bool CookieMode { get; init; }
}

public sealed record ViewerPermissionsDto
{
    /// <summary>Highest allowed minimum age (0, 6, 12, 16, 18); null = unrestricted.</summary>
    public int? MaxAge { get; init; }
    public bool BlockUnrated { get; init; }
    public bool AllowTranscoding { get; init; } = true;
    /// <summary>Null = unlimited.</summary>
    public int? MaxConcurrentStreams { get; init; }
}

public sealed record ViewerProfileResponse
{
    public string AccountType { get; init; } = "viewer";
    public required string Id { get; init; }
    public required string Username { get; init; }
    public required string DisplayName { get; init; }
    public string? Email { get; init; }
    public bool EmailVerified { get; init; }
    public string? PendingEmail { get; init; }
    public bool MustChangePassword { get; init; }
    public bool TwoFactorEnabled { get; init; }
    public int RecoveryCodesRemaining { get; init; }
    public required ViewerPermissionsDto Permissions { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? LastLoginAt { get; init; }
}

public sealed record ViewerProfileUpdateRequest
{
    public string? DisplayName { get; init; }
}

public sealed record ViewerChangePasswordRequest
{
    public string? CurrentPassword { get; init; }
    public string? NewPassword { get; init; }
}

public sealed record ViewerEmailChangeRequest
{
    /// <summary>New address; empty removes the email from the account.</summary>
    public string? Email { get; init; }
    public string? CurrentPassword { get; init; }
}

public sealed record ViewerEmailChangeResponse
{
    public required bool VerificationSent { get; init; }
    public string? PendingEmail { get; init; }
}

public sealed record ViewerCodeConfirmRequest
{
    public string? Code { get; init; }
}

public sealed record ViewerPasswordConfirmRequest
{
    public string? CurrentPassword { get; init; }
}

public sealed record ViewerTotpSetupResponse
{
    public required string Secret { get; init; }
    public required string OtpAuthUri { get; init; }
    public required string Issuer { get; init; }
    public required string AccountName { get; init; }
}

public sealed record ViewerRecoveryCodesResponse
{
    public required IReadOnlyList<string> RecoveryCodes { get; init; }
}

public sealed record ViewerDeviceSessionResponse
{
    public required string Id { get; init; }
    public required string DeviceName { get; init; }
    public required string ClientName { get; init; }
    public required string AuthMethod { get; init; }
    public bool CookieMode { get; init; }
    public string? IpAddress { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset LastSeenAt { get; init; }
    public DateTimeOffset RefreshExpiresAt { get; init; }
    public bool Current { get; init; }
}

public sealed record WatchProgressRequest
{
    /// <summary>"start", "progress" or "stop".</summary>
    public string? Event { get; init; }
    /// <summary>Canonical movie or episode work id, e.g. <c>tmdb-movie-603</c> or <c>tmdb-tv-1396-s01e01</c>.</summary>
    public string? WorkId { get; init; }
    public long PositionTicks { get; init; }
    public long? DurationTicks { get; init; }
    /// <summary>Id of one playback, used to count a completed play exactly once; a <c>/viewer/playback</c> id of this device also fills <c>releaseId</c>/<c>streamToken</c>, keeps that playback alive, and <c>stop</c> ends it.</summary>
    public string? PlaybackId { get; init; }
    /// <summary>Optional (filled from a server playback): forwards the report to the shared event stream (pre-download, notifications).</summary>
    public string? ReleaseId { get; init; }
    public string? StreamToken { get; init; }
    public string? Title { get; init; }
}

public sealed record WatchWorkIdsRequest
{
    /// <summary>Movie/episode ids; for played/unplayed also season (<c>tmdb-tv-1-s02</c>) or series (<c>tmdb-tv-1</c>) ids.</summary>
    public IReadOnlyList<string>? WorkIds { get; init; }
}

public sealed record WatchStateResponse
{
    public required string WorkId { get; init; }
    public required string Kind { get; init; }
    public string? SeriesWorkId { get; init; }
    public int? SeasonNumber { get; init; }
    public int? EpisodeNumber { get; init; }
    public string? Title { get; init; }
    public long PositionTicks { get; init; }
    public long? DurationTicks { get; init; }
    public double? ProgressPercent { get; init; }
    public bool Played { get; init; }
    public int PlayCount { get; init; }
    public string? LastReleaseId { get; init; }
    public DateTimeOffset? LastPlayedAt { get; init; }
    public DateTimeOffset? PlayedAt { get; init; }

    /// <summary>Vivid accent of the title (series for episodes) (<c>#RRGGBB</c>, at least 3:1 against <c>#0A0C12</c>); continue watching only, null until computed.</summary>
    public string? Tint { get; init; }

    /// <summary>Deep shade of the title (series for episodes) (<c>#RRGGBB</c>, white text reaches 4.5:1 on it); continue watching only, null until computed.</summary>
    public string? Tint2 { get; init; }

    /// <summary>Best known version by quality (from the last version lookup); continue watching only; null when none is known yet.</summary>
    public CatalogSpecDto? Spec { get; init; }
}

public sealed record WatchHistoryResponse
{
    public required IReadOnlyList<WatchStateResponse> Items { get; init; }
    public required int Total { get; init; }
}

public sealed record WatchMarkResponse
{
    public required IReadOnlyList<string> WorkIds { get; init; }
    public required bool Played { get; init; }
}

public sealed record NextUpItemResponse
{
    public required string WorkId { get; init; }
    public required string SeriesWorkId { get; init; }
    public required string SeriesTitle { get; init; }
    public string? SeriesPosterUrl { get; init; }
    public required int SeasonNumber { get; init; }
    public required int EpisodeNumber { get; init; }
    public required string EpisodeTitle { get; init; }
    public string? AirDate { get; init; }
    public string? StillUrl { get; init; }
    public int? RuntimeMinutes { get; init; }
    public long PositionTicks { get; init; }
    public long? DurationTicks { get; init; }
    public required string LastWatchedWorkId { get; init; }
    public required DateTimeOffset LastActivityAt { get; init; }

    /// <summary>Vivid accent of the series (<c>#RRGGBB</c>, at least 3:1 against <c>#0A0C12</c>); null until computed.</summary>
    public string? Tint { get; init; }

    /// <summary>Deep shade of the series (<c>#RRGGBB</c>, white text reaches 4.5:1 on it); null until computed.</summary>
    public string? Tint2 { get; init; }

    /// <summary>Best known version by quality (from the last version lookup); null when none is known yet.</summary>
    public CatalogSpecDto? Spec { get; init; }
}

public sealed record NextUpResponse
{
    public required IReadOnlyList<NextUpItemResponse> Items { get; init; }
    /// <summary>True when some series could not be checked (e.g. TMDB unavailable).</summary>
    public required bool Incomplete { get; init; }
}

public sealed record ContentAccessResponse
{
    public required string WorkId { get; init; }
    public required bool Allowed { get; init; }
    /// <summary>unrestricted, within_age_limit, above_age_limit, unrated_allowed, unrated_blocked or rating_unavailable.</summary>
    public required string Reason { get; init; }
    public string? Rating { get; init; }
    public int? MinimumAge { get; init; }
    public int? ViewerMaxAge { get; init; }
}

public sealed record ViewerAdminResponse
{
    public string AccountType { get; init; } = "viewer";
    public required string Id { get; init; }
    public required string Username { get; init; }
    public required string DisplayName { get; init; }
    public string? Email { get; init; }
    public bool EmailVerified { get; init; }
    public string? PendingEmail { get; init; }
    public bool Disabled { get; init; }
    public DateTimeOffset? LockedUntil { get; init; }
    public bool MustChangePassword { get; init; }
    public bool TwoFactorEnabled { get; init; }
    public required ViewerPermissionsDto Permissions { get; init; }
    public int ActiveSessions { get; init; }
    public int PlayedCount { get; init; }
    public int InProgressCount { get; init; }
    public DateTimeOffset? LastPlayedAt { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? LastLoginAt { get; init; }
}

public sealed record ViewerCreateRequest
{
    public string? Username { get; init; }
    public string? DisplayName { get; init; }
    public string? Email { get; init; }
    /// <summary>Leave empty to generate a password that is returned once.</summary>
    public string? Password { get; init; }
    /// <summary>Defaults to true for generated passwords.</summary>
    public bool? MustChangePassword { get; init; }
    public ViewerPermissionsDto? Permissions { get; init; }
    public bool Disabled { get; init; }
}

public sealed record ViewerCreatedResponse
{
    public required ViewerAdminResponse Viewer { get; init; }
    public string? GeneratedPassword { get; init; }
}

public sealed record ViewerUpdateRequest
{
    public string? DisplayName { get; init; }
    /// <summary>New address (trusted as verified); empty string removes it; null keeps it.</summary>
    public string? Email { get; init; }
    public bool? Disabled { get; init; }
    public bool? MustChangePassword { get; init; }
    /// <summary>Clears an active lockout and the failed-attempt counter.</summary>
    public bool Unlock { get; init; }
    public ViewerPermissionsDto? Permissions { get; init; }
}

public sealed record ViewerSetPasswordRequest
{
    /// <summary>Leave empty to generate one.</summary>
    public string? Password { get; init; }
    public bool MustChangePassword { get; init; } = true;
}

public sealed record ViewerSetPasswordResponse
{
    public string? GeneratedPassword { get; init; }
}

public sealed record ViewerSettingsResponse
{
    public required bool Enabled { get; init; }
    public required string ServerName { get; init; }
    public required int AccessTokenMinutes { get; init; }
    public required int RefreshTokenDays { get; init; }
    public required int MaxSessionsPerViewer { get; init; }
    public required int PasswordMinLength { get; init; }
    public required int LockoutThreshold { get; init; }
    public required int LockoutMinutes { get; init; }
    public required bool AllowPasswordReset { get; init; }
    public required bool AllowEmailLogin { get; init; }
    public required bool AllowTotp { get; init; }
    public required int MinResumePercent { get; init; }
    public required int PlayedPercent { get; init; }
    public required int MinResumeDurationSeconds { get; init; }
    public required int NextUpCutoffDays { get; init; }
    public required ViewerEmailSettingsDto Email { get; init; }
    public required bool EmailDeliveryReady { get; init; }
    public required int ViewerCount { get; init; }
}

public sealed record ViewerEmailSettingsDto
{
    /// <summary>disabled, smtp or outbox (test mode: messages are only captured, never sent).</summary>
    public string? Mode { get; init; }
    public string? SmtpHost { get; init; }
    public int? SmtpPort { get; init; }
    /// <summary>auto, none, startTls or sslOnConnect.</summary>
    public string? SmtpSecurity { get; init; }
    public string? SmtpUsername { get; init; }
    /// <summary>Write-only; reads return a mask when set. Omit or send the mask to keep it, empty string clears it.</summary>
    public string? SmtpPassword { get; init; }
    public string? FromAddress { get; init; }
    public string? FromName { get; init; }
}

public sealed record ViewerSettingsWrite
{
    public bool? Enabled { get; init; }
    public string? ServerName { get; init; }
    public int? AccessTokenMinutes { get; init; }
    public int? RefreshTokenDays { get; init; }
    public int? MaxSessionsPerViewer { get; init; }
    public int? PasswordMinLength { get; init; }
    public int? LockoutThreshold { get; init; }
    public int? LockoutMinutes { get; init; }
    public bool? AllowPasswordReset { get; init; }
    public bool? AllowEmailLogin { get; init; }
    public bool? AllowTotp { get; init; }
    public int? MinResumePercent { get; init; }
    public int? PlayedPercent { get; init; }
    public int? MinResumeDurationSeconds { get; init; }
    public int? NextUpCutoffDays { get; init; }
    public ViewerEmailSettingsDto? Email { get; init; }
}

public sealed record ViewerTestEmailRequest
{
    public string? To { get; init; }
}

public sealed record ViewerOutboxMessageResponse
{
    public required string Id { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required string To { get; init; }
    public required string Subject { get; init; }
    public required string Kind { get; init; }
    public required string Text { get; init; }
}
