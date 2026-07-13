using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Test helper for the two-mode auth model (BRIEF §6.4): exchange the seeded admin
/// credentials for a session JWT so admin-scoped endpoints (/config, /debug) can be
/// exercised. Machine-scope endpoints use the bootstrap API key directly.
/// </summary>
internal static class TestAuth
{
    public const string AdminUsername = "admin";
    public const string AdminPassword = "test-admin-password";

    public static async Task<string> LoginAsAdminAsync(HttpClient client)
    {
        var response = await client.PostAsJsonAsync("/api/v1/auth/login", new
        {
            username = AdminUsername,
            password = AdminPassword,
        });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("token").GetString()!;
    }

    public static async Task AuthenticateAsAdminAsync(this HttpClient client)
        => client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", await LoginAsAdminAsync(client));
}
