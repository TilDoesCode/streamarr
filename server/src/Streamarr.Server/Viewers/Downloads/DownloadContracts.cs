using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>Read-only: the versions of a movie or episode with their offline playability on the sent device (POST because the full device profile is needed).</summary>
public sealed record DownloadCandidatesRequest
{
    /// <summary>Canonical movie or episode work id, e.g. <c>tmdb-movie-603</c> or <c>tmdb-tv-1396-s01e01</c>.</summary>
    public string? WorkId { get; init; }

    /// <summary>The full device profile, as for <c>POST /viewer/playback</c>.</summary>
    public DeviceProfileDto? Device { get; init; }

    /// <summary>Spoken languages best first (ISO 639-1, at most 4); omitted = <c>Accept-Language</c>, then the profile's own.</summary>
    public IReadOnlyList<string>? AudioLanguages { get; init; }

    /// <summary><c>auto</c> (default), <c>native</c> or <c>vlc</c>: which engine wins when both play the original file.</summary>
    public string? Engine { get; init; }

    /// <summary>Search the indexers again (same rules as the versions list's <c>refresh</c>).</summary>
    public bool Refresh { get; init; }
}

/// <summary>Read-only: a season's packs and per aired episode its candidates.</summary>
public sealed record DownloadSeasonCandidatesRequest
{
    /// <summary>Season work id, e.g. <c>tmdb-tv-1396-s02</c>.</summary>
    public string? WorkId { get; init; }

    public DeviceProfileDto? Device { get; init; }
    public IReadOnlyList<string>? AudioLanguages { get; init; }
    public string? Engine { get; init; }
    public bool Refresh { get; init; }

    /// <summary>False leaves out the per-episode candidate lists (packs only); default true.</summary>
    public bool IncludeEpisodes { get; init; } = true;
}

/// <summary>"Pick one, the rest by similarity": for each target episode the most similar downloadable release to the anchor.</summary>
public sealed record DownloadPlanRequest
{
    /// <summary>The episode the viewer picked a version for.</summary>
    public string? AnchorWorkId { get; init; }

    /// <summary>The version picked for <see cref="AnchorWorkId"/>.</summary>
    public string? AnchorReleaseId { get; init; }

    /// <summary>Episode work ids to plan (1–100, the same series); the anchor may be among them.</summary>
    public IReadOnlyList<string>? WorkIds { get; init; }

    public DeviceProfileDto? Device { get; init; }

    /// <summary>Orders each episode's candidates and picks the fallback when nothing in the anchor's language is downloadable; the anchor's language decides otherwise.</summary>
    public IReadOnlyList<string>? AudioLanguages { get; init; }

    public string? Engine { get; init; }
}

/// <summary>Starts preparing a download; poll <c>GET /viewer/downloads/{downloadId}</c> until <c>ready</c> or <c>failed</c>.</summary>
public sealed record DownloadPrepareRequest
{
    /// <summary>Movie or episode work id.</summary>
    public string? WorkId { get; init; }

    /// <summary>A version from the candidates (required: a download never picks a version on its own).</summary>
    public string? ReleaseId { get; init; }

    /// <summary>The full device profile; the probed file must play as it is on it (native direct, else VLC direct).</summary>
    public DeviceProfileDto? Device { get; init; }

    /// <summary><c>auto</c> (default), <c>native</c> or <c>vlc</c>: the engine to play the file with when both can.</summary>
    public string? Engine { get; init; }

    /// <summary>Shown to the admin; default = the device name of the viewer session.</summary>
    public string? DeviceName { get; init; }

    /// <summary>Stable id of this app installation (≤ 64 printable characters); <c>GET /viewer/downloads?deviceId=</c> finds the device's downloads after a new sign-in.</summary>
    public string? DeviceId { get; init; }

    /// <summary>Client's own id of this download (≤ 64 printable characters): a repeated prepare with the same id on the same device returns the existing download instead of a second one.</summary>
    public string? ClientRef { get; init; }
}

