using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class PreDownloadJobReleaseSwitchRaceTests
{
    private static readonly DateTimeOffset Now =
        DateTimeOffset.Parse("2026-08-27T12:00:00Z");

    [Theory]
    [InlineData("skipped", "source_expired")]
    [InlineData("skipped", "disk_space")]
    [InlineData("failed", "download_failed")]
    [InlineData("cancelled", "cancelled")]
    public async Task ReleaseSuperseded_WinsConcurrentNonSuccessfulTerminalState(
        string competingState,
        string competingCode)
    {
        var context = CreateJob();
        try
        {
            Assert.True(context.Job.TryStart(Now));
            using var ready = new CountdownEvent(2);
            using var start = new ManualResetEventSlim();

            var competingEnd = Task.Run(() =>
            {
                ready.Signal();
                start.Wait();
                context.Job.End(
                    competingState,
                    competingCode,
                    "competing terminal state",
                    Now.AddSeconds(1));
            });
            var supersede = Task.Run(() =>
            {
                ready.Signal();
                start.Wait();
                context.Job.CancelForReleaseSwitch(
                    "release-b",
                    graceSeconds: 10,
                    Now.AddSeconds(1));
            });

            Assert.True(ready.Wait(TimeSpan.FromSeconds(5)));
            start.Set();
            await Task.WhenAll(competingEnd, supersede);

            var snapshot = context.Job.Snapshot();
            Assert.Equal("cancelled", snapshot.State);
            Assert.Equal("release_superseded", snapshot.ErrorCode);
            Assert.Contains("release-b", snapshot.ErrorMessage);
            Assert.False(context.Job.TryStart(Now.AddSeconds(2)));
        }
        finally
        {
            context.Dispose();
        }
    }

    [Fact]
    public void CompletedTransfer_RemainsCompletedWhenReleaseIsLaterSuperseded()
    {
        var context = CreateJob();
        try
        {
            Assert.True(context.Job.TryStart(Now));
            context.Job.Complete(Now.AddSeconds(1));
            context.Job.CancelForReleaseSwitch(
                "release-b",
                graceSeconds: 10,
                Now.AddSeconds(2));

            var snapshot = context.Job.Snapshot();
            Assert.Equal("completed", snapshot.State);
            Assert.Null(snapshot.ErrorCode);
            Assert.Equal(100, snapshot.ProgressPercent);
            Assert.Equal(Now.AddSeconds(1), snapshot.CompletedAt);
        }
        finally
        {
            context.Dispose();
        }
    }

    [Fact]
    public void LateCompletion_DoesNotEraseReleaseSupersededCause()
    {
        var context = CreateJob();
        try
        {
            Assert.True(context.Job.TryStart(Now));
            context.Job.CancelForReleaseSwitch(
                "release-b",
                graceSeconds: 10,
                Now.AddSeconds(1));
            context.Job.Complete(Now.AddSeconds(2));

            var snapshot = context.Job.Snapshot();
            Assert.Equal("cancelled", snapshot.State);
            Assert.Equal("release_superseded", snapshot.ErrorCode);
            Assert.Equal(Now.AddSeconds(1), snapshot.CompletedAt);
        }
        finally
        {
            context.Dispose();
        }
    }

    private static JobContext CreateJob()
    {
        var manager = new SessionManager(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                SessionTtlSeconds = 300,
                EphemeralCacheSizeMb = 100,
                MaxSessions = 10,
                MaxConcurrentStreams = 10,
            }),
            NullLogger<SessionManager>.Instance);
        var source = manager.CreateSession(
            "release-a",
            "tmdb-movie-1234",
            new ResolvedMediaFile
            {
                FileName = "video.mkv",
                Container = "mkv",
                SizeBytes = 1024,
                OpenStream = _ => new MemoryStream(new byte[16]),
            },
            "jellyfin",
            "user-1");
        var job = new PreDownloadJob(
            "job-a",
            "currentFile",
            "test pre-download",
            source,
            watchPositionTicks: TimeSpan.FromSeconds(10).Ticks,
            watchDurationTicks: TimeSpan.FromMinutes(90).Ticks,
            watchProgressPercent: 1,
            triggerThreshold: 10,
            triggerUnit: "seconds",
            Now);
        return new JobContext(manager, source, job);
    }

    private sealed record JobContext(
        SessionManager Manager,
        ActiveSession Source,
        PreDownloadJob Job) : IDisposable
    {
        public void Dispose() => Manager.CloseSession(Source.Token);
    }
}
