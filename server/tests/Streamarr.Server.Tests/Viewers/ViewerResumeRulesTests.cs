using System.Net.Http.Json;
using System.Text.Json;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>DL-S 8: <c>GET /viewer/me</c> reports the resume/played thresholds the server applies, so offline playback can apply the same.</summary>
public sealed class ViewerResumeRulesTests
{
    private const string Password = "correct horse battery";

    private static async Task<(HttpClient Admin, HttpClient Viewer, JsonElement Login)> SetUpAsync(ViewerApiFactory factory, object settings)
    {
        var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, settings);
        await ViewerApi.CreateAsync(admin, new { username = "resume-rules", password = Password });
        using var anon = factory.CreateClient();
        using var login = await ViewerApi.LoginAsync(anon, "resume-rules", Password);
        var body = await login.Content.ReadFromJsonAsync<JsonElement>();
        return (admin, factory.Viewer(body.GetProperty("session").GetProperty("accessToken").GetString()!), body);
    }

    private static (int Played, int MinPercent, int MinSeconds) Rules(JsonElement profile)
    {
        var resume = profile.GetProperty("resume");
        return (resume.GetProperty("playedPercent").GetInt32(), resume.GetProperty("minResumePercent").GetInt32(),
            resume.GetProperty("minResumeDurationSeconds").GetInt32());
    }

    /// <summary>The resume point a 2-minute title keeps at half way: 0 when it is shorter than <c>minResumeDurationSeconds</c>.</summary>
    private static async Task<long> HalfWayResumeAsync(HttpClient viewer, string workId)
    {
        var duration = TimeSpan.FromMinutes(2).Ticks;
        using var response = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress",
            new { @event = "progress", workId, positionTicks = duration / 2, durationTicks = duration, playbackId = $"pb-{workId}" });
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("positionTicks").GetInt64();
    }

    [Fact]
    public async Task WithNothingConfigured_MeReportsTheDefaults_AndTheyAreTheOnesApplied()
    {
        using var factory = new ViewerApiFactory();
        var (admin, viewer, login) = await SetUpAsync(factory, new { enabled = true });
        using var _ = admin;
        using var __ = viewer;

        var me = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");

        Assert.Equal((90, 5, 300), Rules(me));
        Assert.Equal((90, 5, 300), Rules(login.GetProperty("viewer")));
        Assert.Equal(0, await HalfWayResumeAsync(viewer, "tmdb-movie-801"));
    }

    [Fact]
    public async Task MeReportsTheConfiguredValues_AnAdminChangeOnTheNextCall_AndAViewerCannotWriteThem()
    {
        using var factory = new ViewerApiFactory();
        var (admin, viewer, login) = await SetUpAsync(factory, new { enabled = true, playedPercent = 85, minResumePercent = 10, minResumeDurationSeconds = 60 });
        using var _ = admin;
        using var __ = viewer;

        var configured = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");
        var applied = await HalfWayResumeAsync(viewer, "tmdb-movie-802");

        await ViewerApi.ConfigureAsync(admin, new { minResumeDurationSeconds = 600 });
        var changed = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/me");
        var appliedAfter = await HalfWayResumeAsync(viewer, "tmdb-movie-803");

        using var patch = await viewer.PatchAsJsonAsync("/api/v1/viewer/me",
            new { displayName = "Resume Rules", resume = new { playedPercent = 50, minResumePercent = 0, minResumeDurationSeconds = 0 } });
        var patched = await patch.Content.ReadFromJsonAsync<JsonElement>();
        var settings = await admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/settings");

        Assert.Equal((85, 10, 60), Rules(login.GetProperty("viewer")));
        Assert.Equal((85, 10, 60), Rules(configured));
        Assert.Equal(TimeSpan.FromMinutes(1).Ticks, applied);
        Assert.Equal((85, 10, 600), Rules(changed));
        Assert.Equal(0, appliedAfter);
        Assert.True(patch.IsSuccessStatusCode, patched.ToString());
        Assert.Equal("Resume Rules", patched.GetProperty("displayName").GetString());
        Assert.Equal((85, 10, 600), Rules(patched));
        Assert.Equal((85, 10, 600), (settings.GetProperty("playedPercent").GetInt32(), settings.GetProperty("minResumePercent").GetInt32(),
            settings.GetProperty("minResumeDurationSeconds").GetInt32()));
    }
}
