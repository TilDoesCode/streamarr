using System.Globalization;
using System.Text;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// Pure translation between Core Server DTOs and Jellyfin's <see cref="MediaSourceInfo"/>
/// / <see cref="MediaStream"/> (BRIEF §8.4). No domain logic — it never decides ranking,
/// health or fallbacks; it only reshapes data the server already produced. Kept static
/// and side-effect free so it is unit-testable without a Jellyfin host.
/// </summary>
public static class MediaSourceMapper
{
    /// <summary>
    /// The pre-open "version" for a release: <c>RequiresOpening = true</c>,
    /// <c>OpenToken = releaseId</c>, no Usenet contact yet (BRIEF §8.4).
    /// </summary>
    public static MediaSourceInfo ToUnopenedSource(ReleaseDto release) => new()
    {
        Id = release.ReleaseId,
        OpenToken = release.ReleaseId,
        Name = FormatVersionName(release),
        Protocol = MediaProtocol.Http,
        IsRemote = true,
        RequiresOpening = true,
        RequiresClosing = true,
        SupportsProbing = false,
        SupportsDirectPlay = true,
        SupportsDirectStream = true,
        SupportsTranscoding = true,
        RunTimeTicks = null,
        Size = release.SizeBytes,
    };

    /// <summary>
    /// The opened source after a successful <c>/resolve</c>: a concrete HTTP path with
    /// pre-probed streams, a low analyze duration, and the Bearer ffmpeg must send
    /// (BRIEF §8.4, §11 "pre-probe media info server-side").
    /// </summary>
    public static MediaSourceInfo ToOpenedSource(
        ResolveResponse resolve,
        string liveStreamId,
        string apiKey)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(apiKey))
            headers["Authorization"] = "Bearer " + apiKey;

        return new MediaSourceInfo
        {
            Id = liveStreamId,
            LiveStreamId = liveStreamId,
            Path = resolve.StreamUrl,
            Protocol = MediaProtocol.Http,
            IsRemote = true,
            RequiresOpening = false,
            RequiresClosing = true,
            SupportsProbing = false,
            SupportsDirectPlay = true,
            SupportsDirectStream = true,
            SupportsTranscoding = true,
            Container = resolve.Container,
            Size = resolve.SizeBytes,
            RunTimeTicks = resolve.RunTimeTicks,
            // Server already probed against the stream; keep ffmpeg's own analysis short.
            AnalyzeDurationMs = 1000,
            RequiredHttpHeaders = headers,
            MediaStreams = MapStreams(resolve.MediaStreams),
        };
    }

    public static List<MediaStream> MapStreams(IReadOnlyList<MediaStreamInfo> streams)
    {
        var result = new List<MediaStream>(streams.Count);
        var index = 0;
        foreach (var s in streams)
        {
            result.Add(new MediaStream
            {
                Index = index++,
                Type = ParseStreamType(s.Type),
                Codec = s.Codec,
                Width = s.Width,
                Height = s.Height,
                Channels = s.Channels,
                Language = s.Language,
                IsDefault = index == 1,
            });
        }

        return result;
    }

    internal static MediaStreamType ParseStreamType(string? type) => type?.ToLowerInvariant() switch
    {
        "audio" => MediaStreamType.Audio,
        "subtitle" => MediaStreamType.Subtitle,
        _ => MediaStreamType.Video,
    };

    /// <summary>Human-readable version label, e.g. "1080p WEB-DL x265 · DDP5.1 · GER".</summary>
    public static string FormatVersionName(ReleaseDto release)
    {
        var q = release.Quality;
        var primary = new[] { q.Resolution, q.Source, q.Codec, q.Hdr }
            .Where(s => !string.IsNullOrWhiteSpace(s));
        var segments = new List<string> { string.Join(' ', primary).Trim() };

        if (!string.IsNullOrWhiteSpace(q.Audio))
            segments.Add(q.Audio!);
        if (release.Languages.Count > 0)
            segments.Add(string.Join('/', release.Languages.Select(l => l.ToUpperInvariant())));
        if (release.SizeBytes > 0)
            segments.Add(FormatSize(release.SizeBytes));

        var name = string.Join(" · ", segments.Where(s => !string.IsNullOrWhiteSpace(s)));
        return string.IsNullOrWhiteSpace(name) ? release.Title : name;
    }

    private static string FormatSize(long bytes)
    {
        double gib = bytes / (1024d * 1024d * 1024d);
        if (gib >= 1)
            return gib.ToString("0.0", CultureInfo.InvariantCulture) + " GiB";
        double mib = bytes / (1024d * 1024d);
        return mib.ToString("0", CultureInfo.InvariantCulture) + " MiB";
    }
}
