using Microsoft.Extensions.DependencyInjection;
using Streamarr.Core.Media;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Integration;

[Collection("search-endpoint")]
public sealed class NextEpisodeResolverTests : IClassFixture<SearchEndpointTests.Factory>
{
    private readonly SearchEndpointTests.Factory _factory;

    public NextEpisodeResolverTests(SearchEndpointTests.Factory factory) => _factory = factory;

    [Fact]
    public async Task ResolveAsync_SelectsNextCanonicalEpisodeInSameSeason()
    {
        var resolver = _factory.Services.GetRequiredService<NextEpisodeResolver>();

        var target = await resolver.ResolveAsync("tmdb-tv-37680-s01e01", CancellationToken.None);

        Assert.NotNull(target);
        Assert.Equal("tmdb-tv-37680-s01e02", target.WorkId);
        Assert.Equal(1, target.SeasonNumber);
        Assert.Equal(2, target.EpisodeNumber);
        Assert.Contains("S01E02", target.Title, StringComparison.Ordinal);
        Assert.NotNull(_factory.Services.GetRequiredService<IReleaseStore>()
            .Get(target.ReleaseId, target.WorkId));
    }

    [Theory]
    [InlineData("tmdb-tv-37680-s01e03", "tmdb-tv-37680-s02e01", 2)]
    [InlineData("tmdb-tv-37680-s00e01", "tmdb-tv-37680-s01e01", 1)]
    public async Task ResolveAsync_CrossesToNextRegularSeasonAndSkipsSpecials(
        string sourceWorkId,
        string expectedWorkId,
        int expectedSeason)
    {
        var resolver = _factory.Services.GetRequiredService<NextEpisodeResolver>();

        var target = await resolver.ResolveAsync(sourceWorkId, CancellationToken.None);

        Assert.NotNull(target);
        Assert.Equal(expectedWorkId, target.WorkId);
        Assert.Equal(expectedSeason, target.SeasonNumber);
        Assert.Equal(1, target.EpisodeNumber);
    }

    [Theory]
    [InlineData("tmdb-movie-37680")]
    [InlineData("tmdb-tv-37680")]
    [InlineData("tmdb-tv-37680-s01e01-extra")]
    [InlineData("tmdb-tv-0-s01e01")]
    public async Task ResolveAsync_ReturnsNullForNonCanonicalWorkId(string workId)
    {
        var resolver = _factory.Services.GetRequiredService<NextEpisodeResolver>();

        Assert.Null(await resolver.ResolveAsync(workId, CancellationToken.None));
    }

    [Fact]
    public async Task ResolveAsync_ReturnsNullWhenCanonicalNextEpisodeHasNoRelease()
    {
        var resolver = _factory.Services.GetRequiredService<NextEpisodeResolver>();

        Assert.Null(await resolver.ResolveAsync("tmdb-tv-37680-s01e02", CancellationToken.None));
    }

    [Fact]
    public async Task ResolveAsync_UsesHighestScoredUsableRelease()
    {
        var resolver = _factory.Services.GetRequiredService<NextEpisodeResolver>();
        var store = _factory.Services.GetRequiredService<IReleaseStore>();
        var initial = await resolver.ResolveAsync("tmdb-tv-37680-s01e01", CancellationToken.None);
        Assert.NotNull(initial);

        store.Register(initial.WorkId, TestRelease("rejected-higher-score", 100_000, rejected: true));
        store.Register(initial.WorkId, TestRelease("dead-higher-score", 99_999, health: ReleaseHealth.Dead));
        store.Register(initial.WorkId, TestRelease("healthy-highest-score", 99_998));
        store.Register(initial.WorkId, TestRelease("healthy-lower-score", 99_997));

        var target = await resolver.ResolveAsync("tmdb-tv-37680-s01e01", CancellationToken.None);

        Assert.NotNull(target);
        Assert.Equal("healthy-highest-score", target.ReleaseId);
    }

    private static Release TestRelease(
        string releaseId,
        int score,
        bool rejected = false,
        ReleaseHealth health = ReleaseHealth.Unknown)
        => new()
        {
            ReleaseId = releaseId,
            Title = $"Suits.S01E02.1080p.WEB-DL-{releaseId}",
            Indexer = "next-episode-test",
            SizeBytes = 3_000_000_000,
            Score = score,
            Rejected = rejected,
            Health = health,
            NzbUrl = $"https://nzb.example/{releaseId}.nzb",
        };
}
