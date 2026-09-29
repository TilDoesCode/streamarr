using Streamarr.Core.Media;
using Streamarr.Core.Parser;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>Projects a ranked release onto the viewer-facing <see cref="VersionDto"/>; never carries indexer or NZB data.</summary>
public static class VersionMapper
{
    public static VersionDto Map(
        Release release,
        ParsedReleaseInfo parsed,
        int rank,
        ReleaseHealth health,
        string? local,
        int? estimatedKbps,
        PlaybackPrediction? prediction)
    {
        var hdrFormats = parsed.HdrFormats.Select(HdrCode).OfType<string>().ToList();
        return new VersionDto
        {
            ReleaseId = release.ReleaseId,
            Name = release.Title,
            Rank = rank,
            Recommended = rank == 1,
            Resolution = parsed.Resolution,
            Source = parsed.Source,
            VideoCodec = VideoCode(parsed.VideoCodec),
            BitDepth = parsed.BitDepth ?? (hdrFormats.Count > 0 ? 10 : null),
            Hdr = hdrFormats.FirstOrDefault(),
            HdrFormats = hdrFormats,
            AudioCodec = AudioCode(parsed.AudioCodec),
            AudioChannels = parsed.AudioChannels,
            Atmos = parsed.Atmos,
            Languages = parsed.Languages,
            MultiLanguage = parsed.MultiLanguage || parsed.DualAudio,
            SubtitleHints = parsed.SubtitleHints,
            SubtitleLanguages = parsed.SubtitleLanguages,
            Edition = parsed.Edition,
            ReleaseGroup = parsed.ReleaseGroup,
            Proper = parsed.Proper,
            Repack = parsed.Repack,
            SeasonPack = IsSeasonPack(parsed),
            SizeBytes = release.SizeBytes,
            EstimatedBitrateKbps = estimatedKbps,
            AgeDays = Math.Max(0, release.AgeDays),
            Health = health.ToString().ToLowerInvariant(),
            Local = local,
            PredictedMethod = prediction?.Method,
            PredictionReasons = prediction?.Reasons,
        };
    }

    public static bool IsSeasonPack(ParsedReleaseInfo parsed) => parsed.SeasonPack && parsed.MediaType == ParsedMediaType.Tv;

    public static int? EstimatedKbps(long sizeBytes, int? runtimeMinutes, int files)
        => runtimeMinutes is > 0 && sizeBytes > 0
            ? (int)Math.Min(int.MaxValue, sizeBytes / Math.Max(1, files) * 8 / (runtimeMinutes.Value * 60L) / 1000)
            : null;

    public static string? VideoCode(string? parsed) => parsed switch
    {
        "x264" => "h264",
        "x265" => "hevc",
        "AV1" => "av1",
        "VC-1" => "vc1",
        "MPEG-2" => "mpeg2",
        "XviD" => "xvid",
        "DivX" => "divx",
        _ => null,
    };

    public static string? AudioCode(string? parsed) => parsed switch
    {
        "TrueHD" => "truehd",
        "DTS-HD MA" => "dts-hd-ma",
        "DTS-HD" => "dts-hd",
        "DTS-X" => "dts-x",
        "DTS-ES" => "dts-es",
        "DTS" => "dts",
        "DDP" => "eac3",
        "DD" => "ac3",
        "FLAC" => "flac",
        "Opus" => "opus",
        "AAC" => "aac",
        "MP3" => "mp3",
        "LPCM" => "pcm",
        _ => null,
    };

    public static string? HdrCode(string? parsed) => parsed switch
    {
        "DV" => "dolbyvision",
        "HDR10+" => "hdr10plus",
        "HDR10" => "hdr10",
        "HLG" => "hlg",
        _ => null,
    };
}
