using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Streamarr.Server.Tests.Integration;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>End-to-end behaviour of viewer accounts and watch state over the real HTTP pipeline.</summary>
public sealed partial class ViewerApiTests(ViewerApiFactory factory) : IClassFixture<ViewerApiFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new
        {
            enabled = true,
            lockoutThreshold = 3,
            email = new { mode = "outbox" },
        });
        await _admin.DeleteAsync("/api/v1/config/viewers/outbox");
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private async Task<string> NewViewerAsync(string username, object? permissions = null, string? email = null)
    {
        var created = await ViewerApi.CreateAsync(_admin, new
        {
            username,
            password = Password,
            email,
            permissions,
        });
        return created.GetProperty("viewer").GetProperty("id").GetString()!;
    }

    [GeneratedRegex(@"\b[A-Z0-9]{4}-[A-Z0-9]{4}\b")]
    private static partial Regex CodePattern();

    private async Task<string> LatestCodeAsync(string kind)
    {
        var outbox = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/outbox");
        var mail = outbox.EnumerateArray().First(m => m.GetProperty("kind").GetString() == kind);
        return CodePattern().Match(mail.GetProperty("text").GetString()!).Value;
    }

    [Fact]
    public async Task Viewer_And_Admin_Credentials_Are_Mutually_Exclusive()
    {
        await NewViewerAsync("sep-viewer");
        using var anon = factory.CreateClient();
        var token = await ViewerApi.AccessTokenAsync(anon, "sep-viewer", Password);
        Assert.StartsWith("sva_", token);

        using var viewer = factory.Viewer(token);
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);
        foreach (var adminPath in new[] { "/api/v1/auth/me", "/api/v1/config/general", "/api/v1/config/viewers", "/api/v1/sessions", "/api/v1/caps" })
            Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.GetAsync(adminPath)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await _admin.GetAsync("/api/v1/viewer/me")).StatusCode);
        using var machine = factory.Viewer(ViewerApiFactory.ApiKey);
        Assert.Equal(HttpStatusCode.Unauthorized, (await machine.GetAsync("/api/v1/viewer/me")).StatusCode);

        var adminLogin = await anon.PostAsJsonAsync("/api/v1/auth/login", new { username = "sep-viewer", password = Password });
        Assert.Equal(HttpStatusCode.Unauthorized, adminLogin.StatusCode);
        var viewerLoginWithAdmin = await ViewerApi.LoginAsync(anon, TestAuth.AdminUsername, TestAuth.AdminPassword);
        Assert.Equal(HttpStatusCode.Unauthorized, viewerLoginWithAdmin.StatusCode);

        var me = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");
        Assert.Equal("viewer", me.GetProperty("accountType").GetString());
    }

    [Fact]
    public async Task Generated_Password_Forces_A_Change_Before_Anything_Else()
    {
        var created = await ViewerApi.CreateAsync(_admin, new { username = "gen-viewer", displayName = "Gen" });
        var generated = created.GetProperty("generatedPassword").GetString()!;
        Assert.True(created.GetProperty("viewer").GetProperty("mustChangePassword").GetBoolean());

        using var anon = factory.CreateClient();
        var first = await ViewerApi.AccessTokenAsync(anon, "gen-viewer", generated);
        var second = await ViewerApi.AccessTokenAsync(anon, "gen-viewer", generated);
        using var viewer = factory.Viewer(first);
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);
        var blocked = await viewer.GetAsync("/api/v1/viewer/watch/resume");
        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
        Assert.Equal("password_change_required", await ViewerApi.ErrorCodeAsync(blocked));

        var change = await viewer.PostAsJsonAsync("/api/v1/viewer/me/password", new { currentPassword = generated, newPassword = Password });
        Assert.Equal(HttpStatusCode.NoContent, change.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/watch/resume")).StatusCode);
        using var other = factory.Viewer(second);
        Assert.Equal(HttpStatusCode.Unauthorized, (await other.GetAsync("/api/v1/viewer/me")).StatusCode);
    }

    [Fact]
    public async Task Repeated_Failures_Lock_The_Account_Until_Unlocked()
    {
        var id = await NewViewerAsync("lock-viewer");
        using var anon = factory.CreateClient();
        for (var i = 0; i < 3; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, (await ViewerApi.LoginAsync(anon, "lock-viewer", "wrong password!")).StatusCode);

        var locked = await ViewerApi.LoginAsync(anon, "lock-viewer", Password);
        Assert.Equal((HttpStatusCode)423, locked.StatusCode);
        Assert.Equal("account_locked", await ViewerApi.ErrorCodeAsync(locked));
        var detail = await _admin.GetFromJsonAsync<JsonElement>($"/api/v1/config/viewers/{id}");
        Assert.NotEqual(JsonValueKind.Null, detail.GetProperty("lockedUntil").ValueKind);

        await _admin.PatchAsJsonAsync($"/api/v1/config/viewers/{id}", new { unlock = true });
        await ViewerApi.SignInAsync(anon, "lock-viewer", Password);
    }

    [Fact]
    public async Task Unknown_Users_Get_The_Same_Answer_As_Wrong_Passwords()
    {
        using var anon = factory.CreateClient();
        var response = await ViewerApi.LoginAsync(anon, "nobody-here", Password);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("invalid_credentials", await ViewerApi.ErrorCodeAsync(response));
    }

    [Fact]
    public async Task Disabling_A_Viewer_Ends_Its_Sessions()
    {
        var id = await NewViewerAsync("off-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "off-viewer", Password));
        await _admin.PatchAsJsonAsync($"/api/v1/config/viewers/{id}", new { disabled = true });
        Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);
        var login = await ViewerApi.LoginAsync(anon, "off-viewer", Password);
        Assert.Equal(HttpStatusCode.Forbidden, login.StatusCode);
        Assert.Equal("account_disabled", await ViewerApi.ErrorCodeAsync(login));
    }

    [Fact]
    public async Task Refresh_Rotates_Tokens_And_Detects_Reuse()
    {
        await NewViewerAsync("refresh-viewer");
        using var anon = factory.CreateClient();
        var session = await ViewerApi.SignInAsync(anon, "refresh-viewer", Password);
        var firstAccess = session.GetProperty("accessToken").GetString()!;
        var firstRefresh = session.GetProperty("refreshToken").GetString()!;

        var rotated = await (await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = firstRefresh }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var secondAccess = rotated.GetProperty("accessToken").GetString()!;
        Assert.NotEqual(firstAccess, secondAccess);
        using (var stale = factory.Viewer(firstAccess))
            Assert.Equal(HttpStatusCode.Unauthorized, (await stale.GetAsync("/api/v1/viewer/me")).StatusCode);

        var raced = await (await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = firstRefresh }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(secondAccess, raced.GetProperty("accessToken").GetString());

        using (var current = factory.Viewer(secondAccess))
            Assert.Equal(HttpStatusCode.OK, (await current.GetAsync("/api/v1/viewer/me")).StatusCode);
        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        var reused = await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = firstRefresh });
        Assert.Equal(HttpStatusCode.Unauthorized, reused.StatusCode);
        Assert.Equal("refresh_token_reused", await ViewerApi.ErrorCodeAsync(reused));
        using var revoked = factory.Viewer(secondAccess);
        Assert.Equal(HttpStatusCode.Unauthorized, (await revoked.GetAsync("/api/v1/viewer/me")).StatusCode);
    }

    private static async Task<HttpResponseMessage> RefreshAsync(HttpClient anon, string refreshToken)
        => await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken });

    private static async Task<(string Access, string Refresh)> PairAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return (body.GetProperty("accessToken").GetString()!, body.GetProperty("refreshToken").GetString()!);
    }

    [Fact]
    public async Task Refresh_After_An_App_Kill_Replays_The_Unused_Rotation_And_Reuse_After_Use_Revokes()
    {
        await NewViewerAsync("kill-viewer");
        using var anon = factory.CreateClient();
        var first = (await ViewerApi.SignInAsync(anon, "kill-viewer", Password)).GetProperty("refreshToken").GetString()!;

        var rotated = await PairAsync(await RefreshAsync(anon, first));
        factory.Clock.Advance(TimeSpan.FromMinutes(10));
        Assert.Equal(rotated, await PairAsync(await RefreshAsync(anon, first)));
        factory.Clock.Advance(TimeSpan.FromHours(30));
        var late = await PairAsync(await RefreshAsync(anon, first));
        Assert.Equal(rotated.Refresh, late.Refresh);
        Assert.NotEqual(rotated.Access, late.Access);
        Assert.Equal(late, await PairAsync(await RefreshAsync(anon, first)));
        rotated = late;

        using (var app = factory.Viewer(rotated.Access))
            Assert.Equal(HttpStatusCode.OK, (await app.GetAsync("/api/v1/viewer/me")).StatusCode);
        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        var reused = await RefreshAsync(anon, first);
        Assert.Equal(HttpStatusCode.Unauthorized, reused.StatusCode);
        Assert.Equal("refresh_token_reused", await ViewerApi.ErrorCodeAsync(reused));
        using var revoked = factory.Viewer(rotated.Access);
        Assert.Equal(HttpStatusCode.Unauthorized, (await revoked.GetAsync("/api/v1/viewer/me")).StatusCode);
    }

    [Fact]
    public async Task Refresh_Presenting_The_Rotated_Token_Confirms_It_And_Older_Tokens_Revoke()
    {
        await NewViewerAsync("older-viewer");
        using var anon = factory.CreateClient();
        var first = (await ViewerApi.SignInAsync(anon, "older-viewer", Password)).GetProperty("refreshToken").GetString()!;
        var second = await PairAsync(await RefreshAsync(anon, first));
        factory.Clock.Advance(TimeSpan.FromMinutes(5));
        var third = await PairAsync(await RefreshAsync(anon, second.Refresh));
        factory.Clock.Advance(TimeSpan.FromMinutes(5));

        Assert.Equal(third, await PairAsync(await RefreshAsync(anon, second.Refresh)));
        var older = await RefreshAsync(anon, first);
        Assert.Equal(HttpStatusCode.Unauthorized, older.StatusCode);
        Assert.Equal("refresh_token_reused", await ViewerApi.ErrorCodeAsync(older));
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(anon, third.Refresh)).StatusCode);
    }

    [Fact]
    public async Task Refresh_Replay_Ends_With_The_Lifetime_Of_The_Previous_Token()
    {
        await NewViewerAsync("expiry-viewer");
        using var anon = factory.CreateClient();
        var first = (await ViewerApi.SignInAsync(anon, "expiry-viewer", Password)).GetProperty("refreshToken").GetString()!;
        factory.Clock.Advance(TimeSpan.FromDays(29));
        var rotated = await PairAsync(await RefreshAsync(anon, first));
        factory.Clock.Advance(TimeSpan.FromDays(1) + TimeSpan.FromMinutes(1));

        var late = await RefreshAsync(anon, first);
        Assert.Equal(HttpStatusCode.Unauthorized, late.StatusCode);
        Assert.Equal("refresh_token_reused", await ViewerApi.ErrorCodeAsync(late));
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(anon, rotated.Refresh)).StatusCode);
    }

    [Fact]
    public async Task Concurrent_Refreshes_With_One_Token_Get_One_Rotation()
    {
        await NewViewerAsync("race-viewer");
        using var anon = factory.CreateClient();
        var first = (await ViewerApi.SignInAsync(anon, "race-viewer", Password)).GetProperty("refreshToken").GetString()!;
        using var start = new ManualResetEventSlim();
        var racers = Enumerable.Range(0, 12).Select(_ => Task.Run(async () =>
        {
            using var client = factory.CreateClient();
            start.Wait();
            return await PairAsync(await RefreshAsync(client, first));
        })).ToList();
        start.Set();
        var pairs = await Task.WhenAll(racers);
        Assert.Single(pairs.Distinct());
        using var app = factory.Viewer(pairs[0].Access);
        Assert.Equal(HttpStatusCode.OK, (await app.GetAsync("/api/v1/viewer/me")).StatusCode);
    }

    [Fact]
    public async Task Logout_Revokes_The_Session_And_Devices_Can_Be_Listed()
    {
        await NewViewerAsync("device-viewer");
        using var anon = factory.CreateClient();
        var phone = await ViewerApi.SignInAsync(anon, "device-viewer", Password);
        var tv = await ViewerApi.SignInAsync(anon, "device-viewer", Password);
        using var viewer = factory.Viewer(phone.GetProperty("accessToken").GetString()!);

        var devices = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me/sessions");
        Assert.Equal(2, devices.GetArrayLength());
        Assert.Single(devices.EnumerateArray(), d => d.GetProperty("current").GetBoolean());

        var revokeTv = await viewer.DeleteAsync($"/api/v1/viewer/me/sessions/{tv.GetProperty("sessionId").GetString()}");
        Assert.Equal(HttpStatusCode.NoContent, revokeTv.StatusCode);
        using (var tvClient = factory.Viewer(tv.GetProperty("accessToken").GetString()!))
            Assert.Equal(HttpStatusCode.Unauthorized, (await tvClient.GetAsync("/api/v1/viewer/me")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await viewer.PostAsJsonAsync("/api/v1/viewer/auth/logout", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);
        var refresh = await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = phone.GetProperty("refreshToken").GetString() });
        Assert.Equal(HttpStatusCode.Unauthorized, refresh.StatusCode);
    }

    [Fact]
    public async Task Authenticator_Two_Factor_Flow_With_Recovery_Codes()
    {
        await NewViewerAsync("totp-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "totp-viewer", Password));

        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/setup", new { currentPassword = "nope" })).StatusCode);
        var setup = await (await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/setup", new { currentPassword = Password }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var secret = setup.GetProperty("secret").GetString()!;
        Assert.StartsWith("otpauth://totp/", setup.GetProperty("otpAuthUri").GetString());

        var enable = await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/enable", new { code = ViewerApi.Totp(secret, factory.Clock.GetUtcNow()) });
        Assert.Equal(HttpStatusCode.OK, enable.StatusCode);
        var recovery = (await enable.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("recoveryCodes")
            .EnumerateArray().Select(c => c.GetString()!).ToList();
        Assert.Equal(10, recovery.Count);

        var challenge = await (await ViewerApi.LoginAsync(anon, "totp-viewer", Password)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("mfa_required", challenge.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, challenge.GetProperty("session").ValueKind);
        var mfaToken = challenge.GetProperty("mfaToken").GetString()!;

        var replay = await anon.PostAsJsonAsync("/api/v1/viewer/auth/login/second-factor", new { mfaToken, code = ViewerApi.Totp(secret, factory.Clock.GetUtcNow()) });
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);

        factory.Clock.Advance(TimeSpan.FromSeconds(30));
        var ok = await anon.PostAsJsonAsync("/api/v1/viewer/auth/login/second-factor", new { mfaToken, code = ViewerApi.Totp(secret, factory.Clock.GetUtcNow()) });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var okBody = await ok.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("authenticated", okBody.GetProperty("status").GetString());
        using (var unnamed = factory.Viewer(okBody.GetProperty("session").GetProperty("accessToken").GetString()!))
        {
            var current = (await unnamed.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me/sessions"))
                .EnumerateArray().Single(d => d.GetProperty("current").GetBoolean());
            Assert.Equal(JsonValueKind.Null, current.GetProperty("deviceName").ValueKind);
        }

        var second = (await (await ViewerApi.LoginAsync(anon, "totp-viewer", Password)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("mfaToken").GetString();
        var viaRecovery = await anon.PostAsJsonAsync("/api/v1/viewer/auth/login/second-factor", new { mfaToken = second, code = recovery[0].ToUpperInvariant() });
        Assert.Equal(HttpStatusCode.OK, viaRecovery.StatusCode);
        var profile = (await viaRecovery.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("viewer");
        Assert.Equal(9, profile.GetProperty("recoveryCodesRemaining").GetInt32());

        var third = (await (await ViewerApi.LoginAsync(anon, "totp-viewer", Password)).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("mfaToken").GetString();
        var reusedRecovery = await anon.PostAsJsonAsync("/api/v1/viewer/auth/login/second-factor", new { mfaToken = third, code = recovery[0] });
        Assert.Equal(HttpStatusCode.Unauthorized, reusedRecovery.StatusCode);
    }

    [Fact]
    public async Task Admin_Can_Reset_A_Lost_Authenticator()
    {
        var id = await NewViewerAsync("reset2fa-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "reset2fa-viewer", Password));
        var secret = (await (await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/setup", new { currentPassword = Password }))
            .Content.ReadFromJsonAsync<JsonElement>()).GetProperty("secret").GetString()!;
        await viewer.PostAsJsonAsync("/api/v1/viewer/me/two-factor/enable", new { code = ViewerApi.Totp(secret, factory.Clock.GetUtcNow()) });

        Assert.Equal(HttpStatusCode.NoContent, (await _admin.PostAsync($"/api/v1/config/viewers/{id}/two-factor/reset", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);
        await ViewerApi.SignInAsync(anon, "reset2fa-viewer", Password);
    }

    [Fact]
    public async Task Password_Reset_By_Email_Code()
    {
        await NewViewerAsync("reset-viewer", email: "reset@example.com");
        using var anon = factory.CreateClient();
        using var before = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "reset-viewer", Password));

        Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/forgot", new { login = "reset@example.com" })).StatusCode);
        var code = await LatestCodeAsync("password_reset");
        Assert.NotEmpty(code);

        var weak = await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/reset", new { login = "reset@example.com", code, newPassword = "short" });
        Assert.Equal("invalid_password", await ViewerApi.ErrorCodeAsync(weak));
        var wrong = await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/reset", new { login = "reset@example.com", code = "ZZZZ-ZZZZ", newPassword = "a brand new secret" });
        Assert.Equal("invalid_code", await ViewerApi.ErrorCodeAsync(wrong));

        var reset = await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/reset", new { login = "reset@example.com", code, newPassword = "a brand new secret" });
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await before.GetAsync("/api/v1/viewer/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await ViewerApi.LoginAsync(anon, "reset-viewer", Password)).StatusCode);
        await ViewerApi.SignInAsync(anon, "reset-viewer", "a brand new secret");

        var replay = await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/reset", new { login = "reset@example.com", code, newPassword = "yet another secret" });
        Assert.Equal("invalid_code", await ViewerApi.ErrorCodeAsync(replay));
    }

    [Fact]
    public async Task Code_Requests_For_Unknown_Accounts_Look_Identical()
    {
        using var anon = factory.CreateClient();
        await _admin.DeleteAsync("/api/v1/config/viewers/outbox");
        var response = await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/forgot", new { login = "ghost@example.com" });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var login = await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "ghost" });
        Assert.Equal(HttpStatusCode.Accepted, login.StatusCode);
        var outbox = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/outbox");
        Assert.DoesNotContain(outbox.EnumerateArray(), m => m.GetProperty("to").GetString()!.StartsWith("ghost", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Email_Code_Login_And_Wrong_Codes_Burn_Out()
    {
        await NewViewerAsync("code-viewer", email: "code@example.com");
        using var anon = factory.CreateClient();
        await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "code-viewer" });
        var code = await LatestCodeAsync("login_code");

        for (var i = 0; i < 5; i++)
        {
            var wrong = await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code/verify", new { login = "code-viewer", code = "ZZZZ-ZZZZ" });
            Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);
        }
        var burned = await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code/verify", new { login = "code-viewer", code });
        Assert.Equal(HttpStatusCode.Unauthorized, burned.StatusCode);

        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "code@example.com" });
        var fresh = await LatestCodeAsync("login_code");
        var ok = await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code/verify", new { login = "code@example.com", code = fresh.ToLowerInvariant() });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
    }

    [Fact]
    public async Task Viewer_Changes_Email_With_Verification()
    {
        var id = await NewViewerAsync("mail-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "mail-viewer", Password));

        var request = await viewer.PostAsJsonAsync("/api/v1/viewer/me/email", new { email = "new@example.com", currentPassword = Password });
        Assert.True((await request.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("verificationSent").GetBoolean());
        var pending = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");
        Assert.Equal("new@example.com", pending.GetProperty("pendingEmail").GetString());
        Assert.Equal(JsonValueKind.Null, pending.GetProperty("email").ValueKind);

        var verified = await viewer.PostAsJsonAsync("/api/v1/viewer/me/email/verify", new { code = await LatestCodeAsync("email_verification") });
        var profile = await verified.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("new@example.com", profile.GetProperty("email").GetString());
        Assert.True(profile.GetProperty("emailVerified").GetBoolean());

        await NewViewerAsync("mail-viewer2");
        var dup = await ViewerApi.CreateAsyncRaw(_admin, new { username = "mail-viewer3", password = Password, email = "NEW@example.com" });
        Assert.Equal(HttpStatusCode.Conflict, dup.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _admin.GetAsync($"/api/v1/config/viewers/{id}")).StatusCode);
    }

    private async Task<JsonElement> LatestMailAsync(string kind, string to)
    {
        var outbox = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/outbox");
        return outbox.EnumerateArray().First(m => m.GetProperty("kind").GetString() == kind && m.GetProperty("to").GetString() == to);
    }

    private static async Task AssertCooldownAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error");
        Assert.Equal("email_code_cooldown", error.GetProperty("code").GetString());
        var seconds = error.GetProperty("retryAfterSeconds").GetInt32();
        Assert.InRange(seconds, 1, 30);
        Assert.Equal(seconds.ToString(System.Globalization.CultureInfo.InvariantCulture), error.GetProperty("params").GetProperty("retryAfterSeconds").GetString());
        Assert.Equal(seconds.ToString(System.Globalization.CultureInfo.InvariantCulture), response.Headers.GetValues("Retry-After").Single());
    }

    private async Task<int> OutboxCountAsync(string to)
        => (await _admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/outbox")).EnumerateArray()
            .Count(m => m.GetProperty("to").GetString() == to);

    [Fact]
    public async Task Email_Change_Inside_The_Cooldown_Answers_429_Without_A_Mail()
    {
        await NewViewerAsync("cool-change");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "cool-change", Password));

        var first = await viewer.PostAsJsonAsync("/api/v1/viewer/me/email", new { email = "cool1@example.com", currentPassword = Password });
        Assert.True((await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("verificationSent").GetBoolean());
        factory.Clock.Advance(TimeSpan.FromSeconds(10));
        var again = await viewer.PostAsJsonAsync("/api/v1/viewer/me/email", new { email = "cool2@example.com", currentPassword = Password });
        await AssertCooldownAsync(again);
        Assert.Equal(0, await OutboxCountAsync("cool2@example.com"));
        Assert.Equal("cool1@example.com", (await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me")).GetProperty("pendingEmail").GetString());

        factory.Clock.Advance(TimeSpan.FromSeconds(21));
        var later = await viewer.PostAsJsonAsync("/api/v1/viewer/me/email", new { email = "cool2@example.com", currentPassword = Password });
        Assert.True((await later.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("verificationSent").GetBoolean());
        Assert.Equal(1, await OutboxCountAsync("cool2@example.com"));
    }

    [Fact]
    public async Task Sign_In_Code_Inside_The_Cooldown_Answers_429_For_Known_And_Unknown_Logins()
    {
        await NewViewerAsync("cool-login", email: "cool-login@example.com");
        using var anon = factory.CreateClient();

        Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "cool-login" })).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "cool-ghost" })).StatusCode);
        factory.Clock.Advance(TimeSpan.FromSeconds(5));
        await AssertCooldownAsync(await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "COOL-LOGIN " }));
        await AssertCooldownAsync(await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "cool-ghost" }));
        Assert.Equal(1, await OutboxCountAsync("cool-login@example.com"));

        // the same account by its address: answered like a first send (no link between the aliases), still no second mail
        var alias = await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "cool-login@example.com" });
        Assert.Equal(HttpStatusCode.Accepted, alias.StatusCode);
        Assert.False(alias.Headers.Contains("Retry-After"));
        Assert.Equal(1, await OutboxCountAsync("cool-login@example.com"));
        await AssertCooldownAsync(await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "cool-login@example.com" }));

        factory.Clock.Advance(TimeSpan.FromSeconds(26));
        Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = "cool-login" })).StatusCode);
        Assert.Equal(2, await OutboxCountAsync("cool-login@example.com"));
    }

    [Fact]
    public async Task Sign_In_Code_Aliases_Answer_Alike_And_Share_The_Mail_Limit()
    {
        await NewViewerAsync("alias-login", email: "alias-login@example.com");
        using var anon = factory.CreateClient();
        string[] aliases = ["alias-login", "alias-login@example.com"];

        Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = aliases[0] })).StatusCode);
        var code = await LatestCodeAsync("login_code");
        factory.Clock.Advance(TimeSpan.FromSeconds(16));
        var alias = await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = aliases[1] });
        Assert.Equal(HttpStatusCode.Accepted, alias.StatusCode);
        Assert.Equal(1, await OutboxCountAsync("alias-login@example.com"));
        Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code/verify", new { login = aliases[1], code })).StatusCode);

        // alternating aliases every 31 s: always a plain 202, but the account still gets at most 5 mails per hour
        for (var i = 1; i <= 8; i++)
        {
            factory.Clock.Advance(TimeSpan.FromSeconds(31));
            Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = aliases[i % 2] })).StatusCode);
        }
        Assert.Equal(5, await OutboxCountAsync("alias-login@example.com"));
    }

    [Fact]
    public async Task Password_Forgot_Stays_Generic_Inside_The_Cooldown()
    {
        await NewViewerAsync("cool-forgot", email: "cool-forgot@example.com");
        using var anon = factory.CreateClient();

        for (var i = 0; i < 3; i++)
            Assert.Equal(HttpStatusCode.Accepted, (await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/forgot", new { login = "cool-forgot" })).StatusCode);
        Assert.Equal(1, await OutboxCountAsync("cool-forgot@example.com"));
    }

    [Theory]
    [InlineData("de-DE,de;q=0.9", "de")]
    [InlineData("en-US", "en")]
    [InlineData("fr-FR", "en")]
    [InlineData(null, "en")]
    public async Task Viewer_Emails_Follow_The_Request_Language(string? acceptLanguage, string expected)
    {
        var tag = acceptLanguage is null ? "none" : acceptLanguage[..2];
        var name = $"lang-{tag}";
        var address = $"{name}@example.com";
        await NewViewerAsync(name, email: address);
        using var anon = factory.CreateClient();
        if (acceptLanguage is not null)
            anon.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", acceptLanguage);

        await anon.PostAsJsonAsync("/api/v1/viewer/auth/email-code", new { login = name });
        await anon.PostAsJsonAsync("/api/v1/viewer/auth/password/forgot", new { login = name });
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, name, Password));
        if (acceptLanguage is not null)
            viewer.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", acceptLanguage);
        Assert.Equal(HttpStatusCode.OK, (await viewer.PostAsJsonAsync("/api/v1/viewer/me/email", new { email = $"new-{address}", currentPassword = Password })).StatusCode);

        var login = await LatestMailAsync("login_code", address);
        var reset = await LatestMailAsync("password_reset", address);
        var verify = await LatestMailAsync("email_verification", $"new-{address}");
        string[] subjects = [login.GetProperty("subject").GetString()!, reset.GetProperty("subject").GetString()!, verify.GetProperty("subject").GetString()!];
        string[] texts = [login.GetProperty("text").GetString()!, reset.GetProperty("text").GetString()!, verify.GetProperty("text").GetString()!];
        if (expected == "de")
        {
            Assert.Contains("Anmeldecode", subjects[0], StringComparison.Ordinal);
            Assert.Contains("Passwort zurücksetzen", subjects[1], StringComparison.Ordinal);
            Assert.Contains("Bestätige deine E-Mail-Adresse", subjects[2], StringComparison.Ordinal);
            Assert.All(texts, t => Assert.StartsWith($"Hallo {name},", t, StringComparison.Ordinal));
            Assert.All(texts, t => Assert.Contains("Minuten gültig", t, StringComparison.Ordinal));
        }
        else
        {
            Assert.Contains("sign-in code", subjects[0], StringComparison.Ordinal);
            Assert.StartsWith("Reset your", subjects[1], StringComparison.Ordinal);
            Assert.StartsWith("Confirm your email", subjects[2], StringComparison.Ordinal);
            Assert.All(texts, t => Assert.StartsWith($"Hi {name},", t, StringComparison.Ordinal));
            Assert.All(texts, t => Assert.Contains("expires in", t, StringComparison.Ordinal));
        }
        Assert.All(texts, t => Assert.Matches(CodePattern(), t));
    }

    [Fact]
    public async Task Sign_Out_Others_Keeps_The_Current_Session_And_Counts_The_Rest()
    {
        await NewViewerAsync("others-viewer");
        await NewViewerAsync("others-bystander");
        using var anon = factory.CreateClient();
        var phone = await ViewerApi.SignInAsync(anon, "others-viewer", Password);
        var tv = await ViewerApi.SignInAsync(anon, "others-viewer", Password);
        var web = await ViewerApi.SignInAsync(anon, "others-viewer", Password);
        var bystander = await ViewerApi.SignInAsync(anon, "others-bystander", Password);
        using var viewer = factory.Viewer(phone.GetProperty("accessToken").GetString()!);

        var response = await viewer.PostAsync("/api/v1/viewer/me/sessions/sign-out-others", null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(2, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("signedOut").GetInt32());

        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);
        foreach (var other in new[] { tv, web })
        {
            using var client = factory.Viewer(other.GetProperty("accessToken").GetString()!);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/viewer/me")).StatusCode);
            var refresh = await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = other.GetProperty("refreshToken").GetString() });
            Assert.Equal(HttpStatusCode.Unauthorized, refresh.StatusCode);
        }
        using (var other = factory.Viewer(bystander.GetProperty("accessToken").GetString()!))
            Assert.Equal(HttpStatusCode.OK, (await other.GetAsync("/api/v1/viewer/me")).StatusCode);
        var devices = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me/sessions");
        Assert.True(Assert.Single(devices.EnumerateArray()).GetProperty("current").GetBoolean());

        var again = await viewer.PostAsync("/api/v1/viewer/me/sessions/sign-out-others", null);
        Assert.Equal(0, (await again.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("signedOut").GetInt32());
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsync("/api/v1/viewer/me/sessions/sign-out-others", null)).StatusCode);
    }

    [Fact]
    public async Task Viewer_Edits_Display_Name_And_Avatar()
    {
        await NewViewerAsync("profile-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "profile-viewer", Password));

        var initial = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");
        Assert.Equal(JsonValueKind.Null, initial.GetProperty("avatarKey").ValueKind);

        var named = await (await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { displayName = "  Anna B.  " })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Anna B.", named.GetProperty("displayName").GetString());

        var avatar = await (await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { avatarKey = "Coral" })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(("Anna B.", "coral"), (avatar.GetProperty("displayName").GetString(), avatar.GetProperty("avatarKey").GetString()));

        var invalid = await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { avatarKey = "unicorn", displayName = "Other" });
        Assert.Equal("invalid_avatar", await ViewerApi.ErrorCodeAsync(invalid));
        var tooLong = await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { displayName = new string('x', 65) });
        Assert.Equal("invalid_display_name", await ViewerApi.ErrorCodeAsync(tooLong));
        var control = await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { displayName = "a\u0007b" });
        Assert.Equal("invalid_display_name", await ViewerApi.ErrorCodeAsync(control));
        var spaces = await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { displayName = "   " });
        Assert.Equal(HttpStatusCode.BadRequest, spaces.StatusCode);
        Assert.Equal("invalid_display_name", await ViewerApi.ErrorCodeAsync(spaces));

        await NewViewerAsync("profile-twin");
        var shared = await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { displayName = "profile-twin" });
        Assert.Equal(HttpStatusCode.OK, shared.StatusCode);

        var reset = await (await viewer.PatchAsync("/api/v1/viewer/me",
            new StringContent("""{"displayName":null,"avatarKey":null}""", System.Text.Encoding.UTF8, "application/json"))).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("profile-viewer", reset.GetProperty("displayName").GetString());
        Assert.Equal(JsonValueKind.Null, reset.GetProperty("avatarKey").ValueKind);

        await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { displayName = "Kept", avatarKey = "slate" });
        var untouched = await (await viewer.PatchAsJsonAsync("/api/v1/viewer/me", new { })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(("Kept", "slate"), (untouched.GetProperty("displayName").GetString(), untouched.GetProperty("avatarKey").GetString()));

        var listed = (await _admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers")).EnumerateArray()
            .Single(v => v.GetProperty("username").GetString() == "profile-viewer");
        Assert.Equal("slate", listed.GetProperty("avatarKey").GetString());
        var id = listed.GetProperty("id").GetString();
        Assert.Equal("slate", (await _admin.GetFromJsonAsync<JsonElement>($"/api/v1/config/viewers/{id}")).GetProperty("avatarKey").GetString());
        var twin = (await _admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers")).EnumerateArray()
            .Single(v => v.GetProperty("username").GetString() == "profile-twin");
        Assert.Equal(JsonValueKind.Null, twin.GetProperty("avatarKey").ValueKind);
    }

    [Fact]
    public async Task Progress_Resume_History_And_Played_Flags()
    {
        await NewViewerAsync("watch-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "watch-viewer", Password));
        var hour = ViewerApi.Ticks(60);

        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "start", workId = "tmdb-movie-1", positionTicks = 0, durationTicks = hour, playbackId = "pb-1" });
        var mid = await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = "tmdb-movie-1", positionTicks = hour / 2, durationTicks = hour, playbackId = "pb-1", title = "Movie One" }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(50.0, mid.GetProperty("progressPercent").GetDouble());

        var resume = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/resume");
        Assert.Equal("tmdb-movie-1", Assert.Single(resume.EnumerateArray()).GetProperty("workId").GetString());

        var done = await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "stop", workId = "tmdb-movie-1", positionTicks = hour * 95 / 100, durationTicks = hour, playbackId = "pb-1" }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(done.GetProperty("played").GetBoolean());
        Assert.Equal(1, done.GetProperty("playCount").GetInt32());
        Assert.Empty((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/resume")).EnumerateArray());

        var states = await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/state", new { workIds = new[] { "tmdb-movie-1", "tmdb-movie-2" } }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(states[0].GetProperty("played").GetBoolean());
        Assert.False(states[1].GetProperty("played").GetBoolean());

        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-movie-2" } });
        var history = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/history");
        Assert.Equal(2, history.GetProperty("total").GetInt32());

        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/unplayed", new { workIds = new[] { "tmdb-movie-1" } });
        history = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/history");
        Assert.Equal("tmdb-movie-2", Assert.Single(history.GetProperty("items").EnumerateArray()).GetProperty("workId").GetString());

        var bad = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = "tmdb-tv-100-s01", positionTicks = 1 });
        Assert.Equal("invalid_work_id", await ViewerApi.ErrorCodeAsync(bad));
        var badEvent = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "pause", workId = "tmdb-movie-1", positionTicks = 1 });
        Assert.Equal("invalid_event", await ViewerApi.ErrorCodeAsync(badEvent));
    }

    [Fact]
    public async Task Played_Episode_Leaves_Continue_Watching_And_Next_Up_Advances_Despite_Late_Reports()
    {
        await NewViewerAsync("late-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "late-viewer", Password));
        var episode = ViewerApi.Ticks(45);
        async Task Report(string kind, long position) => (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress",
            new { @event = kind, workId = "tmdb-tv-100-s01e01", positionTicks = position, durationTicks = episode, playbackId = "pb-late" })).EnsureSuccessStatusCode();

        await Report("progress", episode / 2);
        await Report("progress", episode * 92 / 100);
        await Report("progress", episode * 88 / 100);
        await Report("stop", episode * 89 / 100);

        Assert.Empty((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/resume")).EnumerateArray());
        var item = Assert.Single((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/next-up")).GetProperty("items").EnumerateArray());
        Assert.Equal("tmdb-tv-100-s01e02", item.GetProperty("workId").GetString());
        Assert.Equal(0, item.GetProperty("positionTicks").GetInt64());
        var state = (await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/state", new { workIds = new[] { "tmdb-tv-100-s01e01" } }))
            .Content.ReadFromJsonAsync<JsonElement>())[0];
        Assert.True(state.GetProperty("played").GetBoolean());
        Assert.Equal(0, state.GetProperty("positionTicks").GetInt64());
    }

    [Fact]
    public async Task Watch_State_Is_Private_Per_Viewer()
    {
        await NewViewerAsync("private-a");
        var bId = await NewViewerAsync("private-b");
        using var anon = factory.CreateClient();
        using var a = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "private-a", Password));
        using var b = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "private-b", Password));
        await a.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-movie-3" } });

        Assert.Equal(0, (await b.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/history")).GetProperty("total").GetInt32());
        var adminView = await _admin.GetFromJsonAsync<JsonElement>($"/api/v1/config/viewers/{bId}/watch-state");
        Assert.Equal(0, adminView.GetProperty("total").GetInt32());
    }

    [Fact]
    public async Task Next_Up_Follows_The_Catalog_And_Skips_Unaired_Episodes()
    {
        await NewViewerAsync("nextup-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "nextup-viewer", Password));
        var episode = ViewerApi.Ticks(45);

        Assert.Empty((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/next-up")).GetProperty("items").EnumerateArray());

        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "stop", workId = "tmdb-tv-100-s01e01", positionTicks = episode, durationTicks = episode });
        var next = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/next-up");
        var item = Assert.Single(next.GetProperty("items").EnumerateArray());
        Assert.Equal("tmdb-tv-100-s01e02", item.GetProperty("workId").GetString());
        Assert.Equal("Test Show", item.GetProperty("seriesTitle").GetString());
        Assert.Equal("tmdb-tv-100-s01e01", item.GetProperty("lastWatchedWorkId").GetString());

        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = "tmdb-tv-100-s01e02", positionTicks = episode / 2, durationTicks = episode });
        item = Assert.Single((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/next-up")).GetProperty("items").EnumerateArray());
        Assert.Equal(episode / 2, item.GetProperty("positionTicks").GetInt64());

        var season = await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-tv-100-s01" } }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(3, season.GetProperty("workIds").GetArrayLength());
        var titled = await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/state", new { workIds = new[] { "tmdb-tv-100-s01e03" } }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Test Show · S01E03 · Episode 3", titled[0].GetProperty("title").GetString());
        item = Assert.Single((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/next-up")).GetProperty("items").EnumerateArray());
        Assert.Equal("tmdb-tv-100-s02e01", item.GetProperty("workId").GetString());

        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-tv-100-s02e01" } });
        Assert.Empty((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/next-up")).GetProperty("items").EnumerateArray());

        var series = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/series/tmdb-tv-100");
        Assert.Equal(4, series.GetArrayLength());

        var all = await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/unplayed", new { workIds = new[] { "tmdb-tv-100" } }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(4, all.GetProperty("workIds").GetArrayLength());
        Assert.Equal(0, (await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/series/tmdb-tv-100")).GetArrayLength());
    }

    [Fact]
    public async Task Next_Up_Reports_Catalog_Outages_As_Incomplete()
    {
        await NewViewerAsync("outage-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "outage-viewer", Password));
        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { $"tmdb-tv-{ViewerTmdbFake.BrokenSeriesId}-s01e01" } });

        var next = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/watch/next-up");
        Assert.True(next.GetProperty("incomplete").GetBoolean());
        Assert.Empty(next.GetProperty("items").EnumerateArray());

        var cleared = await (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/unplayed", new { workIds = new[] { $"tmdb-tv-{ViewerTmdbFake.BrokenSeriesId}-s01" } }))
            .Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal($"tmdb-tv-{ViewerTmdbFake.BrokenSeriesId}-s01e01", Assert.Single(cleared.GetProperty("workIds").EnumerateArray()).GetString());
        var markSeries = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { $"tmdb-tv-{ViewerTmdbFake.BrokenSeriesId}" } });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, markSeries.StatusCode);
        Assert.Equal("catalog_unavailable", await ViewerApi.ErrorCodeAsync(markSeries));
    }

    [Fact]
    public async Task Age_Limit_Is_Evaluated_Against_Tmdb_Certifications()
    {
        await NewViewerAsync("kid-viewer", permissions: new { maxAge = 12, blockUnrated = true });
        using var anon = factory.CreateClient();
        using var kid = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "kid-viewer", Password));

        async Task<JsonElement> Check(string workId) => await kid.GetFromJsonAsync<JsonElement>($"/api/v1/viewer/access/{workId}");

        var pg13 = await Check("tmdb-movie-1");
        Assert.False(pg13.GetProperty("allowed").GetBoolean());
        Assert.Equal("above_age_limit", pg13.GetProperty("reason").GetString());
        Assert.Equal(13, pg13.GetProperty("minimumAge").GetInt32());
        Assert.True((await Check("tmdb-movie-4")).GetProperty("allowed").GetBoolean());
        Assert.Equal("unrated_blocked", (await Check("tmdb-movie-3")).GetProperty("reason").GetString());
        Assert.Equal("rating_unavailable", (await Check("tmdb-movie-999")).GetProperty("reason").GetString());
        Assert.False((await Check("tmdb-tv-100-s01e01")).GetProperty("allowed").GetBoolean());
    }

    [Fact]
    public async Task Invalid_Admin_Input_Is_Rejected()
    {
        var badName = await ViewerApi.CreateAsyncRaw(_admin, new { username = "x", password = Password });
        Assert.Equal("invalid_username", await ViewerApi.ErrorCodeAsync(badName));
        var badAge = await ViewerApi.CreateAsyncRaw(_admin, new { username = "age-viewer", password = Password, permissions = new { maxAge = 13 } });
        Assert.Equal("invalid_permissions", await ViewerApi.ErrorCodeAsync(badAge));
        var weak = await ViewerApi.CreateAsyncRaw(_admin, new { username = "weak-viewer", password = "abc" });
        Assert.Equal("invalid_password", await ViewerApi.ErrorCodeAsync(weak));
        await NewViewerAsync("dupe-viewer");
        var dupe = await ViewerApi.CreateAsyncRaw(_admin, new { username = "DUPE-viewer", password = Password });
        Assert.Equal(HttpStatusCode.Conflict, dupe.StatusCode);
        var settings = await _admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { playedPercent = 10 });
        Assert.Equal(HttpStatusCode.BadRequest, settings.StatusCode);
        var mode = await _admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { email = new { mode = "pigeon" } });
        Assert.Equal("invalid_viewer_settings", await ViewerApi.ErrorCodeAsync(mode));
    }

    [Fact]
    public async Task Admin_Password_Assignment_And_Deletion()
    {
        var id = await NewViewerAsync("assign-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "assign-viewer", Password));
        var assigned = await (await _admin.PostAsJsonAsync($"/api/v1/config/viewers/{id}/password", new { mustChangePassword = false }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var generated = assigned.GetProperty("generatedPassword").GetString()!;
        Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);

        using var fresh = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "assign-viewer", generated));
        await fresh.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-movie-2" } });
        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"/api/v1/config/viewers/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await fresh.GetAsync("/api/v1/viewer/me")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _admin.GetAsync($"/api/v1/config/viewers/{id}")).StatusCode);
    }

    [Fact]
    public async Task Cookie_Mode_Keeps_Tokens_Out_Of_The_Body_And_Requires_Same_Origin()
    {
        await NewViewerAsync("cookie-viewer");
        using var browser = factory.CreateClient();
        var login = await browser.PostAsJsonAsync("/api/v1/viewer/auth/login", new { login = "cookie-viewer", password = Password, useCookies = true });
        var session = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("session");
        Assert.Equal(JsonValueKind.Null, session.GetProperty("accessToken").ValueKind);
        Assert.True(session.GetProperty("cookieMode").GetBoolean());
        Assert.Contains(login.Headers.GetValues("Set-Cookie"), c => c.StartsWith("streamarr_viewer=", StringComparison.Ordinal) && c.Contains("httponly", StringComparison.OrdinalIgnoreCase));

        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/v1/viewer/me")).StatusCode);
        var crossSite = await browser.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-movie-1" } });
        Assert.Equal(HttpStatusCode.Forbidden, crossSite.StatusCode);
        Assert.Equal("csrf_rejected", await ViewerApi.ErrorCodeAsync(crossSite));

        using var sameOrigin = new HttpRequestMessage(HttpMethod.Post, "/api/v1/viewer/watch/played")
        {
            Content = JsonContent.Create(new { workIds = new[] { "tmdb-movie-1" } }),
        };
        sameOrigin.Headers.Add("Origin", "http://localhost");
        Assert.Equal(HttpStatusCode.OK, (await browser.SendAsync(sameOrigin)).StatusCode);

        using var refresh = new HttpRequestMessage(HttpMethod.Post, "/api/v1/viewer/auth/refresh") { Content = JsonContent.Create(new { }) };
        refresh.Headers.Add("Origin", "http://localhost");
        var refreshed = await browser.SendAsync(refresh);
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);
        Assert.True((await refreshed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("cookieMode").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/api/v1/viewer/me")).StatusCode);
    }

    [Fact]
    public async Task Progress_With_A_Release_Reaches_The_Shared_Event_Stream()
    {
        await NewViewerAsync("events-viewer");
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "events-viewer", Password));
        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new
        {
            @event = "start", workId = "tmdb-movie-2", positionTicks = 0, durationTicks = ViewerApi.Ticks(90), releaseId = "rel-viewer-test", playbackId = "pb-events",
        });

        var events = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/events?limit=50");
        var forwarded = events.EnumerateArray().First(e => e.GetProperty("releaseId").GetString() == "rel-viewer-test");
        Assert.Equal("streamarr-viewer", forwarded.GetProperty("source").GetString());
        Assert.Equal("events-viewer", forwarded.GetProperty("externalUserName").GetString());
    }

    [Fact]
    public async Task Refresh_And_Logout_Accept_An_Empty_Body()
    {
        using var anon = factory.CreateClient();
        var refresh = await anon.PostAsync("/api/v1/viewer/auth/refresh", null);
        Assert.Equal(HttpStatusCode.Unauthorized, refresh.StatusCode);
        Assert.Equal("refresh_session_expired", await ViewerApi.ErrorCodeAsync(refresh));
        Assert.Equal(HttpStatusCode.NoContent, (await anon.PostAsync("/api/v1/viewer/auth/logout", null)).StatusCode);
    }

    [Fact]
    public async Task Auth_Options_Reflect_Settings()
    {
        using var anon = factory.CreateClient();
        var options = await anon.GetFromJsonAsync<JsonElement>("/api/v1/viewer/auth/options");
        Assert.True(options.GetProperty("emailCodeLogin").GetBoolean());
        Assert.True(options.GetProperty("passwordReset").GetBoolean());

        var settings = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/settings");
        Assert.True(settings.GetProperty("enabled").GetBoolean());
        Assert.Equal("outbox", settings.GetProperty("email").GetProperty("mode").GetString());
        Assert.True(settings.GetProperty("emailDeliveryReady").GetBoolean());
    }
}
