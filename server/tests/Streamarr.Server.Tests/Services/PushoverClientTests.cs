using System.Net;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class PushoverClientTests
{
    [Fact]
    public async Task SendAsync_PostsEmergencyParametersAndTargeting()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var handler = new StubHandler(async request =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync();
            return Json(HttpStatusCode.OK, """{"status":1,"request":"request-id","receipt":"receipt-id"}""");
        });
        var client = new PushoverClient(new HttpClient(handler)
        {
            BaseAddress = new Uri("https://api.pushover.net/"),
        });

        await client.SendAsync(new NotificationConfigEntity
        {
            Device = "phone",
            Sound = "siren",
            EmergencyRetrySeconds = 45,
            EmergencyExpireSeconds = 900,
        }, "app-token", "user-key", "Outage", "Provider is down", 2, default);

        Assert.Equal(HttpMethod.Post, captured!.Method);
        Assert.Equal("https://api.pushover.net/1/messages.json", captured.RequestUri!.ToString());
        Assert.Contains("token=app-token", body);
        Assert.Contains("user=user-key", body);
        Assert.Contains("device=phone", body);
        Assert.Contains("sound=siren", body);
        Assert.Contains("priority=2", body);
        Assert.Contains("retry=45", body);
        Assert.Contains("expire=900", body);
    }

    [Fact]
    public async Task SendAsync_ReportsPushoverValidationErrors()
    {
        var client = new PushoverClient(new HttpClient(new StubHandler(_ =>
            Task.FromResult(Json(HttpStatusCode.BadRequest,
                """{"status":0,"errors":["user identifier is invalid"]}"""))))
        {
            BaseAddress = new Uri("https://api.pushover.net/"),
        });

        var exception = await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.SendAsync(new NotificationConfigEntity(), "token", "user", "Test", "Test", 0, default));

        Assert.Contains("user identifier is invalid", exception.Message);
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json)
        => new(status) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };

    private sealed class StubHandler(
        Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => handler(request);
    }
}
