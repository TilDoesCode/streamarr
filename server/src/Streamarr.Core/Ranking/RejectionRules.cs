using System.Globalization;
using System.Text.RegularExpressions;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;

namespace Streamarr.Core.Ranking;

/// <summary>
/// A single pre-ranking rejection check (BRIEF.md §7.2). Returns a
/// <see cref="RejectionReason"/> when the release should be rejected, else null. Rules
/// are independent and additive so several reasons can attach to one release.
/// </summary>
public interface IRejectionRule
{
    RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile);
}

/// <summary>Sonarr/Radarr minimum custom-format score threshold.</summary>
public sealed class CustomFormatScoreRejectionRule : IRejectionRule
{
    public RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile)
    {
        if (profile.CustomFormats.Count == 0)
            return null;

        var score = CustomFormatMatcher.TotalScore(signals, profile);
        return score < profile.MinimumCustomFormatScore
            ? new RejectionReason(
                RejectionCode.CustomFormatScore,
                $"Custom-format score {score.ToString(CultureInfo.InvariantCulture)} is below " +
                $"the profile minimum {profile.MinimumCustomFormatScore.ToString(CultureInfo.InvariantCulture)}.")
            : null;
    }
}

/// <summary>Sample clip: a "sample" name marker, or a size far too small for the runtime.</summary>
public sealed class SampleRejectionRule : IRejectionRule
{
    // Word-boundary "sample" so it does not fire on "resample" or titles.
    private static readonly Regex SampleMarker = new(
        @"(?<![a-z0-9])sample(?![a-z0-9])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // A feature-length runtime cannot fit in this many bytes at any watchable quality.
    private const long AbsoluteFloorBytes = 100_000_000; // 100 MB
    private const int MinFeatureMinutes = 15;

    public RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile)
    {
        if (SampleMarker.IsMatch(signals.ReleaseName))
        {
            return new RejectionReason(RejectionCode.Sample, "Release name is marked as a sample.");
        }

        if (signals.RuntimeMinutes is { } runtime
            && runtime >= MinFeatureMinutes
            && signals.SizeBytes > 0
            && signals.SizeBytes < AbsoluteFloorBytes)
        {
            return new RejectionReason(
                RejectionCode.Sample,
                $"Size {Format.Bytes(signals.SizeBytes)} is implausibly small for a {runtime}-minute runtime.");
        }

        return null;
    }
}

/// <summary>
/// Fake / size sanity: bytes-per-minute against the TMDB runtime, judged against the
/// sane band for the claimed resolution (BRIEF.md §7.2). Skipped when runtime unknown.
/// </summary>
public sealed class SizeSanityRejectionRule : IRejectionRule
{
    public RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile)
    {
        if (signals.RuntimeMinutes is not { } runtime || runtime <= 0 || signals.SizeBytes <= 0)
        {
            return null;
        }

        var band = profile.BandFor(signals.Resolution);
        var bytesPerMinute = signals.SizeBytes / runtime;

        if (bytesPerMinute < band.MinBytesPerMinute)
        {
            return new RejectionReason(
                RejectionCode.SizeTooSmall,
                $"{Format.Rate(bytesPerMinute)} is below the {Format.Rate(band.MinBytesPerMinute)} floor "
                + $"expected for {signals.Resolution ?? "this quality"}.");
        }

        if (bytesPerMinute > band.MaxBytesPerMinute)
        {
            return new RejectionReason(
                RejectionCode.SizeTooLarge,
                $"{Format.Rate(bytesPerMinute)} exceeds the {Format.Rate(band.MaxBytesPerMinute)} ceiling "
                + $"expected for {signals.Resolution ?? "this quality"}.");
        }

        return null;
    }
}

/// <summary>Password-protected archive with no known password (post-resolve).</summary>
public sealed class PasswordProtectedRejectionRule : IRejectionRule
{
    public RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile)
        => signals.Nzb?.PasswordProtected == true
            ? new RejectionReason(RejectionCode.PasswordProtected, "Archive is password-protected.")
            : null;
}

