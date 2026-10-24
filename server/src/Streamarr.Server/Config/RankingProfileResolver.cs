using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Config;

/// <summary>The ranking profile a request uses, where it came from (<c>viewer</c> or <c>server</c>) and the profile revision it was resolved at.</summary>
public sealed record ResolvedProfile(QualityProfile Profile, string Source, long Revision)
{
    public const string ViewerSource = "viewer";
    public const string ServerSource = "server";

    /// <summary>Identifies this exact ranking (profile id + revision); a ranking cached under another key must be re-evaluated.</summary>
    public string Key => $"{Profile.Id}@{Revision}";
}

/// <summary>
/// The one place that decides which ranking profile ranks a viewer's versions, recommendations, playback pick, pre-download
/// and My List availability: the viewer's own choice (when viewers may choose and it exists and applies to the media type),
/// else the server default for the media type, else the built-in Standard.
/// </summary>
public sealed class RankingProfileResolver(ProfileConfigService profiles, IDbContextFactory<StreamarrDbContext> dbFactory)
{
    /// <summary>The server default for <paramref name="mediaType"/> (no viewer).</summary>
    public ResolvedProfile ServerDefault(MediaType mediaType)
    {
        var revision = profiles.Revision;
        return new ResolvedProfile(profiles.ServerDefault(mediaType), ResolvedProfile.ServerSource, revision);
    }

    public ResolvedProfile ForViewer(ViewerEntity? viewer, MediaType mediaType) => ForChoice(viewer?.RankingProfileId, mediaType);

    /// <summary>A viewer's stored choice (null = follow the server default) resolved for <paramref name="mediaType"/>.</summary>
    public ResolvedProfile ForChoice(string? choice, MediaType mediaType)
    {
        var revision = profiles.Revision;
        return profiles.Defaults.ViewersMayChoose && profiles.Usable(choice, mediaType) is { } own
            ? new ResolvedProfile(own, ResolvedProfile.ViewerSource, revision)
            : new ResolvedProfile(profiles.ServerDefault(mediaType), ResolvedProfile.ServerSource, revision);
    }

    /// <summary>The profile for whoever requested a stream: a viewer of the app gets their own, everything else (Jellyfin, admin) the server default.</summary>
    public async Task<ResolvedProfile> ForRequesterAsync(string? client, string? requesterId, MediaType mediaType, CancellationToken ct)
    {
        if (client != WatchStateService.EventSource || string.IsNullOrEmpty(requesterId))
            return ServerDefault(mediaType);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var choice = await db.Viewers.AsNoTracking().Where(v => v.Id == requesterId).Select(v => v.RankingProfileId).FirstOrDefaultAsync(ct);
        return ForChoice(choice, mediaType);
    }
}
