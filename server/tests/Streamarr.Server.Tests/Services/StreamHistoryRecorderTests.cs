using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

/// <summary>
/// Exercises the real channel-backed background consumer end to end (real temp-file SQLite,
/// same pattern as <see cref="WatchEventServiceTests"/>). Writes are asynchronous by design, so
/// assertions poll briefly instead of assuming immediate visibility.
/// </summary>
public sealed class StreamHistoryRecorderTests
{
    [Fact]
    public async Task BeginAppendFinalize_RoundTrips_AndResolvesByTokenOrAttemptId()
    {
        await using var fixture = await Fixture.CreateAsync();
        var recorder = fixture.Recorder;

        var attemptId = recorder.BeginAttempt(new StreamAttemptBegin
        {
            ReleaseId = "rel-1",
            WorkId = "work-1",
            Title = "Requested.Release.2026.1080p-WEB",
            Client = "web",
        });
        recorder.AttachToken(attemptId, "token-1");
        recorder.AppendEvents(attemptId,
        [
            new StreamEventWrite(DateTimeOffset.UtcNow, "ttff", "nzb", "nzb-fetch", "ok", 0, 12),
            new StreamEventWrite(DateTimeOffset.UtcNow.AddMilliseconds(20), "error", "stream", "UsenetArticleNotFoundException", "Article missing on all providers."),
        ]);
        recorder.Finalize(attemptId, new StreamRecordFinalize
        {
            FinalState = "closed",
            ResolvedReleaseId = "rel-fallback",
            ResolvedTitle = "Fallback.Release.2026.1080p-WEB",
            BytesServed = 1024,
            NntpCommandsTotal = 3,
        });

        // Wait for the fully-settled state (Finalize applied), not just "the row exists" —
        // AttachToken makes the row findable by token before its later Finalize op has run.
        var byToken = await fixture.WaitForAsync(async () =>
        {
            var record = await recorder.GetAsync("token-1", default);
            return record is { FinalState: not null } ? record : null;
        });
        Assert.Equal("rel-1", byToken.ReleaseId);
        Assert.Equal("work-1", byToken.WorkId);
        Assert.Equal("Requested.Release.2026.1080p-WEB", byToken.Title);
        Assert.Equal("rel-fallback", byToken.ResolvedReleaseId);
        Assert.Equal("Fallback.Release.2026.1080p-WEB", byToken.ResolvedTitle);
        Assert.Equal("closed", byToken.FinalState);
        Assert.Equal(1024, byToken.BytesServed);
        Assert.Equal(2, byToken.Events.Count);
        Assert.Contains(byToken.Events, entry => entry.Name == "nzb-fetch");

        var byAttempt = await recorder.GetAsync(attemptId, default);
        Assert.NotNull(byAttempt);
        Assert.Equal(byToken.Id, byAttempt!.Id);

        var correlation = await recorder.GetCorrelationAsync("token-1", default);
        Assert.Equal(attemptId, correlation?.AttemptId);
        Assert.Equal("rel-1", correlation?.ReleaseId);
        Assert.Equal("work-1", correlation?.WorkId);

        var controller = new StreamHistoryController(recorder);
        var action = await controller.List(50, default);
        var summaries = Assert.IsAssignableFrom<IReadOnlyList<StreamRecordSummaryResponse>>(
            Assert.IsType<OkObjectResult>(action.Result).Value);
        var summary = Assert.Single(summaries, entry => entry.Token == "token-1");
        Assert.Equal("article", summary.FailureKind);
        Assert.Equal("Article missing on all providers.", summary.FailureReason);
    }

    [Fact]
    public async Task Prune_RemovesOldestClosedRowsBeyondTheCap_ButNeverAnOpenRow()
    {
        await using var fixture = await Fixture.CreateAsync(maxRetainedStreams: 2);
        var recorder = fixture.Recorder;

        BeginAndClose(recorder, "a");
        BeginAndClose(recorder, "b");
        await fixture.WaitForAsync(async () => (await recorder.ListAsync(50, default)).Count == 2 ? true : (bool?)null);

        // A third closed row pushes the count to 3; the oldest closed row ("a") must be pruned.
        // Wait for the fully-settled state specifically ("c" landed *and* "a" is gone) — "c"
        // becomes visible via its own Begin op before its later Finalize op runs Prune, so
        // merely polling for Count == 2 would also match that earlier, pre-prune instant.
        BeginAndClose(recorder, "c");
        var afterPrune = await fixture.WaitForAsync(async () =>
        {
            var list = await recorder.ListAsync(50, default);
            return list.Any(r => r.ReleaseId == "c") && !list.Any(r => r.ReleaseId == "a") ? list : null;
        });
        Assert.Equal(2, afterPrune.Count);
        Assert.DoesNotContain(afterPrune, r => r.ReleaseId == "a");
        Assert.Contains(afterPrune, r => r.ReleaseId == "b");
        Assert.Contains(afterPrune, r => r.ReleaseId == "c");

        // A still-open row is never a prune candidate, even though it's the oldest of all.
        var openAttempt = recorder.BeginAttempt(new StreamAttemptBegin { ReleaseId = "still-open" });
        await fixture.WaitForAsync(() => recorder.GetAsync(openAttempt, default));
        BeginAndClose(recorder, "d");
        var final = await fixture.WaitForAsync(async () =>
        {
            var list = await recorder.ListAsync(50, default);
            return list.Any(r => r.ReleaseId == "d") ? list : null;
        });
        Assert.Contains(final, r => r.ReleaseId == "still-open" && r.FinalState is null);
    }

