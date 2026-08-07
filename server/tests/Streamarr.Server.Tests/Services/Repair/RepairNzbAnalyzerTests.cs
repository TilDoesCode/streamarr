using Streamarr.Server.Services;
using Streamarr.Server.Services.Repair;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Tests.Services.Repair;

public sealed class RepairNzbAnalyzerTests
{
    [Fact]
    public void FingerprintIncludesFileNamesBoundariesAndArchiveShape()
    {
        var first = Candidate(false, File("video.mkv", ("one@test", 100), ("two@test", 200)));
        var renamed = Candidate(false, File("other.mkv", ("one@test", 100), ("two@test", 200)));
        var split = Candidate(
            true,
            File("video.part01.rar", ("one@test", 100)),
            File("video.part02.rar", ("two@test", 200)));

        var fingerprint = RepairNzbAnalyzer.ComputeFingerprint(first);

        Assert.Equal(fingerprint, RepairNzbAnalyzer.ComputeFingerprint(first));
        Assert.NotEqual(fingerprint, RepairNzbAnalyzer.ComputeFingerprint(renamed));
        Assert.NotEqual(fingerprint, RepairNzbAnalyzer.ComputeFingerprint(split));
    }

    [Fact]
    public void Par2Selection_UsesAnAnchoredVolumeMarkerAndPrioritizesMatchingVolumes()
    {
        var document = new NzbDocument();
        var volcanoIndex = File("movie.volcano.par2", ("volcano@test", 10));
        var selectedIndex = File("movie.par2", ("index@test", 20));
        var matchingVolume = File("movie.vol00+01.par2", ("matching@test", 100));
        var foreignVolume = File("other.vol00+01.par2", ("foreign@test", 1));
        document.Files.AddRange([foreignVolume, matchingVolume, selectedIndex, volcanoIndex]);

        var companions = Assert.IsType<Par2CompanionFiles>(
            RepairNzbAnalyzer.SelectPar2Files(document));

        Assert.Equal(
            [volcanoIndex, selectedIndex],
            companions.IndexCandidates.Take(2));
        Assert.Contains(matchingVolume, companions.IndexCandidates);
        Assert.Contains(foreignVolume, companions.IndexCandidates);
        var selectedVolumes = RepairNzbAnalyzer.OrderRecoveryFiles(
            companions.AllFiles,
            selectedIndex);
        Assert.Same(matchingVolume, selectedVolumes[0]);
        Assert.Contains(selectedIndex, selectedVolumes);
        Assert.Contains(foreignVolume, companions.AllFiles);
        Assert.Equal([foreignVolume, matchingVolume], companions.Volumes);

        var selectedVolumeRecovery = RepairNzbAnalyzer.OrderRecoveryFiles(
            companions.AllFiles,
            matchingVolume);
        Assert.Equal(1, selectedVolumeRecovery.Count(item => ReferenceEquals(item, matchingVolume)));
    }

    private static MediaFileCandidate Candidate(bool isRar, params NzbFile[] files) => new()
    {
        DisplayName = files[0].GetSubjectFileName(),
        IsRarWrapped = isRar,
        Files = files,
    };

    private static NzbFile File(string name, params (string Id, long Bytes)[] segments)
    {
        var file = new NzbFile { Subject = $"\"{name}\" yEnc" };
        file.Segments.AddRange(segments.Select((segment, index) => new NzbSegment
        {
            Number = index + 1,
            MessageId = segment.Id,
            Bytes = segment.Bytes,
        }));
        return file;
    }
}
