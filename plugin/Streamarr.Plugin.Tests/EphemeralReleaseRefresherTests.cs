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
    {
        var api = new StreamarrApiClient(
            new HttpClient(new CallbackHandler(respond)),
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

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class CallbackHandler(Func<HttpRequestMessage, HttpResponseMessage> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(callback(request));
    }
}
