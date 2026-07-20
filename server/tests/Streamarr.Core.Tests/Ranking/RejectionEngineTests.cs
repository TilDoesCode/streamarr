using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;

namespace Streamarr.Core.Tests.Ranking;

public class RejectionEngineTests
{
    private static readonly QualityProfile Profile = DefaultProfiles.Standard;
    private static readonly RejectionEngine Engine = new();

    private static ReleaseSignals Signals(
        string name = "Example.2021.1080p.WEB-DL.x265-GROUP",
        long sizeBytes = 4_000_000_000,
        int? runtimeMinutes = 120,
        string? resolution = "1080p",
        ReleaseHealth health = ReleaseHealth.Unknown,
        NzbInspection? nzb = null) => new()
    {
        ReleaseName = name,
        SizeBytes = sizeBytes,
        RuntimeMinutes = runtimeMinutes,
        Resolution = resolution,
        Health = health,
        Nzb = nzb,
    };

    private static bool Has(IReadOnlyList<RejectionReason> reasons, RejectionCode code)
        => reasons.Any(r => r.Code == code);

    [Fact]
    public void GoodRelease_IsAccepted()
    {
        var reasons = Engine.Evaluate(Signals(), Profile);
        Assert.Empty(reasons);
    }

    [Theory]
    [InlineData("Example.2021.1080p.WEB-DL.sample-GROUP")]
    [InlineData("Example.2021.Sample.1080p.WEB-DL-GROUP")]
    public void SampleMarker_IsRejected(string name)
    {
        var reasons = Engine.Evaluate(Signals(name: name), Profile);
        Assert.True(Has(reasons, RejectionCode.Sample));
    }

    [Fact]
    public void ResampledInTitle_IsNotFlaggedAsSample()
    {
        var reasons = Engine.Evaluate(Signals(name: "The.Resample.2021.1080p.WEB-DL-GROUP"), Profile);
        Assert.False(Has(reasons, RejectionCode.Sample));
    }

    [Fact]
    public void TinyFileForRuntime_IsRejectedAsSample()
    {
        // 40 MB for a 120-minute feature cannot be the real thing.
        var reasons = Engine.Evaluate(Signals(sizeBytes: 40_000_000), Profile);
        Assert.True(Has(reasons, RejectionCode.Sample));
    }

    [Fact]
    public void SizeTooSmall_ForClaimedResolution_IsRejected()
    {
        // 300 MB / 120 min = 2.5 MB/min — below the 6 MB/min 1080p floor, but above
        // the absolute sample floor so this is a size-sanity (fake) rejection.
        var reasons = Engine.Evaluate(Signals(sizeBytes: 300_000_000), Profile);
        Assert.True(Has(reasons, RejectionCode.SizeTooSmall));
        Assert.False(Has(reasons, RejectionCode.Sample));
    }

    [Fact]
    public void SizeTooLarge_ForClaimedResolution_IsRejected()
    {
        // 500 MB/min * 120 min = 60 GB — over the 450 MB/min 1080p ceiling.
        var reasons = Engine.Evaluate(Signals(sizeBytes: 60_000_000_000), Profile);
        Assert.True(Has(reasons, RejectionCode.SizeTooLarge));
    }

    [Fact]
    public void SizeSanity_SkippedWhenRuntimeUnknown()
    {
        var reasons = Engine.Evaluate(Signals(sizeBytes: 300_000_000, runtimeMinutes: null), Profile);
        Assert.False(Has(reasons, RejectionCode.SizeTooSmall));
    }

    [Fact]
    public void PasswordProtectedArchive_IsRejected()
    {
        var nzb = new NzbInspection { PasswordProtected = true };
        var reasons = Engine.Evaluate(Signals(nzb: nzb), Profile);
        Assert.True(Has(reasons, RejectionCode.PasswordProtected));
    }

