using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Auth;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Email;

namespace Streamarr.Server.Viewers.Auth;

public sealed record ViewerLoginResult(ViewerEntity? Viewer, string Method, string? MfaToken, DateTimeOffset? MfaExpiresAt);

/// <summary>Viewer sign-in flows: password, emailed code, second factor, and self-service password reset.</summary>
public sealed class ViewerLoginService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerSettingsService settings,
    ViewerCodeService codes,
    ViewerTwoFactorService twoFactor,
    ViewerSessionService sessions,
    ViewerMailer mailer,
    TimeProvider time)
{
    private static readonly TimeSpan MfaLifetime = TimeSpan.FromMinutes(5);
    private const int MfaAttempts = 5;
    private static readonly (string Hash, string Salt) DummyPassword =
        PasswordHasher.Hash(Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)));

    private readonly ConcurrentDictionary<string, MfaChallenge> _challenges = new(StringComparer.Ordinal);

    public async Task<ViewerLoginResult> PasswordAsync(string? login, string? password, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(login) || login.Length > 254 || string.IsNullOrEmpty(password) || password.Length > ViewerPasswords.MaxLength)
            throw ViewerProblem.BadRequest("invalid_login", "'login' and 'password' are required.");

        var current = await settings.GetAsync(ct);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindByLoginAsync(db, login, ct);
        if (viewer is null)
        {
            _ = PasswordHasher.Verify(password, DummyPassword.Hash, DummyPassword.Salt);
            throw InvalidCredentials();
        }

        var now = time.GetUtcNow();
        var verification = PasswordHasher.VerifyDetailed(password, viewer.PasswordHash, viewer.PasswordSalt);
        if (!verification.Valid)
        {
            await RegisterFailureAsync(db, viewer, current, now, ct);
            throw InvalidCredentials();
        }

        EnsureCanSignIn(viewer, now);
        if (verification.NeedsRehash)
            ViewerAccountService.ApplyPassword(viewer, password, viewer.PasswordChangedAt ?? now);
        return await CompleteFirstFactorAsync(db, viewer, "password", now, ct);
    }

    public async Task<ViewerLoginResult> SecondFactorAsync(string? mfaToken, string? code, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        Prune(now);
        if (!ViewerAuth.HasShape(mfaToken, ViewerAuth.MfaTokenPrefix) ||
            !_challenges.TryGetValue(ViewerAuth.Hash(mfaToken!), out var challenge) || challenge.ExpiresAt <= now)
        {
            throw ViewerProblem.Unauthorized("mfa_expired", "The sign-in attempt expired. Start again.");
        }

        var current = await settings.GetAsync(ct);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await db.Viewers.SingleOrDefaultAsync(v => v.Id == challenge.ViewerId, ct);
        if (viewer is null)
            throw ViewerProblem.Unauthorized("mfa_expired", "The sign-in attempt expired. Start again.");
        EnsureCanSignIn(viewer, now);

        if (!await twoFactor.VerifyAsync(db, viewer, code, ct))
        {
            if (Interlocked.Increment(ref challenge.Attempts) >= MfaAttempts)
                _challenges.TryRemove(ViewerAuth.Hash(mfaToken!), out _);
            await RegisterFailureAsync(db, viewer, current, now, ct);
            throw ViewerProblem.Unauthorized("invalid_code", "The authenticator or recovery code is not valid.");
        }

        _challenges.TryRemove(ViewerAuth.Hash(mfaToken!), out _);
        await SucceedAsync(db, viewer, now, ct);
        return new ViewerLoginResult(viewer, challenge.Method + "+2fa", null, null);
    }

    public async Task RequestLoginCodeAsync(string? login, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        if (!current.AllowEmailLogin || !ViewerMailer.CanDeliver(current))
            throw ViewerProblem.Forbidden("email_login_unavailable", "Sign-in by email code is not available on this server.");
        await SendCodeAsync(login, ViewerCodePurpose.Login, current, ct);
    }

    public async Task<ViewerLoginResult> LoginCodeAsync(string? login, string? code, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        if (!current.AllowEmailLogin)
            throw ViewerProblem.Forbidden("email_login_unavailable", "Sign-in by email code is not available on this server.");
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var now = time.GetUtcNow();
        var viewer = await RedeemForLoginAsync(db, login, code, ViewerCodePurpose.Login, ct);
        if (viewer is null)
            throw ViewerProblem.Unauthorized("invalid_code", "The code is wrong, expired, or was replaced by a newer one.");
        EnsureCanSignIn(viewer, now);
        return await CompleteFirstFactorAsync(db, viewer, "email_code", now, ct);
    }

    public async Task RequestPasswordResetAsync(string? login, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        if (!current.AllowPasswordReset || !ViewerMailer.CanDeliver(current))
            throw ViewerProblem.Forbidden("password_reset_unavailable", "Password reset by email is not available on this server.");
        await SendCodeAsync(login, ViewerCodePurpose.PasswordReset, current, ct);
    }

    public async Task ResetPasswordAsync(string? login, string? code, string? newPassword, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        if (!current.AllowPasswordReset)
            throw ViewerProblem.Forbidden("password_reset_unavailable", "Password reset by email is not available on this server.");
        if (ViewerPasswords.Problem(newPassword, login?.Trim() ?? string.Empty, current) is { } problem)
            throw ViewerProblem.BadRequest("invalid_password", problem);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await RedeemForLoginAsync(db, login, code, ViewerCodePurpose.PasswordReset, ct);
        if (viewer is null)
            throw ViewerProblem.BadRequest("invalid_code", "The code is wrong, expired, or was replaced by a newer one.");

        if (ViewerPasswords.Problem(newPassword, viewer.Username, current) is { } usernameProblem)
            throw ViewerProblem.BadRequest("invalid_password", usernameProblem);
        var now = time.GetUtcNow();
        ViewerAccountService.ApplyPassword(viewer, newPassword!, now);
        viewer.MustChangePassword = false;
        viewer.FailedLoginCount = 0;
        viewer.LockoutEndsAt = null;
        await db.SaveChangesAsync(ct);
        await sessions.RevokeAllAsync(viewer.Id, "password_reset", exceptSessionId: null, ct);
    }

    private async Task SendCodeAsync(string? login, string purpose, ViewerSettings current, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(login) || login.Length > 254)
            throw ViewerProblem.BadRequest("invalid_login", "'login' is required.");
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindByLoginAsync(db, login, ct);
        if (viewer is null || viewer.IsDisabled || viewer.Email is null || viewer.EmailVerifiedAt is null)
            return;
        var code = await codes.IssueAsync(db, viewer.Id, purpose, viewer.Email, ct);
        if (code is null)
            return;
        var minutes = (int)ViewerCodePurpose.Lifetime(purpose).TotalMinutes;
        mailer.Enqueue(purpose == ViewerCodePurpose.Login
            ? ViewerMailTemplates.LoginCode(current.ServerName, viewer.Email, viewer.DisplayName, code, minutes)
            : ViewerMailTemplates.PasswordReset(current.ServerName, viewer.Email, viewer.DisplayName, code, minutes));
    }

    private async Task<ViewerEntity?> RedeemForLoginAsync(StreamarrDbContext db, string? login, string? code, string purpose, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(login) || login.Length > 254)
            return null;
        var viewer = await FindByLoginAsync(db, login, ct);
        if (viewer?.Email is null)
            return null;
        var redeemed = await codes.RedeemAsync(db, viewer.Id, purpose, code, ct);
        return redeemed is not null && string.Equals(redeemed.Target, viewer.Email, StringComparison.Ordinal) ? viewer : null;
    }

    private async Task<ViewerLoginResult> CompleteFirstFactorAsync(
        StreamarrDbContext db, ViewerEntity viewer, string method, DateTimeOffset now, CancellationToken ct)
    {
        if (viewer.TotpEnabledAt is null)
        {
            await SucceedAsync(db, viewer, now, ct);
            return new ViewerLoginResult(viewer, method, null, null);
        }

        await db.SaveChangesAsync(ct);
        Prune(now);
        var token = ViewerAuth.NewToken(ViewerAuth.MfaTokenPrefix);
        var expires = now + MfaLifetime;
        _challenges[ViewerAuth.Hash(token)] = new MfaChallenge(viewer.Id, method, expires);
        return new ViewerLoginResult(null, method, token, expires);
    }

    private static async Task SucceedAsync(StreamarrDbContext db, ViewerEntity viewer, DateTimeOffset now, CancellationToken ct)
    {
        viewer.FailedLoginCount = 0;
        viewer.LockoutEndsAt = null;
        viewer.LastLoginAt = now;
        await db.SaveChangesAsync(ct);
    }

    private static async Task RegisterFailureAsync(StreamarrDbContext db, ViewerEntity viewer, ViewerSettings current, DateTimeOffset now, CancellationToken ct)
    {
        if (viewer.LockoutEndsAt > now)
            return;
        viewer.FailedLoginCount++;
        if (viewer.FailedLoginCount >= current.LockoutThreshold)
        {
            viewer.LockoutEndsAt = now.AddMinutes(current.LockoutMinutes);
            viewer.FailedLoginCount = 0;
        }
        await db.SaveChangesAsync(ct);
    }

    private static void EnsureCanSignIn(ViewerEntity viewer, DateTimeOffset now)
    {
        if (viewer.IsDisabled)
            throw ViewerProblem.Forbidden("account_disabled", "This viewer account is disabled.");
        if (viewer.LockoutEndsAt is { } until && until > now)
            throw new ViewerProblem(StatusCodes.Status423Locked, "account_locked",
                $"Too many failed sign-in attempts. Try again after {until:u}.");
    }

    private static Task<ViewerEntity?> FindByLoginAsync(StreamarrDbContext db, string login, CancellationToken ct)
    {
        var normalized = login.Trim().ToUpperInvariant();
        return normalized.Contains('@', StringComparison.Ordinal)
            ? db.Viewers.SingleOrDefaultAsync(v => v.NormalizedEmail == normalized, ct)
            : db.Viewers.SingleOrDefaultAsync(v => v.NormalizedUsername == normalized, ct);
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var (key, challenge) in _challenges)
        {
            if (challenge.ExpiresAt <= now)
                _challenges.TryRemove(key, out _);
        }
    }

    private static ViewerProblem InvalidCredentials()
        => ViewerProblem.Unauthorized("invalid_credentials", "Incorrect username or password.");

    private sealed class MfaChallenge(string viewerId, string method, DateTimeOffset expiresAt)
    {
        public string ViewerId { get; } = viewerId;
        public string Method { get; } = method;
        public DateTimeOffset ExpiresAt { get; } = expiresAt;
        public int Attempts;
    }
}
