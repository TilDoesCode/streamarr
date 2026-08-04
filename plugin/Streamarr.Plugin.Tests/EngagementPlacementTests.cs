using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// Engagement-gated library visibility: search hits materialize below the hidden staging root and
/// only deliberate engagement (playback/favorite/watched) moves a subtree into the visible
/// "Streamarr" library, where it stays as a permanent history until explicitly un-engaged.
/// </summary>
public class EngagementPlacementTests : IDisposable
{
    private readonly string _cacheRoot =
        Path.Combine(Path.GetTempPath(), "streamarr-placement-tests", Guid.NewGuid().ToString("N"));

    private readonly ConcurrentDictionary<Guid, BaseItem> _store = new();
    private readonly Dictionary<Guid, UserItemData> _engagement = new();
    private readonly Folder _userRoot = new() { Id = Guid.NewGuid(), Name = "user-root" };
    private readonly AggregateFolder _aggregateRoot = new() { Id = Guid.NewGuid(), Name = "aggregate-root" };
    private readonly ILibraryManager _libraryManager;
    private readonly EphemeralLibraryService _library;

    public EngagementPlacementTests()
    {
        var libraryManager = _libraryManager = Substitute.For<ILibraryManager>();
        libraryManager.GetNewItemId(Arg.Any<string>(), Arg.Any<Type>())
            .Returns(callInfo => DeterministicGuid((string)callInfo[0]!));
        libraryManager.GetItemById(Arg.Any<Guid>())
            .Returns(callInfo => _store.TryGetValue((Guid)callInfo[0]!, out var item) ? item : null);
        libraryManager.GetUserRootFolder().Returns(_userRoot);
        libraryManager.RootFolder.Returns(_aggregateRoot);
        libraryManager
            .When(x => x.CreateItems(Arg.Any<IReadOnlyList<BaseItem>>(), Arg.Any<BaseItem>(), Arg.Any<CancellationToken>()))
            .Do(callInfo =>
            {
                foreach (var item in (IReadOnlyList<BaseItem>)callInfo[0]!)
                    _store[item.Id] = item;
            });
        libraryManager
            .UpdateItemAsync(Arg.Any<BaseItem>(), Arg.Any<BaseItem>(), Arg.Any<ItemUpdateType>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                var item = (BaseItem)callInfo[0]!;
                _store[item.Id] = item;
                return Task.CompletedTask;
            });
        libraryManager
            .UpdateItemsAsync(Arg.Any<IReadOnlyList<BaseItem>>(), Arg.Any<BaseItem>(), Arg.Any<ItemUpdateType>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                foreach (var item in (IReadOnlyList<BaseItem>)callInfo[0]!)
                    _store[item.Id] = item;
                return Task.CompletedTask;
            });
        libraryManager.GetItemList(Arg.Any<InternalItemsQuery>())
            .Returns(callInfo =>
            {
                var query = (InternalItemsQuery)callInfo[0]!;
                return (IReadOnlyList<BaseItem>)_store.Values
                    .Where(item => item.ParentId == query.ParentId)
                    .ToList();
            });
        libraryManager
            .UpdatePeopleAsync(Arg.Any<BaseItem>(), Arg.Any<IReadOnlyList<PersonInfo>>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        libraryManager
            .When(x => x.DeleteItem(Arg.Any<BaseItem>(), Arg.Any<DeleteOptions>()))
            .Do(callInfo => _store.TryRemove(((BaseItem)callInfo[0]!).Id, out _));
        // Series.CreatePresentationUniqueKey consults the static library-manager for grouping options.
        libraryManager.GetLibraryOptions(Arg.Any<BaseItem>())
            .Returns(new MediaBrowser.Model.Configuration.LibraryOptions { EnableAutomaticSeriesGrouping = false });
        BaseItem.LibraryManager = libraryManager;

        var user = new User("streamarr-test", "auth", "reset");
        var userManager = Substitute.For<IUserManager>();
        userManager.GetUsers().Returns(_ => new[] { user });
        var userDataManager = Substitute.For<IUserDataManager>();
        userDataManager.GetUserData(Arg.Any<User>(), Arg.Any<BaseItem>())
            .Returns(callInfo =>
                _engagement.TryGetValue(((BaseItem)callInfo[1]!).Id, out var data)
                    ? data
                    : new UserItemData { Key = "none" });

        var artworkHandler = new StaticHandler();
        _library = new EphemeralLibraryService(
            libraryManager,
            new EphemeralReleaseStore(),
            new PlaybackSessionTracker(),
            new StubApplicationPaths(_cacheRoot),
            userManager,
            userDataManager,
            Substitute.For<IProviderManager>(),
            Substitute.For<IFileSystem>(),
            new ArtworkBadgeService(
                new StubHttpClientFactory(artworkHandler),
                new StubApplicationPaths(_cacheRoot),
                NullLogger<ArtworkBadgeService>.Instance),
            new HierarchyEnrichmentDispatcher(
                NullLogger<HierarchyEnrichmentDispatcher>.Instance),
            NullLogger<EphemeralLibraryService>.Instance);
    }

    [Fact]
    public async Task Search_hits_materialize_below_the_hidden_staging_root()
    {
        var itemId = await _library.MaterializeAsync(Movie("work-hidden"), CancellationToken.None);

        var item = Assert.Contains(itemId, (IDictionary<Guid, BaseItem>)_store);
        Assert.Equal(_library.StagingFolderId, item.ParentId);
        // The staging root hangs below the aggregate root (invisible in every user view); the
        // visible library folder hangs below the user root.
        Assert.Equal(_aggregateRoot.Id, _store[_library.StagingFolderId].ParentId);
        Assert.Equal(_userRoot.Id, _store[_library.FolderId].ParentId);
        Assert.False(Assert.Single(_library.GetLifecycleItems(), c => c.Item.Id == itemId).IsPromoted);
    }

    [Fact]
    public async Task Capacity_evicts_multiple_candidates_from_one_repository_snapshot()
    {
        await _library.MaterializeAsync(Movie("seed-0"), CancellationToken.None);
        for (var index = 1; index < EphemeralLibraryService.MaxEphemeralItems; index++)
        {
            var workId = $"seed-{index}";
            var item = new Movie
            {
                Id = _library.ItemIdFor(workId),
                Name = workId,
                ParentId = _library.StagingFolderId,
                ProviderIds = new Dictionary<string, string>
                {
                    [EphemeralLibraryService.WorkIdProviderKey] = workId,
                    [EphemeralLibraryService.OwnerProviderKey] = EphemeralLibraryService.OwnerProviderValue,
                },
                Tags = [EphemeralLibraryService.EphemeralTag, EphemeralLibraryService.StreamarrTag],
            };
            _store[item.Id] = item;
        }

        _libraryManager.ClearReceivedCalls();
        var series = new TvSeriesDto
        {
            WorkId = "replacement-series",
            Title = "Replacement",
            TmdbId = 4711,
            AddStreamarrBadge = false,
        };
        var seasons = Enumerable.Range(1, 4)
            .Select(index => new TvSeasonDto
            {
                WorkId = $"replacement-s{index:D2}",
                Title = $"Season {index}",
                TmdbId = 4711,
                SeasonNumber = index,
                EpisodeCount = 0,
            })
            .ToArray();
        await _library.MaterializeSeasonsAsync(
            new TvSeriesDetailsResponse { Series = series, Seasons = seasons },
            CancellationToken.None);

        Assert.Equal(
            EphemeralLibraryService.MaxEphemeralItems,
            EphemeralLibraryService.CountDescendants(_store.Values.ToArray(), _library.StagingFolderId));
        Assert.Equal(
            8,
            _libraryManager.ReceivedCalls().Count(call => call.GetMethodInfo().Name == nameof(ILibraryManager.GetItemList)));
        _libraryManager.Received(5).DeleteItem(Arg.Any<BaseItem>(), Arg.Any<DeleteOptions>());
    }

    [Fact]
    public async Task Engagement_promotes_a_movie_and_repeat_searches_keep_it_in_the_library()
    {
        var itemId = await _library.MaterializeAsync(Movie("work-promoted"), CancellationToken.None);

        Assert.True(await _library.TryPromoteToLibraryAsync(itemId, CancellationToken.None));
        Assert.Equal(_library.FolderId, _store[itemId].ParentId);
        Assert.True(Assert.Single(_library.GetLifecycleItems(), c => c.Item.Id == itemId).IsPromoted);

        // Promoting again is a no-op, and a repeat search must refresh in place (no throw, no
        // placement change) — the history never loses an item to a new search.
        Assert.False(await _library.TryPromoteToLibraryAsync(itemId, CancellationToken.None));
        var again = await _library.MaterializeAsync(Movie("work-promoted"), CancellationToken.None);
        Assert.Equal(itemId, again);
        Assert.Equal(_library.FolderId, _store[itemId].ParentId);
    }

    [Fact]
    public async Task Promoting_an_episode_moves_the_entire_series_hierarchy()
    {
        var (seriesId, seasonId, episodeIds) = await MaterializeSeriesWithEpisodesAsync("hier");
        Assert.Equal(_library.StagingFolderId, _store[seriesId].ParentId);

        Assert.True(await _library.TryPromoteToLibraryAsync(episodeIds[0], CancellationToken.None));

        Assert.Equal(_library.FolderId, _store[seriesId].ParentId);
        Assert.Equal(seriesId, _store[seasonId].ParentId);
        Assert.All(episodeIds, id => Assert.Equal(seasonId, _store[id].ParentId));
        Assert.All(
            _library.GetLifecycleItems().Where(c => c.SubtreeIds.Contains(seriesId)),
            c => Assert.True(c.IsPromoted));
    }

    [Fact]
    public async Task Reconcile_promotes_engaged_staging_items_and_demotes_unengaged_library_items()
    {
        var engagedId = await _library.MaterializeAsync(Movie("work-engaged"), CancellationToken.None);
        var spamId = await _library.MaterializeAsync(Movie("work-spam"), CancellationToken.None);
        Assert.True(await _library.TryPromoteToLibraryAsync(spamId, CancellationToken.None));
        _engagement[engagedId] = new UserItemData { Key = "k", Played = true };

        var (promoted, demoted) = await _library.ReconcileEngagementPlacementAsync(CancellationToken.None);

        Assert.Equal(1, promoted);
        Assert.Equal(1, demoted);
        Assert.Equal(_library.FolderId, _store[engagedId].ParentId);
        Assert.Equal(_library.StagingFolderId, _store[spamId].ParentId);
    }

    [Fact]
    public async Task Demotion_refuses_while_any_user_still_holds_engagement()
    {
        var itemId = await _library.MaterializeAsync(Movie("work-sticky"), CancellationToken.None);
        Assert.True(await _library.TryPromoteToLibraryAsync(itemId, CancellationToken.None));
        _engagement[itemId] = new UserItemData { Key = "k", IsFavorite = true };

        Assert.False(await _library.TryDemoteFromLibraryAsync(itemId, CancellationToken.None));
        Assert.Equal(_library.FolderId, _store[itemId].ParentId);

        // Removing the last engagement signal (unfavorite) makes the explicit removal succeed.
        _engagement.Remove(itemId);
        Assert.True(await _library.TryDemoteFromLibraryAsync(itemId, CancellationToken.None));
        Assert.Equal(_library.StagingFolderId, _store[itemId].ParentId);
    }

    [Fact]
    public async Task Promotion_rejects_items_the_plugin_does_not_own()
    {
        var foreign = new Folder { Id = Guid.NewGuid(), Name = "foreign", ParentId = _userRoot.Id };
        _store[foreign.Id] = foreign;

        Assert.False(await _library.TryPromoteToLibraryAsync(foreign.Id, CancellationToken.None));
        Assert.Equal(_userRoot.Id, foreign.ParentId);
    }

    [Fact]
    public async Task Legacy_staged_items_are_upgraded_against_their_actual_parent()
    {
        var itemId = await _library.MaterializeAsync(Movie("work-legacy-staged"), CancellationToken.None);
        var current = _store[itemId];
        _store[itemId] = new StreamarrMovie
        {
            Id = itemId,
            Name = current.Name,
            ParentId = _library.StagingFolderId,
            ProviderIds = new Dictionary<string, string>(current.ProviderIds, StringComparer.OrdinalIgnoreCase),
            Tags = current.Tags,
            IsVirtualItem = true,
        };

        await _library.EnsureLibraryIntegrationAsync(CancellationToken.None);

        await _libraryManager.Received().UpdateItemsAsync(
            Arg.Is<IReadOnlyList<BaseItem>>(items => items.Any(item => item.Id == itemId)),
            Arg.Is<BaseItem>(parent => parent.Id == _library.StagingFolderId),
            ItemUpdateType.MetadataEdit,
            Arg.Any<CancellationToken>());
        Assert.Equal(_library.StagingFolderId, _store[itemId].ParentId);
    }

    private async Task<(Guid SeriesId, Guid SeasonId, IReadOnlyList<Guid> EpisodeIds)> MaterializeSeriesWithEpisodesAsync(
        string prefix)
    {
        var series = new TvSeriesDto
        {
            WorkId = $"{prefix}-series",
            Title = "Series",
            TmdbId = 4711,
            AddStreamarrBadge = false,
        };
        var season = new TvSeasonDto
        {
            WorkId = $"{prefix}-s01",
            Title = "Season 1",
            TmdbId = 4711,
            SeasonNumber = 1,
            EpisodeCount = 2,
        };
        await _library.MaterializeSeasonsAsync(
            new TvSeriesDetailsResponse { Series = series, Seasons = [season] },
            CancellationToken.None);
        var episodes = new[]
        {
            new TvEpisodeDto
            {
                WorkId = $"{prefix}-s01e01", Title = "E1", SeriesTitle = "Series",
                TmdbId = 4711, SeasonNumber = 1, EpisodeNumber = 1, AddStreamarrBadge = false,
            },
            new TvEpisodeDto
            {
                WorkId = $"{prefix}-s01e02", Title = "E2", SeriesTitle = "Series",
                TmdbId = 4711, SeasonNumber = 1, EpisodeNumber = 2, AddStreamarrBadge = false,
            },
        };
        var episodeIds = await _library.MaterializeEpisodesAsync(
            new TvSeasonDetailsResponse { Series = series, Season = season, Episodes = episodes },
            CancellationToken.None);
        return (
            _library.ItemIdFor(series.WorkId),
            _library.ItemIdFor(season.WorkId),
            episodeIds.Where(id => id != _library.ItemIdFor(series.WorkId)
                                   && id != _library.ItemIdFor(season.WorkId)).ToArray());
    }

    private static WorkDto Movie(string workId) => new()
    {
        WorkId = workId,
        MediaType = "movie",
        Title = workId,
        AddStreamarrBadge = false,
    };

    private static Guid DeterministicGuid(string key)
    {
        var hash = MD5.HashData(Encoding.UTF8.GetBytes(key));
        return new Guid(hash);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_cacheRoot))
                Directory.Delete(_cacheRoot, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort cleanup.
        }
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class StaticHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }

    private sealed class StubApplicationPaths(string cachePath) : IApplicationPaths
    {
        public string CachePath { get; } = cachePath;

        public string ProgramDataPath => CachePath;
        public string WebPath => CachePath;
        public string ProgramSystemPath => CachePath;
        public string DataPath => CachePath;
        public string VirtualDataPath => CachePath;
        public string ImageCachePath => CachePath;
        public string PluginsPath => CachePath;
        public string PluginConfigurationsPath => CachePath;
        public string LogDirectoryPath => CachePath;
        public string ConfigurationDirectoryPath => CachePath;
        public string SystemConfigurationFilePath => CachePath;
        public string TempDirectory => CachePath;
        public string TrickplayPath => CachePath;
        public string BackupPath => CachePath;

        public void MakeSanityCheckOrThrow()
        {
        }

        public void CreateAndCheckMarker(string directory, string markerName, bool recursive = false)
        {
        }
    }
}
