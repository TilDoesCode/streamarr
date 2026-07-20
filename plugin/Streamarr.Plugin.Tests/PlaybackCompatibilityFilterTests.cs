using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.MediaSources;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// Pins the scope of the Swiftfin playback compatibility shim: it must rewrite exactly the
/// PlaybackInfo requests of affected clients for Streamarr-owned items — and nothing else.
/// A regression in either direction is a real bug: too narrow re-breaks Swiftfin, too broad
/// changes playback behavior for clients that implement the Jellyfin protocol correctly.
/// </summary>
public class PlaybackCompatibilityFilterTests
{
    private static WorkDto Work(string workId) => new()
    {
        WorkId = workId,
        MediaType = "movie",
        Title = "Owned Movie",
        Releases =
        [
            new ReleaseDto { ReleaseId = workId + "-r1", Title = "R1", Indexer = "demo", Quality = new QualityDto() },
        ],
    };

    private static async Task<(StreamarrPlaybackCompatibilityFilter Filter, Guid OwnedItemId)> CreateFilterAsync()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        Assert.True(await store.PutRangeAsync(
            [new KeyValuePair<Guid, WorkDto>(itemId, Work("work-a"))],
            CancellationToken.None));
        var projection = new StreamarrMediaSourceProjection(
            store,
            new MediaSourceOfferStore(),
            NullLogger<StreamarrMediaSourceProjection>.Instance);
        var filter = new StreamarrPlaybackCompatibilityFilter(
            projection,
            NullLogger<StreamarrPlaybackCompatibilityFilter>.Instance);
        return (filter, itemId);
    }

    private static ActionExecutingContext PlaybackInfoContext(
        Guid itemId,
        string? client,
        string method = "POST",
        string? path = null,
        ActionDescriptor? descriptor = null)
    {
        var http = new DefaultHttpContext();
        http.Request.Method = method;
        http.Request.Path = path ?? $"/Items/{itemId:N}/PlaybackInfo";
        if (client is not null)
        {
            http.User = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim(StreamarrPlaybackCompatibilityFilter.ClientClaimType, client)]));
        }

        // Mirrors the real MediaInfoController action: both parameters are declared, but MVC
        // omits optional query parameters the client did not send from the bound-argument
        // dictionary — Swiftfin sends neither, so the dictionary starts empty.
        descriptor ??= new ActionDescriptor
        {
            Parameters =
            [
                new ParameterDescriptor
                {
                    Name = StreamarrPlaybackCompatibilityFilter.AutoOpenArgument,
                    ParameterType = typeof(bool?),
                },
                new ParameterDescriptor
                {
                    Name = StreamarrPlaybackCompatibilityFilter.EnableDirectPlayArgument,
                    ParameterType = typeof(bool?),
                },
            ],
        };

        return new ActionExecutingContext(
            new ActionContext(http, new RouteData(), descriptor),
            [],
            new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase),
            new object());
    }

    private static Task RunAsync(StreamarrPlaybackCompatibilityFilter filter, ActionExecutingContext context)
        => filter.OnActionExecutionAsync(
            context,
            () => Task.FromResult(new ActionExecutedContext(context, [], context.Controller)));

    [Theory]
    [InlineData("Swiftfin iOS")]
    [InlineData("Swiftfin tvOS")]
    [InlineData("swiftfin ipados")]
    public async Task Swiftfin_playback_info_for_owned_item_is_rewritten(string client)
    {
        var (filter, itemId) = await CreateFilterAsync();
        var context = PlaybackInfoContext(itemId, client);

        await RunAsync(filter, context);

        Assert.Equal(true, context.ActionArguments[StreamarrPlaybackCompatibilityFilter.AutoOpenArgument]);
        Assert.Equal(false, context.ActionArguments[StreamarrPlaybackCompatibilityFilter.EnableDirectPlayArgument]);
    }

    [Theory]
    [InlineData("Jellyfin Web")]
    [InlineData("Streamyfin")]
    [InlineData("Android TV")]
    [InlineData("Findroid")]
    [InlineData(null)]
    public async Task Other_clients_are_never_touched(string? client)
    {
        var (filter, itemId) = await CreateFilterAsync();
        var context = PlaybackInfoContext(itemId, client);

        await RunAsync(filter, context);

        Assert.Empty(context.ActionArguments);
    }

    [Fact]
    public async Task Swiftfin_playback_info_for_native_items_is_never_touched()
    {
        var (filter, _) = await CreateFilterAsync();
        var context = PlaybackInfoContext(Guid.NewGuid(), "Swiftfin iOS");

        await RunAsync(filter, context);

        Assert.Empty(context.ActionArguments);
    }

    [Fact]
    public async Task Only_the_playback_info_post_route_is_rewritten()
    {
        var (filter, itemId) = await CreateFilterAsync();

        var wrongMethod = PlaybackInfoContext(itemId, "Swiftfin iOS", method: "GET");
        await RunAsync(filter, wrongMethod);
        Assert.Empty(wrongMethod.ActionArguments);

        var wrongPath = PlaybackInfoContext(itemId, "Swiftfin iOS", path: "/LiveStreams/Open");
        await RunAsync(filter, wrongPath);
        Assert.Empty(wrongPath.ActionArguments);
    }

    [Fact]
    public async Task Drifted_action_shape_fails_open()
    {
        // A future Jellyfin renaming the declared parameters must degrade to "no shim", never
        // to an exception or a partially rewritten request.
        var (filter, itemId) = await CreateFilterAsync();
        var drifted = new ActionDescriptor
        {
            Parameters = [new ParameterDescriptor { Name = "somethingElse", ParameterType = typeof(bool?) }],
        };
        var context = PlaybackInfoContext(itemId, "Swiftfin iOS", descriptor: drifted);

        await RunAsync(filter, context);

        Assert.Empty(context.ActionArguments);
    }

    [Theory]
    [InlineData("/Items/00000000000000000000000000000000/PlaybackInfo", false)] // empty guid
    [InlineData("/Items/Latest/PlaybackInfo", false)]
    [InlineData("/Items/4e73b4e945988c4fd0b9b45da13157d0", false)]
    [InlineData("/LiveStreams/Open", false)]
    [InlineData("/Items/4e73b4e945988c4fd0b9b45da13157d0/PlaybackInfo", true)]
    [InlineData("/items/4e73b4e9-4598-8c4f-d0b9-b45da13157d0/playbackinfo", true)]
    public void Playback_info_route_matching_is_exact(string path, bool expected)
    {
        Assert.Equal(
            expected,
            StreamarrPlaybackCompatibilityFilter.TryGetPlaybackInfoItemId(new PathString(path), out var itemId));
        Assert.Equal(expected, itemId != Guid.Empty);
    }

    [Theory]
    [InlineData("Swiftfin iOS", true)]
    [InlineData("Swiftfin tvOS", true)]
    [InlineData(" Swiftfin iPadOS", true)]
    [InlineData("swiftfin", true)]
    [InlineData("Jellyfin Web", false)]
    [InlineData("Jellyfin Media Player", false)]
    [InlineData("Streamyfin", false)]
    [InlineData("", false)]
    public void Affected_client_detection_matches_swiftfin_only(string client, bool expected)
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(StreamarrPlaybackCompatibilityFilter.ClientClaimType, client)]));

        Assert.Equal(expected, StreamarrPlaybackCompatibilityFilter.IsAffectedClient(user));
    }

    [Fact]
    public void Missing_client_claim_is_not_affected()
    {
        Assert.False(StreamarrPlaybackCompatibilityFilter.IsAffectedClient(null));
        Assert.False(StreamarrPlaybackCompatibilityFilter.IsAffectedClient(new ClaimsPrincipal(new ClaimsIdentity())));
    }
}
