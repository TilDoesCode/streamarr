using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Email;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers;

internal static class ViewerMappings
{
    public static ViewerPermissionsDto Permissions(ViewerEntity v) => new()
    {
        MaxAge = v.MaxAge,
        BlockUnrated = v.BlockUnrated,
        AllowTranscoding = v.AllowTranscoding,
        MaxConcurrentStreams = v.MaxConcurrentStreams,
    };

    public static ViewerPermissions Permissions(ViewerPermissionsDto? dto)
        => new(dto?.MaxAge, dto?.BlockUnrated ?? false, dto?.AllowTranscoding ?? true, dto?.MaxConcurrentStreams);

    public static ViewerProfileResponse Profile(ViewerEntity v, int recoveryCodesRemaining) => new()
    {
        Id = v.Id,
        Username = v.Username,
        DisplayName = v.DisplayName,
        Email = v.Email,
        EmailVerified = v.EmailVerifiedAt is not null,
        PendingEmail = v.PendingEmail,
        MustChangePassword = v.MustChangePassword,
        TwoFactorEnabled = v.TotpEnabledAt is not null,
        RecoveryCodesRemaining = recoveryCodesRemaining,
        Permissions = Permissions(v),
        CreatedAt = v.CreatedAt,
        LastLoginAt = v.LastLoginAt,
    };

    public static ViewerAdminResponse Admin(ViewerEntity v, int sessions, WatchSummary? watch, DateTimeOffset now) => new()
    {
        Id = v.Id,
        Username = v.Username,
        DisplayName = v.DisplayName,
        Email = v.Email,
        EmailVerified = v.EmailVerifiedAt is not null,
        PendingEmail = v.PendingEmail,
        Disabled = v.IsDisabled,
        LockedUntil = v.LockoutEndsAt > now ? v.LockoutEndsAt : null,
        MustChangePassword = v.MustChangePassword,
        TwoFactorEnabled = v.TotpEnabledAt is not null,
        Permissions = Permissions(v),
        ActiveSessions = sessions,
        PlayedCount = watch?.Played ?? 0,
        InProgressCount = watch?.InProgress ?? 0,
        LastPlayedAt = watch?.LastPlayedAt,
        CreatedAt = v.CreatedAt,
        LastLoginAt = v.LastLoginAt,
    };

    public static ViewerDeviceSessionResponse Device(ViewerSessionEntity s, string? currentSessionId) => new()
    {
        Id = s.Id,
        DeviceName = s.DeviceName,
        ClientName = s.ClientName,
        AuthMethod = s.AuthMethod,
        CookieMode = s.CookieMode,
        IpAddress = s.IpAddress,
        CreatedAt = s.CreatedAt,
        LastSeenAt = s.LastSeenAt,
        RefreshExpiresAt = s.RefreshExpiresAt,
        Current = s.Id == currentSessionId,
    };

    public static WatchStateResponse State(ViewerWatchStateEntity s) => new()
    {
        WorkId = s.WorkId,
        Kind = s.Kind,
        SeriesWorkId = s.SeriesWorkId,
        SeasonNumber = s.SeasonNumber,
        EpisodeNumber = s.EpisodeNumber,
        Title = s.Title,
        PositionTicks = s.PositionTicks,
        DurationTicks = s.DurationTicks,
        ProgressPercent = s.DurationTicks is > 0 ? Math.Round(s.PositionTicks * 100d / s.DurationTicks.Value, 1) : null,
        Played = s.Played,
        PlayCount = s.PlayCount,
        LastReleaseId = s.LastReleaseId,
        LastPlayedAt = s.LastPlayedAt,
        PlayedAt = s.PlayedAt,
    };

    public static WatchStateResponse EmptyState(WorkKey key) => new()
    {
        WorkId = key.WorkId,
        Kind = key.KindName,
        SeriesWorkId = key.SeriesWorkId,
        SeasonNumber = key.Season,
        EpisodeNumber = key.Episode,
    };

    public static NextUpItemResponse NextUp(NextUpItem i) => new()
    {
        WorkId = i.WorkId,
        SeriesWorkId = i.SeriesWorkId,
        SeriesTitle = i.SeriesTitle,
        SeriesPosterUrl = i.SeriesPosterUrl,
        SeasonNumber = i.SeasonNumber,
        EpisodeNumber = i.EpisodeNumber,
        EpisodeTitle = i.EpisodeTitle,
        AirDate = i.AirDate,
        StillUrl = i.StillUrl,
        RuntimeMinutes = i.RuntimeMinutes,
        PositionTicks = i.PositionTicks,
        DurationTicks = i.DurationTicks,
        LastWatchedWorkId = i.LastWatchedWorkId,
        LastActivityAt = i.LastActivityAt,
    };

    public static ContentAccessResponse Access(ContentAccessDecision d) => new()
    {
        WorkId = d.WorkId,
        Allowed = d.Allowed,
        Reason = d.Reason,
        Rating = d.Rating,
        MinimumAge = d.MinimumAge,
        ViewerMaxAge = d.ViewerMaxAge,
    };

