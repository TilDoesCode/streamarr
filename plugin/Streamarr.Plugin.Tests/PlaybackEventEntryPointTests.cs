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
        var store = new EphemeralReleaseStore();
        store.Put(item.Id, new WorkDto
        {
            WorkId = "work-1",
            Title = "Example movie",
            Releases =
            [
                new ReleaseDto
                {
                    ReleaseId = "release-1",
                    Title = "Example.Movie.2026.1080p.WEB-DL-GROUP",
                },
            ],
        });
        var entryPoint = new PlaybackEventEntryPoint(
            sessionManager,
            tracker,
            store,
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
        Assert.Equal("Example.Movie.2026.1080p.WEB-DL-GROUP", request.Title);
    }

    [Fact]
    public async Task PlaybackProgress_uses_transient_local_release_title_from_offer_attribution()
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
        var item = new Movie { Id = Guid.NewGuid(), Name = "Episode 2" };
        const string rawTitle = "Show.S01E02.German.DL.1080p.WEB-DL-D3GI";
        Assert.True(tracker.TryTrackSessionWithTitle(
            item.Id,
            "media-source-local",
            "rank-21-local",
            "episode-a",
            "core-session-token",
            rawTitle,
            canAdmit: null,
            out _));
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
                MediaSourceId = "media-source-local",
            });
        await entryPoint.StopAsync(CancellationToken.None);

        var request = Assert.Single(sent);
        Assert.Equal("rank-21-local", request.ReleaseId);
        Assert.Equal("episode-a", request.WorkId);
        Assert.Equal(rawTitle, request.Title);
    }
}
