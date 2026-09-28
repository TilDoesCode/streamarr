using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>The module is off by default and its viewer endpoints vanish while it is switched off.</summary>
public sealed class ViewerModuleGateTests(ViewerApiFactory factory) : IClassFixture<ViewerApiFactory>
{
    [Fact]
    public async Task Module_Is_Off_By_Default_And_Can_Be_Toggled()
    {
        using var admin = await factory.AdminAsync();
        using var anon = factory.CreateClient();

        var settings = await admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/settings");
        Assert.False(settings.GetProperty("enabled").GetBoolean());
        foreach (var response in new[]
                 {
                     await anon.GetAsync("/api/v1/viewer/auth/options"),
                     await ViewerApi.LoginAsync(anon, "someone", "whatever-password"),
                     await anon.GetAsync("/api/v1/viewer/me"),
                 })
        {
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("module_disabled", await ViewerApi.ErrorCodeAsync(response));
        }

        await ViewerApi.CreateAsync(admin, new { username = "gate-viewer", password = "correct horse battery" });
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        var token = await ViewerApi.AccessTokenAsync(anon, "gate-viewer", "correct horse battery");
        using var viewer = factory.Viewer(token);
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);

        await ViewerApi.ConfigureAsync(admin, new { enabled = false });
        var off = await viewer.GetAsync("/api/v1/viewer/me");
        Assert.Equal(HttpStatusCode.NotFound, off.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/config/viewers")).StatusCode);

        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/me")).StatusCode);
    }

    [Fact]
    public async Task Smtp_Password_Is_Write_Only()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new
        {
            email = new { mode = "smtp", smtpHost = "smtp.example.com", fromAddress = "tv@example.com", smtpUsername = "mailer", smtpPassword = "s3cret!" },
        });
        var masked = await admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/settings");
        Assert.Equal("••••••••", masked.GetProperty("email").GetProperty("smtpPassword").GetString());
        Assert.DoesNotContain("s3cret", masked.GetRawText());

        await ViewerApi.ConfigureAsync(admin, new { email = new { smtpPassword = "••••••••", fromName = "Home TV" } });
        Assert.Equal("••••••••", (await admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/settings")).GetProperty("email").GetProperty("smtpPassword").GetString());

        await ViewerApi.ConfigureAsync(admin, new { email = new { smtpPassword = "", mode = "disabled" } });
        var cleared = await admin.GetFromJsonAsync<JsonElement>("/api/v1/config/viewers/settings");
        Assert.Equal(JsonValueKind.Null, cleared.GetProperty("email").GetProperty("smtpPassword").ValueKind);
        Assert.False(cleared.GetProperty("emailDeliveryReady").GetBoolean());
    }

    [Fact]
    public async Task Viewer_Admin_Endpoints_Require_An_Admin()
    {
        using var anon = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/v1/config/viewers")).StatusCode);
        using var machine = factory.Viewer(ViewerApiFactory.ApiKey);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/viewers")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/config/viewers/settings")).StatusCode);
    }
}
