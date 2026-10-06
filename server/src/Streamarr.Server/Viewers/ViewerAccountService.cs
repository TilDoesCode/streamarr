using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Auth;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Email;

namespace Streamarr.Server.Viewers;

public sealed record ViewerCreate(
    string Username,
    string? DisplayName,
    string? Email,
    string? Password,
    bool? MustChangePassword,
    ViewerPermissions Permissions,
    bool Disabled);

public sealed record ViewerPermissions(int? MaxAge, bool BlockUnrated, bool AllowTranscoding, int? MaxConcurrentStreams);

public sealed record ViewerUpdate
{
    public string? DisplayName { get; init; }
    public string? Email { get; init; }
    public bool ClearEmail { get; init; }
    public bool? Disabled { get; init; }
    public bool? MustChangePassword { get; init; }
    public bool Unlock { get; init; }
    public int? MaxAge { get; init; }
    public bool ClearMaxAge { get; init; }
    public bool? BlockUnrated { get; init; }
    public bool? AllowTranscoding { get; init; }
    public int? MaxConcurrentStreams { get; init; }
    public bool ClearMaxConcurrentStreams { get; init; }
}

/// <summary>The fixed avatar choices; the order matches the clients' avatar colour slots 1-8.</summary>
public static class ViewerAvatars
{
    public static readonly IReadOnlyList<string> Keys = ["cyan", "blue", "teal", "green", "amber", "coral", "rose", "slate"];

    public static string? Known(string? key) => key is not null && Keys.Contains(key) ? key : null;

    public static string? Validate(string? key)
        => key is null ? null : Known(key.Trim().ToLowerInvariant())
           ?? throw ViewerProblem.BadRequest("invalid_avatar", $"'avatarKey' must be one of {string.Join(", ", Keys)} or null for the default.");
}

