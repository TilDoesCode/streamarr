using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Tests;

public sealed class PlaybackEventEntryPointTests
{
    [Fact]
    public async Task PlaybackProgress_ForwardsSessionTokenAndRuntimeTicks()
    {
        var sent = new List<EventRequest>();
        var dispatcher = new PlaybackEventDispatcher(
            (request, _) =>
            {
                sent.Add(request);
                return Task.CompletedTask;
            },
            (_, _) => Task.CompletedTask,
            NullLogger.Instance);
        var sessionManager = Substitute.For<ISessionManager>();
        var tracker = new PlaybackSessionTracker();
        var item = new Movie
        {
            Id = Guid.NewGuid(),
            RunTimeTicks = 7_200_000_000,
        };
        tracker.TrackSession(
            item.Id,
            "media-source-1",
            "release-1",
            "work-1",
            "core-session-token");
        var entryPoint = new PlaybackEventEntryPoint(
            sessionManager,
            tracker,
            new EphemeralReleaseStore(),
            dispatcher,
            NullLogger<PlaybackEventEntryPoint>.Instance);

        await entryPoint.StartAsync(CancellationToken.None);
        sessionManager.PlaybackProgress += Raise.EventWith(
            sessionManager,
            new PlaybackProgressEventArgs
            {
                Item = item,
                MediaSourceId = "media-source-1",
                PlaybackPositionTicks = 900_000_000,
                PlaySessionId = "jellyfin-play-session",
                DeviceName = "Living Room TV",
            });
        await entryPoint.StopAsync(CancellationToken.None);

        var request = Assert.Single(sent);
        Assert.Equal("progress", request.Event);
        Assert.Equal("core-session-token", request.SessionToken);
        Assert.Equal(item.RunTimeTicks, request.DurationTicks);
        Assert.Equal("release-1", request.ReleaseId);
        Assert.Equal("work-1", request.WorkId);
    }
}
