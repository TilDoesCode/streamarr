using Microsoft.Extensions.Logging.Abstractions;
using MediaBrowser.Model.Dto;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.MediaSources;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Tests;

public class PlaybackEventDispatcherTests
{
    [Fact]
    public async Task Progress_is_coalesced_and_shutdown_drains_events_and_close()
    {
        var sent = new List<EventRequest>();
        var closed = new List<string>();
        var sendGateEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSendGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var sync = new object();

        async Task Send(EventRequest request, CancellationToken ct)
        {
            if (request.Event == "start")
            {
                sendGateEntered.TrySetResult();
                await releaseSendGate.Task.WaitAsync(ct);
            }

            lock (sync)
                sent.Add(request);
        }

        Task Close(string token, CancellationToken ct)
        {
            lock (sync)
                closed.Add(token);
            return Task.CompletedTask;
        }

        var dispatcher = new PlaybackEventDispatcher(Send, Close, NullLogger.Instance);
        dispatcher.Start();
        Assert.True(dispatcher.EnqueueEvent(Event("start", 0), "playback-1"));
        await sendGateEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        for (var position = 1; position <= 20; position++)
            Assert.True(dispatcher.EnqueueEvent(Event("progress", position), "playback-1"));
        Assert.Equal(1, dispatcher.PendingProgressCount);
        Assert.True(dispatcher.EnqueueClose("session-1"));

        releaseSendGate.TrySetResult();
        await dispatcher.StopAsync(CancellationToken.None);

        Assert.Collection(
            sent,
            start => Assert.Equal("start", start.Event),
            progress =>
            {
                Assert.Equal("progress", progress.Event);
                Assert.Equal(20, progress.PositionTicks);
            });
        Assert.Equal(["session-1"], closed);
        Assert.Equal(0, dispatcher.PendingProgressCount);
    }

    [Fact]
    public async Task Live_stream_dispose_uses_bounded_close_dispatcher_once_and_cleans_aliases()
    {
        var closed = new List<string>();
        var dispatcher = new PlaybackEventDispatcher(
            (_, _) => Task.CompletedTask,
            (token, _) =>
            {
                closed.Add(token);
                return Task.CompletedTask;
            },
            NullLogger.Instance);
        dispatcher.Start();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(Guid.NewGuid(), "live-1", "release-1", "work-1", "capability-1");
        var liveStream = new StreamarrLiveStream(
            new MediaSourceInfo { LiveStreamId = "live-1" },
            "capability-1",
            dispatcher,
            tracker,
            NullLogger.Instance);

        // Jellyfin rewrites this value to a provider-prefixed composite id after open.
        liveStream.MediaSource.LiveStreamId = "provider_live-1";
        liveStream.Dispose();
        liveStream.Dispose();
        await liveStream.Close();
        await dispatcher.StopAsync(CancellationToken.None);

        Assert.Equal(["capability-1"], closed);
        Assert.Empty(tracker.All());
    }

    private static EventRequest Event(string kind, long position) => new()
    {
        ReleaseId = "release-1",
        WorkId = "work-1",
        Event = kind,
        PositionTicks = position,
        Source = "jellyfin",
    };
}
