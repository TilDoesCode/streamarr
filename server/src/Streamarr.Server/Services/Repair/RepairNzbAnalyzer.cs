using System.Text.RegularExpressions;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Services.Repair;

/// <summary>The PAR2 companion files of one NZB: the small index plus the recovery volumes.</summary>
public sealed record Par2CompanionFiles
{
    /// <summary>Legacy first candidate; callers should probe <see cref="IndexCandidates"/>.</summary>
    public required NzbFile IndexFile { get; init; }

    /// <summary>Recovery volumes, smallest first (cheapest additional parity first).</summary>
    public required IReadOnlyList<NzbFile> Volumes { get; init; }

    /// <summary>Index-shaped PAR2 files, cheapest first.</summary>
    public required IReadOnlyList<NzbFile> IndexCandidates { get; init; }

    /// <summary>Every PAR2 file, retained as a SetId-filtered recovery fallback.</summary>
    public required IReadOnlyList<NzbFile> AllFiles { get; init; }
}

/// <summary>Pure NZB analysis for the repair pipeline (deterministic, no I/O).</summary>
public static partial class RepairNzbAnalyzer
{
    [GeneratedRegex(@"^(?<stem>.+)\.vol\d+\+\d+\.par2$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex RecoveryVolumeName();

    /// <summary>
    /// Finds the PAR2 set of an NZB by subject file name: the index is the smallest
    /// <c>.par2</c> without a <c>.volNN+NN</c> marker (falling back to the smallest of
    /// all), the rest are recovery volumes. Returns null when the NZB carries no PAR2.
    /// </summary>
    public static Par2CompanionFiles? SelectPar2Files(NzbDocument document)
    {
        var par2 = document.Files
            .Where(f => f.Segments.Count > 0)
            .Select(f => (File: f, Name: f.GetSubjectFileName()))
            .Where(x => !string.IsNullOrEmpty(x.Name)
                        && x.Name.EndsWith(".par2", StringComparison.OrdinalIgnoreCase))
            .OrderBy(x => x.File.GetTotalYencodedSize())
            .ToList();
        if (par2.Count == 0)
            return null;

        var indexCandidates = par2
            .OrderBy(x => RecoveryVolumeName().IsMatch(x.Name))
            .ThenBy(x => x.File.GetTotalYencodedSize())
            .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var index = indexCandidates[0];
        var volumes = par2
            .Where(item => RecoveryVolumeName().IsMatch(item.Name))
            .OrderBy(item => item.File.GetTotalYencodedSize())
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .Select(item => item.File)
            .ToList();

        return new Par2CompanionFiles
        {
            IndexFile = index.File,
            Volumes = volumes,
            IndexCandidates = indexCandidates.Select(x => x.File).ToList(),
            AllFiles = par2.Select(x => x.File).ToList(),
        };
    }

    /// <summary>
    /// Prioritizes the selected set's named volumes, then its index and all SetId-filtered
    /// fallbacks. The index remains eligible because base PAR2 files may contain recovery slices.
    /// </summary>
    public static IReadOnlyList<NzbFile> OrderRecoveryFiles(
        IReadOnlyList<NzbFile> allFiles,
        NzbFile selectedIndex)
    {
        var selectedStem = SetStem(selectedIndex.GetSubjectFileName());
        return allFiles
            .Select(file => new
            {
                File = file,
                Name = file.GetSubjectFileName(),
            })
            .OrderBy(item =>
            {
                var matchingVolume = RecoveryVolumeName().IsMatch(item.Name)
                    && string.Equals(SetStem(item.Name), selectedStem, StringComparison.OrdinalIgnoreCase);
                if (matchingVolume)
                    return 0;
                return ReferenceEquals(item.File, selectedIndex) ? 1 : 2;
            })
            .ThenBy(item => item.File.GetTotalYencodedSize())
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .Select(item => item.File)
            .ToList();
    }

    internal static bool IsRecoveryVolume(NzbFile file)
        => RecoveryVolumeName().IsMatch(file.GetSubjectFileName());

    internal static string SetStem(NzbFile file)
        => SetStem(file.GetSubjectFileName());

    private static string SetStem(string name)
    {
        var volume = RecoveryVolumeName().Match(name);
        if (volume.Success)
            return volume.Groups["stem"].Value;
        return name.EndsWith(".par2", StringComparison.OrdinalIgnoreCase)
            ? name[..^5]
            : name;
    }

    /// <summary>The stable fingerprint of a media candidate and its complete source layout.</summary>
    public static string ComputeFingerprint(MediaFileCandidate candidate)
        => RepairFingerprint.Compute(candidate);
}