/// <summary>Non-media payload: executables present, or no video/archive file at all (post-resolve).</summary>
public sealed class NonMediaPayloadRejectionRule : IRejectionRule
{
    private static readonly HashSet<string> MediaExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mkv", ".mp4", ".avi", ".ts", ".m2ts", ".mov", ".wmv", ".mpg", ".mpeg",
        ".m4v", ".webm", ".flv", ".vob", ".iso",
    };

    // Archives can legitimately wrap the media (RAR/7z multi-volume), so they count.
    private static readonly HashSet<string> ArchiveExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".rar", ".7z", ".zip", ".001", ".r00", ".r01",
    };

    private static readonly HashSet<string> ExecutableExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".msi", ".bat", ".cmd", ".scr", ".com", ".vbs", ".js", ".jar",
        ".apk", ".lnk", ".ps1",
    };

    public RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile)
    {
        if (signals.Nzb is not { } nzb || nzb.FileNames.Count == 0)
        {
            return null;
        }

        var hasExecutable = false;
        var hasMediaOrArchive = false;

        foreach (var name in nzb.FileNames)
        {
            var ext = Path.GetExtension(name);
            if (ExecutableExtensions.Contains(ext))
            {
                hasExecutable = true;
            }
            else if (MediaExtensions.Contains(ext) || ArchiveExtensions.Contains(ext))
            {
                hasMediaOrArchive = true;
            }
        }

        if (hasExecutable)
        {
            return new RejectionReason(RejectionCode.NonMediaPayload, "NZB contains executable files.");
        }

        if (!hasMediaOrArchive)
        {
            return new RejectionReason(RejectionCode.NonMediaPayload, "NZB contains no media or archive files.");
        }

        return null;
    }
}

/// <summary>Incomplete upload: fewer files than expected, or missing segments (post-resolve).</summary>
public sealed class IncompleteUploadRejectionRule : IRejectionRule
{
    // Even a healthy upload loses the odd article; only reject beyond this fraction.
    private const double MissingSegmentTolerance = 0.02;

    public RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile)
    {
        if (signals.Nzb is not { } nzb)
        {
            return null;
        }

        if (nzb.ExpectedFileCount is { } expected && expected > 0 && nzb.PresentFileCount < expected)
        {
            return new RejectionReason(
                RejectionCode.IncompleteUpload,
                $"Only {nzb.PresentFileCount} of {expected} expected files are present.");
        }

        if (nzb.TotalSegments > 0 && nzb.MissingSegments > 0)
        {
            var missingFraction = (double)nzb.MissingSegments / nzb.TotalSegments;
            if (missingFraction > MissingSegmentTolerance)
            {
                return new RejectionReason(
                    RejectionCode.IncompleteUpload,
                    $"{nzb.MissingSegments} of {nzb.TotalSegments} segments are missing "
                    + $"({missingFraction:P0}).");
            }
        }

        return null;
    }
}

/// <summary>Dead on Usenet: the health check found the media's articles missing.</summary>
public sealed class DeadOnUsenetRejectionRule : IRejectionRule
{
    public RejectionReason? Evaluate(ReleaseSignals signals, QualityProfile profile)
        => signals.Health == ReleaseHealth.Dead
            ? new RejectionReason(RejectionCode.DeadOnUsenet, "Health check reports the release is dead on Usenet.")
            : null;
}

/// <summary>Small human-readable formatting helpers for rejection messages.</summary>
internal static class Format
{
    public static string Bytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double value = bytes;
        var unit = 0;
        while (value >= 1000 && unit < units.Length - 1)
        {
            value /= 1000;
            unit++;
        }

        return $"{value:0.#} {units[unit]}";
    }

    public static string Rate(long bytesPerMinute) => $"{Bytes(bytesPerMinute)}/min";
}
