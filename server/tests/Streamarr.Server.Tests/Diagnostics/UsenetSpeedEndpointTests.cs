using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Server.Contracts;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>The Usenet speed test endpoints: viewer permission, redaction and the shared result.</summary>
public sealed class UsenetSpeedEndpointTests(DiagnosticsFactory factory) : IClassFixture<DiagnosticsFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private async Task<HttpClient> ViewerAsync(bool? allowed)
    {
        await factory.SeedAsync();
        factory.GoodNntp.Articles.TryAdd("speed@endpoint", YencTestEncoder.Encode(YencTestEncoder.LcgBytes(3, 256 * 1024), "speed.bin"));
        using var admin = await factory.AdminAsync();
        var username = $"us-{Guid.NewGuid():N}"[..20];
        await ViewerApi.CreateAsync(admin, allowed is null
            ? new { username, password = DiagnosticsFactory.ViewerPassword }
            : new { username, password = DiagnosticsFactory.ViewerPassword, permissions = new { allowUsenetSpeedTest = allowed } });
        using var anon = factory.CreateClient();
        return factory.Viewer(await ViewerApi.AccessTokenAsync(anon, username, DiagnosticsFactory.ViewerPassword));
    }

    [Fact]
    public async Task Viewers_MayTest_ByDefault_RedactedAndShared_AdminsSeeNames()
    {
        using var viewer = await ViewerAsync(allowed: null);
        var me = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");
        Assert.True(me.GetProperty("permissions").GetProperty("allowUsenetSpeedTest").GetBoolean());
        factory.Clock.Advance(TimeSpan.FromMinutes(5));

        var response = await viewer.PostAsync("/api/v1/viewer/diagnostics/usenet-speed", null);
        var raw = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain("Main Provider", raw);
        Assert.DoesNotContain("Wrong Password", raw);
        Assert.DoesNotContain("127.0.0.1", raw);
        var result = JsonSerializer.Deserialize<UsenetSpeedTestResponse>(raw, Json)!;
        Assert.Equal("ok", result.Status);
        Assert.True(result.MegabitsPerSecond > 0);
        Assert.Equal((1, "primary", null), (result.Provider!.Index, result.Provider.Role, result.Provider.Name));
        Assert.False(result.Reused);

        using var other = await ViewerAsync(allowed: null);
        var shared = await (await other.PostAsync("/api/v1/viewer/diagnostics/usenet-speed", null)).Content.ReadFromJsonAsync<UsenetSpeedTestResponse>(Json);
        Assert.True(shared!.Reused);
        Assert.Equal(result.MeasuredAt, shared.MeasuredAt);

        var state = await other.GetFromJsonAsync<UsenetSpeedTestStateResponse>("/api/v1/viewer/diagnostics/usenet-speed", Json);
        Assert.True(state!.Allowed);
        Assert.Null(state.Latest!.Provider!.Name);

        using var admin = await factory.AdminAsync();
        var adminState = await admin.GetFromJsonAsync<UsenetSpeedTestStateResponse>("/api/v1/diagnostics/usenet-speed", Json);
        Assert.Equal("Main Provider", adminState!.Latest!.Provider!.Name);
    }

    [Fact]
    public async Task WithoutThePermission_AViewerGetsACoded403_UntilTheAdminAllowsIt()
    {
        using var viewer = await ViewerAsync(allowed: false);
        var me = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");
        Assert.False(me.GetProperty("permissions").GetProperty("allowUsenetSpeedTest").GetBoolean());

        var denied = await viewer.PostAsync("/api/v1/viewer/diagnostics/usenet-speed", null);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal("usenet_speedtest_not_allowed", await ViewerApi.ErrorCodeAsync(denied));
        var state = await viewer.GetFromJsonAsync<UsenetSpeedTestStateResponse>("/api/v1/viewer/diagnostics/usenet-speed", Json);
        Assert.False(state!.Allowed);

        using var admin = await factory.AdminAsync();
        var id = me.GetProperty("id").GetString();
        var patch = await admin.PatchAsJsonAsync($"/api/v1/config/viewers/{id}", new { permissions = new { allowUsenetSpeedTest = true } });
        Assert.True(patch.IsSuccessStatusCode, await patch.Content.ReadAsStringAsync());
        Assert.True((await patch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("permissions").GetProperty("allowUsenetSpeedTest").GetBoolean());

        Assert.Equal(HttpStatusCode.OK, (await viewer.PostAsync("/api/v1/viewer/diagnostics/usenet-speed", null)).StatusCode);
    }
}
