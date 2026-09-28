using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Auth;

public static class ViewerCodePurpose
{
    public const string Login = "login";
    public const string PasswordReset = "password_reset";
    public const string EmailVerification = "email_verification";

    public static TimeSpan Lifetime(string purpose) => purpose == Login ? TimeSpan.FromMinutes(10) : TimeSpan.FromMinutes(30);
}

/// <summary>Issues and redeems short emailed codes: 8 unambiguous characters, salted hash, 5 attempts, per-hour cap.</summary>
public sealed class ViewerCodeService(TimeProvider time)
{
    private const string Alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    public const int MaxAttempts = 5;
    public const int MaxCodesPerHour = 5;
    private static readonly TimeSpan ResendCooldown = TimeSpan.FromSeconds(30);

    /// <summary>Returns the formatted code, or null when the cooldown or hourly cap suppresses a new one.</summary>
    public async Task<string?> IssueAsync(StreamarrDbContext db, string viewerId, string purpose, string? target, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        await db.ViewerOneTimeCodes.Where(c => c.ExpiresAt < now.AddDays(-1)).ExecuteDeleteAsync(ct);

        var recent = await db.ViewerOneTimeCodes
            .Where(c => c.ViewerId == viewerId && c.Purpose == purpose)
            .Select(c => c.CreatedAt)
            .ToListAsync(ct);
        if (recent.Count(created => created > now.AddHours(-1)) >= MaxCodesPerHour ||
            recent.Any(created => created > now - ResendCooldown))
        {
            return null;
        }

        await db.ViewerOneTimeCodes
            .Where(c => c.ViewerId == viewerId && c.Purpose == purpose && c.ConsumedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.ConsumedAt, now), ct);

        var code = RandomNumberGenerator.GetString(Alphabet, 8);
        var salt = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        db.ViewerOneTimeCodes.Add(new ViewerOneTimeCodeEntity
        {
            Id = Guid.NewGuid().ToString("n"),
            ViewerId = viewerId,
            Purpose = purpose,
            CodeHash = Hash(salt, code),
            Salt = salt,
            Target = target,
            CreatedAt = now,
            ExpiresAt = now + ViewerCodePurpose.Lifetime(purpose),
        });
        await db.SaveChangesAsync(ct);
        return $"{code[..4]}-{code[4..]}";
    }

    /// <summary>Consumes and returns the matching live code, counting every failed attempt against it.</summary>
    public async Task<ViewerOneTimeCodeEntity?> RedeemAsync(StreamarrDbContext db, string viewerId, string purpose, string? input, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var entity = await db.ViewerOneTimeCodes
            .Where(c => c.ViewerId == viewerId && c.Purpose == purpose && c.ConsumedAt == null)
            .OrderByDescending(c => c.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (entity is null || entity.ExpiresAt <= now)
            return null;

        var normalized = Normalize(input);
        entity.Attempts++;
        var match = normalized is not null && CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(entity.CodeHash),
            Encoding.ASCII.GetBytes(Hash(entity.Salt, normalized)));
        if (match || entity.Attempts >= MaxAttempts)
            entity.ConsumedAt = now;
        await db.SaveChangesAsync(ct);
        return match ? entity : null;
    }

    public static Task InvalidateAsync(StreamarrDbContext db, string viewerId, string purpose, DateTimeOffset now, CancellationToken ct)
        => db.ViewerOneTimeCodes
            .Where(c => c.ViewerId == viewerId && c.Purpose == purpose && c.ConsumedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.ConsumedAt, now), ct);

    internal static string? Normalize(string? input)
    {
        if (string.IsNullOrWhiteSpace(input) || input.Length > 32)
            return null;
        var cleaned = new string(input.Where(char.IsAsciiLetterOrDigit).Select(char.ToUpperInvariant).ToArray());
        return cleaned.Length == 8 && cleaned.All(c => Alphabet.Contains(c, StringComparison.Ordinal)) ? cleaned : null;
    }

    private static string Hash(string salt, string code)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(salt + ":" + code)));
}
