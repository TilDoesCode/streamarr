using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.MediaSources;

namespace Streamarr.Plugin.Tests;

public class LocalReleaseAvailabilityServiceTests
{
    [Fact]
    public async Task Queries_deduplicated_work_ids_in_bounded_batches_and_merges_valid_states()
    {
        var store = new EphemeralReleaseStore();
        var itemIds = Enumerable.Range(0, 401).Select(_ => Guid.NewGuid()).ToArray();
        for (var index = 0; index < itemIds.Length; index++)
            store.Put(itemIds[index], Work(index));

        var requests = new List<(IReadOnlyList<string> WorkIds, string Client, string RequestedById)>();
        var gate = new object();
        var handler = new CallbackHandler(request =>
        {
            using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            var workIds = body.RootElement.GetProperty("workIds")
                .EnumerateArray()
                .Select(value => value.GetString()!)
                .ToArray();
            var client = body.RootElement.GetProperty("client").GetString()!;
            var requestedById = body.RootElement.GetProperty("requestedById").GetString()!;
            lock (gate)
                requests.Add((workIds, client, requestedById));

            return Json(HttpStatusCode.OK, $$"""
                {"releases":[
                  {"workId":"{{workIds[0]}}","releaseId":"release-{{workIds[0]}}","state":"ready"},
                  {"workId":"outside-request","releaseId":"outside","state":"ready"},
                  {"workId":"{{workIds[0]}}","releaseId":"ignored","state":"invalid"}
                ]}
                """);
        });
        var userId = Guid.NewGuid();
        var service = Service(store, handler);

        var snapshot = await service.GetForItemsAsync(
            itemIds.Concat([itemIds[0]]),
            userId,
            CancellationToken.None);

        Assert.Equal([1, 200, 200], requests.Select(request => request.WorkIds.Count).Order());
        Assert.All(requests, request => Assert.Equal("jellyfin", request.Client));
        Assert.All(requests, request => Assert.Equal(userId.ToString("D"), request.RequestedById));
        Assert.Equal(LocalReleaseState.Ready, snapshot.GetState("work-0", "release-work-0"));
        Assert.Equal(LocalReleaseState.Ready, snapshot.GetState("work-200", "release-work-200"));
        Assert.Equal(LocalReleaseState.Ready, snapshot.GetState("work-400", "release-work-400"));
        Assert.Equal(LocalReleaseState.Remote, snapshot.GetState("outside-request", "outside"));
        Assert.Equal(LocalReleaseState.Remote, snapshot.GetState("work-0", "ignored"));
    }

    [Fact]
    public async Task A_failed_batch_does_not_hide_availability_from_other_batches()
    {
        var store = new EphemeralReleaseStore();
        var itemIds = Enumerable.Range(0, 201).Select(_ => Guid.NewGuid()).ToArray();
        for (var index = 0; index < itemIds.Length; index++)
            store.Put(itemIds[index], Work(index));

        var handler = new CallbackHandler(request =>
        {
            using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            var workIds = body.RootElement.GetProperty("workIds")
                .EnumerateArray()
                .Select(value => value.GetString()!)
                .ToArray();
            return workIds.Contains("work-0", StringComparer.Ordinal)
                ? Json(HttpStatusCode.ServiceUnavailable, "{\"error\":{\"code\":\"temporary\"}}")
                : Json(HttpStatusCode.OK, $$"""
                    {"releases":[{"workId":"{{workIds[0]}}","releaseId":"release-{{workIds[0]}}","state":"downloading"}]}
                    """);
        });
        var service = Service(store, handler);

        var snapshot = await service.GetForItemsAsync(itemIds, Guid.NewGuid(), CancellationToken.None);

        Assert.Equal(LocalReleaseState.Remote, snapshot.GetState("work-0", "release-work-0"));
        Assert.Equal(LocalReleaseState.Downloading, snapshot.GetState("work-200", "release-work-200"));
    }

    [Fact]
    public async Task Metadata_is_normalized_and_merged_only_when_outer_release_id_matches_exactly()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work(0));
        var handler = new CallbackHandler(_ => Json(HttpStatusCode.OK, """
            {
              "releases": [
                {
                  "workId": "work-0",
                  "releaseId": "local-21",
                  "state": " READY ",
                  "release": {
                    "releaseId": "local-21",
                    "title": "Show.S01E02.1080p.WEB-DL-D3GI",
                    "indexer": "demo",
                    "sizeBytes": -4,
                    "languages": ["de", "en"]
                  }
                },
                {
                  "workId": "work-0",
                  "releaseId": "outer-id",
                  "state": "ready",
                  "release": {
                    "releaseId": "different-id",
                    "title": "Must.Not.Merge",
                    "indexer": "demo"
                  }
                },
                {
                  "workId": "other-work",
                  "releaseId": "outside-scope",
                  "state": "ready",
                  "release": {
                    "releaseId": "outside-scope",
                    "title": "Must.Not.Cross.Scope",
                    "indexer": "demo"
                  }
                }
              ]
            }
            """));
        var snapshot = await Service(store, handler)
            .GetForItemsAsync([itemId], Guid.NewGuid(), CancellationToken.None);

        var merged = snapshot.MergeReleases("work-0", Work(0).Releases);

        var local = Assert.Single(merged, release => release.ReleaseId == "local-21");
        Assert.Equal("Show.S01E02.1080p.WEB-DL-D3GI", local.Title);
        Assert.Equal(0, local.SizeBytes);
        Assert.DoesNotContain(merged, release => release.ReleaseId is "different-id" or "outer-id" or "outside-scope");
        Assert.Equal(LocalReleaseState.Ready, snapshot.GetState("work-0", "outer-id"));
        Assert.Equal(LocalReleaseState.Remote, snapshot.GetState("other-work", "outside-scope"));
    }

    private static WorkDto Work(int index) => new()
    {
        WorkId = "work-" + index,
        MediaType = "movie",
        Title = "Work " + index,
        Releases =
        [
            new ReleaseDto
            {
                ReleaseId = "release-work-" + index,
                Title = "Release " + index,
                Indexer = "demo",
            },
        ],
    };

    private static LocalReleaseAvailabilityService Service(
        EphemeralReleaseStore store,
        HttpMessageHandler handler)
    {
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => new PluginConfiguration { ServerUrl = "https://core.example" });
        return new LocalReleaseAvailabilityService(
            store,
            api,
            NullLogger<LocalReleaseAvailabilityService>.Instance);
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class CallbackHandler(Func<HttpRequestMessage, HttpResponseMessage> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(callback(request));
    }
}
