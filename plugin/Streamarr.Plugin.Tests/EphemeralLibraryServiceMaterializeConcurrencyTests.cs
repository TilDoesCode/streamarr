using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
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
/// Regression coverage for the bug report "metadata loads unreliably in Streamyfin and Jellyfin
/// Web" (see EphemeralLibraryService's <c>_materializeGate</c> remarks). Before the fix, every
/// <c>Materialize*Async</c> entry point acquired the single plugin-wide <c>_materializeGate</c>
/// BEFORE fetching/badging TMDB artwork, so one client materializing a work whose poster download
/// was slow (a flaky CDN, or TMDB itself under load) would stall a completely unrelated
/// materialization requested by a different client for the same duration. With two clients open
/// at once — literally what the bug report describes: Jellyfin Web and Streamyfin — this reads as
/// "unreliable, and it depends on what else is happening at the time."
/// </summary>
public class EphemeralLibraryServiceMaterializeConcurrencyTests : IDisposable
{
    private readonly string _cacheRoot =
        Path.Combine(Path.GetTempPath(), "streamarr-materialize-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Materializing_one_work_does_not_block_an_unrelated_works_materialization_behind_a_slow_artwork_download()
    {
        var slowRequestStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSlowRequest = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        var handler = new AsyncCallbackHandler(async request =>
        {
            if (request.RequestUri!.AbsolutePath.Contains("slow", StringComparison.Ordinal))
            {
                slowRequestStarted.TrySetResult();
                await releaseSlowRequest.Task.ConfigureAwait(false);
            }

            // Any non-transient status makes ArtworkBadgeService fail open to the source URL
            // without retrying — we only care about how long the download itself was held open.
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        });

        var (library, store) = CreateService(handler);

        var slowWork = MakeWork("work-slow", posterUrl: "https://image.tmdb.org/t/p/w780/slow.jpg");
        var fastWork = MakeWork("work-fast", posterUrl: null); // no poster: zero network I/O at all

        var slowTask = library.MaterializeAsync(slowWork, CancellationToken.None);
        await slowRequestStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var stopwatch = Stopwatch.StartNew();
        var fastTask = library.MaterializeAsync(fastWork, CancellationToken.None);
        var finishedFirst = await Task.WhenAny(fastTask, Task.Delay(TimeSpan.FromSeconds(2)));
        stopwatch.Stop();

        Assert.Same(fastTask, finishedFirst);
        Assert.True(
            fastTask.IsCompletedSuccessfully,
            "The unrelated 'fast' work should materialize while the 'slow' work's artwork download is still in flight.");
        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(1),
            $"Fast materialization took {stopwatch.Elapsed} — it looks serialized behind the slow artwork download.");

        // Let the slow download finish and confirm both works ultimately land correctly; the fix
        // only changes ordering/lock scope, never the end result.
        releaseSlowRequest.TrySetResult();
        var slowId = await slowTask.WaitAsync(TimeSpan.FromSeconds(5));
        var fastId = await fastTask;

        Assert.True(store.ContainsKey(slowId));
        Assert.True(store.ContainsKey(fastId));
        Assert.NotEqual(slowId, fastId);
    }

    private static WorkDto MakeWork(string workId, string? posterUrl) => new()
    {
        WorkId = workId,
        MediaType = "movie",
        Title = workId,
        PosterUrl = posterUrl,
        AddStreamarrBadge = posterUrl is not null,
    };

    private (EphemeralLibraryService Library, ConcurrentDictionary<Guid, BaseItem> Store) CreateService(
        HttpMessageHandler artworkHandler)
    {
        var store = new ConcurrentDictionary<Guid, BaseItem>();
        var libraryManager = Substitute.For<ILibraryManager>();

        libraryManager.GetNewItemId(Arg.Any<string>(), Arg.Any<Type>())
            .Returns(callInfo => DeterministicGuid((string)callInfo[0]!));

        libraryManager.GetItemById(Arg.Any<Guid>())
            .Returns(callInfo => store.TryGetValue((Guid)callInfo[0]!, out var item) ? item : null);

        var userRoot = new Folder { Id = Guid.NewGuid(), Name = "root" };
        libraryManager.GetUserRootFolder().Returns(userRoot);
        var aggregateRoot = new AggregateFolder { Id = Guid.NewGuid(), Name = "aggregate-root" };
        libraryManager.RootFolder.Returns(aggregateRoot);

        libraryManager
            .When(x => x.CreateItems(Arg.Any<IReadOnlyList<BaseItem>>(), Arg.Any<BaseItem>(), Arg.Any<CancellationToken>()))
            .Do(callInfo =>
            {
                foreach (var item in (IReadOnlyList<BaseItem>)callInfo[0]!)
                    store[item.Id] = item;
            });

        libraryManager
            .UpdateItemAsync(Arg.Any<BaseItem>(), Arg.Any<BaseItem>(), Arg.Any<ItemUpdateType>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                var item = (BaseItem)callInfo[0]!;
                store[item.Id] = item;
                return Task.CompletedTask;
            });

        libraryManager.GetItemList(Arg.Any<InternalItemsQuery>())
            .Returns(callInfo =>
            {
                var query = (InternalItemsQuery)callInfo[0]!;
                return (IReadOnlyList<BaseItem>)store.Values
                    .Where(item => item.ParentId == query.ParentId)
                    .ToList();
            });

        libraryManager
            .UpdateItemsAsync(Arg.Any<IReadOnlyList<BaseItem>>(), Arg.Any<BaseItem>(), Arg.Any<ItemUpdateType>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                foreach (var item in (IReadOnlyList<BaseItem>)callInfo[0]!)
                    store[item.Id] = item;
                return Task.CompletedTask;
            });

        libraryManager
            .UpdatePeopleAsync(Arg.Any<BaseItem>(), Arg.Any<IReadOnlyList<PersonInfo>>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var userManager = Substitute.For<IUserManager>();
        userManager.GetUsers().Returns(Array.Empty<User>());

        var library = new EphemeralLibraryService(
            libraryManager,
            new EphemeralReleaseStore(),
            new PlaybackSessionTracker(),
            new StubApplicationPaths(_cacheRoot),
            userManager,
            Substitute.For<IUserDataManager>(),
            Substitute.For<IProviderManager>(),
            Substitute.For<IFileSystem>(),
            new ArtworkBadgeService(
                new StubHttpClientFactory(artworkHandler),
                new StubApplicationPaths(_cacheRoot),
                NullLogger<ArtworkBadgeService>.Instance),
            NullLogger<EphemeralLibraryService>.Instance);

        return (library, store);
    }

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

    private sealed class AsyncCallbackHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> callback)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => callback(request);
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