/// <summary>What the device reports when it has the whole file.</summary>
public sealed record DownloadCompleteRequest
{
    /// <summary>Bytes the device holds; must equal <c>sizeBytes</c> when sent.</summary>
    public long? BytesReceived { get; init; }
}

/// <summary>Whether the original file plays as it is on the device (native direct, else VLC direct; never remux or transcode).</summary>
public sealed record OfflinePlayabilityDto
{
    public required bool Playable { get; init; }

    /// <summary><c>native</c> or <c>vlc</c> when playable; null otherwise.</summary>
    public string? Engine { get; init; }

    /// <summary>Stable codes with <c>params</c>: why not (e.g. <c>container_unsupported</c>, <c>video_codec_unsupported</c>, <c>needs_remux</c>, <c>needs_transcode</c>), the engine's notes (<c>vlc_fallback</c>, <c>hdr_tone_mapped</c>, <c>subtitle_not_deliverable</c>) and every assumption of the prediction (<c>container_assumed</c>, …).</summary>
    public required IReadOnlyList<PredictionReasonDto> Reasons { get; init; }

    /// <summary>How the version would stream instead (<c>direct</c>, <c>remux</c>, <c>vlc</c>, <c>transcode</c>, <c>unknown</c>), for "only for streaming" footers.</summary>
    public string? StreamingMethod { get; init; }
}

/// <summary>One version as a download candidate.</summary>
public sealed record DownloadCandidateDto
{
    /// <summary>The version as the versions list shows it (streaming prediction for this profile included); <c>rank</c> is the download order.</summary>
    public required VersionDto Version { get; init; }

    public required OfflinePlayabilityDto Offline { get; init; }

    /// <summary>Bytes this work's file needs on the device (see <see cref="SizeSource"/>).</summary>
    public required long SizeBytes { get; init; }

    /// <summary>True only for <c>resolved</c>.</summary>
    public required bool SizeExact { get; init; }

    /// <summary><c>resolved</c> (exact: an earlier resolve opened this file), <c>indexer</c> (the release's size, an upper bound that includes recovery data) or <c>estimate</c> (pack size ÷ the episodes it covers).</summary>
    public required string SizeSource { get; init; }

    /// <summary>The release carries more than this episode (season or multi-episode pack).</summary>
    public required bool SeasonPack { get; init; }

    /// <summary>Episode numbers of the season this release covers (null for movies and single episodes).</summary>
    public IReadOnlyList<int>? PackEpisodes { get; init; }

    /// <summary>The best downloadable version (first with <c>offline.playable</c>); never set on an unplayable one.</summary>
    public required bool Recommended { get; init; }
}

public sealed record DownloadCandidatesResponse
{
    public required string WorkId { get; init; }

    /// <summary><c>movie</c> or <c>episode</c>.</summary>
    public required string MediaType { get; init; }

    /// <summary>Every version (rejected and known-dead ones left out), downloadable ones first in the download order.</summary>
    public required IReadOnlyList<DownloadCandidateDto> Candidates { get; init; }

    /// <summary>Versions that only stream (remux or transcode needed), for the collapsed footer.</summary>
    public required int StreamOnlyCount { get; init; }

    public required DateTimeOffset CheckedAt { get; init; }
    public bool FromCache { get; init; }
    public bool Incomplete { get; init; }
}

/// <summary>A release that carries several episodes of the season (a full or a partial pack).</summary>
public sealed record DownloadPackDto
{
    /// <summary>The pack as a version, ranked among the season's packs.</summary>
    public required VersionDto Version { get; init; }

    public required OfflinePlayabilityDto Offline { get; init; }

    /// <summary>Episode numbers the pack covers (every aired episode of a full pack, the range of a partial one).</summary>
    public required IReadOnlyList<int> Episodes { get; init; }

    /// <summary>True when it covers every aired regular episode of the season.</summary>
    public required bool Complete { get; init; }

    /// <summary>The whole pack as the indexer reports it.</summary>
    public required long PackSizeBytes { get; init; }

    /// <summary>Sum of the per-episode sizes (exact ones where an earlier resolve knows them, else the even share).</summary>
    public required long SizeBytes { get; init; }

