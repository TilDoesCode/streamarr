using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Auth;

/// <summary>
/// Management user store (BRIEF §6.4). Backs the extensible users table: create, look up,
/// verify credentials, and change passwords. Singleton over
/// <see cref="IDbContextFactory{TContext}"/>. Multi-user ready — nothing here assumes a
/// single admin.
/// </summary>
public sealed class UserService(IDbContextFactory<StreamarrDbContext> dbFactory, TimeProvider time)
{
    private static readonly (string Hash, string Salt) DummyPassword =
        PasswordHasher.Hash(Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)));

    public async Task<bool> AnyAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Users.AnyAsync(ct);
    }

    public async Task<UserEntity> CreateAsync(string username, string password, string role, CancellationToken ct)
    {
        var (hash, salt) = PasswordHasher.Hash(password);
        var entity = new UserEntity
        {
            Id = Guid.NewGuid().ToString("n"),
            Username = username,
            PasswordHash = hash,
            PasswordSalt = salt,
            Role = role,
            CreatedAt = time.GetUtcNow(),
        };

        await using var db = await dbFactory.CreateDbContextAsync(ct);
        db.Users.Add(entity);
        await db.SaveChangesAsync(ct);
        return entity;
    }

    /// <summary>Returns the user when the credentials match, else null (constant-time verify).</summary>
    public async Task<UserEntity?> AuthenticateAsync(string username, string password, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var normalized = username.ToLower();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Username.ToLower() == normalized, ct);
        if (user is null)
        {
            // Match the expensive verification path so the generic login response is
            // not undermined by a username-existence timing oracle.
            _ = PasswordHasher.Verify(password, DummyPassword.Hash, DummyPassword.Salt);
            return null;
        }

        var verification = PasswordHasher.VerifyDetailed(password, user.PasswordHash, user.PasswordSalt);
        if (!verification.Valid)
            return null;

        if (verification.NeedsRehash)
        {
            var upgraded = PasswordHasher.Hash(password);
            user.PasswordHash = upgraded.Hash;
            user.PasswordSalt = upgraded.Salt;
            await db.SaveChangesAsync(ct);
        }

        return user;
    }

    public async Task<UserEntity?> FindByUsernameAsync(string username, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Users.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Username.ToLower() == username.ToLower(), ct);
    }

    public async Task<bool> ChangePasswordAsync(string userId, string newPassword, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null)
            return false;

        var (hash, salt) = PasswordHasher.Hash(newPassword);
        user.PasswordHash = hash;
        user.PasswordSalt = salt;
        await db.SaveChangesAsync(ct);
        return true;
    }
}
