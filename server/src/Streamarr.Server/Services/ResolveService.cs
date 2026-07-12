using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

/// <summary>
/// The /resolve pipeline (BRIEF §6.2): look up the release, fetch + parse its NZB,
/// identify the primary media file (unwrapping RAR), STAT-sample its segments,
/// open a session, and ffprobe the stream URL so front-ends get pre-probed media
/// info. Dead releases short-circuit with a suggested fallback and no session.
/// </summary>
public sealed class ResolveService(
    IReleaseStore releaseStore,
    NzbFetcher nzbFetcher,
    HealthChecker healthChecker,
    MediaFileMaterializer materializer,
    SessionManager sessionManager,
    FfprobeClient ffprobe,
    IOptions<StreamarrOptions> options,
    ILogger<ResolveService> logger)
{
    /// <param name="streamUrlForToken">Builds the public stream URL returned to the client.</param>
    /// <param name="localStreamUrlForToken">
    /// Builds a loopback stream URL for the in-process ffprobe run (the public
    /// host may not be reachable from the server itself, e.g. behind a proxy).
    /// </param>
    public async Task<ResolveResponse> ResolveAsync(
        string releaseId,
        string? client,
        Func<string, string> streamUrlForToken,
        Func<string, string> localStreamUrlForToken,
        CancellationToken ct)
    {
        var registered = releaseStore.Get(releaseId)
            ?? throw new ReleaseNotFoundException(releaseId);
        var nzbUrl = registered.Release.NzbUrl
            ?? throw new NoPlayableFileException("The release has no NZB location on record.");

        var nzb = await nzbFetcher.FetchAsync(nzbUrl, ct);
        var candidate = MediaFileSelector.SelectPrimary(nzb)
            ?? throw new NoPlayableFileException("The NZB contains no playable media file.");

        var health = await healthChecker.CheckAsync(candidate.HealthSegmentIds, ct);
        logger.LogInformation(
            "Health check for release {ReleaseId}: {Status} ({Missing}/{Sampled} sampled segments missing)",
            releaseId, health.StatusLabel, health.MissingCount, health.SampledCount);

        var ttlSeconds = options.Value.SessionTtlSeconds;

        if (health.Health == ReleaseHealth.Dead)
        {
            return new ResolveResponse
            {
                ReleaseId = releaseId,
                Status = health.StatusLabel,
                SessionTtlSeconds = ttlSeconds,
                SuggestedFallbackReleaseId =
                    releaseStore.FindFallback(registered.WorkId, releaseId)?.Release.ReleaseId,
            };
        }

        var media = await materializer.MaterializeAsync(candidate, ct);
        var session = sessionManager.CreateSession(releaseId, registered.WorkId, media, client);

        var probe = await ffprobe.ProbeAsync(localStreamUrlForToken(session.Token), options.Value.ApiKey, ct);
        if (probe == null)
        {
            logger.LogWarning(
                "ffprobe could not read the stream for release {ReleaseId}; returning without media info",
                releaseId);
        }

        return new ResolveResponse
        {
            ReleaseId = releaseId,
            Status = health.StatusLabel,
            StreamUrl = streamUrlForToken(session.Token),
            Container = media.Container,
            SizeBytes = media.SizeBytes,
            RunTimeTicks = probe?.RunTimeTicks,
            MediaStreams = probe?.MediaStreams ?? [],
            SessionTtlSeconds = ttlSeconds,
            SuggestedFallbackReleaseId = null,
        };
    }
}
