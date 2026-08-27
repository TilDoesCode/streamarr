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

    /// <summary>
    /// The release's password, if the NZB's <c>&lt;head&gt;</c> carried one (some
    /// indexers/uploaders embed it as <c>&lt;meta type="password"&gt;</c> specifically so
    /// downloaders can auto-extract password-protected RAR sets). Only meaningful for
    /// RAR-wrapped candidates; a direct video file is never RAR-encrypted.
    /// </summary>
    public string? Password { get; init; }

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
        var password = FindPassword(document);
        var named = NamedFiles(document);

        // 1) a direct (un-archived) video file — pick the largest
        var direct = named
            .Where(x => IsMediaFileName(x.Name))
            .OrderByDescending(x => x.File.GetTotalYencodedSize())
            .FirstOrDefault();
        if (direct.File is not null)
            return DirectCandidate(direct, password);

        // 2) the largest RAR set (release RARs are stored; unwrapped at materialization)
        var rarSets = RarSets(named);
        if (rarSets.Count == 0)
            return null;

        return RarCandidate(rarSets.MaxBy(g => g.Sum(x => x.File.GetTotalYencodedSize()))!, password);
    }

    /// <summary>
    /// Identifies the payload carrying one specific episode of a multi-episode NZB
    /// (season pack support): a direct file or RAR set whose name carries the episode's
    /// numbering wins; a lone RAR set is returned whole (the episode is selected inside
    /// the archive during materialization). When nothing disambiguates, <paramref name="strict"/>
    /// decides between failing (packs must never play the wrong episode) and the legacy
    /// largest-payload behavior (single-episode releases keep working unchanged).
    /// </summary>
    public static MediaFileCandidate? SelectForEpisode(
        NzbDocument document,
        EpisodeTarget target,
        bool strict)
    {
        var password = FindPassword(document);
        var named = NamedFiles(document);

        var directVideos = named.Where(x => IsMediaFileName(x.Name)).ToList();

        // 1) a direct video file named for the episode — pick the largest match
        //    (a sample clip of the same episode is smaller than the real thing).
        var directMatch = directVideos
            .Where(x => target.MatchesFileName(x.Name))
            .OrderByDescending(x => x.File.GetTotalYencodedSize())
            .FirstOrDefault();
        if (directMatch.File is not null)
            return DirectCandidate(directMatch, password);

        // 2) a RAR set whose archive name carries the episode (per-episode-set packs)
        var rarSets = RarSets(named);
        var matchingSets = rarSets
            .Where(g => target.MatchesFileName(g.Key))
            .ToList();
        if (matchingSets.Count > 0)
            return RarCandidate(matchingSets.MaxBy(g => g.Sum(x => x.File.GetTotalYencodedSize()))!, password);

        // 3) exactly one RAR set (monolithic pack, or an ordinary single-episode release):
        //    return it whole — the materializer selects the episode's stored file inside.
        if (rarSets.Count == 1)
            return RarCandidate(rarSets[0], password);

        // 4) no archive and exactly one video file: nothing to disambiguate.
        if (rarSets.Count == 0 && directVideos.Count == 1)
            return DirectCandidate(directVideos[0], password);

        // 5) ambiguous with no episode evidence. For a known multi-episode release the
        //    only safe answer is "no playable file" — never stream a wrong episode.
        return strict ? null : SelectPrimary(document);
    }

    private static List<(NzbFile File, string Name)> NamedFiles(NzbDocument document)
        => document.Files
            .Where(f => f.Segments.Count > 0)
            .Select(f => (File: f, Name: f.GetSubjectFileName()))
            .Where(x => !string.IsNullOrEmpty(x.Name))
            .ToList();

    private static List<IGrouping<string, (NzbFile File, string Name, int? Part)>> RarSets(
        IEnumerable<(NzbFile File, string Name)> named)
        => named
            .Select(x => (x.File, x.Name, Part: RarVolumeReader.GetPartNumberFromFilename(x.Name)))
            .Where(x => x.Part != null)
            .GroupBy(x => RarVolumeReader.GetArchiveName(x.Name), StringComparer.OrdinalIgnoreCase)
            .ToList();

    private static MediaFileCandidate DirectCandidate((NzbFile File, string Name) file, string? password)
        => new()
        {
            DisplayName = file.Name,
            IsRarWrapped = false,
            Files = [file.File],
            Password = password,
        };

    private static MediaFileCandidate RarCandidate(
        IGrouping<string, (NzbFile File, string Name, int? Part)> set,
        string? password)
    {
        var volumes = set.OrderBy(x => x.Part!.Value).ToList();
        return new MediaFileCandidate
        {
            DisplayName = volumes[0].Name,
            IsRarWrapped = true,
            Files = volumes.Select(x => x.File).ToList(),
            Password = password,
        };
    }

    /// <summary>
    /// NZB metadata keys are free-form and untrusted; match "password" case-insensitively
    /// rather than assume any particular indexer's casing convention.
    /// </summary>
    private static string? FindPassword(NzbDocument document)
    {
        foreach (var (key, value) in document.Metadata)
        {
            if (string.Equals(key, "password", StringComparison.OrdinalIgnoreCase))
                return string.IsNullOrEmpty(value) ? null : value;
        }

        return null;
    }
}
