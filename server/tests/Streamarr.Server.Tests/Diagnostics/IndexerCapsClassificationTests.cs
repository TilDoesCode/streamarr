using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Config;

namespace Streamarr.Server.Tests.Diagnostics;

public sealed class IndexerCapsClassificationTests
{
    private sealed class Throwing(Exception error) : INewznabClient
    {
        public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken) => throw error;
        public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken) => throw error;
    }

    public static TheoryData<Exception, string> Cases => new()
    {
        { new NewznabRequestException("Newznab error 100: Incorrect user credentials", isTransient: false), "auth_failed" },
        { new NewznabRequestException("Newznab error 500: Request limit reached", isTransient: false), "http_error" },
        { new NewznabRequestException("Indexer 'x' returned HTTP 401 Unauthorized."), "auth_failed" },
        { new NewznabRequestException("Indexer 'x' returned HTTP 503 Service Unavailable."), "http_error" },
        { new NewznabRequestException("Request to indexer 'x' timed out."), "timeout" },
        { new NewznabParseException("Newznab caps response had no <caps> root element."), "invalid_response" },
        { new NewznabRequestException("Request to indexer 'x' failed.", new HttpRequestException("refused")), "unreachable" },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task Failures_AreClassifiedWithoutChangingThePublicError(Exception error, string code)
    {
        var tester = new IndexerCapsTester(new Throwing(error));

        var result = await tester.TestAsync(new IndexerConfig { Id = "i", Name = "x", BaseUrl = "https://idx.example", ApiKey = "secret" }, default);

        Assert.False(result.Success);
        Assert.Equal(code, result.ErrorCode);
        Assert.Equal("Indexer request failed.", result.Error);
        Assert.Equal(error.Message, result.ErrorDetail);
    }
}