/// <summary>Viewer account lifecycle for admins and the viewer's own profile operations.</summary>
public sealed class ViewerAccountService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerSettingsService settings,
    ViewerSessionService sessions,
    ViewerCodeService codes,
    ViewerMailer mailer,
    ViewerMailLanguage mailLanguage,
    TimeProvider time)
{
    public static readonly int[] AgeLimits = [0, 6, 12, 16, 18];

    public async Task<IReadOnlyList<ViewerEntity>> ListAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Viewers.AsNoTracking().OrderBy(v => v.NormalizedUsername).ToListAsync(ct);
    }

    public async Task<ViewerEntity> GetAsync(string id, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Viewers.AsNoTracking().SingleOrDefaultAsync(v => v.Id == id, ct)
               ?? throw ViewerProblem.NotFound("viewer_not_found", "No viewer account with this id exists.");
    }

    public async Task<(ViewerEntity Viewer, string? GeneratedPassword)> CreateAsync(ViewerCreate create, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        var username = create.Username?.Trim() ?? string.Empty;
        if (!ViewerPasswords.IsValidUsername(username))
            throw ViewerProblem.BadRequest("invalid_username", "Usernames are 3-32 characters: letters, digits, '.', '_' or '-', starting with a letter or digit.");
        ValidatePermissions(create.Permissions);

        var generated = string.IsNullOrEmpty(create.Password) ? ViewerPasswords.Generate(current.PasswordMinLength) : null;
        var password = generated ?? create.Password!;
        if (generated is null && ViewerPasswords.Problem(password, username, current) is { } problem)
            throw ViewerProblem.BadRequest("invalid_password", problem);

        var email = NormalizeEmailInput(create.Email);
        var now = time.GetUtcNow();
        var (hash, salt) = PasswordHasher.Hash(password);
        var viewer = new ViewerEntity
        {
            Id = Guid.NewGuid().ToString("n"),
            Username = username,
            NormalizedUsername = ViewerPasswords.NormalizeUsername(username),
            DisplayName = CleanDisplayName(create.DisplayName) ?? username,
            Email = email,
            NormalizedEmail = email is null ? null : ViewerEmail.Normalize(email),
            EmailVerifiedAt = email is null ? null : now,
            PasswordHash = hash,
            PasswordSalt = salt,
            MustChangePassword = create.MustChangePassword ?? generated is not null,
            IsDisabled = create.Disabled,
            MaxAge = create.Permissions.MaxAge,
            BlockUnrated = create.Permissions.BlockUnrated,
            AllowTranscoding = create.Permissions.AllowTranscoding,
            MaxConcurrentStreams = create.Permissions.MaxConcurrentStreams,
            CreatedAt = now,
            UpdatedAt = now,
            PasswordChangedAt = now,
        };

        await using var db = await dbFactory.CreateDbContextAsync(ct);
        await EnsureUniqueAsync(db, viewer.NormalizedUsername, viewer.NormalizedEmail, exceptId: null, ct);
        db.Viewers.Add(viewer);
        await db.SaveChangesAsync(ct);
        return (viewer, generated);
    }

    public async Task<ViewerEntity> UpdateAsync(string id, ViewerUpdate update, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindTrackedAsync(db, id, ct);
        var now = time.GetUtcNow();
        var revoke = false;

        if (update.DisplayName is not null)
            viewer.DisplayName = CleanDisplayName(update.DisplayName) ?? viewer.Username;
        if (update.ClearEmail)
        {
            viewer.Email = viewer.NormalizedEmail = viewer.PendingEmail = null;
            viewer.EmailVerifiedAt = null;
        }
        else if (update.Email is not null && !string.Equals(ViewerEmail.Normalize(update.Email), viewer.NormalizedEmail, StringComparison.Ordinal))
        {
            var email = NormalizeEmailInput(update.Email)!;
            await EnsureUniqueAsync(db, null, ViewerEmail.Normalize(email), id, ct);
            viewer.Email = email;
            viewer.NormalizedEmail = ViewerEmail.Normalize(email);
            viewer.EmailVerifiedAt = now;
            viewer.PendingEmail = null;
        }
        if (update.Disabled is { } disabled && disabled != viewer.IsDisabled)
        {
            viewer.IsDisabled = disabled;
            revoke |= disabled;
        }
        if (update.MustChangePassword is { } mustChange)
            viewer.MustChangePassword = mustChange;
        if (update.Unlock)
        {
            viewer.LockoutEndsAt = null;
            viewer.FailedLoginCount = 0;
        }

        var permissions = new ViewerPermissions(
            update.ClearMaxAge ? null : update.MaxAge ?? viewer.MaxAge,
            update.BlockUnrated ?? viewer.BlockUnrated,
            update.AllowTranscoding ?? viewer.AllowTranscoding,
            update.ClearMaxConcurrentStreams ? null : update.MaxConcurrentStreams ?? viewer.MaxConcurrentStreams);
        ValidatePermissions(permissions);
        (viewer.MaxAge, viewer.BlockUnrated, viewer.AllowTranscoding, viewer.MaxConcurrentStreams) =
            (permissions.MaxAge, permissions.BlockUnrated, permissions.AllowTranscoding, permissions.MaxConcurrentStreams);

        viewer.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        if (revoke)
            await sessions.RevokeAllAsync(id, "account_disabled", exceptSessionId: null, ct);
        return viewer;
    }

    /// <summary>Admin-assigned password; a null password generates one. All sessions of the viewer end.</summary>
    public async Task<string?> SetPasswordAsync(string id, string? password, bool mustChange, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindTrackedAsync(db, id, ct);
        var generated = string.IsNullOrEmpty(password) ? ViewerPasswords.Generate(current.PasswordMinLength) : null;
        if (generated is null && ViewerPasswords.Problem(password, viewer.Username, current) is { } problem)
            throw ViewerProblem.BadRequest("invalid_password", problem);
        ApplyPassword(viewer, generated ?? password!, time.GetUtcNow());
        viewer.MustChangePassword = mustChange;
        viewer.LockoutEndsAt = null;
        viewer.FailedLoginCount = 0;
        await db.SaveChangesAsync(ct);
        await ViewerCodeService.InvalidateAsync(db, id, ViewerCodePurpose.PasswordReset, time.GetUtcNow(), ct);
        await sessions.RevokeAllAsync(id, "password_set_by_admin", exceptSessionId: null, ct);
        return generated;
    }

    public Task DeleteAsync(string id, CancellationToken ct) => sessions.UnderSessionLockAsync(async () =>
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var ended = await db.ViewerSessions.AsNoTracking().Where(x => x.ViewerId == id).ToListAsync(ct);
        await ViewerSessionService.AddTombstonesAsync(db, ended, "account_deleted", time.GetUtcNow(), ct);
        await db.ViewerSessions.Where(x => x.ViewerId == id).ExecuteDeleteAsync(ct);
        await db.ViewerOneTimeCodes.Where(x => x.ViewerId == id).ExecuteDeleteAsync(ct);
        await db.ViewerRecoveryCodes.Where(x => x.ViewerId == id).ExecuteDeleteAsync(ct);
        await db.ViewerWatchStates.Where(x => x.ViewerId == id).ExecuteDeleteAsync(ct);
        if (await db.Viewers.Where(x => x.Id == id).ExecuteDeleteAsync(ct) == 0)
            throw ViewerProblem.NotFound("viewer_not_found", "No viewer account with this id exists.");
        await transaction.CommitAsync(ct);
    }, ct);

    /// <summary>The viewer's own profile edit; omitted fields stay unchanged.</summary>
    public async Task<ViewerEntity> UpdateProfileAsync(string id, ViewerProfileUpdateRequest request, CancellationToken ct)
    {
        var displayName = request.DisplayNameSet ? CleanDisplayName(request.DisplayName) : null;
        var avatarKey = request.AvatarKeySet ? ViewerAvatars.Validate(request.AvatarKey) : null;
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindTrackedAsync(db, id, ct);
        if (request.DisplayNameSet)
            viewer.DisplayName = displayName ?? viewer.Username;
        if (request.AvatarKeySet)
            viewer.AvatarKey = avatarKey;
        viewer.UpdatedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return viewer;
    }

    /// <summary>Viewer-initiated password change; ends every other session of the viewer.</summary>
    public async Task ChangePasswordAsync(string id, string? currentPassword, string? newPassword, string keepSessionId, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindTrackedAsync(db, id, ct);
        RequirePassword(viewer, currentPassword);
        if (ViewerPasswords.Problem(newPassword, viewer.Username, current) is { } problem)
            throw ViewerProblem.BadRequest("invalid_password", problem);
        if (PasswordHasher.Verify(newPassword!, viewer.PasswordHash, viewer.PasswordSalt))
            throw ViewerProblem.BadRequest("invalid_password", "The new password must differ from the current one.");
        ApplyPassword(viewer, newPassword!, time.GetUtcNow());
        viewer.MustChangePassword = false;
        await db.SaveChangesAsync(ct);
        await ViewerCodeService.InvalidateAsync(db, id, ViewerCodePurpose.PasswordReset, time.GetUtcNow(), ct);
        await sessions.RevokeAllAsync(id, "password_changed", keepSessionId, ct);
    }

    /// <summary>Starts an email change (or removal when <paramref name="newEmail"/> is empty) behind the current password.</summary>
    public async Task<bool> RequestEmailChangeAsync(string id, string? newEmail, string? currentPassword, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindTrackedAsync(db, id, ct);
        RequirePassword(viewer, currentPassword);

        if (string.IsNullOrWhiteSpace(newEmail))
        {
            viewer.Email = viewer.NormalizedEmail = viewer.PendingEmail = null;
            viewer.EmailVerifiedAt = null;
            viewer.UpdatedAt = time.GetUtcNow();
            await db.SaveChangesAsync(ct);
            return false;
        }

        var email = NormalizeEmailInput(newEmail)!;
        if (!ViewerMailer.CanDeliver(current))
            throw ViewerProblem.Conflict("email_unavailable", "This server cannot send email, so an address cannot be verified.");
        await EnsureUniqueAsync(db, null, ViewerEmail.Normalize(email), id, ct);
        var issue = await codes.IssueAsync(db, id, ViewerCodePurpose.EmailVerification, email, ct);
        if (!issue.Issued)
            throw ViewerProblem.EmailCodeCooldown(issue.RetryAfter);
        viewer.PendingEmail = email;
        viewer.UpdatedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        mailer.Enqueue(ViewerMailTemplates.VerifyEmail(mailLanguage.Current, current.ServerName, email, viewer.DisplayName, issue.Code!,
            (int)ViewerCodePurpose.Lifetime(ViewerCodePurpose.EmailVerification).TotalMinutes));
        return true;
    }

    public async Task<ViewerEntity> ConfirmEmailAsync(string id, string? code, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await FindTrackedAsync(db, id, ct);
        var redeemed = await codes.RedeemAsync(db, id, ViewerCodePurpose.EmailVerification, code, ct);
        if (redeemed?.Target is null || !string.Equals(redeemed.Target, viewer.PendingEmail, StringComparison.Ordinal))
            throw ViewerProblem.BadRequest("invalid_code", "The code is wrong, expired, or was replaced by a newer one.");
        await EnsureUniqueAsync(db, null, ViewerEmail.Normalize(redeemed.Target), id, ct);
        viewer.Email = redeemed.Target;
        viewer.NormalizedEmail = ViewerEmail.Normalize(redeemed.Target);
        viewer.EmailVerifiedAt = time.GetUtcNow();
        viewer.PendingEmail = null;
        viewer.UpdatedAt = viewer.EmailVerifiedAt.Value;
        await db.SaveChangesAsync(ct);
        return viewer;
    }

    internal static void RequirePassword(ViewerEntity viewer, string? password)
    {
        if (string.IsNullOrEmpty(password) || password.Length > ViewerPasswords.MaxLength ||
            !PasswordHasher.Verify(password, viewer.PasswordHash, viewer.PasswordSalt))
        {
            throw ViewerProblem.BadRequest("invalid_credentials", "The current password is incorrect.");
        }
    }

    internal static void ApplyPassword(ViewerEntity viewer, string password, DateTimeOffset now)
    {
        var (hash, salt) = PasswordHasher.Hash(password);
        viewer.PasswordHash = hash;
        viewer.PasswordSalt = salt;
        viewer.PasswordChangedAt = now;
        viewer.UpdatedAt = now;
    }

    internal static async Task<ViewerEntity> FindTrackedAsync(StreamarrDbContext db, string id, CancellationToken ct)
        => await db.Viewers.SingleOrDefaultAsync(v => v.Id == id, ct)
           ?? throw ViewerProblem.NotFound("viewer_not_found", "No viewer account with this id exists.");

    private static async Task EnsureUniqueAsync(StreamarrDbContext db, string? normalizedUsername, string? normalizedEmail, string? exceptId, CancellationToken ct)
    {
        if (normalizedUsername is not null &&
            await db.Viewers.AnyAsync(v => v.NormalizedUsername == normalizedUsername && v.Id != exceptId, ct))
        {
            throw ViewerProblem.Conflict("username_taken", "Another viewer already uses this username.");
        }
        if (normalizedEmail is not null &&
            await db.Viewers.AnyAsync(v => v.NormalizedEmail == normalizedEmail && v.Id != exceptId, ct))
        {
            throw ViewerProblem.Conflict("email_taken", "Another viewer already uses this email address.");
        }
    }

    private static void ValidatePermissions(ViewerPermissions permissions)
    {
        if (permissions.MaxAge is { } age && !AgeLimits.Contains(age))
            throw ViewerProblem.BadRequest("invalid_permissions", $"'maxAge' must be one of {string.Join(", ", AgeLimits)} or empty for unrestricted.");
        if (permissions.MaxConcurrentStreams is < 1 or > 20)
            throw ViewerProblem.BadRequest("invalid_permissions", "'maxConcurrentStreams' must be between 1 and 20 or empty for unlimited.");
    }

    private static string? NormalizeEmailInput(string? email)
    {
        if (string.IsNullOrWhiteSpace(email))
            return null;
        var trimmed = email.Trim();
        if (!ViewerEmail.IsValid(trimmed))
            throw ViewerProblem.BadRequest("invalid_email", "The email address is not valid.");
        return trimmed;
    }

    private static string? CleanDisplayName(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return null;
        var trimmed = value.Trim();
        if (trimmed.Length == 0 || trimmed.Length > 64 || trimmed.Any(char.IsControl))
            throw ViewerProblem.BadRequest("invalid_display_name", "Display names are 1-64 printable characters, not only spaces.");
        return trimmed;
    }
}
