using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;
using Streamarr.Core.Search;

namespace Streamarr.Core.Tests.Search;

public class WorkAggregatorTests
{
    private static readonly QualityProfile Profile = DefaultProfiles.Standard;

    private static WorkAggregator Aggregator(FakeTmdbClient tmdb) => new(tmdb, new ReleaseEvaluator());

    private static Release Raw(string title, long size, string? id = null) => new()
    {
        ReleaseId = id ?? title,
        Title = title,
        Indexer = "mock",
        SizeBytes = size,
        NzbUrl = $"https://secret.example/{id ?? title}.nzb",
    };

    private static Task<SearchAggregation> Run(WorkAggregator aggregator, SearchContext ctx, params Release[] releases)
        => aggregator.AggregateAsync(releases, [], ctx, Profile, CancellationToken.None);

    [Fact]
    public async Task GroupsReleasesUnderOneResolvedMovieWork()
    {
        var tmdb = new FakeTmdbClient
        {
            OnSearchMovie = (_, _) => FakeTmdbClient.Movie(12345, "Example Movie", 2021, runtime: 120, imdbId: "tt1234567"),
        };

        var result = await Run(Aggregator(tmdb), SearchContext.Any,
            Raw("Example.Movie.2021.1080p.WEB-DL.x265.DDP5.1-GROUP", 4_000_000_000, "a"),
            Raw("Example.Movie.2021.720p.WEB-DL.x264-OTHER", 2_000_000_000, "b"));

        var work = Assert.Single(result.Works);
        Assert.Equal("tmdb-movie-12345", work.WorkId);
        Assert.Equal(MediaType.Movie, work.MediaType);
        Assert.Equal("Example Movie", work.Title);
        Assert.Equal(12345, work.TmdbId);
        Assert.Equal("tt1234567", work.ImdbId);
        Assert.Equal(120, work.RuntimeMinutes);
        Assert.Equal(2, work.Releases.Count);
        // TMDB is queried once for the work, not once per release.
        Assert.Equal(1, tmdb.SearchMovieCalls);
    }

    [Fact]
    public async Task DemotesReleasesKnownDeadFromTheHealthCache()
    {
        var tmdb = new FakeTmdbClient
        {
            OnSearchMovie = (_, _) => FakeTmdbClient.Movie(1, "Example Movie", 2021, runtime: 120),
        };

        // A prior resolve found the higher-scoring release dead on Usenet.
        var healthCache = new ReleaseHealthCache(TimeSpan.FromMinutes(30));
        healthCache.Record("dead", ReleaseHealth.Dead);

        var aggregator = new WorkAggregator(tmdb, new ReleaseEvaluator(), healthCache);
        var result = await aggregator.AggregateAsync(
            [
                Raw("Example.Movie.2021.2160p.BluRay.x265.TrueHD-GROUP", 20_000_000_000, "dead"),
                Raw("Example.Movie.2021.1080p.WEB-DL.x265.DDP5.1-GROUP", 4_000_000_000, "healthy"),
            ],
            [], SearchContext.Any, Profile, CancellationToken.None);

        var work = Assert.Single(result.Works);
        // Even though the 2160p release would normally outrank the 1080p one, the cached
        // dead classification rejects it and sinks it below the healthy release.
        Assert.Equal("healthy", work.Releases[0].ReleaseId);
        Assert.False(work.Releases[0].Rejected);

        var dead = result.Releases.Single(r => r.Release.ReleaseId == "dead");
        Assert.True(dead.Release.Rejected);
        Assert.Equal(ReleaseHealth.Dead, dead.Release.Health);
        Assert.Contains(dead.Assessment.Rejections, r => r.Code == RejectionCode.DeadOnUsenet);
    }

