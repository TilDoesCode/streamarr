using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>
/// The picture a version shows on the viewer's device, in ranker points: half the resolution weight for every resolution step
/// above the profile's preferred one that the device really gets, plus a bonus for HDR the screen shows. Only for versions that
/// play without a transcode, so a 4K file the device plays as it is outranks a 1080p one, while a transcode keeps the profile's order.
/// </summary>
public static class ViewerPicturePreference
{
    /// <summary>Less than a resolution step: HDR decides between equal resolutions, never against a sharper picture.</summary>
    public const int HdrBonus = 15;

    private static readonly int[] Heights = [2160, 1080, 720, 480];

    /// <summary>Points to add to the ranker score; 0 without a prediction, for a transcode, and for resolutions the profile does not list.</summary>
    public static int Adjustment(QualityProfile profile, string? resolution, string? playClass, PlaybackPrediction? prediction)
    {
        ArgumentNullException.ThrowIfNull(profile);
        if (prediction is null || playClass is null || !PlayClass.WithoutTranscode(playClass) || resolution is null
            || WeightedSumRanker.ResolutionPoints(profile, resolution) == 0)
            return 0;
        var height = prediction.Height ?? VersionMapper.Height(resolution);
        var preferred = VersionMapper.Height(profile.PreferredResolutions.FirstOrDefault());
        var steps = Heights.Count(h => h > preferred && height >= h);
        var hdr = prediction.Hdr is { } range && range != "sdr" ? HdrBonus : 0;
        return steps * profile.ResolutionWeight / 2 + hdr;
    }
}
