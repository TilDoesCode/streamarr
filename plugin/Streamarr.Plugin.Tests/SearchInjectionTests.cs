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
    public void BuildHint_maps_materialized_artwork_tags()
    {
        var id = Guid.NewGuid();

        var hint = SearchInjection.BuildHint(
            id,
            Movie("tmdb-movie-1", "Example"),
            primaryImageTag: "primary-tag",
            backdropImageTag: "backdrop-tag");

        Assert.Equal("primary-tag", hint.PrimaryImageTag);
        Assert.Equal("backdrop-tag", hint.BackdropImageTag);
        Assert.Equal(id.ToString("N"), hint.BackdropImageItemId);
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

    [Fact]
    public void BuildSeriesHint_maps_series_as_folder_with_artwork()
    {
        var id = Guid.NewGuid();
        var series = new TvSeriesDto
        {
            WorkId = "tmdb-tv-37680",
            TmdbId = 37680,
            Title = "Suits",
            Year = 2011,
            RuntimeMinutes = 42,
        };

        var hint = SearchInjection.BuildSeriesHint(id, series, "poster-tag", "backdrop-tag");

        Assert.Equal(id, hint.Id);
        Assert.Equal("Suits", hint.Name);
        Assert.Equal(BaseItemKind.Series, hint.Type);
        Assert.Equal(MediaType.Video, hint.MediaType);
        Assert.True(hint.IsFolder);
        Assert.Equal(2011, hint.ProductionYear);
        Assert.Equal(TimeSpan.FromMinutes(42).Ticks, hint.RunTimeTicks);
        Assert.Equal("poster-tag", hint.PrimaryImageTag);
        Assert.Equal("backdrop-tag", hint.BackdropImageTag);
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
            null,
            MediaType.Unknown);

        Assert.Equal(3, root.RemainingCapacity(nativeCount: 2, defaultLimit: 20));
        Assert.Equal("movie", root.CoreMediaType);
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
        Assert.Equal(
            "tv",
            (root with { IncludeItemTypes = new HashSet<BaseItemKind> { BaseItemKind.Episode } }).CoreMediaType);
        Assert.Null((root with
        {
            IncludeItemTypes = new HashSet<BaseItemKind> { BaseItemKind.Movie, BaseItemKind.Episode },
        }).CoreMediaType);
    }

    [Fact]
    public void Constraints_allow_series_discovery_only_when_native_filters_allow_series()
    {
        var series = new TvSeriesDto
        {
            WorkId = "tmdb-tv-37680",
            TmdbId = 37680,
            Title = "Suits",
        };
        var global = new SearchInjection.Constraints(
            0,
            20,
            null,
            new HashSet<BaseItemKind>(),
            new HashSet<BaseItemKind>(),
            new HashSet<MediaType>(),
            true,
            null,
            null,
            MediaType.Unknown);

        Assert.True(global.AllowsMovieDiscovery);
        Assert.True(global.AllowsSeriesDiscovery);
        Assert.True(global.AllowsSeries(series));
        Assert.True((global with
        {
            MediaTypes = new HashSet<MediaType> { MediaType.Video },
            SeriesMediaType = MediaType.Video,
        }).AllowsSeriesDiscovery);
        Assert.False((global with
        {
            MediaTypes = new HashSet<MediaType> { MediaType.Video },
        }).AllowsSeriesDiscovery);
        Assert.False((global with { IsMovie = true }).AllowsSeriesDiscovery);
        Assert.True((global with { IsSeries = true }).AllowsSeriesDiscovery);
        Assert.False((global with { IsSeries = false }).AllowsSeriesDiscovery);
        Assert.False((global with
        {
            IncludeItemTypes = new HashSet<BaseItemKind> { BaseItemKind.Movie },
        }).AllowsSeriesDiscovery);
        Assert.False((global with
        {
            ExcludeItemTypes = new HashSet<BaseItemKind> { BaseItemKind.Series },
        }).AllowsSeries(series));
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
            null,
            MediaType.Unknown);

        Assert.False(constraints.CanInjectAtRoot);
        Assert.Equal(0, constraints.RemainingCapacity(0, 20));
        Assert.False(constraints.Allows(Movie("movie", "Movie")));
    }

    [Fact]
    public void Jellyfin_web_grouped_search_accepts_non_missing_movies_and_series()
    {
        var context = new DefaultHttpContext();
        context.Request.QueryString = new QueryString(
            "?userId=10000000-0000-0000-0000-000000000001"
            + "&recursive=true"
            + "&searchTerm=Suits"
            + "&includeItemTypes=Movie,Series,Episode,Playlist,MusicAlbum,Audio,TvChannel,PhotoAlbum,Photo,AudioBook,Book,BoxSet"
            + "&isMissing=false"
            + "&limit=800"
            + "&fields=PrimaryImageAspectRatio,CanDelete,MediaSourceCount"
            + "&enableTotalRecordCount=false"
            + "&imageTypeLimit=1");

        var constraints = StreamarrSearchActionFilter.GetConstraints(
            context.Request,
            isHintRequest: false);

        Assert.True(constraints.IsValid);
        Assert.True(constraints.CanInjectAtRoot);
        Assert.True(constraints.AllowsMovieDiscovery);
        Assert.True(constraints.AllowsSeriesDiscovery);
    }

    [Fact]
    public void Jellyfin_web_generic_video_search_excludes_structured_movies_and_series()
    {
        var context = new DefaultHttpContext();
        context.Request.QueryString = new QueryString(
            "?userId=10000000-0000-0000-0000-000000000001"
            + "&recursive=true"
            + "&searchTerm=Suits"
            + "&mediaTypes=Video"
            + "&excludeItemTypes=Movie,Episode,TvChannel"
            + "&fields=PrimaryImageAspectRatio,CanDelete,MediaSourceCount"
            + "&enableTotalRecordCount=false"
            + "&imageTypeLimit=1");

        var constraints = StreamarrSearchActionFilter.GetConstraints(
            context.Request,
            isHintRequest: false);

        Assert.True(constraints.IsValid);
        Assert.False(constraints.AllowsMovieDiscovery);
        Assert.False(constraints.AllowsSeriesDiscovery);
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
    [InlineData("?isMissing=perhaps")]
    [InlineData("?isMissing=true")]
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

    [Theory]
    [InlineData("/Items", false, true)]
    [InlineData("/items", false, true)]
    [InlineData("/Search/Hints", true, true)]
    [InlineData("/Artists", false, false)]
    [InlineData("/Persons", false, false)]
    [InlineData("/Items/RemoteSearch/Movie", false, false)]
    [InlineData("/Items", true, false)]
    public void Interception_is_scoped_to_media_search_routes(
        string path,
        bool isHintRequest,
        bool expected)
    {
        Assert.Equal(
            expected,
            StreamarrSearchActionFilter.IsSupportedSearchPath(new PathString(path), isHintRequest));
    }

    [Theory]
    [InlineData("/Shows/10000000-0000-0000-0000-000000000001/Seasons", true)]
    [InlineData("/shows/10000000-0000-0000-0000-000000000001/episodes", true)]
    [InlineData("/Shows/not-a-guid/Seasons", false)]
    [InlineData("/Shows/10000000-0000-0000-0000-000000000001/NextUp", false)]
    [InlineData("/Items/10000000-0000-0000-0000-000000000001", false)]
    public void Hierarchy_interception_is_scoped_to_show_navigation_routes(string path, bool expected)
        => Assert.Equal(expected, StreamarrSearchActionFilter.IsSupportedHierarchyPath(new PathString(path)));

    [Theory]
    [InlineData("", BaseItemKind.Season, true)]
    [InlineData("?includeItemTypes=Season", BaseItemKind.Season, true)]
    [InlineData("?includeItemTypes=Episode", BaseItemKind.Season, false)]
    [InlineData("?excludeItemTypes=Season", BaseItemKind.Season, false)]
    [InlineData("?mediaTypes=Video", BaseItemKind.Episode, true)]
    [InlineData("?mediaTypes=Audio", BaseItemKind.Episode, false)]
    [InlineData("?includeItemTypes=NotAType", BaseItemKind.Season, false)]
    [InlineData("?isMissing=true&isSpecialSeason=false&sortBy=SortName&fields=Overview", BaseItemKind.Episode, true)]
    public void Hierarchy_population_parses_kind_constraints_and_leaves_other_semantics_native(
        string query,
        BaseItemKind kind,
        bool expected)
    {
        var context = new DefaultHttpContext();
        context.Request.QueryString = new QueryString(query);

        Assert.Equal(expected, StreamarrSearchActionFilter.HierarchyAllowsKind(context.Request.Query, kind));
    }

    [Theory]
    [InlineData("?recursive=true&includeItemTypes=Episode", true)]
    [InlineData("?recursive=true&includeItemTypes=Season,Episode", true)]
    [InlineData("?recursive=true&excludeItemTypes=Episode", false)]
    [InlineData("?recursive=false&includeItemTypes=Episode", false)]
    [InlineData("?includeItemTypes=Episode", false)]
    public void Recursive_hierarchy_expands_episode_descendants_when_native_query_can_return_them(
        string query,
        bool expected)
    {
        var context = new DefaultHttpContext();
        context.Request.QueryString = new QueryString(query);

        Assert.Equal(expected, StreamarrSearchActionFilter.HierarchyAllowsRecursiveEpisodes(context.Request.Query));
    }
}