    [Fact]
    public async Task Prune_CascadeDeletesTheEventsOfARemovedRecord()
    {
        await using var fixture = await Fixture.CreateAsync(maxRetainedStreams: 1);
        var recorder = fixture.Recorder;

        var pruned = recorder.BeginAttempt(new StreamAttemptBegin { ReleaseId = "pruned" });
        recorder.AppendEvents(pruned, [new StreamEventWrite(DateTimeOffset.UtcNow, "ttff", "nzb", "x")]);
        recorder.Finalize(pruned, new StreamRecordFinalize { FinalState = "closed" });
        // Wait for the fully-settled state, not just "the row exists" — BeginAttempt makes the
        // row findable before the later AppendEvents/Finalize ops queued behind it have run.
        var prunedRecord = await fixture.WaitForAsync(async () =>
        {
            var record = await recorder.GetAsync(pruned, default);
            return record is { FinalState: not null } ? record : null;
        });
        Assert.Single(prunedRecord.Events);

        BeginAndClose(recorder, "survivor");
        await fixture.WaitForAsync(async () => (await recorder.GetAsync(pruned, default)) is null ? true : (bool?)null);

        Assert.Null(await recorder.GetAsync(pruned, default));

        await using var db = await fixture.DbFactory.CreateDbContextAsync();
        Assert.False(await db.StreamEvents.AnyAsync(e => e.StreamRecordId == prunedRecord.Id));
    }

    [Fact]
    public async Task Startup_FinalizesPriorOpenRowsThenPrunesWithoutTouchingCurrentAttempts()
    {
        await using var fixture = await Fixture.CreateAsync(
            maxRetainedStreams: 2,
            seed: async db =>
            {
                for (var index = 1; index <= 3; index++)
                {
                    db.StreamRecords.Add(new StreamRecordEntity
                    {
                        AttemptId = $"attempt-prior-{index}",
                        ReleaseId = $"prior-{index}",
                        WorkId = "work",
                        CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-index),
                    });
                }
                await db.SaveChangesAsync();
            });

        var recovered = await fixture.WaitForAsync(async () =>
        {
            var records = await fixture.Recorder.ListAsync(50, default);
            return records.Count == 2 && records.All(record => record.FinalState == "interrupted")
                ? records
                : null;
        });
        Assert.DoesNotContain(recovered, record => record.ReleaseId == "prior-1");
        Assert.All(recovered, record =>
        {
            Assert.NotNull(record.ClosedAt);
            Assert.Equal("server process ended before stream history was finalized", record.CloseReason);
        });

        var currentAttempt = fixture.Recorder.BeginAttempt(new StreamAttemptBegin { ReleaseId = "current" });
        var current = await fixture.WaitForAsync(() => fixture.Recorder.GetAsync(currentAttempt, default));
        Assert.Null(current.FinalState);
        Assert.Null(current.ClosedAt);
    }

    private static void BeginAndClose(IStreamHistoryRecorder recorder, string releaseId)
    {
        var attemptId = recorder.BeginAttempt(new StreamAttemptBegin { ReleaseId = releaseId });
        recorder.Finalize(attemptId, new StreamRecordFinalize { FinalState = "closed" });
    }

    /// <summary>Owns the temp SQLite file and the running background consumer for one test.</summary>
    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string _directory;
        private readonly ServiceProvider _provider;

        private Fixture(string directory, ServiceProvider provider, StreamHistoryRecorder recorder)
        {
            _directory = directory;
            _provider = provider;
            Recorder = recorder;
        }

        public StreamHistoryRecorder Recorder { get; }
        public IDbContextFactory<StreamarrDbContext> DbFactory => _provider.GetRequiredService<IDbContextFactory<StreamarrDbContext>>();

        public static async Task<Fixture> CreateAsync(
            int maxRetainedStreams = 50,
            Func<StreamarrDbContext, Task>? seed = null)
        {
            var directory = Directory.CreateTempSubdirectory("streamarr-stream-history-").FullName;
            var services = new ServiceCollection();
            services.AddDbContextFactory<StreamarrDbContext>(o =>
                o.UseSqlite($"Data Source={Path.Combine(directory, "history.db")}"));
            services.AddSingleton(TimeProvider.System);
            services.Configure<StreamarrOptions>(o => o.MaxRetainedStreams = maxRetainedStreams);
            services.AddSingleton<ILogger<StreamHistoryRecorder>>(NullLogger<StreamHistoryRecorder>.Instance);
            services.AddSingleton<StreamHistoryRecorder>();
            var provider = services.BuildServiceProvider();

            await using (var db = await provider.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
            {
                await db.Database.EnsureCreatedAsync();
                if (seed is not null)
                    await seed(db);
            }

            var recorder = provider.GetRequiredService<StreamHistoryRecorder>();
            await recorder.StartAsync(CancellationToken.None);
            return new Fixture(directory, provider, recorder);
        }

        /// <summary>Polls a probe up to ~2s for the background consumer to catch up; throws on timeout.</summary>
        public async Task<T> WaitForAsync<T>(Func<Task<T?>> probe)
        {
            var deadline = DateTime.UtcNow.AddSeconds(2);
            while (DateTime.UtcNow < deadline)
            {
                var result = await probe();
                if (result is not null)
                    return result;
                await Task.Delay(20);
            }
            throw new TimeoutException("Timed out waiting for the stream history background consumer.");
        }

        public async ValueTask DisposeAsync()
        {
            await Recorder.StopAsync(CancellationToken.None);
            await _provider.DisposeAsync();
            Directory.Delete(_directory, recursive: true);
        }
    }
}
