using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// The repair-status observer is pure transport: it polls the token-bound Core status of
/// actively played Streamarr sessions and turns transitions into deduplicated
/// DisplayMessage commands — fail-open, bounded, no tokens in logs, zero Core traffic
/// when nothing relevant is playing.
/// </summary>
public class RepairStatusObserverTests
{
    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class CallbackHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _callback;

        public CallbackHandler(Func<HttpRequestMessage, HttpResponseMessage> callback)
            : this((request, _) => Task.FromResult(callback(request)))
        {
        }

        public CallbackHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> callback)
        {
            _callback = callback;
        }

        public int Requests;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Requests);
            return _callback(request, cancellationToken);
        }
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public ConcurrentQueue<LogLevel> Levels { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Levels.Enqueue(logLevel);
    }

    private static StreamarrApiClient Api(
        CallbackHandler handler,
        ILogger<StreamarrApiClient>? logger = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
        => new(
            new HttpClient(handler),
            logger ?? NullLogger<StreamarrApiClient>.Instance,
            () => new PluginConfiguration { ServerUrl = "https://core.example" },
            delay);

    private static SessionInfo PlayingSession(
        Guid itemId,
        string mediaSourceId,
        params GeneralCommandType[] commands)
    {
        var session = new SessionInfo(Substitute.For<ISessionManager>(), NullLogger.Instance)
        {
            Id = Guid.NewGuid().ToString("N"),
            NowPlayingItem = new BaseItemDto { Id = itemId },
            PlayState = new PlayerStateInfo { MediaSourceId = mediaSourceId },
            Capabilities = new ClientCapabilities { SupportedCommands = commands },
        };
        return session;
    }

    private static string RepairJson(
        string playability,
        string state,
        int percent = 50,
        string jobId = "job-1")
        => "{\"playability\":\"" + playability + "\",\"repair\":{\"jobId\":\"" + jobId + "\","
           + "\"disposition\":\"repairable\",\"state\":\"" + state + "\","
           + "\"phase\":\"recovery\",\"progressPercent\":" + percent + "}}";

    [Fact]
    public void Bounds_clamp_and_validate_repair_payloads()
    {
        var normalized = StreamarrPayloadBounds.Normalize(new SessionRepairStatusDto
        {
            Playability = new string('x', 500) + "",
            Repair = new RepairStatusDto
            {
                JobId = "job-1",
                Disposition = new string('d', 200),
                State = "downloadingRecovery",
                ProgressPercent = 250,
                ProcessedBytes = -5,
                EtaSeconds = -1,
                RetryAfterSeconds = 99_999,
                FailureReason = new string('r', 5_000),
            },
        });

        Assert.NotNull(normalized);
        Assert.Equal(32, normalized!.Playability.Length);
        Assert.Equal(100, normalized.Repair!.ProgressPercent);
        Assert.Equal(0, normalized.Repair.ProcessedBytes);
        Assert.Null(normalized.Repair.EtaSeconds);
        Assert.Null(normalized.Repair.RetryAfterSeconds);
        Assert.Equal(512, normalized.Repair.FailureReason!.Length);

        // A repair block without a sane job id is dropped entirely.
        Assert.Null(StreamarrPayloadBounds.Normalize(new SessionRepairStatusDto
        {
            Playability = "repairing",
            Repair = new RepairStatusDto { JobId = new string('j', 500) },
        })!.Repair);
    }

    [Fact]
    public async Task Client_is_fail_open_on_errors_and_older_cores()
    {
        var failing = Api(new CallbackHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError)));
        Assert.Null(await failing.GetSessionRepairStatusAsync("token-a", CancellationToken.None));

        var logger = new RecordingLogger<StreamarrApiClient>();
        var older = Api(
            new CallbackHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound)),
            logger);
        Assert.Null(await older.GetSessionRepairStatusAsync("token-a", CancellationToken.None));
        Assert.DoesNotContain(logger.Levels, level => level >= LogLevel.Warning);
    }

    [Fact]
    public void Capability_log_paths_preserve_the_operation_without_exposing_the_token()
    {
        Assert.Equal(
            "/api/v1/sessions/{session}/repair",
            StreamarrApiClient.SafeLogPath("/api/v1/sessions/secret-token/repair"));
        Assert.Equal(
            "/api/v1/sessions/{session}/close",
            StreamarrApiClient.SafeLogPath("/api/v1/sessions/secret-token/close"));
    }

    [Fact]
    public async Task Transitions_are_deduplicated_and_target_only_display_message_clients()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(itemId, "media-source-1", "rel-1", "work-1", "cap-token-1");

        var tick = 0;
        var handler = new CallbackHandler(request =>
        {
            Assert.DoesNotContain("cap-token-1", request.RequestUri!.Query); // token only in path
            return Json(HttpStatusCode.OK, tick switch
            {
                <= 2 => RepairJson("repairing", "downloadingRecovery"),
                3 => RepairJson("repairedReady", "ready", 100),
                _ => RepairJson("repairedReady", "ready", 100),
            });
        });

        var capable = PlayingSession(
            itemId,
            "media-source-1",
            GeneralCommandType.DisplayMessage,
            GeneralCommandType.Play);
        var incapable = PlayingSession(itemId, "untracked-source", GeneralCommandType.Play);
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns(new[] { capable, incapable });
        var sent = new List<(string SessionId, string Text)>();
        sessionManager
            .SendMessageCommand(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<MessageCommand>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                sent.Add((call.ArgAt<string>(1), call.ArgAt<MessageCommand>(2).Text));
                return Task.CompletedTask;
            });

        var observer = new RepairStatusObserver(
            sessionManager, tracker, Api(handler), NullLogger<RepairStatusObserver>.Instance);

        for (tick = 1; tick <= 4; tick++)
            await observer.ObserveOnceAsync(CancellationToken.None);

        // repairing shown once, completion shown once — never on the incapable client.
        Assert.Equal(2, sent.Count);
        Assert.All(sent, s => Assert.Equal(capable.Id, s.SessionId));
        Assert.Contains("Reparatur läuft", sent[0].Text);
        Assert.Contains("Reparatur abgeschlossen", sent[1].Text);
    }

    [Fact]
    public async Task Failed_message_delivery_is_retried_on_the_next_observation()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(itemId, "media-source-1", "rel-1", "work-1", "cap-token-1");
        var session = PlayingSession(itemId, "media-source-1", GeneralCommandType.DisplayMessage);
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns([session]);
        var attempts = 0;
        sessionManager
            .SendMessageCommand(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<MessageCommand>(), Arg.Any<CancellationToken>())
            .Returns(_ => Interlocked.Increment(ref attempts) == 1
                ? Task.FromException(new IOException("client disconnected"))
                : Task.CompletedTask);
        var handler = new CallbackHandler(_ => Json(
            HttpStatusCode.OK,
            RepairJson("repairing", "downloadingRecovery")));
        var observer = new RepairStatusObserver(
            sessionManager, tracker, Api(handler), NullLogger<RepairStatusObserver>.Instance);

        await observer.ObserveOnceAsync(CancellationToken.None);
        await observer.ObserveOnceAsync(CancellationToken.None);

        Assert.Equal(2, attempts);
    }

    [Fact]
    public async Task Stalled_message_delivery_times_out_and_does_not_stop_future_polling()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(itemId, "media-source-1", "rel-1", "work-1", "cap-token-1");
        var session = PlayingSession(itemId, "media-source-1", GeneralCommandType.DisplayMessage);
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns([session]);
        var cancelledDeliveries = 0;
        sessionManager
            .SendMessageCommand(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<MessageCommand>(), Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, call.ArgAt<CancellationToken>(3));
                }
                finally
                {
                    Interlocked.Increment(ref cancelledDeliveries);
                }
            });
        var handler = new CallbackHandler(_ => Json(
            HttpStatusCode.OK,
            RepairJson("repairing", "downloadingRecovery")));
        var observer = new RepairStatusObserver(
            sessionManager,
            tracker,
            Api(handler),
            NullLogger<RepairStatusObserver>.Instance,
            TimeSpan.FromSeconds(1),
            TimeSpan.FromMilliseconds(50));

        var stopwatch = Stopwatch.StartNew();
        await observer.ObserveOnceAsync(CancellationToken.None);
        await observer.ObserveOnceAsync(CancellationToken.None);
        stopwatch.Stop();

        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1));
        Assert.Equal(2, handler.Requests);
        Assert.Equal(2, Volatile.Read(ref cancelledDeliveries));
    }

    [Fact]
    public async Task Same_item_playbacks_are_correlated_by_their_exact_media_source()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(itemId, "source-a", "release-a", null, "token-a");
        tracker.TrackSession(itemId, "source-b", "release-b", null, "token-b");

        var handler = new CallbackHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/token-a/repair", StringComparison.Ordinal))
                return Json(HttpStatusCode.OK, RepairJson("repairing", "planning", jobId: "job-a"));
            if (path.EndsWith("/token-b/repair", StringComparison.Ordinal))
                return Json(HttpStatusCode.OK, RepairJson("repairing", "recovery", jobId: "job-b"));
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        });

        var sessionA = PlayingSession(itemId, "source-a", GeneralCommandType.DisplayMessage);
        var sessionB = PlayingSession(itemId, "source-b", GeneralCommandType.DisplayMessage);
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns(new[] { sessionA, sessionB });
        var sent = new ConcurrentBag<string>();
        sessionManager
            .SendMessageCommand(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<MessageCommand>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                sent.Add(call.ArgAt<string>(1));
                return Task.CompletedTask;
            });

        var observer = new RepairStatusObserver(
            sessionManager,
            tracker,
            Api(handler),
            NullLogger<RepairStatusObserver>.Instance);
        await observer.ObserveOnceAsync(CancellationToken.None);

        Assert.Equal(2, sent.Count);
        Assert.Contains(sessionA.Id, sent);
        Assert.Contains(sessionB.Id, sent);
    }

    [Fact]
    public async Task Source_switch_during_status_poll_suppresses_stale_notification()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(itemId, "source-a", "release-a", null, "token-a");
        tracker.TrackSession(itemId, "source-b", "release-b", null, "token-b");
        var session = PlayingSession(itemId, "source-a", GeneralCommandType.DisplayMessage);
        var handler = new CallbackHandler(_ =>
        {
            session.PlayState!.MediaSourceId = "source-b";
            return Json(HttpStatusCode.OK, RepairJson("repairing", "planning", jobId: "job-a"));
        });
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns([session]);
        var observer = new RepairStatusObserver(
            sessionManager,
            tracker,
            Api(handler),
            NullLogger<RepairStatusObserver>.Instance);

        await observer.ObserveOnceAsync(CancellationToken.None);

        await sessionManager.DidNotReceive().SendMessageCommand(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<MessageCommand>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Poll_batch_leaves_connection_headroom_and_rotates_fairly()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        var sessions = new List<SessionInfo>();
        var expectedPaths = new List<string>();
        for (var index = 0; index < 10; index++)
        {
            var source = $"source-{index}";
            var token = $"token-{index}";
            tracker.TrackSession(itemId, source, $"release-{index}", null, token);
            sessions.Add(PlayingSession(itemId, source, GeneralCommandType.DisplayMessage));
            expectedPaths.Add($"/api/v1/sessions/{token}/repair");
        }

        var observedPaths = new ConcurrentBag<string>();
        var handler = new CallbackHandler(request =>
        {
            observedPaths.Add(request.RequestUri!.AbsolutePath);
            return Json(HttpStatusCode.OK, """{"playability":"remoteReady","repair":null}""");
        });
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns(sessions);
        var observer = new RepairStatusObserver(
            sessionManager,
            tracker,
            Api(handler),
            NullLogger<RepairStatusObserver>.Instance);

        await observer.ObserveOnceAsync(CancellationToken.None);
        await observer.ObserveOnceAsync(CancellationToken.None);
        await observer.ObserveOnceAsync(CancellationToken.None);

        Assert.Equal(12, handler.Requests);
        Assert.All(expectedPaths, path => Assert.Contains(path, observedPaths));
    }

    [Fact]
    public async Task A_stalled_status_request_times_out_without_delaying_other_sessions()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(itemId, "slow-source", "slow-release", null, "slow-token");
        tracker.TrackSession(itemId, "fast-source", "fast-release", null, "fast-token");
        var slowRequestCancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new CallbackHandler(async (request, requestToken) =>
        {
            if (request.RequestUri!.AbsolutePath.Contains("slow-token", StringComparison.Ordinal))
            {
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, requestToken);
                }
                finally
                {
                    slowRequestCancelled.TrySetResult();
                }
            }

            return Json(HttpStatusCode.OK, RepairJson("repairing", "planning", jobId: "fast-job"));
        });

        var slowSession = PlayingSession(itemId, "slow-source", GeneralCommandType.DisplayMessage);
        var fastSession = PlayingSession(itemId, "fast-source", GeneralCommandType.DisplayMessage);
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns(new[] { slowSession, fastSession });
        var sent = new ConcurrentBag<string>();
        sessionManager
            .SendMessageCommand(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<MessageCommand>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                sent.Add(call.ArgAt<string>(1));
                return Task.CompletedTask;
            });
        var observer = new RepairStatusObserver(
            sessionManager,
            tracker,
            Api(handler),
            NullLogger<RepairStatusObserver>.Instance,
            TimeSpan.FromMilliseconds(50));

        var stopwatch = Stopwatch.StartNew();
        await observer.ObserveOnceAsync(CancellationToken.None);
        stopwatch.Stop();

        await slowRequestCancelled.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1));
        Assert.Single(sent);
        Assert.Contains(fastSession.Id, sent);
    }

    [Fact]
    public async Task No_streamarr_playback_means_zero_core_traffic()
    {
        var handler = new CallbackHandler(_ => Json(HttpStatusCode.OK, RepairJson("repairing", "planning")));
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns(Array.Empty<SessionInfo>());

        var observer = new RepairStatusObserver(
            sessionManager, new PlaybackSessionTracker(), Api(handler), NullLogger<RepairStatusObserver>.Instance);
        await observer.ObserveOnceAsync(CancellationToken.None);

        Assert.Equal(0, handler.Requests);

        // Tracked but not currently playing: still no polling.
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(Guid.NewGuid(), "media-source-1", "rel-1", null, "cap-token-1");
        var idleObserver = new RepairStatusObserver(
            sessionManager, tracker, Api(handler), NullLogger<RepairStatusObserver>.Instance);
        await idleObserver.ObserveOnceAsync(CancellationToken.None);

        Assert.Equal(0, handler.Requests);
    }

    [Fact]
    public async Task A_healthy_session_produces_no_messages()
    {
        var itemId = Guid.NewGuid();
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(itemId, "media-source-1", "rel-1", null, "cap-token-1");
        var handler = new CallbackHandler(_ =>
            Json(HttpStatusCode.OK, """{"playability":"remoteReady","repair":null}"""));
        var sessionManager = Substitute.For<ISessionManager>();
        sessionManager.Sessions.Returns(new[]
        {
            PlayingSession(itemId, "media-source-1", GeneralCommandType.DisplayMessage),
        });

        var observer = new RepairStatusObserver(
            sessionManager, tracker, Api(handler), NullLogger<RepairStatusObserver>.Instance);
        await observer.ObserveOnceAsync(CancellationToken.None);

        Assert.Equal(1, handler.Requests);
        await sessionManager.DidNotReceive().SendMessageCommand(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<MessageCommand>(), Arg.Any<CancellationToken>());
    }
}
