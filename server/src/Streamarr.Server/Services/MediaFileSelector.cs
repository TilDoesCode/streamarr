using Streamarr.Usenet.Nzb;
using Streamarr.Usenet.Rar;

namespace Streamarr.Server.Services;

/// <summary>
/// The primary media payload of an NZB before any Usenet contact: either one
/// direct video file, or the ordered volumes of the RAR set that wraps it.
/// <see cref="HealthSegmentIds"/> are exactly the articles carrying media bytes —
/// par2/nfo/sample companions are never included (BRIEF §6.1 module 5).
/// </summary>
public sealed record MediaFileCandidate
{
    public required string DisplayName { get; init; }

    public required bool IsRarWrapped { get; init; }

    /// <summary>Direct: a single file. RAR: volumes ordered by part number.</summary>
    public required IReadOnlyList<NzbFile> Files { get; init; }

    public string[] HealthSegmentIds => Files.SelectMany(f => f.GetSegmentIds()).ToArray();
}

/// <summary>
/// Identifies the primary media file of an NZB (BRIEF §6.2 /resolve) from file
/// names alone, so the (cheap) STAT health check can run before any article body
/// is downloaded. RAR sets are unwrapped later by <see cref="MediaFileMaterializer"/>.
/// </summary>
public static class MediaFileSelector
{
    private static readonly HashSet<string> MediaExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".ts", ".m2ts",
        ".webm", ".mpg", ".mpeg", ".vob", ".flv", ".ogm",
    };

    public static bool IsMediaFileName(string fileName)
        => MediaExtensions.Contains(Path.GetExtension(fileName));

    public static MediaFileCandidate? SelectPrimary(NzbDocument document)
    {
        var named = document.Files
            .Where(f => f.Segments.Count > 0)
            .Select(f => (File: f, Name: f.GetSubjectFileName()))
            .Where(x => !string.IsNullOrEmpty(x.Name))
            .ToList();

        // 1) a direct (un-archived) video file — pick the largest
        var direct = named
            .Where(x => IsMediaFileName(x.Name))
            .OrderByDescending(x => x.File.GetTotalYencodedSize())
            .FirstOrDefault();
        if (direct.File is not null)
        {
            return new MediaFileCandidate
            {
                DisplayName = direct.Name,
                IsRarWrapped = false,
                Files = [direct.File],
            };
        }

        // 2) the largest RAR set (release RARs are stored; unwrapped at materialization)
        var rarSets = named
            .Select(x => (x.File, x.Name, Part: RarVolumeReader.GetPartNumberFromFilename(x.Name)))
            .Where(x => x.Part != null)
            .GroupBy(x => RarVolumeReader.GetArchiveName(x.Name), StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (rarSets.Count == 0)
            return null;

        var volumes = rarSets
            .MaxBy(g => g.Sum(x => x.File.GetTotalYencodedSize()))!
            .OrderBy(x => x.Part!.Value)
            .ToList();

        return new MediaFileCandidate
        {
            DisplayName = volumes[0].Name,
            IsRarWrapped = true,
            Files = volumes.Select(x => x.File).ToList(),
        };
    }
}
