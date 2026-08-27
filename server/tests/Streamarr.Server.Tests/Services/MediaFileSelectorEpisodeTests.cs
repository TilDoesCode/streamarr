using Streamarr.Server.Services;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Nzb;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Server.Tests.Services;

/// <summary>
/// Season pack payload selection: SelectForEpisode must identify the requested
/// episode's file or RAR set inside a multi-episode NZB, and EpisodeTarget must
/// parse workIds and match release-style file names.
/// </summary>
public class MediaFileSelectorEpisodeTests
{
    private static async Task<NzbDocument> ParseNzb(params PublishedNzbFile[] files)
    {
        var xml = NzbTestFixtures.BuildNzbXml(files);
        using var ms = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(xml));
        return await NzbDocument.LoadAsync(ms);
    }

    // ---------------------------------------------------------------- EpisodeTarget

    [Theory]
    [InlineData("tmdb-tv-37680-s01e02", 1, 2)]
    [InlineData("tmdb-tv-1-s10e22", 10, 22)]
    [InlineData("tmdb-tv-999-s00e05", 0, 5)]
    public void FromWorkId_ParsesCanonicalEpisodeWorkIds(string workId, int season, int episode)
    {
        var target = EpisodeTarget.FromWorkId(workId);
        Assert.Equal(new EpisodeTarget(season, episode), target);
    }

    [Theory]
    [InlineData("tmdb-movie-42")]
    [InlineData("tmdb-tv-37680")]
    [InlineData("tmdb-tv-37680-s01")]
    [InlineData("unmatched-tv-some-title-s01-e02")]
    [InlineData("")]
    [InlineData(null)]
    public void FromWorkId_RejectsNonEpisodeWorkIds(string? workId)
        => Assert.Null(EpisodeTarget.FromWorkId(workId));

    [Theory]
    [InlineData("Show.S01E15.1080p.WEB-DL.x264-GRP.mkv", true)]
    [InlineData("Show.S01E15.mkv", true)]
    [InlineData("Show.S01E15", true)] // RAR archive base name, no extension
    [InlineData("show 1x15 remastered.mkv", true)]
    [InlineData("Show.S01E14E15.720p.mkv", true)] // double episode containing e15
    [InlineData("Show.S01E14.mkv", false)]
    [InlineData("Show.S02E15.mkv", false)] // wrong season
    [InlineData("Show.S01.1080p.BluRay.mkv", false)] // season pack marker, no episode
    [InlineData("a9f3k2j8s7d6.mkv", false)] // obfuscated
    [InlineData("", false)]
    public void MatchesFileName_UsesReleaseStyleNumbering(string name, bool expected)
        => Assert.Equal(expected, new EpisodeTarget(1, 15).MatchesFileName(name));

    // ---------------------------------------------------------------- direct-file packs

    [Fact]
    public async Task SelectForEpisode_DirectPack_PicksTheEpisodesOwnFile()
    {
        await using var server = new MockNntpServer();
        var nzb = await ParseNzb(
            NzbTestFixtures.PublishFile(server, "Show.S01E01.mkv", YencTestEncoder.LcgBytes(1, 40_000), "e01"),
            NzbTestFixtures.PublishFile(server, "Show.S01E02.mkv", YencTestEncoder.LcgBytes(2, 60_000), "e02"),
            NzbTestFixtures.PublishFile(server, "Show.S01E03.mkv", YencTestEncoder.LcgBytes(3, 50_000), "e03"),
            NzbTestFixtures.PublishFile(server, "Show.S01.par2", YencTestEncoder.LcgBytes(4, 2_000), "par2"));

        var candidate = MediaFileSelector.SelectForEpisode(nzb, new EpisodeTarget(1, 2), strict: true);

        Assert.NotNull(candidate);
        Assert.False(candidate!.IsRarWrapped);
        Assert.Equal("Show.S01E02.mkv", candidate.DisplayName);
        Assert.Single(candidate.Files);
        // health sampling is scoped to the selected episode's articles only
        Assert.All(candidate.HealthSegmentIds, id => Assert.StartsWith("e02", id));
    }

    [Fact]
    public async Task SelectForEpisode_PrefersTheLargerMatch_OverASampleOfTheSameEpisode()
    {
        await using var server = new MockNntpServer();
        var nzb = await ParseNzb(
            NzbTestFixtures.PublishFile(server, "Show.S01E02.sample.mkv", YencTestEncoder.LcgBytes(5, 8_000), "sample"),
            NzbTestFixtures.PublishFile(server, "Show.S01E02.mkv", YencTestEncoder.LcgBytes(2, 60_000), "full"));

        var candidate = MediaFileSelector.SelectForEpisode(nzb, new EpisodeTarget(1, 2), strict: true);

        Assert.Equal("Show.S01E02.mkv", candidate!.DisplayName);
    }

    // ---------------------------------------------------------------- per-episode RAR sets

    [Fact]
    public async Task SelectForEpisode_PerEpisodeRarSets_PicksTheMatchingSet()
    {
        await using var server = new MockNntpServer();
        var e1 = Rar4TestWriter.WriteMultiVolume("Show.S01E01.1080p", "Show.S01E01.mkv", YencTestEncoder.LcgBytes(1, 90_000), 50_000);
        var e2 = Rar4TestWriter.WriteMultiVolume("Show.S01E02.1080p", "Show.S01E02.mkv", YencTestEncoder.LcgBytes(2, 90_000), 50_000);
        var files = e1.Select((v, i) => NzbTestFixtures.PublishFile(server, v.FileName, v.Bytes, $"e01v{i}"))
            .Concat(e2.Select((v, i) => NzbTestFixtures.PublishFile(server, v.FileName, v.Bytes, $"e02v{i}")))
            .ToArray();
        var nzb = await ParseNzb(files);

        var candidate = MediaFileSelector.SelectForEpisode(nzb, new EpisodeTarget(1, 2), strict: true);

        Assert.NotNull(candidate);
        Assert.True(candidate!.IsRarWrapped);
        Assert.StartsWith("Show.S01E02.1080p", candidate.DisplayName);
        Assert.Equal(2, candidate.Files.Count);
        Assert.All(candidate.HealthSegmentIds, id => Assert.StartsWith("e02", id));
    }

    // ---------------------------------------------------------------- monolithic set

    [Fact]
    public async Task SelectForEpisode_SingleRarSet_IsReturnedWhole_EvenPastANonMatchingSample()
    {
        await using var server = new MockNntpServer();
        var pack = Rar4TestWriter.WriteMultiVolumePack(
            "Show.S01.1080p",
            [("Show.S01E01.mkv", YencTestEncoder.LcgBytes(1, 60_000)), ("Show.S01E02.mkv", YencTestEncoder.LcgBytes(2, 60_000))],
            50_000);
        var files = pack.Select((v, i) => NzbTestFixtures.PublishFile(server, v.FileName, v.Bytes, $"packv{i}"))
            .Append(NzbTestFixtures.PublishFile(server, "sample.mkv", YencTestEncoder.LcgBytes(9, 5_000), "sample"))
            .ToArray();
        var nzb = await ParseNzb(files);

        var candidate = MediaFileSelector.SelectForEpisode(nzb, new EpisodeTarget(1, 2), strict: true);

        Assert.NotNull(candidate);
        Assert.True(candidate!.IsRarWrapped);
        Assert.Equal(pack.Count, candidate.Files.Count);
    }

    // ---------------------------------------------------------------- ambiguity

    [Fact]
    public async Task SelectForEpisode_AmbiguousObfuscatedSets_FailsStrict_FallsBackLenient()
    {
        await using var server = new MockNntpServer();
        var a = Rar4TestWriter.WriteMultiVolume("a9f3k2", "a9f3k2.mkv", YencTestEncoder.LcgBytes(1, 40_000), 50_000);
        var b = Rar4TestWriter.WriteMultiVolume("z7q1x5", "z7q1x5.mkv", YencTestEncoder.LcgBytes(2, 80_000), 50_000);
        var files = a.Select((v, i) => NzbTestFixtures.PublishFile(server, v.FileName, v.Bytes, $"av{i}"))
            .Concat(b.Select((v, i) => NzbTestFixtures.PublishFile(server, v.FileName, v.Bytes, $"bv{i}")))
            .ToArray();
        var nzb = await ParseNzb(files);

        // A known pack must never guess: two unidentifiable sets → no candidate.
        Assert.Null(MediaFileSelector.SelectForEpisode(nzb, new EpisodeTarget(1, 5), strict: true));

        // A single-episode release keeps the historical largest-payload behavior.
        var lenient = MediaFileSelector.SelectForEpisode(nzb, new EpisodeTarget(1, 5), strict: false);
        Assert.NotNull(lenient);
        Assert.Equal(MediaFileSelector.SelectPrimary(nzb)!.DisplayName, lenient!.DisplayName);
    }
}
