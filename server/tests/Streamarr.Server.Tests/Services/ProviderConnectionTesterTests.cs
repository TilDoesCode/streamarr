using Streamarr.Server.Config;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Server.Tests.Services;

public sealed class ProviderConnectionTesterTests
{
    [Fact]
    public async Task Probe_RejectsAnUnsuccessfulAuthenticationResponse()
    {
        var fake = new FakeNntpClient
        {
            AuthenticationResponse = new NntpResponse
            {
                ResponseCode = 481,
                ResponseMessage = "481 rejected",
            },
        };
        var tester = new ProviderConnectionTester(() => fake);

        var result = await tester.ProbeAsync(new UsenetProvider
        {
            Name = "test",
            Host = "news.example",
            Port = 563,
            UseSsl = true,
            Username = "user",
            Password = "bad",
            MaxConnections = 1,
        }, CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Contains("481", result.Error);
    }
}
