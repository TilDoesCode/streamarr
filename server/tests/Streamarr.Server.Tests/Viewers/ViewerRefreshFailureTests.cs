using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Refresh 401s say which case they are (unknown / expired / revoked with reason / reused), backed by 30-day tombstones.</summary>
public sealed class ViewerRefreshFailureTests(ViewerApiFactory factory) : IClassFixture<ViewerApiFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true, email = new { mode = "outbox" } });
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private async Task<string> NewViewerAsync(string username)
        => (await ViewerApi.CreateAsync(_admin, new { username, password = Password }))
            .GetProperty("viewer").GetProperty("id").GetString()!;

    private static async Task<(string Access, string Refresh, string SessionId)> SignInAsync(HttpClient anon, string username)
    {
        var session = await ViewerApi.SignInAsync(anon, username, Password);
        return (session.GetProperty("accessToken").GetString()!, session.GetProperty("refreshToken").GetString()!,
            session.GetProperty("sessionId").GetString()!);
    }

    private static Task<HttpResponseMessage> RefreshAsync(HttpClient anon, string refreshToken)
        => anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken });

    private static async Task<(string Code, string? Reason, JsonElement Error)> FailureAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error");
        var reason = error.TryGetProperty("params", out var p) ? p.GetProperty("reason").GetString() : null;
        return (error.GetProperty("code").GetString()!, reason, error);
    }

    private async Task AssertRevokedAsync(HttpClient anon, string refreshToken, string reason)
    {
        var (code, actual, _) = await FailureAsync(await RefreshAsync(anon, refreshToken));
        Assert.Equal("refresh_session_revoked", code);
        Assert.Equal(reason, actual);
    }

    private async Task<int> PruneAsync() => await factory.Services.GetRequiredService<ViewerSessionService>().PruneAsync(default);

    private async Task<bool> SessionRowExistsAsync(string sessionId)
    {
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync();
        return await db.ViewerSessions.AnyAsync(s => s.Id == sessionId);
    }

    [Theory]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("svr_doesNotExistAnywhere0123456789abcdefghijk")]
    [InlineData(null)]
    public async Task Unknown_Or_Garbage_Tokens_Get_Refresh_Token_Unknown_Without_Detail(string? token)
    {
        token ??= ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix);
        using var anon = factory.CreateClient();
        var (code, reason, error) = await FailureAsync(await RefreshAsync(anon, token));
        Assert.Equal("refresh_token_unknown", code);
        Assert.Null(reason);
        Assert.Equal(["code", "message"], error.EnumerateObject().Where(p => p.Value.ValueKind != JsonValueKind.Null).Select(p => p.Name).Order());
        Assert.Equal("refresh_token_unknown", (await FailureAsync(await anon.PostAsync("/api/v1/viewer/auth/refresh", null))).Code);
    }

    [Fact]
    public async Task Expired_Session_Says_Expired_Then_Via_Tombstone_Then_Unknown_After_30_Days()
    {
        await NewViewerAsync("exp-viewer");
        using var anon = factory.CreateClient();
        var (_, refresh, sessionId) = await SignInAsync(anon, "exp-viewer");
        factory.Clock.Advance(TimeSpan.FromDays(30) + TimeSpan.FromMinutes(1));

        Assert.Equal("refresh_session_expired", (await FailureAsync(await RefreshAsync(anon, refresh))).Code);
        await PruneAsync();
        Assert.False(await SessionRowExistsAsync(sessionId));
        Assert.Equal("refresh_session_expired", (await FailureAsync(await RefreshAsync(anon, refresh))).Code);

        factory.Clock.Advance(TimeSpan.FromDays(30));
        await PruneAsync();
        Assert.Equal("refresh_token_unknown", (await FailureAsync(await RefreshAsync(anon, refresh))).Code);
    }

    [Fact]
    public async Task Revoked_Sessions_Carry_Their_Reason_And_Keep_It_As_Tombstones_For_30_Days()
    {
        var id = await NewViewerAsync("rev-viewer");
        using var anon = factory.CreateClient();

        var logout = await SignInAsync(anon, "rev-viewer");
        await anon.PostAsJsonAsync("/api/v1/viewer/auth/logout", new { refreshToken = logout.Refresh });

        var byViewer = await SignInAsync(anon, "rev-viewer");
        var others = await SignInAsync(anon, "rev-viewer");
        var keeper = await SignInAsync(anon, "rev-viewer");
        using (var me = factory.Viewer(keeper.Access))
        {
            Assert.Equal(HttpStatusCode.NoContent, (await me.DeleteAsync($"/api/v1/viewer/me/sessions/{byViewer.SessionId}")).StatusCode);
            Assert.True((await me.PostAsync("/api/v1/viewer/me/sessions/sign-out-others", null)).IsSuccessStatusCode);
        }

        var changed = await SignInAsync(anon, "rev-viewer");
        using (var me = factory.Viewer(keeper.Access))
        {
            var response = await me.PostAsJsonAsync("/api/v1/viewer/me/password", new { currentPassword = Password, newPassword = "another horse battery" });
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        }
        await _admin.PostAsJsonAsync($"/api/v1/config/viewers/{id}/password", new { password = Password, mustChangePassword = false });

        await AssertRevokedAsync(anon, logout.Refresh, "signed_out");
        await AssertRevokedAsync(anon, byViewer.Refresh, "revoked_by_viewer");
        await AssertRevokedAsync(anon, others.Refresh, "revoked_by_viewer");
        await AssertRevokedAsync(anon, changed.Refresh, "password_changed");
        await AssertRevokedAsync(anon, keeper.Refresh, "admin");

        var admin = await SignInAsync(anon, "rev-viewer");
        await _admin.DeleteAsync($"/api/v1/config/viewers/{id}/sessions/{admin.SessionId}");
        await AssertRevokedAsync(anon, admin.Refresh, "admin");
        var disabled = await SignInAsync(anon, "rev-viewer");
        await _admin.PatchAsJsonAsync($"/api/v1/config/viewers/{id}", new { disabled = true });
        await AssertRevokedAsync(anon, disabled.Refresh, "account_disabled");

        factory.Clock.Advance(TimeSpan.FromDays(1) + TimeSpan.FromMinutes(1));
        Assert.True(await PruneAsync() >= 7);
        Assert.False(await SessionRowExistsAsync(logout.SessionId));
        await AssertRevokedAsync(anon, logout.Refresh, "signed_out");
        await AssertRevokedAsync(anon, byViewer.Refresh, "revoked_by_viewer");
        await AssertRevokedAsync(anon, changed.Refresh, "password_changed");
        await AssertRevokedAsync(anon, keeper.Refresh, "admin");
        await AssertRevokedAsync(anon, disabled.Refresh, "account_disabled");

        factory.Clock.Advance(TimeSpan.FromDays(29) - TimeSpan.FromMinutes(2));
        await PruneAsync();
        await AssertRevokedAsync(anon, logout.Refresh, "signed_out");
        factory.Clock.Advance(TimeSpan.FromMinutes(2));
        await PruneAsync();
        Assert.Equal("refresh_token_unknown", (await FailureAsync(await RefreshAsync(anon, logout.Refresh))).Code);
        Assert.Equal("refresh_token_unknown", (await FailureAsync(await RefreshAsync(anon, disabled.Refresh))).Code);
    }

    [Fact]
    public async Task The_Twenty_First_Sign_In_Evicts_The_Oldest_Session_As_Session_Limit()
    {
        await NewViewerAsync("limit-viewer");
        using var anon = factory.CreateClient();
        var first = await SignInAsync(anon, "limit-viewer");
        for (var i = 0; i < 20; i++)
        {
            factory.Clock.Advance(TimeSpan.FromSeconds(1));
            await SignInAsync(anon, "limit-viewer");
        }
        await AssertRevokedAsync(anon, first.Refresh, "session_limit");
    }

    [Fact]
    public async Task Old_Tokens_Of_A_Reuse_Revoked_Session_Say_Token_Reused_Even_After_Deletion()
    {
        await NewViewerAsync("reuse-viewer");
        using var anon = factory.CreateClient();
        var (_, first, sessionId) = await SignInAsync(anon, "reuse-viewer");
        var rotated = (await (await RefreshAsync(anon, first)).Content.ReadFromJsonAsync<JsonElement>());
        var second = rotated.GetProperty("refreshToken").GetString()!;
        Assert.Equal(second, (await (await RefreshAsync(anon, first)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refreshToken").GetString());
        using (var app = factory.Viewer(rotated.GetProperty("accessToken").GetString()!))
            Assert.Equal(HttpStatusCode.OK, (await app.GetAsync("/api/v1/viewer/me")).StatusCode);
        factory.Clock.Advance(TimeSpan.FromSeconds(31));

        Assert.Equal("refresh_token_reused", (await FailureAsync(await RefreshAsync(anon, first))).Code);
        await AssertRevokedAsync(anon, second, "token_reused");
        await AssertRevokedAsync(anon, first, "token_reused");

        factory.Clock.Advance(TimeSpan.FromDays(2));
        await PruneAsync();
        Assert.False(await SessionRowExistsAsync(sessionId));
        await AssertRevokedAsync(anon, second, "token_reused");
        await AssertRevokedAsync(anon, first, "token_reused");
    }

    [Fact]
    public async Task Deleting_An_Account_Leaves_Tombstones_That_Say_Admin()
    {
        var id = await NewViewerAsync("gone-viewer");
        using var anon = factory.CreateClient();
        var (_, refresh, _) = await SignInAsync(anon, "gone-viewer");
        Assert.Equal(HttpStatusCode.NoContent, (await _admin.DeleteAsync($"/api/v1/config/viewers/{id}")).StatusCode);
        await AssertRevokedAsync(anon, refresh, "admin");
    }
}

[CollectionDefinition("viewer-refresh-logs", DisableParallelization = true)]
public sealed class ViewerRefreshLogCollection;

/// <summary>Serial: the shared Serilog logger writes to the host built last, so the log feed is only reliable without parallel hosts.</summary>
[Collection("viewer-refresh-logs")]
public sealed class ViewerRefreshLogTests(ViewerApiFactory factory) : IClassFixture<ViewerApiFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true, email = new { mode = "outbox" } });
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private async Task<string> NewViewerAsync(string username)
        => (await ViewerApi.CreateAsync(_admin, new { username, password = Password }))
            .GetProperty("viewer").GetProperty("id").GetString()!;

    private static async Task<(string Access, string Refresh, string SessionId)> SignInAsync(HttpClient anon, string username)
    {
        var session = await ViewerApi.SignInAsync(anon, username, Password);
        return (session.GetProperty("accessToken").GetString()!, session.GetProperty("refreshToken").GetString()!,
            session.GetProperty("sessionId").GetString()!);
    }

    private static Task<HttpResponseMessage> RefreshAsync(HttpClient anon, string refreshToken)
        => anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken });

    [Fact]
    public async Task Refresh_Failures_Are_Logged_With_Case_And_Ids_But_No_Token_Material()
    {
        var viewerId = await NewViewerAsync("log-viewer");
        using var anon = factory.CreateClient();
        var (_, refresh, sessionId) = await SignInAsync(anon, "log-viewer");
        await anon.PostAsJsonAsync("/api/v1/viewer/auth/logout", new { refreshToken = refresh });
        await RefreshAsync(anon, refresh);
        var garbage = ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix);
        await RefreshAsync(anon, garbage);

        var logs = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/logs?source=core&search=Viewer%20refresh%20refused&limit=500");
        var lines = logs.GetProperty("entries").EnumerateArray()
            .Select(e => (Level: e.GetProperty("level").GetString(), Message: e.GetProperty("message").GetString()!)).ToList();
        Assert.Contains(lines, l => l.Level == "information" && l.Message.Contains("Revoked") && l.Message.Contains("signed_out")
            && l.Message.Contains(sessionId) && l.Message.Contains(viewerId));
        Assert.Contains(lines, l => l.Level == "information" && l.Message.Contains("Unknown") && l.Message.Contains("no_match"));
        foreach (var token in new[] { refresh, garbage })
        {
            Assert.DoesNotContain(lines, l => l.Message.Contains(token) || l.Message.Contains(ViewerAuth.Hash(token)) || l.Message.Contains(ViewerAuth.Hash(token)[..12]));
        }
        Assert.DoesNotContain(lines, l => l.Message.Contains("svr_"));
    }
}
