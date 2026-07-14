using Microsoft.AspNetCore.Http;

namespace Streamarr.Server.Tests.Services;

public sealed class RequestLogRedactionTests
{
    [Fact]
    public void CapabilityPathsNeverReachTheRequestLogProperty()
    {
        const string capability = "known-secret-capability";

        var stream = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/stream/{capability}"));
        var close = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/sessions/{capability}/close"));

        Assert.Equal("/api/v1/stream/{capability}", stream);
        Assert.Equal("/api/v1/sessions/{capability}/close", close);
        Assert.DoesNotContain(capability, stream);
        Assert.DoesNotContain(capability, close);
    }
}
