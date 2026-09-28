using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Auth;

public sealed record ViewerSessionRequest(string DeviceName, string ClientName, string AuthMethod, bool CookieMode, string? IpAddress);

public sealed record ViewerTokens(
    string SessionId,
    string AccessToken,
    DateTimeOffset AccessExpiresAt,
    string RefreshToken,
    DateTimeOffset RefreshExpiresAt);

public sealed record ViewerIdentity(ViewerEntity Viewer, ViewerSessionEntity Session);

public enum RefreshFailure
{
    None,
    Invalid,
    Reused,
    Disabled,
}

/// <summary>Opaque, hashed viewer session tokens: short access token, rotating refresh token, reuse detection.</summary>
public sealed class ViewerSessionService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerSettingsService settings,
    IDataProtectionProvider dataProtection,
    TimeProvider time,
    ILogger<ViewerSessionService> logger)
{
    private static readonly TimeSpan RotationGrace = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan SeenResolution = TimeSpan.FromMinutes(1);
    private readonly IDataProtector _rotated = dataProtection.CreateProtector("Streamarr.Viewers.RotatedTokens.v1");
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<ViewerTokens> IssueAsync(ViewerEntity viewer, ViewerSessionRequest request, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        var now = time.GetUtcNow();
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await db.ViewerSessions
                .Where(s => s.RefreshExpiresAt < now || (s.RevokedAt != null && s.RevokedAt < now.AddDays(-1)))
                .ExecuteDeleteAsync(ct);

            var access = ViewerAuth.NewToken(ViewerAuth.AccessTokenPrefix);
            var refresh = ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix);
            var session = new ViewerSessionEntity
            {
                Id = Guid.NewGuid().ToString("n"),
                ViewerId = viewer.Id,
                AccessTokenHash = ViewerAuth.Hash(access),
                AccessExpiresAt = now.AddMinutes(current.AccessTokenMinutes),
                RefreshTokenHash = ViewerAuth.Hash(refresh),
                RefreshExpiresAt = now.AddDays(current.RefreshTokenDays),
                DeviceName = Bounded(request.DeviceName, "Unknown device"),
                ClientName = Bounded(request.ClientName, "Unknown client"),
                AuthMethod = request.AuthMethod,
                CookieMode = request.CookieMode,
                IpAddress = request.IpAddress,
                CreatedAt = now,
                LastSeenAt = now,
            };
            db.ViewerSessions.Add(session);
            await db.SaveChangesAsync(ct);

            var surplus = await db.ViewerSessions
                .Where(s => s.ViewerId == viewer.Id && s.RevokedAt == null)
                .OrderByDescending(s => s.LastSeenAt)
                .Skip(current.MaxSessionsPerViewer)
                .Select(s => s.Id)
                .ToListAsync(ct);
            if (surplus.Count > 0)
                await RevokeWhereAsync(db, s => surplus.Contains(s.Id), "session_limit", now, ct);

            return new ViewerTokens(session.Id, access, session.AccessExpiresAt, refresh, session.RefreshExpiresAt);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ViewerIdentity?> ValidateAsync(string accessToken, CancellationToken ct)
    {
        if (!ViewerAuth.HasShape(accessToken, ViewerAuth.AccessTokenPrefix))
            return null;
        var now = time.GetUtcNow();
        var hash = ViewerAuth.Hash(accessToken);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var session = await db.ViewerSessions.AsNoTracking().SingleOrDefaultAsync(s => s.AccessTokenHash == hash, ct);
        if (session is null || session.RevokedAt is not null || session.AccessExpiresAt <= now || session.RefreshExpiresAt <= now)
            return null;
        var viewer = await db.Viewers.AsNoTracking().SingleOrDefaultAsync(v => v.Id == session.ViewerId, ct);
        if (viewer is null || viewer.IsDisabled)
            return null;

        if (now - session.LastSeenAt >= SeenResolution)
        {
            await db.ViewerSessions.Where(s => s.Id == session.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.LastSeenAt, now), ct);
        }
        return new ViewerIdentity(viewer, session);
    }

    public async Task<(ViewerTokens? Tokens, RefreshFailure Failure)> RefreshAsync(string? refreshToken, string? ipAddress, CancellationToken ct)
    {
        if (!ViewerAuth.HasShape(refreshToken, ViewerAuth.RefreshTokenPrefix))
            return (null, RefreshFailure.Invalid);
        var current = await settings.GetAsync(ct);
        var now = time.GetUtcNow();
        var hash = ViewerAuth.Hash(refreshToken!);
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var session = await db.ViewerSessions.SingleOrDefaultAsync(
                s => s.RefreshTokenHash == hash || s.PreviousRefreshTokenHash == hash, ct);
            if (session is null || session.RevokedAt is not null || session.RefreshExpiresAt <= now)
                return (null, RefreshFailure.Invalid);

            if (session.RefreshTokenHash != hash)
            {
                if (session.RotatedAt is { } rotatedAt && now - rotatedAt <= RotationGrace &&
                    ReplayRotation(session) is { } replay)
                {
                    return (replay, RefreshFailure.None);
                }

                session.RevokedAt = now;
                session.RevokedReason = "refresh_token_reuse";
                session.RotatedTokensEncrypted = null;
                await db.SaveChangesAsync(ct);
                logger.LogWarning("Viewer refresh token reuse detected; session {SessionId} revoked", session.Id);
                return (null, RefreshFailure.Reused);
            }

            var viewer = await db.Viewers.AsNoTracking().SingleOrDefaultAsync(v => v.Id == session.ViewerId, ct);
            if (viewer is null || viewer.IsDisabled)
                return (null, RefreshFailure.Disabled);

            var access = ViewerAuth.NewToken(ViewerAuth.AccessTokenPrefix);
            var refresh = ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix);
            session.PreviousRefreshTokenHash = hash;
            session.RefreshTokenHash = ViewerAuth.Hash(refresh);
            session.RotatedTokensEncrypted = _rotated.Protect($"{access}|{refresh}");
            session.AccessTokenHash = ViewerAuth.Hash(access);
            session.AccessExpiresAt = now.AddMinutes(current.AccessTokenMinutes);
            session.RefreshExpiresAt = now.AddDays(current.RefreshTokenDays);
            session.RotatedAt = now;
            session.LastSeenAt = now;
            session.IpAddress = ipAddress ?? session.IpAddress;
            await db.SaveChangesAsync(ct);
            return (new ViewerTokens(session.Id, access, session.AccessExpiresAt, refresh, session.RefreshExpiresAt), RefreshFailure.None);
        }
        finally
        {
            _gate.Release();
        }
    }

    private ViewerTokens? ReplayRotation(ViewerSessionEntity session)
    {
        try
        {
            if (session.RotatedTokensEncrypted is null)
                return null;
            var parts = _rotated.Unprotect(session.RotatedTokensEncrypted).Split('|');
            if (parts.Length != 2 || ViewerAuth.Hash(parts[0]) != session.AccessTokenHash || ViewerAuth.Hash(parts[1]) != session.RefreshTokenHash)
                return null;
            return new ViewerTokens(session.Id, parts[0], session.AccessExpiresAt, parts[1], session.RefreshExpiresAt);
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return null;
        }
    }

    public async Task<IReadOnlyList<ViewerSessionEntity>> ListActiveAsync(string viewerId, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerSessions.AsNoTracking()
            .Where(s => s.ViewerId == viewerId && s.RevokedAt == null && s.RefreshExpiresAt > now)
            .OrderByDescending(s => s.LastSeenAt)
            .ToListAsync(ct);
    }

    public async Task<Dictionary<string, int>> CountActiveAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerSessions.AsNoTracking()
            .Where(s => s.RevokedAt == null && s.RefreshExpiresAt > now)
            .GroupBy(s => s.ViewerId)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Key, x => x.Count, ct);
    }

    public async Task<bool> RevokeAsync(string viewerId, string sessionId, string reason, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await RevokeWhereAsync(db, s => s.ViewerId == viewerId && s.Id == sessionId, reason, time.GetUtcNow(), ct) > 0;
    }

    public async Task<int> RevokeAllAsync(string viewerId, string reason, string? exceptSessionId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await RevokeWhereAsync(db, s => s.ViewerId == viewerId && s.Id != exceptSessionId, reason, time.GetUtcNow(), ct);
    }

    public async Task<bool> RevokeByRefreshTokenAsync(string? refreshToken, CancellationToken ct)
    {
        if (!ViewerAuth.HasShape(refreshToken, ViewerAuth.RefreshTokenPrefix))
            return false;
        var hash = ViewerAuth.Hash(refreshToken!);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await RevokeWhereAsync(db, s => s.RefreshTokenHash == hash || s.PreviousRefreshTokenHash == hash, "logout", time.GetUtcNow(), ct) > 0;
    }

    private static Task<int> RevokeWhereAsync(
        StreamarrDbContext db,
        System.Linq.Expressions.Expression<Func<ViewerSessionEntity, bool>> predicate,
        string reason,
        DateTimeOffset now,
        CancellationToken ct)
        => db.ViewerSessions.Where(predicate).Where(s => s.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now).SetProperty(x => x.RevokedReason, reason), ct);

    private static string Bounded(string? value, string fallback)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Any(char.IsControl))
            return fallback;
        return trimmed.Length <= 100 ? trimmed : trimmed[..100];
    }
}