    /// <summary>True when every covered episode's size is exact.</summary>
    public required bool SizeExact { get; init; }

    /// <summary>The even share per episode (pack size ÷ episodes), for display.</summary>
    public required long PerEpisodeSizeBytes { get; init; }

    /// <summary>Best downloadable pack (complete ones before partial ones).</summary>
    public required bool Recommended { get; init; }
}

public sealed record DownloadSeasonEpisodeDto
{
    public required string WorkId { get; init; }
    public required int EpisodeNumber { get; init; }
    public string? Title { get; init; }
    public string? AirDate { get; init; }
    public required bool Aired { get; init; }
    public int? RuntimeMinutes { get; init; }

    /// <summary>Like the movie/episode candidates (empty when <c>includeEpisodes=false</c>).</summary>
    public required IReadOnlyList<DownloadCandidateDto> Candidates { get; init; }

    public required int StreamOnlyCount { get; init; }
}

public sealed record DownloadSeasonCandidatesResponse
{
    public required string WorkId { get; init; }
    public required string SeriesWorkId { get; init; }
    public required int SeasonNumber { get; init; }

    /// <summary>Downloadable packs first, complete before partial, then the download order.</summary>
    public required IReadOnlyList<DownloadPackDto> Packs { get; init; }

    /// <summary>Every episode of the season in episode order (not aired ones without candidates).</summary>
    public required IReadOnlyList<DownloadSeasonEpisodeDto> Episodes { get; init; }

    public required DateTimeOffset CheckedAt { get; init; }
    public bool FromCache { get; init; }
    public bool Incomplete { get; init; }
}

public sealed record DownloadPlanItemDto
{
    public required string WorkId { get; init; }

    /// <summary>
    /// <c>same_release</c> (another copy of the pack, the group's next episode), <c>same_variant</c> (same group, resolution and HDR),
    /// <c>same_group</c> (a similar release in another resolution or HDR), <c>best_available</c> (nothing similar: the best downloadable one),
    /// <c>none</c> (nothing downloadable).
    /// </summary>
    public required string Match { get; init; }

    /// <summary>Similarity to the anchor (0–100, <c>ReleaseSimilarityScorer</c>; 100 for the same release); null for <c>none</c>.</summary>
    public double? Score { get; init; }

    /// <summary>The chosen candidate; null for <c>none</c>.</summary>
    public DownloadCandidateDto? Candidate { get; init; }

    /// <summary>
    /// Why <c>none</c> or why not more similar (e.g. <c>no_versions</c>, <c>not_offline_playable</c>, <c>language_mismatch</c>, <c>episode_not_found</c>);
    /// <c>language_differs</c> (params <c>languages</c>, <c>anchorLanguages</c>) when the choice is not in the picked version's language.
    /// </summary>
    public IReadOnlyList<PredictionReasonDto> Notes { get; init; } = [];
}

public sealed record DownloadPlanResponse
{
    public required string AnchorWorkId { get; init; }
    public required string AnchorReleaseId { get; init; }
    public string? AnchorName { get; init; }

    /// <summary>In the order of the request's <c>workIds</c>.</summary>
    public required IReadOnlyList<DownloadPlanItemDto> Items { get; init; }

    /// <summary>Sum of the chosen candidates' sizes.</summary>
    public required long TotalSizeBytes { get; init; }

    /// <summary>True when every chosen size is exact.</summary>
    public required bool TotalSizeExact { get; init; }
}

/// <summary>One device download: its preparation state and, once <c>ready</c>, the file capability and what the file is.</summary>
public sealed record DownloadResponse
{
    public required string DownloadId { get; init; }

    /// <summary><c>queued</c>, <c>resolving</c>, <c>probing</c>, <c>ready</c>, <c>failed</c> or <c>completed</c> (the device reported the whole file).</summary>
    public required string State { get; init; }

    public required string WorkId { get; init; }

    /// <summary>Display title (movie, or "Series · S01E02 · Episode") in the server language at creation.</summary>
    public string? Title { get; init; }

