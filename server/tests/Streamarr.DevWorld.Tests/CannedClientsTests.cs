using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Providers;

namespace Streamarr.DevWorld.Tests;

public class CannedClientsTests(FakeWorld world) : IClassFixture<FakeWorld>
{
    private static readonly IndexerConfig Indexer = new() { Id = DevWorldIds.IndexerId, Name = "Dev World", BaseUrl = "http://indexer.devworld.invalid/api" };

    private CannedNewznabClient Newznab => new(world.Store.Releases, DateTimeOffset.UtcNow);
    private CannedTmdbClient Tmdb => new(world.Plan.Catalog);

    private async Task<string[]> SearchAsync(NewznabQuery query)
        => (await Newznab.SearchAsync(Indexer, query, CancellationToken.None)).Items.Select(i => i.Title).ToArray();

    [Fact]
    public async Task MovieSearchByTmdbId_ReturnsExactlyThatTitlesReleases_WithNominalSizes()
    {
        var cosmos = world.Plan.Catalog.Movies.Single(m => m.Key == "cosmos-laundromat");

        var response = await Newznab.SearchAsync(Indexer, new NewznabQuery { Kind = NewznabSearchKind.Movie, TmdbId = cosmos.TmdbId }, CancellationToken.None);

        Assert.Equal(cosmos.Releases.Select(r => r.Name).Order(), response.Items.Select(i => i.Title).Order());
        Assert.All(response.Items, item => Assert.Equal(
            world.Store.Releases.Single(r => r.Plan.Name == item.Title).Plan.ReportedSizeBytes, item.SizeBytes));
    }

    [Fact]
    public async Task TermSearch_NeedsEveryToken()
    {
        var titles = await SearchAsync(new NewznabQuery { Term = "tears steel" });

        Assert.NotEmpty(titles);
        Assert.All(titles, t => Assert.StartsWith("Tears.of.Steel.", t));
        Assert.Empty(await SearchAsync(new NewznabQuery { Term = "tears sintel" }));
    }

    [Fact]
    public async Task EpisodeSearch_IncludesTheSeasonPack()
    {
        var pioneer = world.Plan.Catalog.Series.Single(s => s.Key == "pioneer-one");

        var titles = await SearchAsync(new NewznabQuery { Kind = NewznabSearchKind.Tv, TmdbId = pioneer.TmdbId, Season = 1, Episode = 2 });

        Assert.Contains(pioneer.SeasonPacks.Single().Name, titles);
        Assert.All(titles.Where(t => t != pioneer.SeasonPacks.Single().Name), t => Assert.Contains(".S01E02.", t));
        Assert.Equal(pioneer.Seasons[0].Episodes[1].Releases.Count + 1, titles.Length);
    }

    [Fact]
    public async Task MetadataOnlySeason_HasNoReleases()
    {
        var sherlock = world.Plan.Catalog.Series.Single(s => s.Key == "sherlock");

        Assert.Empty(await SearchAsync(new NewznabQuery { Kind = NewznabSearchKind.Tv, TmdbId = sherlock.TmdbId, Season = 3 }));
    }

    [Theory]
    [InlineData("Sintel", null, 45745)]
    [InlineData("die nacht der lebenden toten", MediaType.Movie, 10331)]
    [InlineData("sher", MediaType.Tv, 19885)]
    [InlineData("Tears of Steel!", null, 133701)]
    public async Task TmdbSearch_MatchesExactGermanAndPrefixTitles(string query, MediaType? type, int tmdbId)
    {
        var candidates = await Tmdb.SearchCandidatesAsync(query, type, CancellationToken.None);

        Assert.Equal(tmdbId, candidates[0].TmdbId);
    }

    [Fact]
    public async Task DiscoverLists_FollowTheCatalogOrder_WithCardFieldsOnly()
    {
        var discover = world.Plan.Catalog.Discover;

        var trending = await Tmdb.GetTrendingAsync(MediaType.Movie, CancellationToken.None);
        var popular = await Tmdb.GetPopularAsync(MediaType.Tv, CancellationToken.None);

        Assert.Equal(discover.TrendingMovies, trending.Select(m => world.Plan.Catalog.Movies.Single(e => e.TmdbId == m.TmdbId).Key));
        Assert.Equal(discover.PopularSeries, popular.Select(m => world.Plan.Catalog.Series.Single(e => e.TmdbId == m.TmdbId).Key));
        Assert.All(trending, m => Assert.Equal(MediaType.Movie, m.MediaType));
        Assert.All(trending.Concat(popular), m =>
        {
            Assert.Null(m.OfficialRating);
            Assert.False(string.IsNullOrEmpty(m.PosterUrl));
        });
    }

    [Fact]
    public async Task MovieDetails_CarryTheCapturedLogo()
    {
        var bunny = await Tmdb.GetMovieAsync(10378, CancellationToken.None);

        Assert.StartsWith("https://image.tmdb.org/t/p/w500/", bunny!.LogoUrl);
    }

    [Theory]
    [InlineData("   ", null)]
    [InlineData("sherlock", MediaType.Movie)]
    [InlineData("zzz unknown", null)]
    public async Task TmdbSearch_ReturnsNothingForNonMatches(string query, MediaType? type)
    {
        Assert.Empty(await Tmdb.SearchCandidatesAsync(query, type, CancellationToken.None));
    }

    [Fact]
    public async Task SeasonCatalog_KeepsMissingArtworkAsNull()
    {
        var pioneer = await Tmdb.GetTvSeasonCatalogAsync(33050, 1, CancellationToken.None);
        var sherlock = await Tmdb.GetTvSeasonCatalogAsync(19885, 1, CancellationToken.None);

        Assert.Null(pioneer!.PosterUrl);
        Assert.All(pioneer.Episodes, e => Assert.Null(e.StillUrl));
        Assert.NotNull(sherlock!.PosterUrl);
        Assert.All(sherlock.Episodes, e => Assert.NotNull(e.StillUrl));
    }
}