    [Fact]
    public async Task RanksAcceptedReleasesAboveRejectedOnes()
    {
        var tmdb = new FakeTmdbClient
        {
            OnSearchMovie = (_, _) => FakeTmdbClient.Movie(1, "Example Movie", 2021, runtime: 120),
        };

        var result = await Run(Aggregator(tmdb), SearchContext.Any,
            Raw("Example.Movie.2021.1080p.WEB-DL.x265.DDP5.1-GROUP", 4_000_000_000, "good"),
            Raw("Example.Movie.2021.1080p.sample-GROUP", 4_000_000_000, "sample"),
            Raw("Example.Movie.2021.1080p.WEB-DL.x264-FAKE", 1_000_000, "fake"));

        var work = Assert.Single(result.Works);
        Assert.Equal(3, work.Releases.Count);

        // Accepted release ranks first; both fakes sink below it and are flagged.
        Assert.False(work.Releases[0].Rejected);
        Assert.Equal("good", work.Releases[0].ReleaseId);
        Assert.True(work.Releases[1].Rejected);
        Assert.True(work.Releases[2].Rejected);

        var sample = result.Releases.Single(r => r.Release.ReleaseId == "sample");
        Assert.Contains(sample.Assessment.Rejections, r => r.Code == RejectionCode.Sample);

        var fake = result.Releases.Single(r => r.Release.ReleaseId == "fake");
        Assert.Contains(fake.Assessment.Rejections, r => r.Code == RejectionCode.SizeTooSmall);
    }

    [Fact]
    public async Task EnrichesReleaseQualityFromParsedName()
    {
        var tmdb = new FakeTmdbClient
        {
            OnSearchMovie = (_, _) => FakeTmdbClient.Movie(1, "Example Movie", 2021, runtime: 120),
        };

        var result = await Run(Aggregator(tmdb), SearchContext.Any,
            Raw("Example.Movie.2021.1080p.WEB-DL.x265.DDP5.1-GROUP", 4_000_000_000, "a"));

        var release = result.Works[0].Releases[0];
        Assert.Equal("1080p", release.Quality.Resolution);
        Assert.Equal("WEB-DL", release.Quality.Source);
        Assert.Equal("x265", release.Quality.Codec);
        Assert.Equal("GROUP", release.ReleaseGroup);
        Assert.Equal("DDP5.1", release.Quality.Audio);
        // The NZB URL is retained server-side on the domain release for /resolve.
        Assert.Equal("https://secret.example/a.nzb", release.NzbUrl);
    }

    [Fact]
    public async Task BuildsEpisodeWorkIdForTv()
    {
        var tmdb = new FakeTmdbClient
        {
            OnSearchTv = _ => FakeTmdbClient.Tv(456, "Example Show", 2019, runtime: 42),
        };

        var result = await Run(Aggregator(tmdb), new SearchContext { RequestedType = MediaType.Tv },
            Raw("Example.Show.S01E02.1080p.WEB-DL.x265-GROUP", 2_000_000_000, "e"));

        var work = Assert.Single(result.Works);
        Assert.Equal("tmdb-tv-456-s01e02", work.WorkId);
        Assert.Equal(MediaType.Tv, work.MediaType);
        Assert.Equal(1, work.Season);
        Assert.Equal(2, work.Episode);
        Assert.Equal(1, tmdb.SearchTvCalls);
    }

    [Fact]
    public async Task FallsBackToUnmatchedWorkWhenTmdbMisses()
    {
        var tmdb = new FakeTmdbClient(); // every lookup returns null

        var result = await Run(Aggregator(tmdb), SearchContext.Any,
            Raw("Totally.Unknown.Thing.2021.1080p.WEB-DL.x264-GROUP", 3_000_000_000, "u"));

        var work = Assert.Single(result.Works);
        Assert.StartsWith("unmatched-movie-", work.WorkId);
        Assert.Null(work.TmdbId);
        Assert.Null(work.RuntimeMinutes);
        Assert.Single(work.Releases);
    }

    [Fact]
    public async Task UsesTmdbIdLookupForTargetedMovieSearch()
    {
        var tmdb = new FakeTmdbClient
        {
            OnGetMovie = id => FakeTmdbClient.Movie(id, "Example Movie", 2021, runtime: 120),
        };

        var result = await Run(Aggregator(tmdb), new SearchContext { RequestedType = MediaType.Movie, TmdbId = 777 },
            Raw("Example.Movie.2021.1080p.WEB-DL.x265-GROUP", 4_000_000_000, "a"));

        var work = Assert.Single(result.Works);
        Assert.Equal("tmdb-movie-777", work.WorkId);
        Assert.Equal(1, tmdb.GetMovieCalls);
        Assert.Equal(0, tmdb.SearchMovieCalls);
    }

