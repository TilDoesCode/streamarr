using System.Net;
using System.Text;
using Streamarr.Core.Media;
using Streamarr.Core.Tests.Indexers;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

public class TmdbLanguageTests
{
    private sealed class LanguageEcho : ITmdbClient
    {
        public int Calls;

        public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult<TmdbMatch?>(new TmdbMatch { MediaType = MediaType.Movie, TmdbId = tmdbId, Title = TmdbLanguage.Current ?? "default" });
        }

        public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    }

    [Fact]
    public async Task CacheKeepsOneEntryPerLanguage()
    {
        var inner = new LanguageEcho();
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        var english = await caching.GetMovieAsync(7, default);
        TmdbMatch? german;
        using (TmdbLanguage.Use("de"))
            german = await caching.GetMovieAsync(7, default);
        var again = await caching.GetMovieAsync(7, default);

        Assert.Equal("default", english!.Title);
        Assert.Equal("de", german!.Title);
        Assert.Same(english, again);
        Assert.Equal(2, inner.Calls);
        Assert.Null(TmdbLanguage.Current);
    }

    [Theory]
    [InlineData("de-AT", "de")]
    [InlineData("EN", "en")]
    [InlineData("x1", null)]
    [InlineData(null, null)]
    public void PrimaryTag(string? value, string? expected) => Assert.Equal(expected, TmdbLanguage.Primary(value));

    [Fact]
    public async Task LocalizedMovieFallsBackToEnglishOverviewButKeepsTheTaglineInItsLanguage()
    {
        var languages = new List<string?>();
        var handler = new StubHttpMessageHandler(req =>
        {
            var language = System.Web.HttpUtility.ParseQueryString(req.RequestUri!.Query)["language"];
            languages.Add(language);
            var body = language == "de"
                ? """{"id":5,"title":"Der Film","overview":"","tagline":"","genres":[{"id":35,"name":"Komödie"}]}"""
                : """{"id":5,"title":"The Movie","overview":"English overview.","tagline":"English tagline.","genres":[{"id":35,"name":"Comedy"}]}""";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        });
        var client = new TmdbClient(new HttpClient(handler), new TmdbOptions { ApiKey = "k" }, retryDelay: static (_, _) => Task.CompletedTask);

        TmdbMatch? movie;
        using (TmdbLanguage.Use("de"))
            movie = await client.GetMovieAsync(5, default);
        var english = await client.GetMovieAsync(5, default);

        Assert.Equal("Der Film", movie!.Title);
        Assert.Equal(["Komödie"], movie.Genres);
        Assert.Equal("English overview.", movie.Overview);
        Assert.Null(movie.Tagline);
        Assert.Equal(["de", "en-US", null], languages);
        Assert.Equal("The Movie", english!.Title);
        Assert.Equal("English tagline.", english.Tagline);
    }

    [Fact]
    public async Task LocalizedMovieWithOverviewButNoTaglineMakesNoEnglishCall()
    {
        var languages = new List<string?>();
        var handler = new StubHttpMessageHandler(req =>
        {
            languages.Add(System.Web.HttpUtility.ParseQueryString(req.RequestUri!.Query)["language"]);
            const string body = """{"id":5,"title":"Der Film","overview":"Deutsch.","tagline":"","genres":[]}""";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        });
        var client = new TmdbClient(new HttpClient(handler), new TmdbOptions { ApiKey = "k" }, retryDelay: static (_, _) => Task.CompletedTask);

        TmdbMatch? movie;
        using (TmdbLanguage.Use("de"))
            movie = await client.GetMovieAsync(5, default);

        Assert.Null(movie!.Tagline);
        Assert.Equal(["de"], languages);
    }

    [Fact]
    public async Task LocalizedSeriesFallsBackToEnglishOverviewButNotTagline()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            var language = System.Web.HttpUtility.ParseQueryString(req.RequestUri!.Query)["language"];
            var body = language == "de"
                ? """{"id":7,"name":"Die Serie","overview":"","tagline":"","seasons":[]}"""
                : """{"id":7,"name":"The Series","overview":"English overview.","tagline":"English tagline.","seasons":[]}""";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        });
        var client = new TmdbClient(new HttpClient(handler), new TmdbOptions { ApiKey = "k" }, retryDelay: static (_, _) => Task.CompletedTask);

        TmdbMatch? series;
        using (TmdbLanguage.Use("de"))
            series = await client.GetTvAsync(7, default);

        Assert.Equal("Die Serie", series!.Title);
        Assert.Equal("English overview.", series.Overview);
        Assert.Null(series.Tagline);
    }
}
