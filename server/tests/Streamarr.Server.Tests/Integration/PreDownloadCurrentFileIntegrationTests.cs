using System.Net;
using System.Net.Http.Json;
using Streamarr.Core.Media;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Integration;

[Collection("streamarr-server")]
public sealed class PreDownloadCurrentFileIntegrationTests(StreamarrServerFixture fixture)
{
    [Fact]
    public async Task NextEpisodeTrigger_UsesWatchPercentageAtExactThreshold_AndIgnoresMovies()
    {
        const string episodeWorkId = "tmdb-tv-987654-s01e01";
        var config = fixture.GetRequiredService<PreDownloadConfigService>();
        var coordinator = fixture.GetRequiredService<PreDownloadCoordinator>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        var releases = fixture.GetRequiredService<IReleaseStore>();
        var originalPolicy = config.Current;
        string? movieToken = null;
        string? episodeToken = null;

        try
        {
            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = true,
                DownloadCurrentFile = false,
                CurrentFileThresholdSeconds = originalPolicy.CurrentFileThresholdSeconds,
                DownloadNextEpisode = true,
                NextEpisodeThresholdPercent = 75,
                MaxConcurrentDownloads = 1,
            }, CancellationToken.None);

            var direct = Assert.IsType<RegisteredRelease>(
                releases.Get(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1"));
            releases.Register(episodeWorkId, direct.Release);

            using var client = fixture.CreateClient();
            movieToken = await ResolveTokenAsync(client, "tmdb-movie-1", "movie-threshold-user");
            coordinator.Observe(Progress(
                movieToken,
                "tmdb-movie-1",
                watchPositionTicks: 750,
                watchDurationTicks: 1_000));
            Assert.Empty(coordinator.List(movieToken));

            episodeToken = await ResolveTokenAsync(client, episodeWorkId, "episode-threshold-user");
            coordinator.Observe(Progress(
                episodeToken,
                episodeWorkId,
                watchPositionTicks: 749,
                watchDurationTicks: 1_000));
            Assert.Empty(coordinator.List(episodeToken));

            coordinator.Observe(Progress(
                episodeToken,
                episodeWorkId,
                watchPositionTicks: 750,
                watchDurationTicks: 1_000));

            var job = Assert.Single(coordinator.List(episodeToken));
            Assert.Equal("nextEpisode", job.Kind);
            Assert.Equal(750, job.WatchPositionTicks);
            Assert.Equal(1_000, job.WatchDurationTicks);
            Assert.Equal(75d, job.WatchProgressPercent);
            Assert.Equal(75d, job.TriggerThreshold);
            Assert.Equal("percent", job.TriggerUnit);
            Assert.Equal(0, job.BytesDownloaded);
            Assert.Equal(0, job.TotalBytes);
        }
        finally
        {
            if (movieToken is not null)
                sessions.CloseSession(movieToken);
            if (episodeToken is not null)
                sessions.CloseSession(episodeToken);

            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = originalPolicy.Enabled,
                DownloadCurrentFile = originalPolicy.DownloadCurrentFile,
                CurrentFileThresholdSeconds = originalPolicy.CurrentFileThresholdSeconds,
                DownloadNextEpisode = originalPolicy.DownloadNextEpisode,
                NextEpisodeThresholdPercent = originalPolicy.NextEpisodeThresholdPercent,
                MaxConcurrentDownloads = originalPolicy.MaxConcurrentDownloads,
            }, CancellationToken.None);
        }
    }

    [Fact]
    public async Task ProgressEvent_PreDownloadsCurrentFileIntoSessionDiskCache()
    {
        var config = fixture.GetRequiredService<PreDownloadConfigService>();
        var coordinator = fixture.GetRequiredService<PreDownloadCoordinator>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        var originalPolicy = config.Current;
        string? token = null;

        try
        {
            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = true,
                DownloadCurrentFile = true,
                CurrentFileThresholdSeconds = 0,
                DownloadNextEpisode = false,
                NextEpisodeThresholdPercent = originalPolicy.NextEpisodeThresholdPercent,
                MaxConcurrentDownloads = 1,
            }, CancellationToken.None);

            using var client = fixture.CreateClient();
            using var resolveResponse = await client.PostAsJsonAsync("/api/v1/resolve", new ResolveRequest
            {
                ReleaseId = StreamarrServerFixture.DirectReleaseId,
                WorkId = "tmdb-movie-1",
                Client = "pre-download-integration",
                RequestedById = "current-file-pre-download-user",
                RequestedByName = "Current File Pre-Download Test",
            });
            Assert.Equal(HttpStatusCode.OK, resolveResponse.StatusCode);

            var resolved = await resolveResponse.Content.ReadFromJsonAsync<ResolveResponse>();
            Assert.NotNull(resolved);
            Assert.NotNull(resolved.StreamUrl);
            token = resolved.StreamUrl.Split('/').Last();

            var watchPosition = 10 * TimeSpan.TicksPerSecond;
            var watchDuration = 40 * TimeSpan.TicksPerSecond;
            using var eventResponse = await client.PostAsJsonAsync("/api/v1/events", new EventRequest
            {
                ReleaseId = StreamarrServerFixture.DirectReleaseId,
                WorkId = "tmdb-movie-1",
                Event = "progress",
                PositionTicks = watchPosition,
                DurationTicks = watchDuration,
                SessionToken = token,
                Source = "pre-download-integration",
                PlaybackSessionId = "current-file-pre-download-playback",
                ExternalUserId = "current-file-pre-download-user",
                ExternalUserName = "Current File Pre-Download Test",
                DeviceName = "Integration Test",
            });
            Assert.Equal(HttpStatusCode.Accepted, eventResponse.StatusCode);

            var job = await WaitForCompletedJobAsync(coordinator, token);
            Assert.Equal("completed", job.State);
            Assert.Equal("currentFile", job.Kind);
            Assert.Equal("low", job.Priority);
            Assert.Equal("Playback passed 0 seconds", job.Reason);
            Assert.Equal(token, job.SourceToken);
            Assert.Equal(token, job.TargetToken);
            Assert.Equal(StreamarrServerFixture.DirectReleaseId, job.SourceReleaseId);
            Assert.Equal(StreamarrServerFixture.DirectReleaseId, job.TargetReleaseId);
            Assert.Equal("tmdb-movie-1", job.SourceWorkId);
            Assert.Equal("tmdb-movie-1", job.TargetWorkId);
            Assert.Equal(watchPosition, job.WatchPositionTicks);
            Assert.Equal(watchDuration, job.WatchDurationTicks);
            Assert.Equal(25d, job.WatchProgressPercent);
            Assert.Equal(0d, job.TriggerThreshold);
            Assert.Equal("seconds", job.TriggerUnit);
            Assert.Equal(fixture.Video.Length, job.BytesDownloaded);
            Assert.Equal(fixture.Video.Length, job.TotalBytes);
            Assert.Equal(100d, job.ProgressPercent);
            Assert.NotNull(job.StartedAt);
            Assert.NotNull(job.CompletedAt);
            Assert.Null(job.ErrorCode);
            Assert.Null(job.ErrorMessage);

            Assert.True(sessions.TryGetSession(token, out var session));
            Assert.Equal(EphemeralRetentionPriority.Normal, session.RetentionPriority);
            Assert.Equal(job.Id, session.PreDownloadJobId);
            Assert.Equal("currentFile", session.PreDownloadKind);
            Assert.Equal(job.Reason, session.PreDownloadReason);
            Assert.Null(session.PreDownloadSourceToken);
            Assert.False(session.IsPreDownloading);

            var cache = Assert.IsType<PreDownloadCacheFile>(session.PreDownloadCache);
            Assert.True(cache.IsComplete);
            Assert.False(cache.IsCancelled);
            Assert.Equal(fixture.Video.Length, cache.DownloadedBytes);
            Assert.Equal(fixture.Video.Length, cache.TotalBytes);

            await using (var diskStream = cache.TryOpenReadablePrefix())
            {
                Assert.NotNull(diskStream);
                using var diskCopy = new MemoryStream();
                await diskStream.CopyToAsync(diskCopy);
                Assert.Equal(fixture.Video, diskCopy.ToArray());
            }

            await using var playbackStream = sessions.OpenStream(session);
            using var playbackCopy = new MemoryStream();
            await playbackStream.CopyToAsync(playbackCopy);
            Assert.Equal(fixture.Video, playbackCopy.ToArray());
        }
        finally
        {
            if (token is not null)
                sessions.CloseSession(token);

            await config.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = originalPolicy.Enabled,
                DownloadCurrentFile = originalPolicy.DownloadCurrentFile,
                CurrentFileThresholdSeconds = originalPolicy.CurrentFileThresholdSeconds,
                DownloadNextEpisode = originalPolicy.DownloadNextEpisode,
                NextEpisodeThresholdPercent = originalPolicy.NextEpisodeThresholdPercent,
                MaxConcurrentDownloads = originalPolicy.MaxConcurrentDownloads,
            }, CancellationToken.None);
        }
    }

    private static async Task<PreDownloadJobResponse> WaitForCompletedJobAsync(
        PreDownloadCoordinator coordinator,
        string sessionToken)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (!timeout.IsCancellationRequested)
        {
            var job = coordinator.List(sessionToken).SingleOrDefault();
            if (job is { State: "completed" })
                return job;
            if (job is { State: "failed" or "skipped" or "cancelled" })
            {
                throw new InvalidOperationException(
                    $"Pre-download ended as '{job.State}' ({job.ErrorCode}: {job.ErrorMessage}).");
            }

            try
            {
                await Task.Delay(50, timeout.Token);
            }
            catch (OperationCanceledException) when (timeout.IsCancellationRequested)
            {
                break;
            }
        }

        throw new TimeoutException("The current-file pre-download did not complete within 30 seconds.");
    }

    private static async Task<string> ResolveTokenAsync(
        HttpClient client,
        string workId,
        string requestedById)
    {
        using var response = await client.PostAsJsonAsync("/api/v1/resolve", new ResolveRequest
        {
            ReleaseId = StreamarrServerFixture.DirectReleaseId,
            WorkId = workId,
            Client = "pre-download-threshold-test",
            RequestedById = requestedById,
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var resolved = await response.Content.ReadFromJsonAsync<ResolveResponse>();
        Assert.NotNull(resolved?.StreamUrl);
        return resolved.StreamUrl.Split('/').Last();
    }

    private static WatchEventWrite Progress(
        string token,
        string workId,
        long watchPositionTicks,
        long watchDurationTicks)
        => new()
        {
            ReleaseId = StreamarrServerFixture.DirectReleaseId,
            WorkId = workId,
            Event = "progress",
            PositionTicks = watchPositionTicks,
            DurationTicks = watchDurationTicks,
            SessionToken = token,
            Source = "pre-download-threshold-test",
            ExternalUserId = workId,
        };
}