    /// <summary>The version that was asked for.</summary>
    public required string RequestedReleaseId { get; init; }

    /// <summary>The release the file comes from (another copy of the requested release after a fallback).</summary>
    public string? ReleaseId { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public DateTimeOffset? ReadyAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }

    /// <summary>Suggested delay before the next poll; 0 once ready, failed or completed.</summary>
    public int PollAfterMs { get; init; }

    public string? DeviceName { get; init; }

    /// <summary>True when the download was prepared by the calling viewer session or the request's <c>deviceId</c>.</summary>
    public required bool ThisDevice { get; init; }

    /// <summary>Every copy tried, in order, with its health (<c>resolving</c>, <c>ready</c>, <c>degraded</c>, <c>dead</c>).</summary>
    public required IReadOnlyList<PlaybackAttemptDto> Attempts { get; init; }

    /// <summary>The requested copy when it was dead and another copy of the same release stands in.</summary>
    public PlaybackReleaseDto? FallbackFrom { get; init; }

    public VersionDto? Version { get; init; }

    /// <summary>Capability path relative to the server origin (<c>/api/v1/offline/{capability}</c>); needs no auth header; treat it like a token. Only for the device that prepared it.</summary>
    public string? FileUrl { get; init; }

    /// <summary>Exact bytes of the file (ready and completed).</summary>
    public long? SizeBytes { get; init; }

    /// <summary>File name inside the release (also the <c>Content-Disposition</c> name).</summary>
    public string? FileName { get; init; }

    /// <summary>Container family: <c>mkv</c>, <c>mp4</c>, …</summary>
    public string? Container { get; init; }

    public string? ContentType { get; init; }

    /// <summary>Strong entity tag of the file; stays the same across stream sessions and restarts (send it in <c>If-Range</c>).</summary>
    public string? ETag { get; init; }

    /// <summary><c>native</c> or <c>vlc</c>: the engine that plays this file as it is.</summary>
    public string? Engine { get; init; }

    /// <summary>The probed tracks as they are in the file (<c>deliveredAs</c> <c>original</c>/<c>embedded</c>); <c>vlcOnly</c> marks image subtitles only VLC shows.</summary>
    public PlaybackMediaInfoDto? MediaInfo { get; init; }

    /// <summary>Why this engine (and the hard check's reasons when it failed with <c>not_direct_playable</c>).</summary>
    public PlaybackDecisionDto? Decision { get; init; }

    /// <summary>When the file capability stops working unless renewed (<c>POST {id}/renew</c>).</summary>
    public DateTimeOffset? ExpiresAt { get; init; }

    /// <summary>
    /// True after a security sign-out (admin "sign out all", a revoked device, a password reset): the old file URL answers
    /// <c>410 download_revoked</c>; <c>POST {id}/renew</c> from the signed-in device issues a new one (same file and ETag).
    /// </summary>
    public bool FileUrlRevoked { get; init; }

    /// <summary>Bytes the server has sent for this download (all requests together, resumes included).</summary>
    public long BytesServed { get; init; }

    public DateTimeOffset? LastTransferAt { get; init; }

    /// <summary>True while a file request of this download is open.</summary>
    public bool Transferring { get; init; }

    public PlaybackErrorDto? Error { get; init; }

    /// <summary><c>retry</c>, <c>otherVersion</c> (failed only).</summary>
    public IReadOnlyList<string>? SuggestedActions { get; init; }
}

public sealed record DownloadListResponse
{
    /// <summary>Newest first.</summary>
    public required IReadOnlyList<DownloadResponse> Items { get; init; }

    /// <summary>Transfers this viewer may run at once and how many are running.</summary>
    public required DownloadLimitsDto Limits { get; init; }
}

public sealed record DownloadLimitsDto
{
    public required bool Allowed { get; init; }
    public required int MaxConcurrentDownloads { get; init; }
    public required int ActiveDownloads { get; init; }
}

