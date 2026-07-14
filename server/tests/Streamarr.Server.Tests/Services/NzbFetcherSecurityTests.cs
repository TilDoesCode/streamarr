using System.Net;
using System.Text;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public class NzbFetcherSecurityTests
{
    private static readonly IndexerConfig Indexer = new()
    {
        Id = "idx",
        Name = "Indexer",
        BaseUrl = "https://indexer.example/base",
        ApiKey = "secret",
    };

    private const string NzbXml =
        "<nzb><file subject=\"video.mkv\"><segments><segment bytes=\"123\" number=\"1\">part@example.test</segment></segments></file></nzb>";

    [Fact]
    public async Task CrossOriginRedirect_IsRejectedWithoutFollowingIt()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.Redirect)
        {
            Headers = { Location = new Uri("http://169.254.169.254/latest/meta-data/") },
        });
        var fetcher = Create(handler);

        var ex = await Assert.ThrowsAsync<NzbOriginNotAllowedException>(() => fetcher.FetchAsync(
            "https://indexer.example/download/one.nzb", "Indexer", CancellationToken.None));
        Assert.Equal("169.254.169.254", ex.Host);
        Assert.Equal("idx", ex.IndexerId);
        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task DifferentInitialOrigin_IsRejectedBeforeNetworkIo()
    {
        var handler = new StubHandler(_ => throw new Xunit.Sdk.XunitException("network should not be reached"));
        var fetcher = Create(handler);

        var ex = await Assert.ThrowsAsync<NzbOriginNotAllowedException>(() => fetcher.FetchAsync(
            "https://evil.example/one.nzb", "Indexer", CancellationToken.None));
        Assert.Equal("evil.example", ex.Host);
        Assert.Equal(0, handler.RequestCount);
    }

    [Fact]
    public async Task AllowedDownloadHost_OnADifferentHost_IsAccepted()
    {
        var indexer = Indexer with { AllowedDownloadHosts = ["dl.indexer.example"] };
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(NzbXml, Encoding.UTF8, "application/x-nzb"),
        });
        var fetcher = new NzbFetcher(
            new HttpClient(handler),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()),
            new Store(indexer));

        var document = await fetcher.FetchAsync(
            "https://dl.indexer.example/one.nzb", "Indexer", CancellationToken.None);
        Assert.Single(document.Files);
    }

    [Fact]
    public async Task DownloadHost_NotInAllowList_IsRejected()
    {
        var indexer = Indexer with { AllowedDownloadHosts = ["dl.indexer.example"] };
        var handler = new StubHandler(_ => throw new Xunit.Sdk.XunitException("network should not be reached"));
        var fetcher = new NzbFetcher(
            new HttpClient(handler),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()),
            new Store(indexer));

        var ex = await Assert.ThrowsAsync<NzbOriginNotAllowedException>(() => fetcher.FetchAsync(
            "https://other.indexer.example/one.nzb", "Indexer", CancellationToken.None));
        Assert.Equal("other.indexer.example", ex.Host);
        Assert.Equal(0, handler.RequestCount);
    }

    [Fact]
    public async Task OversizedUrl_IsRejectedBeforeNetworkIo()
    {
        var handler = new StubHandler(_ => throw new Xunit.Sdk.XunitException("network should not be reached"));
        var fetcher = Create(handler);

        await Assert.ThrowsAsync<InvalidDataException>(() => fetcher.FetchAsync(
            "https://indexer.example/" + new string('a', NzbFetcher.MaxNzbUrlLength),
            "Indexer",
            CancellationToken.None));
        Assert.Equal(0, handler.RequestCount);
    }

    [Fact]
    public async Task LocalPath_RequiresExplicitOptIn()
    {
        var fetcher = Create(new StubHandler(_ => throw new Xunit.Sdk.XunitException("network should not be reached")));
        await Assert.ThrowsAsync<InvalidDataException>(() => fetcher.FetchAsync(
            "/tmp/untrusted.nzb", "Indexer", CancellationToken.None));
    }

    [Fact]
    public async Task OversizedBody_IsRejectedWhileReading()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(new byte[2048]),
        });
        var fetcher = Create(handler, new StreamarrOptions { MaxNzbBytes = 1024 });
        await Assert.ThrowsAsync<InvalidDataException>(() => fetcher.FetchAsync(
            "https://indexer.example/download/one.nzb", "Indexer", CancellationToken.None));
    }

    [Fact]
    public async Task SameOriginBoundedNzb_IsAccepted()
    {
        const string xml = "<nzb><file subject=\"video.mkv\"><segments><segment bytes=\"123\" number=\"1\">part@example.test</segment></segments></file></nzb>";
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(xml, Encoding.UTF8, "application/x-nzb"),
        });
        var document = await Create(handler).FetchAsync(
            "https://indexer.example/download/one.nzb", "Indexer", CancellationToken.None);
        Assert.Single(document.Files);
    }

    private static NzbFetcher Create(HttpMessageHandler handler, StreamarrOptions? options = null)
        => new(
            new HttpClient(handler),
            Microsoft.Extensions.Options.Options.Create(options ?? new StreamarrOptions()),
            new Store(Indexer));

    private sealed class Store(params IndexerConfig[] indexers) : IIndexerConfigStore
    {
        public IReadOnlyList<IndexerConfig> GetAll() => indexers;
        public IReadOnlyList<IndexerConfig> GetEnabled() => indexers.Where(x => x.Enabled).ToArray();
    }

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        public int RequestCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            RequestCount++;
            return Task.FromResult(response(request));
        }
    }
}
