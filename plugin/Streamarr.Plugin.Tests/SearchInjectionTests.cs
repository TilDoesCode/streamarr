using Jellyfin.Data.Enums;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Search;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Search;

namespace Streamarr.Plugin.Tests;

public class SearchInjectionTests
{
    private static WorkDto Movie(string workId, string title, int? year = 2021, int runtime = 130) => new()
    {
        WorkId = workId,
        Title = title,
        MediaType = "movie",
        Year = year,
        RuntimeMinutes = runtime,
        Releases = [new ReleaseDto { ReleaseId = workId + "-r", Title = title, Indexer = "demo", Quality = new QualityDto() }],
    };

    [Fact]
    public void MergeItems_appends_injected_after_native_and_dedupes_by_id()
    {
        var nativeId = Guid.NewGuid();
        var injectedId = Guid.NewGuid();
        var native = new List<BaseItemDto> { new() { Id = nativeId, Name = "Local" } };
        var injected = new List<BaseItemDto>
        {
            new() { Id = injectedId, Name = "Usenet" },
            new() { Id = nativeId, Name = "Dup-of-local" }, // duplicate id must be dropped
        };

        var merged = SearchInjection.MergeItems(native, injected);

        Assert.Equal(2, merged.Count);
        Assert.Equal(nativeId, merged[0].Id); // native first
        Assert.Equal(injectedId, merged[1].Id);
    }

    [Fact]
    public void MergeItems_returns_same_instance_when_nothing_injected()
    {
        var native = new List<BaseItemDto> { new() { Id = Guid.NewGuid() } };
        Assert.Same(native, SearchInjection.MergeItems(native, []));
    }

    [Fact]
    public void MergeItems_skips_empty_guid_injected()
    {
        var native = new List<BaseItemDto>();
        var injected = new List<BaseItemDto> { new() { Id = Guid.Empty, Name = "no-id" } };
        Assert.Empty(SearchInjection.MergeItems(native, injected));
    }

    [Fact]
    public void MergeHints_appends_and_dedupes_by_id()
    {
        var sharedId = Guid.NewGuid();
        var native = new List<SearchHint> { new() { Id = sharedId, Name = "Local" } };
        var injected = new List<SearchHint>
        {
            new() { Id = sharedId, Name = "Dup" },
            new() { Id = Guid.NewGuid(), Name = "Usenet" },
        };

        var merged = SearchInjection.MergeHints(native, injected);

        Assert.Equal(2, merged.Count);
        Assert.Equal("Usenet", merged[1].Name);
    }

    [Fact]
    public void BuildHint_maps_movie_fields()
    {
        var id = Guid.NewGuid();
        var hint = SearchInjection.BuildHint(id, Movie("tmdb-movie-1", "Example", 2021, 130));

        Assert.Equal(id, hint.Id);
        Assert.Equal("Example", hint.Name);
        Assert.Equal(2021, hint.ProductionYear);
        Assert.Equal(BaseItemKind.Movie, hint.Type);
        Assert.Equal(MediaType.Video, hint.MediaType);
        Assert.False(hint.IsFolder);
        Assert.Equal(TimeSpan.FromMinutes(130).Ticks, hint.RunTimeTicks);
    }

    [Fact]
    public void BuildHint_maps_tv_work_to_episode_with_index_numbers()
    {
        var work = new WorkDto
        {
            WorkId = "tmdb-tv-9",
            Title = "Show",
            MediaType = "tv",
            Season = 2,
            Episode = 5,
        };

        var hint = SearchInjection.BuildHint(Guid.NewGuid(), work);

        Assert.Equal(BaseItemKind.Episode, hint.Type);
        Assert.Equal(5, hint.IndexNumber);
        Assert.Equal(2, hint.ParentIndexNumber);
        Assert.Null(hint.RunTimeTicks); // no runtime provided
    }

    [Theory]
    [InlineData("movie", BaseItemKind.Movie)]
    [InlineData("tv", BaseItemKind.Episode)]
    [InlineData("episode", BaseItemKind.Episode)]
    public void KindFor_maps_media_type(string mediaType, BaseItemKind expected)
        => Assert.Equal(expected, SearchInjection.KindFor(new WorkDto { MediaType = mediaType }));
}