/// <summary>Admin view of one stored download.</summary>
public sealed record DownloadAdminItemDto
{
    public required string DownloadId { get; init; }
    public required string ViewerId { get; init; }
    public required string Username { get; init; }
    public string? DeviceName { get; init; }
    public required string State { get; init; }
    public required string WorkId { get; init; }
    public string? Title { get; init; }
    public string? ReleaseName { get; init; }
    public string? FileName { get; init; }
    public long? SizeBytes { get; init; }
    public long BytesServed { get; init; }
    public bool Transferring { get; init; }

    /// <summary>Current transfer speed over the last few seconds (0 when idle).</summary>
    public long BytesPerSecond { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
    public DateTimeOffset? LastTransferAt { get; init; }
    public DateTimeOffset? ExpiresAt { get; init; }

    /// <summary>True when a security sign-out revoked the file URL and the device has not renewed it yet.</summary>
    public bool FileUrlRevoked { get; init; }

    public string? ErrorCode { get; init; }
}

public sealed record DownloadAdminListResponse
{
    public required IReadOnlyList<DownloadAdminItemDto> Items { get; init; }

    /// <summary>Downloads with an open file request right now (server-wide).</summary>
    public required int ActiveTransfers { get; init; }

    /// <summary>True while live streams hold download transfers back (see the priority settings).</summary>
    public required bool Throttled { get; init; }

    /// <summary>Live playback streams the priority rule sees right now.</summary>
    public required int LiveStreams { get; init; }

    /// <summary>All download transfers together, bytes per second over the last few seconds.</summary>
    public required long BytesPerSecond { get; init; }

    /// <summary>State of the download maintenance components; one is <c>degraded</c> after 3 consecutive failures until it succeeds again.</summary>
    public required IReadOnlyList<DownloadMaintenanceDto> Maintenance { get; init; }
}

/// <summary>One download maintenance component: whether its recent attempts failed.</summary>
public sealed record DownloadMaintenanceDto
{
    /// <summary><c>sweep</c> (open transfers checked against expiry and revocation), <c>accounting</c> (bytes served), <c>resume</c> (preparations resumed at start) or <c>failureRecord</c> (a failed preparation recorded).</summary>
    public required string Component { get; init; }

    /// <summary>Failures since the last success (0 while healthy).</summary>
    public required int ConsecutiveFailures { get; init; }

    /// <summary>True from the 3rd consecutive failure until the next success.</summary>
    public required bool Degraded { get; init; }

    public DateTimeOffset? LastSuccessAt { get; init; }
    public DateTimeOffset? LastFailureAt { get; init; }

    /// <summary>First failure of the current run of failures; null while healthy.</summary>
    public DateTimeOffset? FailingSince { get; init; }

    /// <summary>Type and message of the last failure, capability-redacted, at most 256 characters.</summary>
    public string? LastError { get; init; }
}

/// <summary>Server-wide download limits and priority (part of the viewer settings).</summary>
public sealed record ViewerDownloadSettingsDto
{
    /// <summary>Transfers one viewer may run at once unless the viewer has their own limit (1–10, default 2).</summary>
    public int? MaxActivePerViewer { get; init; }

    /// <summary>Transfers the whole server runs at once (1–50, default 4).</summary>
    public int? MaxActiveGlobal { get; init; }

    /// <summary>Downloads being prepared at once (resolve + probe, 1–4, default 1), so live playback starts keep their resolve slots.</summary>
    public int? MaxConcurrentPrepares { get; init; }

    /// <summary>Share of the Usenet connection budget download transfers may use (5–100 %, default 25).</summary>
    public int? ConnectionSharePercent { get; init; }

    /// <summary>All downloads together while a live stream plays (kbit/s, 0 = pause downloads while someone watches; default 16000).</summary>
    public int? BandwidthWhileStreamingKbps { get; init; }

    /// <summary>All downloads together while nobody watches (kbit/s, 0 = unlimited; default 0).</summary>
    public int? BandwidthKbps { get; init; }

    /// <summary>How long a file capability stays valid without renewal (1–365 days, default 30).</summary>
    public int? CapabilityDays { get; init; }
}