    public static ViewerSettingsResponse Settings(ViewerSettings s, bool hasSmtpPassword, int viewerCount) => new()
    {
        Enabled = s.Enabled,
        ServerName = s.ServerName,
        AccessTokenMinutes = s.AccessTokenMinutes,
        RefreshTokenDays = s.RefreshTokenDays,
        MaxSessionsPerViewer = s.MaxSessionsPerViewer,
        PasswordMinLength = s.PasswordMinLength,
        LockoutThreshold = s.LockoutThreshold,
        LockoutMinutes = s.LockoutMinutes,
        AllowPasswordReset = s.AllowPasswordReset,
        AllowEmailLogin = s.AllowEmailLogin,
        AllowTotp = s.AllowTotp,
        MinResumePercent = s.MinResumePercent,
        PlayedPercent = s.PlayedPercent,
        MinResumeDurationSeconds = s.MinResumeDurationSeconds,
        NextUpCutoffDays = s.NextUpCutoffDays,
        Email = new ViewerEmailSettingsDto
        {
            Mode = Camel(s.Email.Mode.ToString()),
            SmtpHost = s.Email.SmtpHost,
            SmtpPort = s.Email.SmtpPort,
            SmtpSecurity = Camel(s.Email.SmtpSecurity.ToString()),
            SmtpUsername = s.Email.SmtpUsername,
            SmtpPassword = hasSmtpPassword ? SecretMasking.Mask : null,
            FromAddress = s.Email.FromAddress,
            FromName = s.Email.FromName,
        },
        EmailDeliveryReady = ViewerMailer.CanDeliver(s),
        ViewerCount = viewerCount,
    };

    public static ViewerSettings Apply(ViewerSettings current, ViewerSettingsWrite write)
    {
        var email = current.Email;
        if (write.Email is { } e)
        {
            email = email with
            {
                Mode = e.Mode is null ? email.Mode : ParseEnum<ViewerEmailMode>(e.Mode, "email.mode"),
                SmtpHost = e.SmtpHost?.Trim() ?? email.SmtpHost,
                SmtpPort = e.SmtpPort ?? email.SmtpPort,
                SmtpSecurity = e.SmtpSecurity is null ? email.SmtpSecurity : ParseEnum<SmtpSecurity>(e.SmtpSecurity, "email.smtpSecurity"),
                SmtpUsername = e.SmtpUsername?.Trim() ?? email.SmtpUsername,
                FromAddress = e.FromAddress?.Trim() ?? email.FromAddress,
                FromName = e.FromName?.Trim() ?? email.FromName,
            };
        }

        return current with
        {
            Enabled = write.Enabled ?? current.Enabled,
            ServerName = write.ServerName?.Trim() ?? current.ServerName,
            AccessTokenMinutes = write.AccessTokenMinutes ?? current.AccessTokenMinutes,
            RefreshTokenDays = write.RefreshTokenDays ?? current.RefreshTokenDays,
            MaxSessionsPerViewer = write.MaxSessionsPerViewer ?? current.MaxSessionsPerViewer,
            PasswordMinLength = write.PasswordMinLength ?? current.PasswordMinLength,
            LockoutThreshold = write.LockoutThreshold ?? current.LockoutThreshold,
            LockoutMinutes = write.LockoutMinutes ?? current.LockoutMinutes,
            AllowPasswordReset = write.AllowPasswordReset ?? current.AllowPasswordReset,
            AllowEmailLogin = write.AllowEmailLogin ?? current.AllowEmailLogin,
            AllowTotp = write.AllowTotp ?? current.AllowTotp,
            MinResumePercent = write.MinResumePercent ?? current.MinResumePercent,
            PlayedPercent = write.PlayedPercent ?? current.PlayedPercent,
            MinResumeDurationSeconds = write.MinResumeDurationSeconds ?? current.MinResumeDurationSeconds,
            NextUpCutoffDays = write.NextUpCutoffDays ?? current.NextUpCutoffDays,
            Email = email,
        };
    }

    public static WorkKey RequireWork(string? workId, bool playableOnly)
    {
        var key = WorkKey.TryParse(workId)
                  ?? throw ViewerProblem.BadRequest("invalid_work_id", "Expected a work id such as tmdb-movie-603 or tmdb-tv-1396-s01e01.");
        if (playableOnly && !key.IsPlayable)
            throw ViewerProblem.BadRequest("invalid_work_id", "Expected a movie or episode work id.");
        return key;
    }

    public static IReadOnlyList<WorkKey> RequireWorks(IReadOnlyList<string>? workIds, bool playableOnly)
    {
        if (workIds is null || workIds.Count is 0 or > WatchStateService.MaxBatch)
            throw ViewerProblem.BadRequest("invalid_work_ids", $"Send between 1 and {WatchStateService.MaxBatch} work ids.");
        return workIds.Select(id => RequireWork(id, playableOnly)).DistinctBy(k => k.WorkId).ToList();
    }

    private static T ParseEnum<T>(string value, string field) where T : struct, Enum
        => Enum.TryParse<T>(value, ignoreCase: true, out var parsed) && Enum.IsDefined(parsed)
            ? parsed
            : throw ViewerProblem.BadRequest("invalid_viewer_settings", $"'{field}' has an unknown value '{value}'.");

    private static string Camel(string value) => char.ToLowerInvariant(value[0]) + value[1..];
}
