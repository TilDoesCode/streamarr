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

        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        var reused = await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = firstRefresh });
        Assert.Equal(HttpStatusCode.Unauthorized, reused.StatusCode);
        Assert.Equal("refresh_token_reused", await ViewerApi.ErrorCodeAsync(reused));
        using var revoked = factory.Viewer(secondAccess);
        Assert.Equal(HttpStatusCode.Unauthorized, (await revoked.GetAsync("/api/v1/viewer/me")).StatusCode);
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
        Assert.Equal("authenticated", (await ok.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());

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