    [Fact]
    public async Task SemanticTarget_SelectsMatchingTitleInsteadOfLargestUnrelatedGroup()
    {
        var tmdb = new FakeTmdbClient
        {
            OnGetMovie = id => FakeTmdbClient.Movie(id, "Dune: Part Two", 2024, runtime: 167),
            OnSearchMovie = (title, _) => title.Contains("Other", StringComparison.OrdinalIgnoreCase)
                ? FakeTmdbClient.Movie(7, "Other Movie", 2024, runtime: 100)
                : null,
        };

        var context = new SearchContext
        {
            RequestedType = MediaType.Movie,
            TmdbId = 693134,
            CanonicalTitle = "Dune: Part Two",
            CanonicalYear = 2024,
            ResolvedTarget = FakeTmdbClient.Movie(693134, "Dune: Part Two", 2024, runtime: 167),
        };
        var result = await Run(Aggregator(tmdb), context,
            Raw("Other.Movie.2024.1080p.WEB-DL.x265-GROUP", 4_000_000_000, "other-a"),
            Raw("Other.Movie.2024.720p.WEB-DL.x264-GROUP", 2_000_000_000, "other-b"),
            Raw("Dune.2.2024.1080p.WEB-DL.x265-GROUP", 7_000_000_000, "dune"));

        var dune = Assert.Single(result.Works, work => work.TmdbId == 693134);
        Assert.Single(dune.Releases);
        Assert.Equal("dune", dune.Releases[0].ReleaseId);
        Assert.Equal(0, tmdb.GetMovieCalls);
    }

    [Fact]
    public async Task SemanticTarget_DoesNotAttachIdToConflictingTitleOrYear()
    {
        var tmdb = new FakeTmdbClient
        {
            OnGetMovie = id => FakeTmdbClient.Movie(id, "Dune: Part Two", 2024, runtime: 167),
            OnSearchMovie = (_, _) => FakeTmdbClient.Movie(7, "Other Movie", 2023, runtime: 100),
        };
        var context = new SearchContext
        {
            RequestedType = MediaType.Movie,
            TmdbId = 693134,
            CanonicalTitle = "Dune: Part Two",
            CanonicalYear = 2024,
            ResolvedTarget = FakeTmdbClient.Movie(693134, "Dune: Part Two", 2024, runtime: 167),
        };

        var result = await Run(Aggregator(tmdb), context,
            Raw("Other.Movie.2023.1080p.WEB-DL.x265-GROUP", 4_000_000_000, "other"));

        Assert.DoesNotContain(result.Works, work => work.TmdbId == 693134);
        Assert.Equal(0, tmdb.GetMovieCalls);
    }

    [Fact]
    public async Task SeparatesDistinctMoviesIntoDifferentWorks()
    {
        var tmdb = new FakeTmdbClient
        {
            OnSearchMovie = (title, _) => title.Contains("First", StringComparison.OrdinalIgnoreCase)
                ? FakeTmdbClient.Movie(1, "First Movie", 2020, runtime: 100)
                : FakeTmdbClient.Movie(2, "Second Movie", 2021, runtime: 110),
        };

        var result = await Run(Aggregator(tmdb), SearchContext.Any,
            Raw("First.Movie.2020.1080p.WEB-DL.x265-GROUP", 3_000_000_000, "f"),
            Raw("Second.Movie.2021.1080p.WEB-DL.x265-GROUP", 3_000_000_000, "s"));

        Assert.Equal(2, result.Works.Count);
        Assert.Contains(result.Works, w => w.WorkId == "tmdb-movie-1");
        Assert.Contains(result.Works, w => w.WorkId == "tmdb-movie-2");
    }

    [Fact]
    public async Task EmptyReleasesYieldNoWorks()
    {
        var result = await Run(Aggregator(new FakeTmdbClient()), SearchContext.Any);
        Assert.Empty(result.Works);
        Assert.Empty(result.Releases);
    }
}
