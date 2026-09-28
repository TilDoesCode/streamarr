using System.Net.Mail;

namespace Streamarr.Server.Viewers;

public enum ViewerEmailMode
{
    Disabled,
    Smtp,
    Outbox,
}

public enum SmtpSecurity
{
    Auto,
    None,
    StartTls,
    SslOnConnect,
}

/// <summary>Runtime policy of the viewer module; persisted as JSON and editable by admins.</summary>
public sealed record ViewerSettings
{
    public bool Enabled { get; init; }
    public string ServerName { get; init; } = "Streamarr";

    public int AccessTokenMinutes { get; init; } = 60;
    public int RefreshTokenDays { get; init; } = 30;
    public int MaxSessionsPerViewer { get; init; } = 20;

    public int PasswordMinLength { get; init; } = 8;
    public int LockoutThreshold { get; init; } = 10;
    public int LockoutMinutes { get; init; } = 15;

    public bool AllowPasswordReset { get; init; } = true;
    public bool AllowEmailLogin { get; init; } = true;
    public bool AllowTotp { get; init; } = true;

    public int MinResumePercent { get; init; } = 5;
    public int PlayedPercent { get; init; } = 90;
    public int MinResumeDurationSeconds { get; init; } = 300;
    public int NextUpCutoffDays { get; init; } = 365;

    public ViewerEmailSettings Email { get; init; } = new();

    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        Range(errors, "accessTokenMinutes", AccessTokenMinutes, 5, 1_440);
        Range(errors, "refreshTokenDays", RefreshTokenDays, 1, 365);
        Range(errors, "maxSessionsPerViewer", MaxSessionsPerViewer, 1, 100);
        Range(errors, "passwordMinLength", PasswordMinLength, 6, 128);
        Range(errors, "lockoutThreshold", LockoutThreshold, 3, 100);
        Range(errors, "lockoutMinutes", LockoutMinutes, 1, 1_440);
        Range(errors, "minResumePercent", MinResumePercent, 0, 50);
        Range(errors, "playedPercent", PlayedPercent, 50, 100);
        Range(errors, "minResumeDurationSeconds", MinResumeDurationSeconds, 0, 3_600);
        Range(errors, "nextUpCutoffDays", NextUpCutoffDays, 1, 3_650);
        if (string.IsNullOrWhiteSpace(ServerName) || ServerName.Length > 64 || ServerName.Any(char.IsControl))
            errors.Add("'serverName' must be 1-64 printable characters.");
        errors.AddRange(Email.Validate());
        return errors;
    }

    private static void Range(List<string> errors, string name, int value, int min, int max)
    {
        if (value < min || value > max)
            errors.Add($"'{name}' must be between {min} and {max}.");
    }
}

public sealed record ViewerEmailSettings
{
    public ViewerEmailMode Mode { get; init; } = ViewerEmailMode.Disabled;
    public string SmtpHost { get; init; } = string.Empty;
    public int SmtpPort { get; init; } = 587;
    public SmtpSecurity SmtpSecurity { get; init; } = SmtpSecurity.StartTls;
    public string SmtpUsername { get; init; } = string.Empty;
    public string FromAddress { get; init; } = string.Empty;
    public string FromName { get; init; } = "Streamarr";

    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        if (SmtpPort is < 1 or > 65_535)
            errors.Add("'email.smtpPort' must be between 1 and 65535.");
        if (SmtpHost.Length > 255 || SmtpHost.Any(c => char.IsControl(c) || char.IsWhiteSpace(c)))
            errors.Add("'email.smtpHost' must be a host name without spaces.");
        if (SmtpUsername.Length > 256 || SmtpUsername.Any(char.IsControl))
            errors.Add("'email.smtpUsername' is too long or contains control characters.");
        if (FromName.Length > 128 || FromName.Any(char.IsControl))
            errors.Add("'email.fromName' is too long or contains control characters.");
        if (FromAddress.Length > 0 && !ViewerEmail.IsValid(FromAddress))
            errors.Add("'email.fromAddress' must be a valid email address.");
        if (Mode == ViewerEmailMode.Smtp && (string.IsNullOrWhiteSpace(SmtpHost) || FromAddress.Length == 0))
            errors.Add("SMTP delivery needs 'email.smtpHost' and 'email.fromAddress'.");
        return errors;
    }
}

public static class ViewerEmail
{
    public static bool IsValid(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 254 || value.Any(c => char.IsControl(c) || char.IsWhiteSpace(c)))
            return false;
        return MailAddress.TryCreate(value, out var parsed) &&
               string.Equals(parsed.Address, value, StringComparison.Ordinal) &&
               parsed.Host.Contains('.', StringComparison.Ordinal);
    }

    public static string Normalize(string value) => value.Trim().ToUpperInvariant();
}
