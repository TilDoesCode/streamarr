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
    public async Task Live_stream_dispose_retains_core_file_and_cleans_plugin_aliases_once()
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
        var offerReleases = 0;
        tracker.TrackSession(Guid.NewGuid(), "live-1", "release-1", "work-1", "capability-1");
        var liveStream = new StreamarrLiveStream(
            new MediaSourceInfo { LiveStreamId = "live-1" },
            tracker,
            NullLogger.Instance,
            () => offerReleases++);

        // MediaSourceManager decrements this value on every CloseLiveStream call and closes at
        // zero. A newly opened exclusive stream therefore starts with exactly one consumer.
        Assert.Equal(1, liveStream.ConsumerCount);

        // Jellyfin rewrites this value to a provider-prefixed composite id after open.
        liveStream.MediaSource.LiveStreamId = "provider_live-1";
        liveStream.Dispose();
        liveStream.Dispose();
        await liveStream.Close();
        await dispatcher.StopAsync(CancellationToken.None);

        Assert.Empty(closed);
        Assert.Equal(1, offerReleases);
        Assert.Empty(tracker.All());
    }

    [Fact]
    public async Task CriticalClose_SurvivesTelemetryQueueSaturation()
    {
        var sendEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSend = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var closed = new List<string>();
        async Task Send(EventRequest _, CancellationToken ct)
        {
            sendEntered.TrySetResult();
            await releaseSend.Task.WaitAsync(ct);
        }

        var dispatcher = new PlaybackEventDispatcher(
            Send,
            (token, _) =>
            {
                closed.Add(token);
                return Task.CompletedTask;
            },
            NullLogger.Instance);
        dispatcher.Start();
        Assert.True(dispatcher.EnqueueEvent(Event("start", 0), "first"));
        await sendEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

        // Fill the bounded telemetry channel while its only reader is blocked.
        for (var index = 0; index < 128; index++)
            Assert.True(dispatcher.EnqueueEvent(Event("start", index), $"queued-{index}"));

        Assert.True(dispatcher.EnqueueClose("critical-session"));
        releaseSend.TrySetResult();
        await dispatcher.StopAsync(CancellationToken.None);

        Assert.Equal(["critical-session"], closed);
    }

    [Fact]
    public async Task CriticalClose_RetriesTransientDeliveryFailures()
    {
        var attempts = 0;
        var dispatcher = new PlaybackEventDispatcher(
            (_, _) => Task.CompletedTask,
            (_, _) => ++attempts < 3
                ? Task.FromException(new HttpRequestException("transient"))
                : Task.CompletedTask,
            NullLogger.Instance);
        dispatcher.Start();

        Assert.True(dispatcher.EnqueueClose("session-1"));
        await dispatcher.StopAsync(CancellationToken.None);

        Assert.Equal(3, attempts);
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
