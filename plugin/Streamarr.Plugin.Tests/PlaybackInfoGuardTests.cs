using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dlna;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.MediaSources;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// Pins the scope of the client-agnostic PlaybackInfo guard: it must drop exactly those
/// live-stream ids that Jellyfin no longer has open — for any client — on Streamarr-owned
/// items, and touch nothing else. Too eager re-opens streams that are still healthy
/// (duplicate sessions); too lazy re-breaks players that rebuild playback with a stale id.
/// </summary>
public class PlaybackInfoGuardTests
{
    private const string StaleId = "closed-live-stream";
    private const string OpenId = "open-live-stream";

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

    private static async Task<(StreamarrPlaybackInfoGuard Guard, Guid OwnedItemId, IMediaSourceManager Manager)> CreateGuardAsync()
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
        var manager = Substitute.For<IMediaSourceManager>();
        manager.GetLiveStreamInfo(OpenId).Returns(Substitute.For<ILiveStream>());
        manager.GetLiveStreamInfo(StaleId).Returns((ILiveStream?)null);
        var guard = new StreamarrPlaybackInfoGuard(
            projection,
            manager,
            NullLogger<StreamarrPlaybackInfoGuard>.Instance);
        return (guard, itemId, manager);
    }

    private static ActionExecutingContext PlaybackInfoContext(
        Guid itemId,
        string method = "POST",
        string? path = null,
        ActionDescriptor? descriptor = null)
    {
        var http = new DefaultHttpContext();
        http.Request.Method = method;
        http.Request.Path = path ?? $"/Items/{itemId:N}/PlaybackInfo";

        // Mirrors the real MediaInfoController action: the compatibility parameters are
        // declared, while the bound-argument dictionary starts empty. The guard intentionally
        // avoids a Jellyfin.Api DTO dependency and overrides the query-bound arguments.
        descriptor ??= new ActionDescriptor
        {
            Parameters =
            [
                new ParameterDescriptor
                {
                    Name = StreamarrPlaybackInfoGuard.LiveStreamArgument,
                    ParameterType = typeof(string),
                },
                new ParameterDescriptor
                {
                    Name = StreamarrPlaybackInfoGuard.AutoOpenArgument,
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

    private static Task RunAsync(StreamarrPlaybackInfoGuard guard, ActionExecutingContext context)
        => guard.OnActionExecutionAsync(
            context,
            () => Task.FromResult(new ActionExecutedContext(context, [], context.Controller)));

    private sealed class FakePlaybackInfoDto
    {
        public string? LiveStreamId { get; set; }

        public bool? AutoOpenLiveStream { get; set; }

        public DeviceProfile? DeviceProfile { get; set; }
    }

    private sealed class FakeOpenLiveStreamDto
    {
        public Guid? ItemId { get; set; }

        public DeviceProfile? DeviceProfile { get; set; }
    }

    /// <summary>Faithful shape of Streamyfin's MPV profile, including its malformed "h264, hevc".</summary>
    private static DeviceProfile MalformedStreamyfinProfile() => new()
    {
        DirectPlayProfiles =
        [
            new DirectPlayProfile { Container = "mp4 ,mkv", VideoCodec = "h264,hevc", AudioCodec = "aac, mp3" },
        ],
        TranscodingProfiles =
        [
            new TranscodingProfile { Container = "ts", VideoCodec = "h264, hevc", AudioCodec = "aac,mp3,ac3,dts" },
        ],
        CodecProfiles =
        [
            new CodecProfile { Codec = "hevc, h265" },
        ],
        ContainerProfiles =
        [
            new ContainerProfile { Container = " avi" },
        ],
    };

    [Fact]
    public async Task Stale_query_live_stream_id_is_cleared()
    {
        var (guard, itemId, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId);
        context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument] = StaleId;

        await RunAsync(guard, context);

        Assert.Equal(string.Empty, context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);
    }

    [Fact]
    public async Task Stale_body_live_stream_id_is_blocked_via_the_query_argument()
    {
        // Players such as Swiftfin's rebuilt player resend the closed stream's id in the posted
        // dto. The controller merges `liveStreamId ??= dto.LiveStreamId`, so the guard blocks it
        // by winning that merge with an empty query argument.
        var (guard, itemId, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId);
        context.ActionArguments[StreamarrPlaybackInfoGuard.BodyArgument] =
            new FakePlaybackInfoDto { LiveStreamId = StaleId };

        await RunAsync(guard, context);

        Assert.Equal(string.Empty, context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);
    }

    [Fact]
    public async Task Still_open_live_stream_id_is_honored_unchanged()
    {
        // The anti-duplicate-session property: a client legitimately reusing an open stream
        // keeps it; the guard must not force a re-open.
        var (guard, itemId, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId);
        context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument] = OpenId;

        await RunAsync(guard, context);

        Assert.Equal(OpenId, context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);
    }

    [Fact]
    public async Task Requests_without_a_live_stream_id_keep_no_forced_id_and_default_auto_open()
    {
        var (guard, itemId, manager) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId);

        await RunAsync(guard, context);

        Assert.False(context.ActionArguments.ContainsKey(StreamarrPlaybackInfoGuard.LiveStreamArgument));
        Assert.Equal(true, context.ActionArguments[StreamarrPlaybackInfoGuard.AutoOpenArgument]);
        manager.DidNotReceiveWithAnyArgs().GetLiveStreamInfo(default!);
    }

    [Fact]
    public async Task Explicit_auto_open_false_is_honored()
    {
        // A client that intends the explicit /LiveStreams/Open two-step must keep its choice.
        var (guard, itemId, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId);
        context.ActionArguments[StreamarrPlaybackInfoGuard.BodyArgument] =
            new FakePlaybackInfoDto { AutoOpenLiveStream = false };

        await RunAsync(guard, context);

        Assert.False(context.ActionArguments.ContainsKey(StreamarrPlaybackInfoGuard.AutoOpenArgument));
    }

    [Fact]
    public async Task Explicit_auto_open_true_is_left_alone()
    {
        var (guard, itemId, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId);
        context.ActionArguments[StreamarrPlaybackInfoGuard.AutoOpenArgument] = (bool?)true;

        await RunAsync(guard, context);

        Assert.Equal(true, context.ActionArguments[StreamarrPlaybackInfoGuard.AutoOpenArgument]);
    }

    [Fact]
    public async Task Non_streamarr_items_are_never_touched()
    {
        var (guard, _, manager) = await CreateGuardAsync();
        var context = PlaybackInfoContext(Guid.NewGuid());
        context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument] = StaleId;

        await RunAsync(guard, context);

        Assert.Equal(StaleId, context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);
        Assert.False(context.ActionArguments.ContainsKey(StreamarrPlaybackInfoGuard.AutoOpenArgument));
        manager.DidNotReceiveWithAnyArgs().GetLiveStreamInfo(default!);
    }

    [Fact]
    public async Task Only_the_playback_info_post_route_is_guarded()
    {
        var (guard, itemId, _) = await CreateGuardAsync();

        var wrongMethod = PlaybackInfoContext(itemId, method: "GET");
        wrongMethod.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument] = StaleId;
        await RunAsync(guard, wrongMethod);
        Assert.Equal(StaleId, wrongMethod.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);

        var wrongPath = PlaybackInfoContext(itemId, path: "/LiveStreams/Open");
        wrongPath.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument] = StaleId;
        await RunAsync(guard, wrongPath);
        Assert.Equal(StaleId, wrongPath.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);
    }

    [Fact]
    public async Task Drifted_action_shape_fails_open()
    {
        // A future Jellyfin renaming the declared parameter must degrade to "no guard", never
        // to an exception or a partially rewritten request.
        var (guard, itemId, _) = await CreateGuardAsync();
        var drifted = new ActionDescriptor
        {
            Parameters = [new ParameterDescriptor { Name = "somethingElse", ParameterType = typeof(string) }],
        };
        var context = PlaybackInfoContext(itemId, descriptor: drifted);
        context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument] = StaleId;

        await RunAsync(guard, context);

        Assert.Equal(StaleId, context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);
    }

    [Fact]
    public async Task Registry_errors_fail_open()
    {
        var (guard, itemId, manager) = await CreateGuardAsync();
        manager.GetLiveStreamInfo(StaleId).Throws(new InvalidOperationException("host drift"));
        var context = PlaybackInfoContext(itemId);
        context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument] = StaleId;

        await RunAsync(guard, context);

        Assert.Equal(StaleId, context.ActionArguments[StreamarrPlaybackInfoGuard.LiveStreamArgument]);
    }

    [Fact]
    public async Task Malformed_codec_lists_in_the_posted_profile_are_normalized()
    {
        // Streamyfin's real MPV profile declares "h264, hevc"; Jellyfin's untrimmed split plus
        // the HLS codec filter silently evicted hevc, turning every HEVC remux into a full
        // H.264 re-encode. The guard must repair exactly these lists and nothing else.
        var (guard, itemId, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId);
        var profile = MalformedStreamyfinProfile();
        context.ActionArguments[StreamarrPlaybackInfoGuard.BodyArgument] =
            new FakePlaybackInfoDto { DeviceProfile = profile };

        await RunAsync(guard, context);

        Assert.Equal("h264,hevc", profile.TranscodingProfiles[0].VideoCodec);
        Assert.Equal("aac,mp3,ac3,dts", profile.TranscodingProfiles[0].AudioCodec);
        Assert.Equal("mp4,mkv", profile.DirectPlayProfiles[0].Container);
        Assert.Equal("aac,mp3", profile.DirectPlayProfiles[0].AudioCodec);
        Assert.Equal("hevc,h265", profile.CodecProfiles[0].Codec);
        Assert.Equal("avi", profile.ContainerProfiles[0].Container);
    }

    [Fact]
    public void Well_formed_profiles_are_left_untouched()
    {
        var profile = MalformedStreamyfinProfile();
        Assert.Equal(5, StreamarrPlaybackInfoGuard.NormalizeDeviceProfileLists(profile));
        Assert.Equal(0, StreamarrPlaybackInfoGuard.NormalizeDeviceProfileLists(profile));
    }

    [Fact]
    public async Task Open_live_stream_profile_is_normalized_for_owned_items()
    {
        var (guard, itemId, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(itemId, path: "/LiveStreams/Open");
        var profile = MalformedStreamyfinProfile();
        context.ActionArguments[StreamarrPlaybackInfoGuard.OpenBodyArgument] =
            new FakeOpenLiveStreamDto { ItemId = itemId, DeviceProfile = profile };

        await RunAsync(guard, context);

        Assert.Equal("h264,hevc", profile.TranscodingProfiles[0].VideoCodec);
        // The open route gets profile normalization only — no auto-open defaulting.
        Assert.False(context.ActionArguments.ContainsKey(StreamarrPlaybackInfoGuard.AutoOpenArgument));
    }

    [Fact]
    public async Task Open_live_stream_profile_for_foreign_items_is_untouched()
    {
        var (guard, _, _) = await CreateGuardAsync();
        var context = PlaybackInfoContext(Guid.NewGuid(), path: "/LiveStreams/Open");
        var profile = MalformedStreamyfinProfile();
        context.ActionArguments[StreamarrPlaybackInfoGuard.OpenBodyArgument] =
            new FakeOpenLiveStreamDto { ItemId = Guid.NewGuid(), DeviceProfile = profile };

        await RunAsync(guard, context);

        Assert.Equal("h264, hevc", profile.TranscodingProfiles[0].VideoCodec);
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
            StreamarrPlaybackInfoGuard.TryGetPlaybackInfoItemId(new PathString(path), out var itemId));
        Assert.Equal(expected, itemId != Guid.Empty);
    }

    [Theory]
    [InlineData("/LiveStreams/Open", true)]
    [InlineData("/livestreams/open", true)]
    [InlineData("/LiveStreams/Close", false)]
    [InlineData("/LiveStreams/Open/Extra", false)]
    public void Open_route_matching_is_exact(string path, bool expected)
    {
        Assert.Equal(expected, StreamarrPlaybackInfoGuard.IsLiveStreamOpenPath(new PathString(path)));
    }
}
