using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.MediaSources;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// Pins the self-healing contract for the Grey's Anatomy S21 bug class: an item materialized
/// while Core had zero releases (an indexer bug, a not-yet-leaked episode, whatever) must not
/// stay wrong forever just because nobody happens to re-open its season page. Also pins the
/// safety valves — a fixed retry floor and single-flight per item — so a legitimately-still-empty
/// item does not hammer Core on every page view.
/// </summary>
public class EphemeralReleaseRefresherTests
{
    private static WorkDto Work(string workId, int episode, params string[] releaseIds) => new()
    {
        WorkId = workId,
        Title = "Work " + workId,
        MediaType = "episode",
        TmdbId = 1416,
        Season = 21,
        Episode = episode,
        Releases = releaseIds.Select(id => new ReleaseDto
        {
            ReleaseId = id,
            Title = id,
            Indexer = "demo",
        }).ToArray(),
    };

    private static EphemeralReleaseRefresher Refresher(
        EphemeralReleaseStore store,
        Func<HttpRequestMessage, HttpResponseMessage> respond)
        => Refresher(store, new CallbackHandler(respond));

    private static EphemeralReleaseRefresher Refresher(
        EphemeralReleaseStore store,
        HttpMessageHandler handler)
    {
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => new PluginConfiguration { ServerUrl = "https://core.example" });
        return new EphemeralReleaseRefresher(store, api, NullLogger<EphemeralReleaseRefresher>.Instance);
    }

    [Fact]
    public void Zero_release_entries_always_need_refresh_regardless_of_age()
    {
        var entry = new EphemeralReleaseStore.Entry(Guid.NewGuid(), Work("tmdb-tv-1416-s21e01", 1))
        {
            LastRefreshedUtc = DateTime.UtcNow,
        };

        Assert.True(EphemeralReleaseRefresher.NeedsRefresh(entry, DateTime.UtcNow, TimeSpan.FromHours(1)));
    }

    [Fact]
    public void Fresh_nonempty_entries_do_not_need_refresh()
    {
        var entry = new EphemeralReleaseStore.Entry(Guid.NewGuid(), Work("tmdb-tv-1416-s21e01", 1, "r1"))
        {
            LastRefreshedUtc = DateTime.UtcNow,
        };

        Assert.False(EphemeralReleaseRefresher.NeedsRefresh(entry, DateTime.UtcNow, TimeSpan.FromHours(1)));
    }

    [Fact]
    public void Nonempty_entries_go_stale_after_the_configured_ttl()
    {
        var entry = new EphemeralReleaseStore.Entry(Guid.NewGuid(), Work("tmdb-tv-1416-s21e01", 1, "r1"))
        {
            LastRefreshedUtc = DateTime.UtcNow - TimeSpan.FromHours(2),
        };

        Assert.True(EphemeralReleaseRefresher.NeedsRefresh(entry, DateTime.UtcNow, TimeSpan.FromHours(1)));
    }

    [Fact]
    public async Task Stale_zero_release_item_is_refreshed_from_core_on_the_read_path()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1));

        var calls = 0;
        var refresher = Refresher(store, _ =>
        {
            calls++;
            return Json(HttpStatusCode.OK, """
                {"results":[{"workId":"tmdb-tv-1416-s21e01","mediaType":"episode","title":"Ep 1",
                "releases":[{"releaseId":"r1","title":"R1","indexer":"demo"}]}]}
                """);
        });

        await refresher.RefreshIfStaleAsync(itemId, CancellationToken.None);

        Assert.Equal(1, calls);
        Assert.Equal(["r1"], store.ReleasesFor(itemId).Select(r => r.ReleaseId));
    }

    [Fact]
    public async Task Unowned_item_triggers_no_core_call()
    {
        var store = new EphemeralReleaseStore();
        var calls = 0;
        var refresher = Refresher(store, _ =>
        {
            calls++;
            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        });

        await refresher.RefreshIfStaleAsync(Guid.NewGuid(), CancellationToken.None);

        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task Fresh_nonempty_item_triggers_no_core_call()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1, "r1"));

        var calls = 0;
        var refresher = Refresher(store, _ =>
        {
            calls++;
            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        });

        await refresher.RefreshIfStaleAsync(itemId, CancellationToken.None);

        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task A_failed_refresh_does_not_corrupt_the_store_entry()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1));

        var refresher = Refresher(store, _ => Json(HttpStatusCode.ServiceUnavailable, "{\"error\":{}}"));

        await refresher.RefreshIfStaleAsync(itemId, CancellationToken.None);

        Assert.Empty(store.ReleasesFor(itemId));
        Assert.NotNull(store.Peek(itemId));
    }

    [Fact]
    public async Task Repeated_views_of_a_still_empty_item_do_not_hammer_core()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1));

        var calls = 0;
        var refresher = Refresher(store, _ =>
        {
            calls++;
            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        });

        await refresher.RefreshIfStaleAsync(itemId, CancellationToken.None);
        await refresher.RefreshIfStaleAsync(itemId, CancellationToken.None);
        await refresher.RefreshIfStaleAsync(itemId, CancellationToken.None);

        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task RefreshAllNow_ignores_the_retry_cooldown_and_reports_how_many_changed()
    {
        var store = new EphemeralReleaseStore();
        var staleWithReleases = Guid.NewGuid();
        var stillEmpty = Guid.NewGuid();
        store.Put(staleWithReleases, Work("tmdb-tv-1416-s21e01", 1, "old"));
        store.Put(stillEmpty, Work("tmdb-tv-1416-s21e02", 2));

        var refresher = Refresher(store, request =>
        {
            // RefreshWorkAsync is a GET; the query carries stable tmdbId/season/episode
            // coordinates, not the workId string, so distinguish the two items by episode.
            return request.RequestUri!.Query.Contains("episode=1", StringComparison.Ordinal)
                ? Json(HttpStatusCode.OK, """{"results":[{"workId":"tmdb-tv-1416-s21e01","mediaType":"episode","title":"Ep 1","releases":[{"releaseId":"new","title":"New","indexer":"demo"}]}]}""")
                : Json(HttpStatusCode.OK, "{\"results\":[]}");
        });
        // First view already consumed the retry floor for one of the two items.
        await refresher.RefreshIfStaleAsync(stillEmpty, CancellationToken.None);

        var updated = await refresher.RefreshAllNowAsync(CancellationToken.None);

        Assert.Equal(1, updated);
        Assert.Equal(["new"], store.ReleasesFor(staleWithReleases).Select(r => r.ReleaseId));
    }

    [Fact]
    public async Task Playback_refresh_does_not_report_the_old_cache_entry_as_a_success()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1, "old"));
        using var refresher = Refresher(
            store,
            _ => Json(HttpStatusCode.OK, "{\"results\":[]}"));

        var refreshed = await refresher.RefreshForPlaybackAsync(itemId, CancellationToken.None);

        Assert.Null(refreshed);
        Assert.Equal(["old"], store.ReleasesFor(itemId).Select(release => release.ReleaseId));
    }

    [Fact]
    public async Task Playback_refresh_is_not_limited_to_the_short_background_timeout()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1, "old"));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var refresher = Refresher(store, new AsyncCallbackHandler(async (_, ct) =>
        {
            started.TrySetResult();
            await release.Task.WaitAsync(ct);
            return Json(HttpStatusCode.OK, """
                {"results":[{"workId":"tmdb-tv-1416-s21e01","mediaType":"episode","title":"Ep 1",
                "releases":[{"releaseId":"restored","title":"Restored","indexer":"demo"}]}]}
                """);
        }));

        var refresh = refresher.RefreshForPlaybackAsync(itemId, CancellationToken.None);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await Task.Delay(EphemeralReleaseRefresher.RefreshTimeout + TimeSpan.FromMilliseconds(250));

        Assert.False(refresh.IsCompleted);
        release.SetResult();
        Assert.Equal(
            "restored",
            Assert.Single((await refresh.WaitAsync(TimeSpan.FromSeconds(2)))!.Releases).ReleaseId);
    }

    [Fact]
    public async Task Concurrent_playback_recovery_for_one_work_is_single_flight()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1, "old"));
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var refresher = Refresher(store, new AsyncCallbackHandler(async (_, ct) =>
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            await release.Task.WaitAsync(ct);
            return Json(HttpStatusCode.OK, """
                {"results":[{"workId":"tmdb-tv-1416-s21e01","mediaType":"episode","title":"Ep 1",
                "releases":[{"releaseId":"restored","title":"Restored","indexer":"demo"}]}]}
                """);
        }));

        var first = refresher.RefreshForPlaybackAsync(itemId, CancellationToken.None);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var second = refresher.RefreshForPlaybackAsync(itemId, CancellationToken.None);
        release.SetResult();

        var results = await Task.WhenAll(first, second);
        Assert.All(results, result => Assert.Equal("restored", Assert.Single(result!.Releases).ReleaseId));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task Playback_recovery_is_not_blocked_by_the_background_queue()
    {
        var store = new EphemeralReleaseStore();
        var backgroundItem = Guid.NewGuid();
        var playbackItem = Guid.NewGuid();
        store.Put(backgroundItem, Work("tmdb-tv-1416-s21e01", 1));
        store.Put(playbackItem, Work("tmdb-tv-1416-s21e02", 2, "old"));
        var backgroundStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseBackground = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refresher = Refresher(store, new AsyncCallbackHandler(async (request, ct) =>
        {
            if (request.RequestUri!.Query.Contains("episode=1", StringComparison.Ordinal))
            {
                backgroundStarted.TrySetResult();
                await releaseBackground.Task.WaitAsync(ct);
                return Json(HttpStatusCode.OK, "{\"results\":[]}");
            }

            return Json(HttpStatusCode.OK, """
                {"results":[{"workId":"tmdb-tv-1416-s21e02","mediaType":"episode","title":"Ep 2",
                "releases":[{"releaseId":"restored","title":"Restored","indexer":"demo"}]}]}
                """);
        }));
        await refresher.StartAsync(CancellationToken.None);
        try
        {
            Assert.True(refresher.QueueIfStale(backgroundItem));
            await backgroundStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

            var restored = await refresher.RefreshForPlaybackAsync(playbackItem, CancellationToken.None)
                .WaitAsync(TimeSpan.FromSeconds(2));

            Assert.Equal("restored", Assert.Single(restored!.Releases).ReleaseId);
            releaseBackground.SetResult();
            await WaitUntilAsync(() => refresher.QueuedWorkCount == 0);
        }
        finally
        {
            releaseBackground.TrySetResult();
            await refresher.StopAsync(CancellationToken.None);
            refresher.Dispose();
        }
    }

    [Fact]
    public async Task Playback_recovery_joins_an_active_background_refresh_for_the_same_work()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1));
        var calls = 0;
        var backgroundStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseBackground = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refresher = Refresher(store, new AsyncCallbackHandler(async (_, ct) =>
        {
            Interlocked.Increment(ref calls);
            backgroundStarted.TrySetResult();
            await releaseBackground.Task.WaitAsync(ct);
            return Json(HttpStatusCode.OK, """
                {"results":[{"workId":"tmdb-tv-1416-s21e01","mediaType":"episode","title":"Ep 1",
                "releases":[{"releaseId":"restored","title":"Restored","indexer":"demo"}]}]}
                """);
        }));
        await refresher.StartAsync(CancellationToken.None);
        try
        {
            Assert.True(refresher.QueueIfStale(itemId));
            await backgroundStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

            var playback = refresher.RefreshForPlaybackAsync(itemId, CancellationToken.None);
            await Task.Delay(100);
            Assert.Equal(1, calls);

            releaseBackground.SetResult();
            Assert.Equal(
                "restored",
                Assert.Single((await playback.WaitAsync(TimeSpan.FromSeconds(2)))!.Releases).ReleaseId);
            Assert.Equal(1, calls);
        }
        finally
        {
            releaseBackground.TrySetResult();
            await refresher.StopAsync(CancellationToken.None);
            refresher.Dispose();
        }
    }

    [Fact]
    public void Atomic_cache_update_rejects_a_replaced_or_removed_snapshot()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1, "old"));
        var staleSnapshot = Assert.IsType<EphemeralReleaseStore.Entry>(store.Peek(itemId));
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1, "newer"));

        Assert.False(store.TryUpdateIfCurrent(
            staleSnapshot,
            Work("tmdb-tv-1416-s21e01", 1, "late-background")));
        Assert.Equal("newer", Assert.Single(store.ReleasesFor(itemId)).ReleaseId);

        var removedSnapshot = Assert.IsType<EphemeralReleaseStore.Entry>(store.Peek(itemId));
        Assert.True(store.Remove(itemId));
        Assert.False(store.TryUpdateIfCurrent(
            removedSnapshot,
            Work("tmdb-tv-1416-s21e01", 1, "resurrected")));
        Assert.Null(store.Peek(itemId));
    }

    [Fact]
    public async Task Background_queue_is_small_retryable_and_runs_one_search_at_a_time()
    {
        var store = new EphemeralReleaseStore();
        var items = Enumerable.Range(1, EphemeralReleaseRefresher.BackgroundQueueCapacity + 2)
            .Select(episode => (ItemId: Guid.NewGuid(), Work: Work($"tmdb-tv-1416-s21e{episode:00}", episode)))
            .ToArray();
        foreach (var item in items)
            store.Put(item.ItemId, item.Work);

        var calls = 0;
        var active = 0;
        var maximumActive = 0;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refresher = Refresher(store, new AsyncCallbackHandler(async (_, ct) =>
        {
            Interlocked.Increment(ref calls);
            var current = Interlocked.Increment(ref active);
            UpdateMaximum(ref maximumActive, current);
            try
            {
                await release.Task.WaitAsync(ct);
                return Json(HttpStatusCode.OK, "{\"results\":[]}");
            }
            finally
            {
                Interlocked.Decrement(ref active);
            }
        }));
        await refresher.StartAsync(CancellationToken.None);
        try
        {
            Assert.True(refresher.QueueIfStale(items[0].ItemId));
            await WaitUntilAsync(() => Volatile.Read(ref calls) == 1);
            foreach (var item in items.Skip(1).Take(EphemeralReleaseRefresher.BackgroundQueueCapacity))
                Assert.True(refresher.QueueIfStale(item.ItemId));

            Assert.False(refresher.QueueIfStale(items[^1].ItemId));
            Assert.Equal(1, Volatile.Read(ref maximumActive));

            release.SetResult();
            await WaitUntilAsync(() => refresher.QueuedWorkCount == 0);
            Assert.Equal(EphemeralReleaseRefresher.BackgroundQueueCapacity + 1, calls);

            Assert.True(refresher.QueueIfStale(items[^1].ItemId));
            await WaitUntilAsync(() => Volatile.Read(ref calls) == items.Length);
            Assert.Equal(1, Volatile.Read(ref maximumActive));
        }
        finally
        {
            await refresher.StopAsync(CancellationToken.None);
            refresher.Dispose();
        }
    }

    [Fact]
    public async Task Background_queue_coalesces_duplicate_work_ids()
    {
        var store = new EphemeralReleaseStore();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        store.Put(first, Work("tmdb-tv-1416-s21e01", 1));
        store.Put(second, Work("tmdb-tv-1416-s21e01", 1));
        var calls = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refresher = Refresher(store, new AsyncCallbackHandler(async (_, ct) =>
        {
            Interlocked.Increment(ref calls);
            started.TrySetResult();
            await release.Task.WaitAsync(ct);
            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        }));
        await refresher.StartAsync(CancellationToken.None);
        try
        {
            Assert.True(refresher.QueueIfStale(first));
            await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.True(refresher.QueueIfStale(second));
            release.SetResult();
            await WaitUntilAsync(() => refresher.QueuedWorkCount == 0);
            Assert.Equal(1, calls);
        }
        finally
        {
            await refresher.StopAsync(CancellationToken.None);
            refresher.Dispose();
        }
    }

    [Fact]
    public async Task Removed_item_is_not_resurrected_by_queued_refresh()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refresher = Refresher(store, new AsyncCallbackHandler(async (_, ct) =>
        {
            started.TrySetResult();
            await release.Task.WaitAsync(ct);
            return Json(HttpStatusCode.OK, """
                {"results":[{"workId":"tmdb-tv-1416-s21e01","mediaType":"episode","title":"Ep 1",
                "releases":[{"releaseId":"r1","title":"R1","indexer":"demo"}]}]}
                """);
        }));
        await refresher.StartAsync(CancellationToken.None);
        try
        {
            Assert.True(refresher.QueueIfStale(itemId));
            await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.True(store.Remove(itemId));
            release.SetResult();
            await WaitUntilAsync(() => refresher.QueuedWorkCount == 0);
            Assert.Null(store.Peek(itemId));
        }
        finally
        {
            await refresher.StopAsync(CancellationToken.None);
            refresher.Dispose();
        }
    }

    [Fact]
    public async Task Stop_cancels_active_background_refresh_and_rejects_new_work()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-tv-1416-s21e01", 1));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refresher = Refresher(store, new AsyncCallbackHandler(async (_, ct) =>
        {
            started.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, ct);
            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        }));
        await refresher.StartAsync(CancellationToken.None);
        Assert.True(refresher.QueueIfStale(itemId));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(2));

        await refresher.StopAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));

        Assert.False(refresher.QueueIfStale(itemId));
        refresher.Dispose();
    }

    private static void UpdateMaximum(ref int target, int value)
    {
        while (true)
        {
            var current = Volatile.Read(ref target);
            if (value <= current || Interlocked.CompareExchange(ref target, value, current) == current)
                return;
        }
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        while (!condition())
            await Task.Delay(10, timeout.Token);
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class CallbackHandler(Func<HttpRequestMessage, HttpResponseMessage> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(callback(request));
    }

    private sealed class AsyncCallbackHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => callback(request, cancellationToken);
    }
}
