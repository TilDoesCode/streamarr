using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Bitrate vs. the measured streaming path, and the ranking that follows from it.</summary>
public sealed class BandwidthFitTests
{
    [Theory]
    [InlineData(10_000, 20_000, "ok")] // 13 000 needed with headroom
    [InlineData(10_000, 13_000, "ok")]
    [InlineData(10_000, 12_999, "tight")]
    [InlineData(10_000, 10_000, "tight")]
    [InlineData(10_000, 9_999, "tooHigh")]
    public void TheHeadroomDecides_OkTightOrTooHigh(int bitrate, int device, string fit)
    {
        var result = ViewerBandwidthFit.Evaluate(bitrate, null, false, new BandwidthLegs(device, null))!;

        Assert.Equal(fit, result.Fit);
        Assert.Equal("device", result.Leg);
        Assert.Equal(13_000, result.NeededKbps);
        Assert.Equal(device, result.AvailableKbps);
    }

    [Fact]
    public void TheSlowerLeg_Decides()
    {
        var usenet = ViewerBandwidthFit.Evaluate(20_000, null, false, new BandwidthLegs(100_000, 18_000))!;
        var device = ViewerBandwidthFit.Evaluate(20_000, null, false, new BandwidthLegs(18_000, 100_000))!;

        Assert.Equal(("tooHigh", "usenet", 18_000), (usenet.Fit, usenet.Leg, usenet.AvailableKbps));
        Assert.Equal(("tooHigh", "device", 18_000), (device.Fit, device.Leg, device.AvailableKbps));
    }

    [Fact]
    public void ADownloadedVersion_SkipsTheUsenetLeg()
    {
        var downloading = ViewerBandwidthFit.Evaluate(20_000, "downloading", false, new BandwidthLegs(100_000, 10_000))!;
        var ready = ViewerBandwidthFit.Evaluate(20_000, "ready", false, new BandwidthLegs(100_000, 10_000))!;
        var readyWithoutDevice = ViewerBandwidthFit.Evaluate(20_000, "ready", false, new BandwidthLegs(null, 10_000))!;

        Assert.Equal(("tooHigh", "usenet"), (downloading.Fit, downloading.Leg));
        Assert.Equal(("ok", "device"), (ready.Fit, ready.Leg));
        Assert.Equal(("unknown", (string?)null), (readyWithoutDevice.Fit, readyWithoutDevice.Leg));
    }

    [Fact]
    public void ATranscode_SkipsTheDeviceLeg_AndSaysSo()
    {
        var transcoded = ViewerBandwidthFit.Evaluate(60_000, null, true, new BandwidthLegs(10_000, 200_000))!;
        var transcodedLocal = ViewerBandwidthFit.Evaluate(60_000, "ready", true, new BandwidthLegs(10_000, 200_000))!;

        Assert.Equal(("ok", "usenet", true), (transcoded.Fit, transcoded.Leg, transcoded.ViaTranscode));
        Assert.Equal(("unknown", true), (transcodedLocal.Fit, transcodedLocal.ViaTranscode));
    }

    [Fact]
    public void NoMeasurement_IsNull_AndNoBitrate_IsUnknown()
    {
        Assert.Null(ViewerBandwidthFit.Evaluate(10_000, null, false, BandwidthLegs.None));
        Assert.Equal("unknown", ViewerBandwidthFit.Evaluate(null, null, false, new BandwidthLegs(50_000, null))!.Fit);
    }

    private static (VersionDto, string?, int) Version(string id, int score, string? fit = null, string? local = null)
        => (new VersionDto { ReleaseId = id, Name = id, Rank = 1, QualityRank = 1, Health = "ready", BandwidthFit = fit, Local = local }, null, score);

    [Fact]
    public void TooHighVersions_RankBelowFittingOnes_EvenDownloadedOnes_ButStayListed()
    {
        var order = ViewerCatalogService.DeviceOrder(
        [
            Version("4k-remux", 400, "tooHigh"),
            Version("4k-local", 350, "tooHigh", local: "ready"),
            Version("1080p", 300, "tight"),
            Version("720p", 200, "ok"),
        ]);

        Assert.Equal(["1080p", "720p", "4k-local", "4k-remux"], order.Select(v => v.ReleaseId));
        Assert.Equal("1080p", Assert.Single(order, v => v.Recommended).ReleaseId);
    }

    [Fact]
    public void WhenNothingFits_TheBestStaysRecommended()
    {
        var order = ViewerCatalogService.DeviceOrder([Version("a", 300, "tooHigh"), Version("b", 200, "tooHigh")]);
        var unknown = ViewerCatalogService.DeviceOrder([Version("a", 300, "tooHigh"), Version("c", 100, "unknown")]);

        Assert.Equal(["a", "b"], order.Select(v => v.ReleaseId));
        Assert.True(order[0].Recommended);
        Assert.Equal(["c", "a"], unknown.Select(v => v.ReleaseId));
    }
}
