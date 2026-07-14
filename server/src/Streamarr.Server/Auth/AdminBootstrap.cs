using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Auth;

/// <summary>
/// First-run admin bootstrap (BRIEF §6.4). When the users table is empty, creates a single
/// admin from (in priority order) the STREAMARR_ADMIN_PASSWORD env var, the
/// <c>Streamarr:Admin:Password</c> config value, or (in Development only) a freshly
/// generated random password that is logged exactly once. Production fails fast when
/// no password is supplied. The username defaults to "admin". Extensible: this only
/// seeds the empty table; further users are added through the (future) user API.
/// </summary>
public sealed class AdminBootstrap(
    UserService users,
    IOptions<StreamarrOptions> options,
    IHostEnvironment environment,
    ILogger<AdminBootstrap> logger)
{
    public const string PasswordEnvVar = "STREAMARR_ADMIN_PASSWORD";
    public const string UsernameEnvVar = "STREAMARR_ADMIN_USERNAME";

    public async Task EnsureAdminAsync(CancellationToken ct = default)
    {
        if (await users.AnyAsync(ct))
            return;

        var admin = options.Value.Admin;
        var username = FirstNonEmpty(
            Environment.GetEnvironmentVariable(UsernameEnvVar), admin.Username, "admin")!;

        var envPassword = Environment.GetEnvironmentVariable(PasswordEnvVar);
        var configured = FirstNonEmpty(envPassword, admin.Password);

        if (configured is null && !environment.IsDevelopment())
        {
            throw new InvalidOperationException(
                $"A bootstrap admin password is required outside Development. Set {PasswordEnvVar} or Streamarr:Admin:Password.");
        }

        if (configured is { Length: < 12 or > 1024 } || configured?.Any(char.IsControl) == true)
            throw new InvalidOperationException("The bootstrap admin password must be 12-1024 characters without control characters.");

        var password = configured ?? GeneratePassword();
        await users.CreateAsync(username, password, AuthRoles.Admin, ct);

        if (configured is null)
        {
            // Logged exactly once, at first run only — there is no other way to recover it.
            logger.LogWarning(
                "Generated a bootstrap admin account. Username: '{Username}'  Password: '{Password}'. " +
                "Store it now and change it via the Management UI — this is shown only once.",
                username, password);
        }
        else
        {
            logger.LogInformation("Bootstrapped admin account '{Username}' from configuration.", username);
        }
    }

    private static string? FirstNonEmpty(params string?[] candidates)
        => candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c));

    /// <summary>A URL-safe, unambiguous 24-char random password.</summary>
    private static string GeneratePassword()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(18))
            .Replace('+', 'A').Replace('/', 'B').Replace('=', 'C');
}
