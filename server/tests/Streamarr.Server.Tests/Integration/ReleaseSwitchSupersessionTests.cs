using Microsoft.Extensions.Logging;
using Streamarr.Core.Media;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Integration;

[Collection("streamarr-server")]
public sealed class ReleaseSwitchSupersessionTests(StreamarrServerFixture fixture)
{
    private static readonly byte[] Payload = [1, 2, 3, 4, 5, 6, 7, 8];
    private static readonly DateTimeOffset ObservationEpoch =
        DateTimeOffset.Parse("2026-08-27T12:00:00Z");
    private static int _identity;

    [Fact]
    public async Task Observe_KeepsPreviousReleaseBelowGrace_AndPurgesItAtExactGrace()
    {
        await WithGracePolicyAsync(10, () =>
        {
            var scenario = CreateScenario();
            try
            {
                Observe(scenario.Old, "start", 0, scenario.UserId, "playback-a", At(0));
                Observe(scenario.Selected, "start", 0, scenario.UserId, "playback-b", At(0));

                Observe(
                    scenario.Selected,
                    "progress",
                    Seconds(9),
                    scenario.UserId,
                    "playback-b",
                    At(9));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Selected,
                    "progress",
                    Seconds(10),
                    scenario.UserId,
                    "playback-b",
                    At(10));
                AssertPurged(scenario.Old);
                AssertRetained(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task Observe_FirstProgressWithoutStartSelectsNewRelease_ThenUsesObservedGrace()
    {
        await WithGracePolicyAsync(10, () =>
        {
            var scenario = CreateScenario();
            try
            {
                var resumePosition = TimeSpan.FromMinutes(37).Ticks;
                Observe(scenario.Old, "start", 0, scenario.UserId, "playback-a", At(0));

                Observe(
                    scenario.Selected,
                    "progress",
                    resumePosition,
                    scenario.UserId,
                    "playback-b",
                    At(0));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Selected,
                    "progress",
                    resumePosition + Seconds(9),
                    scenario.UserId,
                    "playback-b",
                    At(9));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Selected,
                    "progress",
                    resumePosition + Seconds(10),
                    scenario.UserId,
                    "playback-b",
                    At(10));
                AssertPurged(scenario.Old);
                AssertRetained(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task Observe_ImmediateForwardSeekDoesNotSatisfyObservedGrace()
    {
        await WithGracePolicyAsync(10, () =>
        {
            var scenario = CreateScenario();
            try
            {
                var seekPosition = TimeSpan.FromHours(1).Ticks;
                Observe(scenario.Old, "start", 0, scenario.UserId, "playback-a", At(0));
                Observe(scenario.Selected, "start", 0, scenario.UserId, "playback-b", At(0));

                Observe(
                    scenario.Selected,
                    "progress",
                    seekPosition,
                    scenario.UserId,
                    "playback-b",
                    At(0));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Selected,
                    "progress",
                    seekPosition + Seconds(9),
                    scenario.UserId,
                    "playback-b",
                    At(9));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Selected,
                    "progress",
                    seekPosition + Seconds(10),
                    scenario.UserId,
                    "playback-b",
                    At(10));
                AssertPurged(scenario.Old);
                AssertRetained(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task Enqueue_AppliesReleaseSwitchBeforeTheBestEffortQueueCanDropTheEvent()
    {
        await WithGracePolicyAsync(0, () =>
        {
            var scenario = CreateScenario();
            try
            {
                var coordinator = fixture.GetRequiredService<PreDownloadCoordinator>();
                Assert.True(coordinator.Enqueue(Event(
                    scenario.Selected,
                    "start",
                    0,
                    scenario.UserId,
                    "playback-b")));
                coordinator.Enqueue(Event(
                    scenario.Selected,
                    "progress",
                    0,
                    scenario.UserId,
                    "playback-b"));

                AssertPurged(scenario.Old);
                AssertRetained(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task Observe_IgnoresStaleProgressFromThePreviouslySelectedRelease()
    {
        await WithGracePolicyAsync(10, () =>
        {
            var scenario = CreateScenario();
            try
            {
                Observe(scenario.Old, "start", 0, scenario.UserId, "playback-a", At(0));
                Observe(scenario.Selected, "start", 0, scenario.UserId, "playback-b", At(0));

                Observe(
                    scenario.Old,
                    "progress",
                    Seconds(30),
                    scenario.UserId,
                    "playback-a",
                    At(5));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Selected,
                    "progress",
                    Seconds(9),
                    scenario.UserId,
                    "playback-b",
                    At(9));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Selected,
                    "progress",
                    Seconds(10),
                    scenario.UserId,
                    "playback-b",
                    At(10));
                AssertPurged(scenario.Old);
                AssertRetained(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Observe_UsesTheCurrentPlaybackAsResumeBaseline(bool sendsStart)
    {
        await WithGracePolicyAsync(10, () =>
        {
            var scenario = CreateScenario();
            try
            {
                var resumePosition = TimeSpan.FromMinutes(42).Ticks;
                if (sendsStart)
                {
                    Observe(
                        scenario.Selected,
                        "start",
                        resumePosition,
                        scenario.UserId,
                        "playback-b",
                        At(0));
                }
                else
                {
                    Observe(
                        scenario.Selected,
                        "progress",
                        resumePosition,
                        scenario.UserId,
                        "playback-b",
                        At(0));
                }

                AssertRetained(scenario.Old);
                Observe(
                    scenario.Selected,
                    "progress",
                    resumePosition + Seconds(9),
                    scenario.UserId,
                    "playback-b",
                    At(9));
                AssertRetained(scenario.Old);

                Observe(
                    scenario.Selected,
                    "progress",
                    resumePosition + Seconds(10),
                    scenario.UserId,
                    "playback-b",
                    At(10));
                AssertPurged(scenario.Old);
                AssertRetained(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task Observe_A_To_B_To_A_PurgesOnlyTheAbandonedBRelease()
    {
        await WithGracePolicyAsync(10, () =>
        {
            var scenario = CreateScenario();
            try
            {
                Observe(
                    scenario.Old,
                    "start",
                    Seconds(100),
                    scenario.UserId,
                    "playback-a",
                    At(0));
                Observe(
                    scenario.Selected,
                    "start",
                    Seconds(200),
                    scenario.UserId,
                    "playback-b",
                    At(0));
                Observe(
                    scenario.Selected,
                    "progress",
                    Seconds(209),
                    scenario.UserId,
                    "playback-b",
                    At(9));
                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);

                Observe(
                    scenario.Old,
                    "start",
                    Seconds(110),
                    scenario.UserId,
                    "playback-a-2",
                    At(9));
                Observe(
                    scenario.Old,
                    "progress",
                    Seconds(120),
                    scenario.UserId,
                    "playback-a-2",
                    At(19));

                AssertRetained(scenario.Old);
                AssertPurged(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task Observe_FailsClosedWithoutTheExactTokenAndStableUserId()
    {
        await WithGracePolicyAsync(10, () =>
        {
            var scenario = CreateScenario();
            try
            {
                Observe(scenario.Old, "start", 0, scenario.UserId, "playback-a", At(0));
                fixture.GetRequiredService<PreDownloadCoordinator>().Observe(
                    Event(scenario.Selected, "start", 0, scenario.UserId, "playback-b") with
                    {
                        SessionToken = null,
                    },
                    At(0));
                fixture.GetRequiredService<PreDownloadCoordinator>().Observe(
                    Event(scenario.Selected, "progress", Seconds(20), scenario.UserId, "playback-b") with
                    {
                        SessionToken = null,
                    },
                    At(20));
                fixture.GetRequiredService<PreDownloadCoordinator>().Observe(
                    Event(scenario.Selected, "start", 0, scenario.UserId, "playback-b") with
                    {
                        ExternalUserId = null,
                    },
                    At(0));
                Observe(
                    scenario.Selected,
                    "progress",
                    Seconds(20),
                    "a-different-user",
                    "playback-b",
                    At(20));

                AssertRetained(scenario.Old);
                AssertRetained(scenario.Selected);
            }
            finally
            {
                Cleanup(scenario);
            }

            return Task.CompletedTask;
        });
    }

    [Fact]
    public async Task SupersedeOtherReleases_ForceClosesStream_PurgesCache_AndFinalizesHistory()
    {
        var history = new FakeStreamHistoryRecorder();
        var logger = new CapturingLogger<SessionManager>();
        var manager = CreateManager(history, logger);
        var attemptId = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "release-a" });
        var old = manager.CreateSession(
            "release-a",
            "tmdb-movie-4242",
            MediaFile(),
            "jellyfin",
            "user-1",
            streamAttemptId: attemptId);
        var selected = manager.CreateSession(
            "release-b",
            "tmdb-movie-4242",
            MediaFile(),
            "jellyfin",
            "user-1");
        var workspace = fixture.GetRequiredService<PreDownloadWorkspace>();
        var cache = new PreDownloadCacheFile(workspace, old.Token, Payload.Length);
        var paths = workspace.Paths(old.Token);
        Stream? oldStream = null;

        try
        {
            await cache.DownloadAsync(
                new MemoryStream(Payload),
                onProgress: null,
                CancellationToken.None);
            Assert.True(File.Exists(paths.Complete));
            Assert.True(old.AttachPreDownload(
                cache,
                "job-a",
                "currentFile",
                "test pre-download",
                sourceToken: null));
            oldStream = manager.OpenStream(old);

            var removed = manager.SupersedeOtherReleases(selected, graceSeconds: 10);

            var superseded = Assert.Single(removed);
            Assert.Equal(old.Token, superseded.Token);
            Assert.Equal("release-a", superseded.ReleaseId);
            Assert.Equal("job-a", superseded.PreDownloadJobId);
            Assert.Equal(Payload.Length, superseded.PreDownloadedBytes);
            AssertPurged(manager, old);
            AssertRetained(manager, selected);
            Assert.True(cache.IsCancelled);
            Assert.False(File.Exists(paths.Partial));
            Assert.False(File.Exists(paths.Complete));
            Assert.Throws<ObjectDisposedException>(() => oldStream.ReadByte());

            Assert.Contains(history.Finalized, item =>
                item.AttemptId == attemptId
                && item.Finalize.FinalState == "purged"
                && item.Finalize.ResolvedReleaseId == "release-a"
                && item.Finalize.CloseReason is not null
                && item.Finalize.CloseReason.Contains("superseded", StringComparison.Ordinal)
                && item.Finalize.CloseReason.Contains("release-b", StringComparison.Ordinal));
            Assert.Contains(history.Appended.SelectMany(item => item.Events), item =>
                item.Name == "release-superseded"
                && item.Detail is not null
                && item.Detail.Contains("release-b", StringComparison.Ordinal));
            Assert.Contains(logger.Entries, entry =>
                entry.Level == LogLevel.Information
                && entry.Message.Contains("superseded", StringComparison.OrdinalIgnoreCase)
                && entry.Message.Contains("release-a", StringComparison.Ordinal)
                && entry.Message.Contains("release-b", StringComparison.Ordinal));
        }
        finally
        {
            oldStream?.Dispose();
            cache.Dispose();
            manager.CloseSession(old.Token);
            manager.CloseSession(selected.Token);
        }
    }

    [Fact]
    public async Task SupersedeOtherReleases_CancelsRunningPreDownloadAndDeletesPartialFile()
    {
        var manager = CreateManager();
        var old = Session(manager, "release-partial-a", "tmdb-movie-4343", "user-1");
        var selected = Session(manager, "release-partial-b", "tmdb-movie-4343", "user-1");
        var workspace = fixture.GetRequiredService<PreDownloadWorkspace>();
        var cache = new PreDownloadCacheFile(workspace, old.Token, Payload.Length);
        var paths = workspace.Paths(old.Token);
        await using var source = new Streamarr.Server.Tests.Services.PausedAfterPrefixStream(
            Payload,
            prefixLength: 3);
        Assert.True(old.AttachPreDownload(
            cache,
            "job-partial",
            "currentFile",
            "test pre-download",
            sourceToken: null));

        try
        {
            var download = cache.DownloadAsync(source, onProgress: null, CancellationToken.None);
            await source.WaitUntilPausedAsync();
            Assert.True(File.Exists(paths.Partial));

            Assert.Single(manager.SupersedeOtherReleases(selected, graceSeconds: 10));

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => download);
            Assert.True(cache.IsCancelled);
            Assert.False(File.Exists(paths.Partial));
            Assert.False(File.Exists(paths.Complete));
            AssertPurged(manager, old);
            AssertRetained(manager, selected);
        }
        finally
        {
            cache.Dispose();
            manager.CloseSession(old.Token);
            manager.CloseSession(selected.Token);
        }
    }

    [Fact]
    public async Task Coordinator_ReleaseSwitchCancelsRunningJobAndPurgesItsPartialFile()
    {
        var config = fixture.GetRequiredService<PreDownloadConfigService>();
        var coordinator = fixture.GetRequiredService<PreDownloadCoordinator>();
        var manager = fixture.GetRequiredService<SessionManager>();
        var workspace = fixture.GetRequiredService<PreDownloadWorkspace>();
        var original = config.Current;
        var identity = Interlocked.Increment(ref _identity);
        var workId = $"tmdb-movie-{950000 + identity}";
        var userId = $"release-switch-job-user-{identity}";
        await using var source = new Streamarr.Server.Tests.Services.PausedAfterPrefixStream(
            Payload,
            prefixLength: 3);
        var old = manager.CreateSession(
            $"release-job-a-{identity}",
            workId,
            MediaFile() with
            {
                OpenPreDownloadStream = (_, _, _) => source,
            },
            "jellyfin",
            userId);
        ActiveSession? selected = null;
        var paths = workspace.Paths(old.Token);

        try
        {
            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = true,
                DownloadCurrentFile = true,
                CurrentFileThresholdSeconds = 1,
                DownloadNextEpisode = false,
                NextEpisodeThresholdPercent = original.NextEpisodeThresholdPercent,
                MaxConcurrentDownloads = 1,
            }, CancellationToken.None);

            Observe(old, "start", 0, userId, "playback-a", At(0));
            Observe(old, "progress", Seconds(1), userId, "playback-a", At(1));
            await source.WaitUntilPausedAsync();
            Assert.True(File.Exists(paths.Partial));
            Assert.True(old.IsPreDownloading);

            selected = Session(
                manager,
                $"release-job-b-{identity}",
                workId,
                userId);
            Observe(selected, "start", 0, userId, "playback-b", At(2));
            Observe(selected, "progress", Seconds(1), userId, "playback-b", At(3));

            var job = Assert.Single(coordinator.List(old.Token));
            Assert.Equal("cancelled", job.State);
            Assert.Equal("release_superseded", job.ErrorCode);
            Assert.Contains(selected.Session.ReleaseId, job.ErrorMessage);
            AssertPurged(manager, old);
            AssertRetained(manager, selected);
            Assert.True(old.PreDownloadCache?.IsCancelled);
            Assert.False(File.Exists(paths.Partial));
            Assert.False(File.Exists(paths.Complete));
        }
        finally
        {
            manager.CloseSession(old.Token);
            if (selected is not null)
                manager.CloseSession(selected.Token);
            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = original.Enabled,
                DownloadCurrentFile = original.DownloadCurrentFile,
                CurrentFileThresholdSeconds = original.CurrentFileThresholdSeconds,
                DownloadNextEpisode = original.DownloadNextEpisode,
                NextEpisodeThresholdPercent = original.NextEpisodeThresholdPercent,
                MaxConcurrentDownloads = original.MaxConcurrentDownloads,
            }, CancellationToken.None);
        }
    }

    [Fact]
    public void PreDownloadJob_ReleaseSwitchReasonWinsTheCancellationRace()
    {
        var manager = CreateManager();
        var source = Session(manager, "release-job-a", "tmdb-movie-4444", "user-1");
        var now = DateTimeOffset.Parse("2026-08-27T12:00:00Z");
        var job = new PreDownloadJob(
            "job-a",
            "currentFile",
            "test pre-download",
            source,
            watchPositionTicks: Seconds(10),
            watchDurationTicks: Seconds(100),
            watchProgressPercent: 10,
            triggerThreshold: 10,
            triggerUnit: "seconds",
            now);

        try
        {
            Assert.True(job.TryStart(now));
            job.End("cancelled", "cancelled", "generic cancellation", now.AddSeconds(1));
            job.CancelForReleaseSwitch("release-job-b", 10, now.AddSeconds(1));
            job.Complete(now.AddSeconds(2));

            var snapshot = job.Snapshot();
            Assert.Equal("cancelled", snapshot.State);
            Assert.Equal("release_superseded", snapshot.ErrorCode);
            Assert.Contains("release-job-b", snapshot.ErrorMessage);
            Assert.False(job.TryStart(now.AddSeconds(3)));
        }
        finally
        {
            manager.CloseSession(source.Token);
        }
    }

    [Fact]
    public void SupersedeOtherReleases_IsScopedByCanonicalWorkAndStableRequester()
    {
        var manager = CreateManager();
        var matching = Session(manager, "old-match", "tmdb-movie-5150", "user-1");
        var sameRelease = Session(manager, "selected", "tmdb-movie-5150", "user-1");
        var otherUser = Session(manager, "old-other-user", "tmdb-movie-5150", "user-2");
        var otherWork = Session(manager, "old-other-work", "tmdb-movie-5151", "user-1");
        var anonymous = Session(manager, "old-anonymous", "tmdb-movie-5150", requestedById: null);
        var selected = Session(manager, "selected", "tmdb-movie-5150", "user-1");

        try
        {
            var removed = manager.SupersedeOtherReleases(selected, graceSeconds: 10);

            Assert.Equal(matching.Token, Assert.Single(removed).Token);
            AssertPurged(manager, matching);
            AssertRetained(manager, selected);
            AssertRetained(manager, sameRelease);
            AssertRetained(manager, otherUser);
            AssertRetained(manager, otherWork);
            AssertRetained(manager, anonymous);
        }
        finally
        {
            foreach (var session in new[]
                     {
                         matching,
                         sameRelease,
                         otherUser,
                         otherWork,
                         anonymous,
                         selected,
                     })
            {
                manager.CloseSession(session.Token);
            }
        }
    }

    [Fact]
    public void SupersedeOtherReleases_NormalizesTvAliases_AndSeparatesClientNamespace()
    {
        var manager = CreateManager();
        var matchingAlias = Session(
            manager,
            "old-tv-alias",
            "tmdb-tv-5250-s1e2",
            "user-1",
            client: "jellyfin");
        var otherClient = Session(
            manager,
            "old-other-client",
            "tmdb-tv-5250-s01e02",
            "user-1",
            client: "plex");
        var otherEpisode = Session(
            manager,
            "old-other-episode",
            "tmdb-tv-5250-s01e03",
            "user-1",
            client: "jellyfin");
        var selected = Session(
            manager,
            "selected-tv",
            "tmdb-tv-5250-s01e02",
            "user-1",
            client: "jellyfin");

        try
        {
            var removed = manager.SupersedeOtherReleases(selected, graceSeconds: 10);

            Assert.Equal(matchingAlias.Token, Assert.Single(removed).Token);
            AssertPurged(manager, matchingAlias);
            AssertRetained(manager, selected);
            AssertRetained(manager, otherClient);
            AssertRetained(manager, otherEpisode);
        }
        finally
        {
            foreach (var session in new[]
                     {
                         matchingAlias,
                         otherClient,
                         otherEpisode,
                         selected,
                     })
            {
                manager.CloseSession(session.Token);
            }
        }
    }

    [Fact]
    public void SupersedeOtherReleases_FailsClosedForMissingOrNonCanonicalIdentity()
    {
        var manager = CreateManager();
        var anonymousOld = Session(manager, "anonymous-a", "tmdb-movie-6161", requestedById: null);
        var anonymousSelected = Session(manager, "anonymous-b", "tmdb-movie-6161", requestedById: null);
        var nonCanonicalOld = Session(manager, "invalid-a", "6161", "user-1");
        var nonCanonicalSelected = Session(manager, "invalid-b", "6161", "user-1");

        try
        {
            Assert.Empty(manager.SupersedeOtherReleases(anonymousSelected, graceSeconds: 10));
            Assert.Empty(manager.SupersedeOtherReleases(nonCanonicalSelected, graceSeconds: 10));
            AssertRetained(manager, anonymousOld);
            AssertRetained(manager, anonymousSelected);
            AssertRetained(manager, nonCanonicalOld);
            AssertRetained(manager, nonCanonicalSelected);
        }
        finally
        {
            foreach (var session in new[]
                     {
                         anonymousOld,
                         anonymousSelected,
                         nonCanonicalOld,
                         nonCanonicalSelected,
                     })
            {
                manager.CloseSession(session.Token);
            }
        }
    }

    private async Task WithGracePolicyAsync(int graceSeconds, Func<Task> assertion)
    {
        var config = fixture.GetRequiredService<PreDownloadConfigService>();
        var original = config.Current;
        try
        {
            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = false,
                DownloadCurrentFile = false,
                CurrentFileThresholdSeconds = graceSeconds,
                DownloadNextEpisode = false,
                NextEpisodeThresholdPercent = original.NextEpisodeThresholdPercent,
                MaxConcurrentDownloads = original.MaxConcurrentDownloads,
            }, CancellationToken.None);
            await assertion();
        }
        finally
        {
            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = original.Enabled,
                DownloadCurrentFile = original.DownloadCurrentFile,
                CurrentFileThresholdSeconds = original.CurrentFileThresholdSeconds,
                DownloadNextEpisode = original.DownloadNextEpisode,
                NextEpisodeThresholdPercent = original.NextEpisodeThresholdPercent,
                MaxConcurrentDownloads = original.MaxConcurrentDownloads,
            }, CancellationToken.None);
        }
    }

    private Scenario CreateScenario()
    {
        var identity = Interlocked.Increment(ref _identity);
        var manager = fixture.GetRequiredService<SessionManager>();
        var workId = $"tmdb-movie-{900000 + identity}";
        var userId = $"release-switch-user-{identity}";
        return new Scenario(
            manager,
            Session(manager, $"release-a-{identity}", workId, userId),
            Session(manager, $"release-b-{identity}", workId, userId),
            userId);
    }

    private void Observe(
        ActiveSession session,
        string eventKind,
        long positionTicks,
        string userId,
        string playbackSessionId,
        DateTimeOffset observedAt)
        => fixture.GetRequiredService<PreDownloadCoordinator>().Observe(
            Event(session, eventKind, positionTicks, userId, playbackSessionId),
            observedAt);

    private static WatchEventWrite Event(
        ActiveSession session,
        string eventKind,
        long positionTicks,
        string userId,
        string playbackSessionId)
        => new()
        {
            ReleaseId = session.Session.ReleaseId,
            WorkId = session.Session.WorkId,
            Event = eventKind,
            PositionTicks = positionTicks,
            DurationTicks = TimeSpan.FromHours(2).Ticks,
            SessionToken = session.Token,
            Source = session.Session.Client,
            PlaybackSessionId = playbackSessionId,
            ExternalUserId = userId,
        };

    private static ActiveSession Session(
        SessionManager manager,
        string releaseId,
        string workId,
        string? requestedById,
        string? client = "jellyfin")
        => manager.CreateSession(
            releaseId,
            workId,
            MediaFile(),
            client,
            requestedById);

    private static SessionManager CreateManager(
        IStreamHistoryRecorder? history = null,
        ILogger<SessionManager>? logger = null)
        => new(
            new Streamarr.Server.Tests.Services.FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                SessionTtlSeconds = 300,
                EphemeralCacheSizeMb = 100,
                MaxSessions = 100,
                MaxConcurrentStreams = 10,
            }),
            logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<SessionManager>.Instance,
            historyRecorder: history);

    private static ResolvedMediaFile MediaFile() => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = Payload.Length,
        OpenStream = _ => new MemoryStream(Payload),
    };

    private static long Seconds(int seconds) => seconds * TimeSpan.TicksPerSecond;

    private static DateTimeOffset At(int seconds) => ObservationEpoch.AddSeconds(seconds);

    private static void AssertRetained(SessionManager manager, ActiveSession session)
    {
        Assert.True(manager.TryGetSession(session.Token, out var retained));
        Assert.Same(session, retained);
    }

    private void AssertRetained(ActiveSession session)
        => AssertRetained(fixture.GetRequiredService<SessionManager>(), session);

    private static void AssertPurged(SessionManager manager, ActiveSession session)
    {
        Assert.False(manager.TryGetSession(session.Token, out _));
        Assert.True(session.IsClosed);
    }

    private void AssertPurged(ActiveSession session)
        => AssertPurged(fixture.GetRequiredService<SessionManager>(), session);

    private static void Cleanup(Scenario scenario)
    {
        scenario.Manager.CloseSession(scenario.Old.Token);
        scenario.Manager.CloseSession(scenario.Selected.Token);
    }

    private sealed record Scenario(
        SessionManager Manager,
        ActiveSession Old,
        ActiveSession Selected,
        string UserId);

    private sealed class FakeStreamHistoryRecorder : IStreamHistoryRecorder
    {
        private int _attempts;

        public List<(string? AttemptId, IReadOnlyList<StreamEventWrite> Events)> Appended { get; } = [];
        public List<(string? AttemptId, StreamRecordFinalize Finalize)> Finalized { get; } = [];

        public string BeginAttempt(StreamAttemptBegin begin)
            => $"attempt-{Interlocked.Increment(ref _attempts)}";

        public void AttachToken(string attemptId, string sessionToken)
        {
        }

        public void AppendEvents(string? attemptId, IReadOnlyList<StreamEventWrite> events)
            => Appended.Add((attemptId, events));

        public void Finalize(string? attemptId, StreamRecordFinalize finalize)
            => Finalized.Add((attemptId, finalize));
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));
    }
}
