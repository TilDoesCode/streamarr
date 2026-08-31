using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Auth;

/// <summary>Issues, rotates, and revokes opaque browser refresh tokens.</summary>
public sealed class AdminRefreshSessionService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    IDataProtectionProvider dataProtection,
    IOptions<StreamarrOptions> options,
    TimeProvider time)
{
    private static readonly TimeSpan RotationGrace = TimeSpan.FromSeconds(30);
    private readonly IDataProtector _protector = dataProtection.CreateProtector("Streamarr.Auth.RefreshReplacement.v1");
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<RefreshSessionResult> IssueAsync(UserEntity user, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var now = time.GetUtcNow();
            await PruneAsync(db, now, ct);
            var result = Create(user, now);
            db.AdminRefreshSessions.Add(result.Entity);
            await db.SaveChangesAsync(ct);
            return result.Result;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<RefreshSessionResult?> RotateAsync(string token, CancellationToken ct)
    {
        if (!IsValidTokenShape(token))
            return null;

        await _gate.WaitAsync(ct);
        try
        {
            var now = time.GetUtcNow();
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await PruneAsync(db, now, ct);
            var current = await db.AdminRefreshSessions.SingleOrDefaultAsync(
                session => session.TokenHash == Hash(token), ct);
            if (current is null || current.ExpiresAt <= now)
                return null;

            var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == current.UserId, ct);
            if (user is null)
                return null;

            if (current.RevokedAt is not null)
                return await ResolveConcurrentRotationAsync(db, current, user, token, now, ct);

            var replacement = Create(user, now);
            current.RevokedAt = now;
            current.ReplacedByTokenHash = replacement.Entity.TokenHash;
            current.ReplacementTokenEncrypted = _protector.Protect(replacement.Result.Token);
            db.AdminRefreshSessions.Add(replacement.Entity);
            await db.SaveChangesAsync(ct);
            return replacement.Result;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> RevokeAsync(string? token, CancellationToken ct)
    {
        if (!IsValidTokenShape(token))
            return false;

        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var tokenHash = Hash(token!);
            var revoked = false;
            var now = time.GetUtcNow();
            for (var depth = 0; depth < 16; depth++)
            {
                var session = await db.AdminRefreshSessions.SingleOrDefaultAsync(
                    item => item.TokenHash == tokenHash, ct);
                if (session is null)
                    break;

                if (session.RevokedAt is null)
                {
                    session.RevokedAt = now;
                    revoked = true;
                }

                if (string.IsNullOrEmpty(session.ReplacedByTokenHash))
                    break;
                tokenHash = session.ReplacedByTokenHash;
            }

            if (revoked)
                await db.SaveChangesAsync(ct);
            return revoked;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task RevokeAllForUserAsync(string userId, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var now = time.GetUtcNow();
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await db.AdminRefreshSessions
                .Where(session => session.UserId == userId && session.RevokedAt == null)
                .ExecuteUpdateAsync(setters => setters.SetProperty(session => session.RevokedAt, now), ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<RefreshSessionResult?> ResolveConcurrentRotationAsync(
        StreamarrDbContext db,
        AdminRefreshSessionEntity current,
        UserEntity user,
        string presentedToken,
        DateTimeOffset now,
        CancellationToken ct)
    {
        if (current.RevokedAt < now - RotationGrace ||
            string.IsNullOrEmpty(current.ReplacedByTokenHash) ||
            string.IsNullOrEmpty(current.ReplacementTokenEncrypted))
            return null;

        var replacementToken = _protector.Unprotect(current.ReplacementTokenEncrypted);
        if (!IsValidTokenShape(replacementToken) ||
            !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(current.TokenHash),
                Encoding.ASCII.GetBytes(Hash(presentedToken))))
            return null;

        var replacement = await db.AdminRefreshSessions.AsNoTracking().SingleOrDefaultAsync(
            session => session.TokenHash == current.ReplacedByTokenHash, ct);
        if (replacement is null || replacement.RevokedAt is not null || replacement.ExpiresAt <= now ||
            !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(replacement.TokenHash),
                Encoding.ASCII.GetBytes(Hash(replacementToken))))
            return null;

        return new RefreshSessionResult(user, replacementToken, replacement.ExpiresAt);
    }

    private (AdminRefreshSessionEntity Entity, RefreshSessionResult Result) Create(
        UserEntity user,
        DateTimeOffset now)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var expiresAt = now.AddSeconds(options.Value.AdminRefreshTokenTtlSeconds);
        var entity = new AdminRefreshSessionEntity
        {
            TokenHash = Hash(token),
            UserId = user.Id,
            CreatedAt = now,
            ExpiresAt = expiresAt,
        };
        return (entity, new RefreshSessionResult(user, token, expiresAt));
    }

    private static async Task PruneAsync(
        StreamarrDbContext db,
        DateTimeOffset now,
        CancellationToken ct)
    {
        var sessions = await db.AdminRefreshSessions.ToListAsync(ct);
        var stale = sessions.Where(session =>
            session.ExpiresAt <= now || session.RevokedAt < now - RotationGrace).ToList();
        if (stale.Count == 0)
            return;

        db.AdminRefreshSessions.RemoveRange(stale);
        await db.SaveChangesAsync(ct);
    }

    private static bool IsValidTokenShape(string? token)
        => token is { Length: 43 } && token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private static string Hash(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}

public sealed record RefreshSessionResult(UserEntity User, string Token, DateTimeOffset ExpiresAt);