    [Fact]
    public void ExecutablePayload_IsRejected()
    {
        var nzb = new NzbInspection { FileNames = ["setup.exe", "readme.txt"] };
        var reasons = Engine.Evaluate(Signals(nzb: nzb), Profile);
        Assert.True(Has(reasons, RejectionCode.NonMediaPayload));
    }

    [Fact]
    public void NoMediaOrArchive_IsRejected()
    {
        var nzb = new NzbInspection { FileNames = ["info.nfo", "poster.jpg"] };
        var reasons = Engine.Evaluate(Signals(nzb: nzb), Profile);
        Assert.True(Has(reasons, RejectionCode.NonMediaPayload));
    }

    [Theory]
    [InlineData("movie.mkv")]
    [InlineData("movie.part01.rar")]
    public void MediaOrArchivePayload_IsAccepted(string fileName)
    {
        var nzb = new NzbInspection { FileNames = [fileName, "info.nfo"] };
        var reasons = Engine.Evaluate(Signals(nzb: nzb), Profile);
        Assert.False(Has(reasons, RejectionCode.NonMediaPayload));
    }

    [Fact]
    public void MissingFiles_IsRejectedAsIncomplete()
    {
        var nzb = new NzbInspection
        {
            FileNames = ["movie.mkv"],
            ExpectedFileCount = 10,
            PresentFileCount = 8,
        };
        var reasons = Engine.Evaluate(Signals(nzb: nzb), Profile);
        Assert.True(Has(reasons, RejectionCode.IncompleteUpload));
    }

    [Fact]
    public void MissingSegmentsBeyondTolerance_IsRejectedAsIncomplete()
    {
        var nzb = new NzbInspection
        {
            FileNames = ["movie.mkv"],
            TotalSegments = 1000,
            MissingSegments = 50, // 5% > 2% tolerance
        };
        var reasons = Engine.Evaluate(Signals(nzb: nzb), Profile);
        Assert.True(Has(reasons, RejectionCode.IncompleteUpload));
    }

    [Fact]
    public void FewMissingSegmentsWithinTolerance_IsAccepted()
    {
        var nzb = new NzbInspection
        {
            FileNames = ["movie.mkv"],
            TotalSegments = 1000,
            MissingSegments = 5, // 0.5% < 2%
        };
        var reasons = Engine.Evaluate(Signals(nzb: nzb), Profile);
        Assert.False(Has(reasons, RejectionCode.IncompleteUpload));
    }

    [Fact]
    public void DeadHealth_IsRejected()
    {
        var reasons = Engine.Evaluate(Signals(health: ReleaseHealth.Dead), Profile);
        Assert.True(Has(reasons, RejectionCode.DeadOnUsenet));
    }

    [Fact]
    public void EveryReasonCarriesCodeAndMessage()
    {
        var nzb = new NzbInspection { PasswordProtected = true };
        var reasons = Engine.Evaluate(Signals(health: ReleaseHealth.Dead, nzb: nzb), Profile);

        Assert.NotEmpty(reasons);
        Assert.All(reasons, r =>
        {
            Assert.False(string.IsNullOrWhiteSpace(r.Message));
            Assert.False(string.IsNullOrWhiteSpace(r.CodeSlug));
        });
    }

    [Fact]
    public void CustomFormatScoreBelowImportedMinimum_IsRejected()
    {
        var profile = Profile with
        {
            MinimumCustomFormatScore = 0,
            CustomFormats =
            [
                new CustomFormatScore
                {
                    Name = "Reject low quality source",
                    Score = -10_000,
                    Conditions =
                    [
                        new CustomFormatCondition
                        {
                            Implementation = "SourceSpecification",
                            Value = "CAM,TS",
                        },
                    ],
                },
            ],
        };

        var reasons = Engine.Evaluate(Signals() with { Source = "CAM" }, profile);
        Assert.True(Has(reasons, RejectionCode.CustomFormatScore));
    }
}
