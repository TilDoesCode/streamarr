using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Auth;

/// <summary>
/// Issues and validates the short-lived admin session JWTs (BRIEF §6.4). The HMAC-SHA256
/// signing key is persisted (Data-Protection ciphertext) so tokens survive restarts, and
/// generated once on first use if the initializer has not already done so. Singleton.
/// </summary>
public sealed class JwtTokenService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ISecretProtector protector,
    IOptions<StreamarrOptions> options,
    TimeProvider time)
{
    private const string Issuer = "streamarr";
    private const string Audience = "streamarr";

    private readonly object _gate = new();
    // Reads happen on every authenticated request while password changes/logout rotate
    // the key under a lock. Volatile publication prevents another request thread from
    // continuing to validate against a stale key after rotation.
    private volatile SymmetricSecurityKey? _key;

    public (string Token, DateTimeOffset ExpiresAt) CreateToken(UserEntity user)
    {
        var now = time.GetUtcNow();
        var expires = now.AddSeconds(Math.Max(60, options.Value.AdminSessionTtlSeconds));

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id),
            new(JwtRegisteredClaimNames.UniqueName, user.Username),
            new(ClaimTypes.Name, user.Username),
            new(ClaimTypes.Role, user.Role),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("n")),
        };

        var token = new JwtSecurityToken(
            issuer: Issuer,
            audience: Audience,
            claims: claims,
            notBefore: now.UtcDateTime,
            expires: expires.UtcDateTime,
            signingCredentials: new SigningCredentials(GetKey(), SecurityAlgorithms.HmacSha256));

        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }

    /// <summary>Validate a bearer token as an admin JWT, returning its principal or null.</summary>
    public ClaimsPrincipal? Validate(string token)
    {
        try
        {
            var principal = new JwtSecurityTokenHandler().ValidateToken(token, new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidIssuer = Issuer,
                ValidateAudience = true,
                ValidAudience = Audience,
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = GetKey(),
                ValidateLifetime = true,
                ClockSkew = TimeSpan.FromSeconds(30),
                RoleClaimType = ClaimTypes.Role,
                NameClaimType = ClaimTypes.Name,
            }, out _);
            return principal;
        }
        catch (Exception)
        {
            // Malformed, expired, wrong signature — treated as "not an admin token".
            return null;
        }
    }

    /// <summary>
    /// Rotates the persisted signing key, immediately invalidating every issued admin
    /// JWT. Password changes use this conservative global revocation until per-user
    /// token versions are introduced.
    /// </summary>
    public void RevokeAll()
    {
        lock (_gate)
        {
            var bytes = RandomNumberGenerator.GetBytes(48);
            using var db = dbFactory.CreateDbContext();
            var general = db.GeneralConfig.SingleOrDefault(g => g.Id == 1);
            if (general is null)
            {
                general = new GeneralConfigEntity { Id = 1 };
                db.GeneralConfig.Add(general);
            }

            general.JwtSigningKeyEncrypted = protector.Protect(Convert.ToBase64String(bytes));
            db.SaveChanges();
            _key = new SymmetricSecurityKey(bytes);
        }
    }

    private SymmetricSecurityKey GetKey()
    {
        if (_key is not null)
            return _key;

        lock (_gate)
        {
            _key ??= new SymmetricSecurityKey(LoadOrCreateKeyBytes());
            return _key;
        }
    }

    private byte[] LoadOrCreateKeyBytes()
    {
        using var db = dbFactory.CreateDbContext();
        var general = db.GeneralConfig.SingleOrDefault(g => g.Id == 1);
        if (general is null)
        {
            general = new GeneralConfigEntity { Id = 1 };
            db.GeneralConfig.Add(general);
        }

        var existing = protector.Unprotect(general.JwtSigningKeyEncrypted);
        if (!string.IsNullOrEmpty(existing))
            return Convert.FromBase64String(existing);

        var bytes = RandomNumberGenerator.GetBytes(48);
        general.JwtSigningKeyEncrypted = protector.Protect(Convert.ToBase64String(bytes));
        db.SaveChanges();
        return bytes;
    }
}
