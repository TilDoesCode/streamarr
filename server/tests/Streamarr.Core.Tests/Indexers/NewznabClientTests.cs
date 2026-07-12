using System.Net;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;

namespace Streamarr.Core.Tests.Indexers;

public class NewznabClientTests
{
    private static IndexerConfig Indexer(string baseUrl = "https://alpha.example", string apiKey = "alphakey")
        => new()
        {
            Id = "alpha",
            Name = "Alpha",
            BaseUrl = baseUrl,
            ApiKey = apiKey,
            Categories = [2000, 5000],
        };

    [Fact]
    public void BuildUrl_Search_IncludesFunctionApiKeyQueryAndCategories()
    {
        var url = NewznabClient.BuildUrl(Indexer(), "search", new NewznabQuery { Term = "the matrix" });

        Assert.StartsWith("https://alpha.example/api?", url.ToString());
        var q = url.Query;
        Assert.Contains("t=search", q);
        Assert.Contains("o=xml", q);
        Assert.Contains("apikey=alphakey", q);
        Assert.Contains("q=the%20matrix", q);
        Assert.Contains("cat=2000,5000", q);
        Assert.Contains("extended=1", q);
    }

    [Fact]
    public void BuildUrl_DoesNotDoubleAppendApiSegment()
    {
        var url = NewznabClient.BuildUrl(Indexer(baseUrl: "https://alpha.example/api/"), "caps", query: null);
        Assert.StartsWith("https://alpha.example/api?", url.ToString());
        Assert.DoesNotContain("/api/api", url.ToString());
    }

    [Fact]
    public void BuildUrl_Movie_StripsTtFromImdbId()
    {
        var url = NewznabClient.BuildUrl(Indexer(), "movie", new NewznabQuery
        {
            Kind = NewznabSearchKind.Movie,
            ImdbId = "tt0133093",
            TmdbId = 603,
        });

        Assert.Contains("t=movie", url.Query);
        Assert.Contains("imdbid=0133093", url.Query);
        Assert.DoesNotContain("tt0133093", url.Query);
        Assert.Contains("tmdbid=603", url.Query);
    }

    [Fact]
    public void BuildUrl_Tv_IncludesSeasonAndEpisode()
    {
        var url = NewznabClient.BuildUrl(Indexer(), "tvsearch", new NewznabQuery
        {
            Kind = NewznabSearchKind.Tv,
            Term = "example show",
            Season = 1,
            Episode = 2,
        });

        Assert.Contains("t=tvsearch", url.Query);
        Assert.Contains("season=1", url.Query);
        Assert.Contains("ep=2", url.Query);
    }

    [Fact]
    public void BuildUrl_QueryCategoriesOverrideIndexerCategories()
    {
        var url = NewznabClient.BuildUrl(Indexer(), "search", new NewznabQuery { Term = "x", Categories = [2040] });
        Assert.Contains("cat=2040", url.Query);
        Assert.DoesNotContain("cat=2000,5000", url.Query);
    }

    [Fact]
    public async Task SearchAsync_ParsesFixtureResponse()
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Xml(NewznabFixtures.Load("alpha-search.xml")));
        var client = new NewznabClient(new HttpClient(handler));

        var response = await client.SearchAsync(Indexer(), new NewznabQuery { Term = "example" }, CancellationToken.None);

        Assert.Equal(3, response.Items.Count);
        Assert.Single(handler.Requests);
        Assert.Contains("t=search", handler.Requests[0].Query);
    }

    [Fact]
    public async Task GetCapabilitiesAsync_ParsesCaps()
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Xml(NewznabFixtures.Load("caps.xml")));
        var client = new NewznabClient(new HttpClient(handler));

        var caps = await client.GetCapabilitiesAsync(Indexer(), CancellationToken.None);

        Assert.True(caps.MovieSearchAvailable);
        Assert.Contains("t=caps", handler.Requests[0].Query);
    }

    [Fact]
    public async Task SearchAsync_HttpError_ThrowsNewznabRequestException()
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Status(HttpStatusCode.ServiceUnavailable));
        var client = new NewznabClient(new HttpClient(handler));

        var ex = await Assert.ThrowsAsync<NewznabRequestException>(
            () => client.SearchAsync(Indexer(), new NewznabQuery { Term = "x" }, CancellationToken.None));
        Assert.Contains("503", ex.Message);
    }

    [Fact]
    public async Task SearchAsync_MalformedXml_ThrowsNewznabParseException()
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Xml(NewznabFixtures.Load("malformed.xml")));
        var client = new NewznabClient(new HttpClient(handler));

        await Assert.ThrowsAsync<NewznabParseException>(
            () => client.SearchAsync(Indexer(), new NewznabQuery { Term = "x" }, CancellationToken.None));
    }
}
