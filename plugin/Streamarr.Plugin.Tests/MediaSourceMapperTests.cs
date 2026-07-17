using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.MediaSources;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// The mapper is the plugin's only non-trivial code. These tests pin the translation
/// so a regression can't silently break playback. No Jellyfin host required.
/// </summary>
public class MediaSourceMapperTests
{
    private static ReleaseDto SampleRelease() => new()
    {
        ReleaseId = "rel-123",
        Title = "Example.2021.1080p.WEB-DL.x265.DDP5.1-GRP",
        Indexer = "demo",
        SizeBytes = 5_368_709_120,
        Languages = ["de", "en"],
        Quality = new QualityDto
        {
            Resolution = "1080p",
            Source = "WEB-DL",
            Codec = "x265",
            Hdr = "HDR10",
            Audio = "DDP5.1",
        },
    };

    [Fact]
    public void UnopenedSource_requires_opening_and_carries_release_token()
    {
        var source = MediaSourceMapper.ToUnopenedSource(SampleRelease(), "opaque-offer");

        Assert.True(source.RequiresOpening);
        Assert.Equal("opaque-offer", source.OpenToken);
        Assert.Equal("rel-123", source.Id);
        Assert.True(source.IsRemote);
        Assert.Equal(MediaProtocol.Http, source.Protocol);
        Assert.Null(source.Path); // no Usenet contact yet
    }

    [Fact]
    public void VersionName_is_human_readable()
    {
        var name = MediaSourceMapper.FormatVersionName(SampleRelease());

        Assert.Contains("1080p WEB-DL x265 HDR10", name);
        Assert.Contains("DDP5.1", name);
        Assert.Contains("DE/EN", name);
        Assert.Contains("GiB", name);
    }

    [Fact]
    public void OpenedSource_has_capability_path_no_machine_secret_streams_and_low_analyze_duration()
    {
        var resolve = new ResolveResponse
        {
            ReleaseId = "rel-123",
            Status = "ready",
            StreamUrl = "https://host/api/v1/stream/tok-abc",
            Container = "mkv",
            SizeBytes = 5_368_709_120,
            RunTimeTicks = 78_000_000_000,
            SessionTtlSeconds = 3600,
            MediaStreams =
            [
                new MediaStreamInfo { Type = "Video", Codec = "hevc", Width = 1920, Height = 1080 },
                new MediaStreamInfo { Type = "Audio", Codec = "eac3", Channels = 6, Language = "deu" },
                new MediaStreamInfo { Type = "Subtitle", Codec = "subrip", Language = "eng" },
            ],
        };

        var source = MediaSourceMapper.ToOpenedSource(resolve, "live-1");

        Assert.Equal("https://host/api/v1/stream/tok-abc", source.Path);
        Assert.Equal(MediaProtocol.Http, source.Protocol);
        Assert.True(source.RequiresClosing);
        Assert.False(source.RequiresOpening);
        Assert.Equal("live-1", source.LiveStreamId);
        Assert.Equal("mkv", source.Container);
        Assert.Equal(78_000_000_000, source.RunTimeTicks);
        Assert.Equal(1000, source.AnalyzeDurationMs);
        Assert.Empty(source.RequiredHttpHeaders);
        Assert.DoesNotContain("secret-key", source.Path, StringComparison.Ordinal);
        Assert.Equal(3, source.MediaStreams.Count);
        Assert.Equal(MediaStreamType.Video, source.MediaStreams[0].Type);
        Assert.Equal(MediaStreamType.Audio, source.MediaStreams[1].Type);
        Assert.Equal(MediaStreamType.Subtitle, source.MediaStreams[2].Type);
    }

    [Theory]
    [InlineData("https://host/api/v1/stream/tok-abc", "tok-abc")]
    [InlineData("https://host/api/v1/stream/tok-abc?access_token=x", "tok-abc")]
    [InlineData("https://host/api/v1/stream/tok-abc/", "tok-abc")]
    [InlineData(null, null)]
    [InlineData("https://host/nope", null)]
    public void TokenFromStreamUrl_extracts_token(string? url, string? expected)
    {
        Assert.Equal(expected, StreamarrApiClient.TokenFromStreamUrl(url));
    }

    [Fact]
    public void Stream_capability_is_resolved_only_against_configured_core_origin()
    {
        Assert.Equal(
            "https://core.example:8443/api/v1/stream/tok-abc",
            StreamarrApiClient.ResolveStreamUrl("https://core.example:8443", "/api/v1/stream/tok-abc"));
        Assert.Equal(
            "https://core.example:8443/api/v1/stream/tok-abc",
            StreamarrApiClient.ResolveStreamUrl(
                "https://core.example:8443",
                "https://core.example:8443/api/v1/stream/tok-abc"));

        Assert.Throws<InvalidOperationException>(() => StreamarrApiClient.ResolveStreamUrl(
            "https://core.example:8443",
            "https://attacker.example/api/v1/stream/tok-abc"));
        Assert.Throws<InvalidOperationException>(() => StreamarrApiClient.ResolveStreamUrl(
            "https://core.example:8443",
            "/api/v1/stream/tok-abc?access_token=secret"));
        Assert.Throws<InvalidOperationException>(() => StreamarrApiClient.ResolveStreamUrl(
            "https://core.example:8443",
            "/api/v1/admin"));
    }

    [Fact]
    public void Stream_capability_can_use_a_client_reachable_origin_distinct_from_core_control()
    {
        Assert.Equal(
            "https://media.example/streamarr/api/v1/stream/tok-abc",
            StreamarrApiClient.ResolveStreamUrl(
                "http://streamarr:8080",
                "https://media.example/streamarr",
                "/api/v1/stream/tok-abc"));
        Assert.Equal(
            "https://media.example/api/v1/stream/tok-abc",
            StreamarrApiClient.ResolveStreamUrl(
                "http://streamarr:8080",
                "https://media.example",
                "http://streamarr:8080/api/v1/stream/tok-abc"));

        Assert.Throws<InvalidOperationException>(() => StreamarrApiClient.ResolveStreamUrl(
            "http://streamarr:8080",
            "https://media.example",
            "https://attacker.example/api/v1/stream/tok-abc"));
    }

    [Fact]
    public void Capability_session_is_redacted_from_transport_log_path()
    {
        Assert.Equal(
            "/api/v1/sessions/{session}/close",
            StreamarrApiClient.SafeLogPath("/api/v1/sessions/highly-secret/close"));
        Assert.Equal(
            "/api/v1/search",
            StreamarrApiClient.SafeLogPath("/api/v1/search?q=private-viewing-history&profileId=secret"));
    }
}
