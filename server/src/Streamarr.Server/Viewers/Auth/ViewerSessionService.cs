using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Auth;

public sealed record ViewerSessionRequest(string? DeviceName, string ClientName, string AuthMethod, bool CookieMode, string? IpAddress);

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
    Unknown,
    Expired,
    Revoked,
    Reused,
}

public sealed record RefreshResult(ViewerTokens? Tokens, RefreshFailure Failure, string? Reason = null);

/// <summary>Opaque, hashed viewer session tokens: short access token, rotating refresh token, reuse detection with replay of an unused rotation.</summary>
public sealed class ViewerSessionService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerSettingsService settings,
    IDataProtectionProvider dataProtection,
    TimeProvider time,
    ILogger<ViewerSessionService> logger)
{
    private static readonly TimeSpan RotationGrace = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan SeenResolution = TimeSpan.FromMinutes(1);
    private const int MaxRetiredTokens = 8;
    public static readonly TimeSpan TombstoneLifetime = TimeSpan.FromDays(30);
    private static readonly TimeSpan RevokedRetention = TimeSpan.FromDays(1);
    private readonly IDataProtector _rotated = dataProtection.CreateProtector("Streamarr.Viewers.RotatedTokens.v1");
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly LogBudget _unknownLog = new(5, TimeSpan.FromMinutes(1));

    public async Task<ViewerTokens> IssueAsync(ViewerEntity viewer, ViewerSessionRequest request, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        var now = time.GetUtcNow();
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await PruneAsync(db, now, ct);

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
                DeviceName = Bounded(request.DeviceName),
                ClientName = Bounded(request.ClientName) ?? "Unknown client",
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

        if (session.RotatedAt is not null && session.RotationConfirmedAt is null)
        {
            await db.ViewerSessions.Where(s => s.Id == session.Id && s.AccessTokenHash == hash && s.RotationConfirmedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.RotationConfirmedAt, now).SetProperty(x => x.LastSeenAt, now), ct);
        }
        else if (now - session.LastSeenAt >= SeenResolution)
        {
            await db.ViewerSessions.Where(s => s.Id == session.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.LastSeenAt, now), ct);
        }
        return new ViewerIdentity(viewer, session);
    }

    public async Task<RefreshResult> RefreshAsync(string? refreshToken, string? ipAddress, CancellationToken ct)
    {
        if (!ViewerAuth.HasShape(refreshToken, ViewerAuth.RefreshTokenPrefix))
            return Refused(RefreshFailure.Unknown, null, "malformed", null);
        var current = await settings.GetAsync(ct);
        var now = time.GetUtcNow();
        var hash = ViewerAuth.Hash(refreshToken!);
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var session = await db.ViewerSessions.SingleOrDefaultAsync(
                s => s.RefreshTokenHash == hash || s.PreviousRefreshTokenHash == hash, ct);
            var retired = session is null;
            if (retired)
            {
                var tombstone = await db.ViewerSessionTombstones.AsNoTracking()
                    .SingleOrDefaultAsync(t => t.RefreshTokenHash == hash && t.ExpiresAt > now, ct);
                if (tombstone is not null)
                {
                    return tombstone.Reason == ExpiredReason
                        ? Refused(RefreshFailure.Expired, null, "tombstone", tombstone.SessionId, tombstone.ViewerId)
                        : Refused(RefreshFailure.Revoked, PublicReason(tombstone.Reason), "tombstone", tombstone.SessionId, tombstone.ViewerId);
                }
                session = await db.ViewerSessions.FirstOrDefaultAsync(
                    s => s.RetiredRefreshTokenHashes != null && s.RetiredRefreshTokenHashes.Contains(hash), ct);
                if (session is not null && !session.RetiredRefreshTokenHashes!.Split(' ').Contains(hash))
                    session = null;
            }
            if (session is null)
                return Refused(RefreshFailure.Unknown, null, "no_match", null);
            if (session.RevokedAt is not null)
                return Refused(RefreshFailure.Revoked, PublicReason(session.RevokedReason), "revoked", session.Id, session.ViewerId);
            if (session.RefreshExpiresAt <= now)
                return Refused(RefreshFailure.Expired, null, "expired", session.Id, session.ViewerId);

            var viewer = await db.Viewers.AsNoTracking().SingleOrDefaultAsync(v => v.Id == session.ViewerId, ct);
            if (viewer is null || viewer.IsDisabled)
                return Refused(RefreshFailure.Revoked, "account_disabled", "account_disabled", session.Id, session.ViewerId);

            if (session.RefreshTokenHash != hash)
            {
                if (!retired && CanReplay(session, now) && ReplayRotation(session) is { } replay)
                {
                    if (replay.AccessExpiresAt > now)
                        return new RefreshResult(replay, RefreshFailure.None);
                    var renewed = ViewerAuth.NewToken(ViewerAuth.AccessTokenPrefix);
                    session.AccessTokenHash = ViewerAuth.Hash(renewed);
                    session.AccessExpiresAt = now.AddMinutes(current.AccessTokenMinutes);
                    session.RotatedTokensEncrypted = _rotated.Protect($"{renewed}|{replay.RefreshToken}");
                    await db.SaveChangesAsync(ct);
                    return new RefreshResult(replay with { AccessToken = renewed, AccessExpiresAt = session.AccessExpiresAt }, RefreshFailure.None);
                }

                session.RevokedAt = now;
                session.RevokedReason = ReuseReason;
                session.RotatedTokensEncrypted = null;
                await db.SaveChangesAsync(ct);
                logger.LogWarning("Viewer refresh token reuse detected; session {SessionId} revoked", session.Id);
                return Refused(RefreshFailure.Reused, null, retired ? "retired_token" : "previous_token_after_use", session.Id, session.ViewerId);
            }

            var access = ViewerAuth.NewToken(ViewerAuth.AccessTokenPrefix);
            var refresh = ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix);
            session.RetiredRefreshTokenHashes = Retire(session.RetiredRefreshTokenHashes, session.PreviousRefreshTokenHash);
            session.PreviousRefreshTokenHash = hash;
            session.PreviousRefreshExpiresAt = session.RefreshExpiresAt;
            session.RotationConfirmedAt = null;
            session.RefreshTokenHash = ViewerAuth.Hash(refresh);
            session.RotatedTokensEncrypted = _rotated.Protect($"{access}|{refresh}");
            session.AccessTokenHash = ViewerAuth.Hash(access);
            session.AccessExpiresAt = now.AddMinutes(current.AccessTokenMinutes);
            session.RefreshExpiresAt = now.AddDays(current.RefreshTokenDays);
            session.RotatedAt = now;
            session.LastSeenAt = now;
            session.IpAddress = ipAddress ?? session.IpAddress;
            await db.SaveChangesAsync(ct);
            return new RefreshResult(new ViewerTokens(session.Id, access, session.AccessExpiresAt, refresh, session.RefreshExpiresAt), RefreshFailure.None);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>True when the hash is the current or previous refresh token of a session that is neither revoked nor expired (read-only, outside the refresh lock).</summary>
    public async Task<bool> IsLiveRefreshTokenAsync(string hash, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerSessions.AsNoTracking().AnyAsync(
            s => (s.RefreshTokenHash == hash || s.PreviousRefreshTokenHash == hash) && s.RevokedAt == null && s.RefreshExpiresAt > now, ct);
    }

    /// <summary>Runs <paramref name="action"/> under the lock refreshes take, so no refresh can rotate a session it is about to end.</summary>
    public async Task UnderSessionLockAsync(Func<Task> action, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await action();
        }
        finally
        {
            _gate.Release();
        }
    }

    private const string ExpiredReason = "expired";
    private const string ReuseReason = "refresh_token_reuse";

    private RefreshResult Refused(RefreshFailure failure, string? reason, string detail, string? sessionId, string? viewerId = null)
    {
        if (failure == RefreshFailure.Unknown)
        {
            if (!_unknownLog.TryTake(time.GetUtcNow(), out var suppressed))
                return new RefreshResult(null, failure, reason);
            if (suppressed > 0)
                logger.LogInformation("Viewer refresh refused {Suppressed} more unknown tokens in the previous window (not logged one by one)", suppressed);
        }
        logger.LogInformation(
            "Viewer refresh refused: {RefreshFailure} ({RefreshDetail}), reason {RefreshReason}, session {SessionId}, viewer {ViewerId}",
            failure, detail, reason ?? "-", sessionId ?? "-", viewerId ?? "-");
        return new RefreshResult(null, failure, reason);
    }

    /// <summary>The stable <c>params.reason</c> of <c>refresh_session_revoked</c> for a stored revoke reason.</summary>
    public static string PublicReason(string? stored) => stored switch
    {
        "logout" => "signed_out",
        "revoked_by_viewer" or "signed_out_by_viewer" => "revoked_by_viewer",
        "session_limit" => "session_limit",
        "revoked_by_admin" or "password_set_by_admin" or "two_factor_reset" or "account_deleted" => "admin",
        "password_changed" or "password_reset" => "password_changed",
        "account_disabled" => "account_disabled",
        ReuseReason => "token_reused",
        _ => "other",
    };

    /// <summary>Deletes expired sessions and those revoked over a day ago (each refresh hash becomes a tombstone) and drops tombstones older than 30 days.</summary>
    public async Task<int> PruneAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            return await PruneAsync(db, time.GetUtcNow(), ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task<int> PruneAsync(StreamarrDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        var cutoff = now - RevokedRetention;
        var ended = await db.ViewerSessions.AsNoTracking()
            .Where(s => s.RefreshExpiresAt < now || (s.RevokedAt != null && s.RevokedAt < cutoff))
            .ToListAsync(ct);
        if (ended.Count > 0)
        {
            await AddTombstonesAsync(db, ended, null, now, ct);
            var ids = ended.Select(s => s.Id).ToList();
            await db.ViewerSessions.Where(s => ids.Contains(s.Id)).ExecuteDeleteAsync(ct);
        }
        await db.ViewerSessionTombstones.Where(t => t.ExpiresAt <= now).ExecuteDeleteAsync(ct);
        return ended.Count;
    }

    /// <summary>Records every refresh hash of sessions about to be deleted; <paramref name="reason"/> overrides the session's own.</summary>
    public static async Task AddTombstonesAsync(
        StreamarrDbContext db, IReadOnlyList<ViewerSessionEntity> sessions, string? reason, DateTimeOffset now, CancellationToken ct)
    {
        var rows = new Dictionary<string, ViewerSessionTombstoneEntity>();
        foreach (var session in sessions)
        {
            var endedAt = session.RevokedAt ?? (session.RefreshExpiresAt < now ? session.RefreshExpiresAt : now);
            var expiresAt = endedAt + TombstoneLifetime;
            if (expiresAt <= now)
                continue;
            var why = session.RevokedAt is not null ? session.RevokedReason ?? "revoked" : reason ?? ExpiredReason;
            var hashes = new[] { session.RefreshTokenHash, session.PreviousRefreshTokenHash }
                .Concat(session.RetiredRefreshTokenHashes?.Split(' ', StringSplitOptions.RemoveEmptyEntries) ?? []);
            foreach (var hash in hashes.Where(h => !string.IsNullOrEmpty(h)))
            {
                rows[hash!] = new ViewerSessionTombstoneEntity
                {
                    RefreshTokenHash = hash!,
                    SessionId = session.Id,
                    ViewerId = session.ViewerId,
                    Reason = why,
                    EndedAt = endedAt,
                    ExpiresAt = expiresAt,
                };
            }
        }
        if (rows.Count == 0)
            return;
        var keys = rows.Keys.ToList();
        var existing = await db.ViewerSessionTombstones.Where(t => keys.Contains(t.RefreshTokenHash)).Select(t => t.RefreshTokenHash).ToListAsync(ct);
        db.ViewerSessionTombstones.AddRange(rows.Where(r => !existing.Contains(r.Key)).Select(r => r.Value));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The previous token gets the same rotated pair inside the concurrency grace, or later while that pair is unused (an app killed before it stored the pair) and the old token has not expired.</summary>
    private static bool CanReplay(ViewerSessionEntity session, DateTimeOffset now)
        => session.RotatedAt is { } rotatedAt &&
           (now - rotatedAt <= RotationGrace ||
            (session.RotationConfirmedAt is null && session.PreviousRefreshExpiresAt is { } previousExpiry && now < previousExpiry));

    private static string? Retire(string? retired, string? hash)
    {
        if (hash is null)
            return retired;
        var hashes = (retired?.Split(' ', StringSplitOptions.RemoveEmptyEntries) ?? []).Prepend(hash).Take(MaxRetiredTokens);
        return string.Join(' ', hashes);
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

    /// <summary>Ends every other active session in one statement and answers how many were ended.</summary>
    public async Task<int> RevokeOthersAsync(string viewerId, string keepSessionId, string reason, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await RevokeWhereAsync(db, s => s.ViewerId == viewerId && s.Id != keepSessionId && s.RefreshExpiresAt > now, reason, now, ct);
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

    private static string? Bounded(string? value)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Any(char.IsControl))
            return null;
        return trimmed.Length <= 100 ? trimmed : trimmed[..100];
    }
}
