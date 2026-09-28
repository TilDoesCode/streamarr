using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Viewers.Auth;

public sealed record TotpSetup(string Secret, string OtpAuthUri, string Issuer, string AccountName);

/// <summary>Authenticator-app enrolment, verification with replay protection, and recovery codes.</summary>
public sealed class ViewerTwoFactorService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerSettingsService settings,
    ViewerSessionService sessions,
    ISecretProtector protector,
    TimeProvider time)
{
    public async Task<TotpSetup> BeginSetupAsync(string viewerId, string? currentPassword, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        if (!current.AllowTotp)
            throw ViewerProblem.Forbidden("totp_not_allowed", "Two-factor authentication is disabled on this server.");
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await ViewerAccountService.FindTrackedAsync(db, viewerId, ct);
        ViewerAccountService.RequirePassword(viewer, currentPassword);
        if (viewer.TotpEnabledAt is not null)
            throw ViewerProblem.Conflict("totp_already_enabled", "Two-factor authentication is already enabled.");

        var secret = ViewerTotp.NewSecret();
        viewer.PendingTotpSecretEncrypted = protector.Protect(secret);
        viewer.UpdatedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return new TotpSetup(secret, ViewerTotp.ProvisioningUri(secret, current.ServerName, viewer.Username), current.ServerName, viewer.Username);
    }

    public async Task<IReadOnlyList<string>> EnableAsync(string viewerId, string? code, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await ViewerAccountService.FindTrackedAsync(db, viewerId, ct);
        var secret = protector.Unprotect(viewer.PendingTotpSecretEncrypted);
        if (secret.Length == 0)
            throw ViewerProblem.Conflict("totp_setup_missing", "Start the authenticator setup first.");
        var now = time.GetUtcNow();
        if (code is null || ViewerTotp.Verify(secret, code, now) is not { } step)
            throw ViewerProblem.BadRequest("invalid_code", "The authenticator code is not valid. Check the device clock and try again.");

        viewer.TotpSecretEncrypted = viewer.PendingTotpSecretEncrypted;
        viewer.PendingTotpSecretEncrypted = null;
        viewer.TotpEnabledAt = now;
        viewer.TotpLastUsedStep = step;
        viewer.UpdatedAt = now;
        var recovery = await ReplaceRecoveryCodesAsync(db, viewerId, now, ct);
        await db.SaveChangesAsync(ct);
        return recovery;
    }

    public async Task DisableAsync(string viewerId, string? currentPassword, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await ViewerAccountService.FindTrackedAsync(db, viewerId, ct);
        ViewerAccountService.RequirePassword(viewer, currentPassword);
        await ClearAsync(db, viewer, ct);
    }

    /// <summary>Admin recovery: removes a lost authenticator and signs the viewer out everywhere.</summary>
    public async Task ResetAsync(string viewerId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await ViewerAccountService.FindTrackedAsync(db, viewerId, ct);
        await ClearAsync(db, viewer, ct);
        await sessions.RevokeAllAsync(viewerId, "two_factor_reset", exceptSessionId: null, ct);
    }

    public async Task<IReadOnlyList<string>> RegenerateRecoveryCodesAsync(string viewerId, string? currentPassword, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await ViewerAccountService.FindTrackedAsync(db, viewerId, ct);
        ViewerAccountService.RequirePassword(viewer, currentPassword);
        if (viewer.TotpEnabledAt is null)
            throw ViewerProblem.Conflict("totp_not_enabled", "Two-factor authentication is not enabled.");
        var codes = await ReplaceRecoveryCodesAsync(db, viewerId, time.GetUtcNow(), ct);
        await db.SaveChangesAsync(ct);
        return codes;
    }

    public async Task<int> RemainingRecoveryCodesAsync(string viewerId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerRecoveryCodes.CountAsync(c => c.ViewerId == viewerId && c.UsedAt == null, ct);
    }

    /// <summary>Checks a TOTP or recovery code for a tracked viewer; the caller saves the context.</summary>
    public async Task<bool> VerifyAsync(StreamarrDbContext db, ViewerEntity viewer, string? code, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(code) || code.Length > 32 || viewer.TotpEnabledAt is null)
            return false;
        var now = time.GetUtcNow();
        if (ViewerTotp.LooksLikeTotp(code))
        {
            var secret = protector.Unprotect(viewer.TotpSecretEncrypted);
            if (secret.Length == 0 || ViewerTotp.Verify(secret, code, now) is not { } step ||
                step <= (viewer.TotpLastUsedStep ?? long.MinValue))
            {
                return false;
            }
            viewer.TotpLastUsedStep = step;
            return true;
        }

        var hash = ViewerTotp.HashRecoveryCode(code);
        var recovery = await db.ViewerRecoveryCodes.SingleOrDefaultAsync(
            c => c.ViewerId == viewer.Id && c.CodeHash == hash && c.UsedAt == null, ct);
        if (recovery is null)
            return false;
        recovery.UsedAt = now;
        return true;
    }

    private async Task ClearAsync(StreamarrDbContext db, ViewerEntity viewer, CancellationToken ct)
    {
        viewer.TotpSecretEncrypted = null;
        viewer.PendingTotpSecretEncrypted = null;
        viewer.TotpEnabledAt = null;
        viewer.TotpLastUsedStep = null;
        viewer.UpdatedAt = time.GetUtcNow();
        await db.ViewerRecoveryCodes.Where(c => c.ViewerId == viewer.Id).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);
    }

    private static async Task<IReadOnlyList<string>> ReplaceRecoveryCodesAsync(
        StreamarrDbContext db, string viewerId, DateTimeOffset now, CancellationToken ct)
    {
        await db.ViewerRecoveryCodes.Where(c => c.ViewerId == viewerId).ExecuteDeleteAsync(ct);
        var codes = ViewerTotp.NewRecoveryCodes();
        db.ViewerRecoveryCodes.AddRange(codes.Select(code => new ViewerRecoveryCodeEntity
        {
            ViewerId = viewerId,
            CodeHash = ViewerTotp.HashRecoveryCode(code),
            CreatedAt = now,
        }));
        return codes;
    }
}
