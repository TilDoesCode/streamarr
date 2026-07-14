using Jellyfin.Data.Enums;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
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

    [Fact]
    public void Constraints_honor_page_parent_limit_types_and_media_filters()
    {
        var root = new SearchInjection.Constraints(
            0,
            5,
            null,
            new HashSet<BaseItemKind> { BaseItemKind.Movie },
            new HashSet<BaseItemKind>(),
            new HashSet<MediaType> { MediaType.Video },
            true,
            null,
            null);

        Assert.Equal(3, root.RemainingCapacity(nativeCount: 2, defaultLimit: 20));
        Assert.True(root.Allows(Movie("movie", "Movie")));
        Assert.False(root.Allows(new WorkDto { WorkId = "tv", MediaType = "tv" }));
        Assert.Equal(0, (root with { StartIndex = 1 }).RemainingCapacity(0, 20));
        Assert.Equal(0, (root with { ParentId = Guid.NewGuid() }).RemainingCapacity(0, 20));
        Assert.Equal(0, (root with { Limit = 2 }).RemainingCapacity(2, 20));
        Assert.False((root with { IncludeMedia = false }).Allows(Movie("movie", "Movie")));
        Assert.False((root with { MediaTypes = new HashSet<MediaType> { MediaType.Audio } })
            .Allows(Movie("movie", "Movie")));
        Assert.False((root with { ExcludeItemTypes = new HashSet<BaseItemKind> { BaseItemKind.Movie } })
            .Allows(Movie("movie", "Movie")));
    }

    [Fact]
    public void Constraints_do_not_repeat_synthetic_results_on_later_pages()
    {
        var constraints = new SearchInjection.Constraints(
            20,
            20,
            null,
            new HashSet<BaseItemKind>(),
            new HashSet<BaseItemKind>(),
            new HashSet<MediaType>(),
            true,
            null,
            null);

        Assert.False(constraints.CanInjectAtRoot);
        Assert.Equal(0, constraints.RemainingCapacity(0, 20));
        Assert.False(constraints.Allows(Movie("movie", "Movie")));
    }

    [Theory]
    [InlineData("?startIndex=not-a-number")]
    [InlineData("?limit=-1")]
    [InlineData("?parentId=not-a-guid")]
    [InlineData("?includeItemTypes=Movie,Bogus")]
    [InlineData("?includeItemTypes=Movie,,Episode")]
    [InlineData("?includeItemTypes=0")]
    [InlineData("?mediaTypes=unsupported")]
    [InlineData("?userId=00000000-0000-0000-0000-000000000000")]
    [InlineData("?isMovie=perhaps")]
    [InlineData("?recursive=false")]
    [InlineData("?tags=family")]
    [InlineData("?collapseBoxSetItems=true")]
    public void Malformed_or_unsupported_native_constraints_fail_closed(string queryString)
    {
        var context = new DefaultHttpContext();
        context.Request.QueryString = new QueryString(queryString);

        var constraints = StreamarrSearchActionFilter.GetConstraints(context.Request, isHintRequest: false);

        Assert.False(constraints.IsValid);
        Assert.False(constraints.CanInjectAtRoot);
    }
}
