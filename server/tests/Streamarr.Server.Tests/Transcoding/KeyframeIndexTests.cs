using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>Media with irregular keyframes and B-frames, generated once; ffprobe's packet flags are the ground truth.</summary>
public sealed class KeyframeFixture : IAsyncLifetime
{
    public const string ForcedKeyframes = "0,1.5,4,9.25,10,16,22.5,30,31";

    public string Directory { get; private set; } = null!;
    public string Mkv => Path.Combine(Directory, "irregular.mkv");
    public string Mp4 => Path.Combine(Directory, "irregular.mp4");
    public string FastStart => Path.Combine(Directory, "faststart.mp4");
    public string NoCues => Path.Combine(Directory, "nocues.mkv");
    public string Hevc => Path.Combine(Directory, "hevc10.mkv");

    public async Task InitializeAsync()
    {
        Directory = System.IO.Directory.CreateTempSubdirectory("streamarr-keyframes-").FullName;
        await FfmpegAsync(
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=40",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=40",
            "-c:v", "libx264", "-preset", "veryfast", "-bf", "3", "-x264-params", "keyint=2000:min-keyint=2000:scenecut=0",
            "-force_key_frames", ForcedKeyframes, "-pix_fmt", "yuv420p", "-c:a", "aac", Mkv);
        await FfmpegAsync("-i", Mkv, "-map", "0", "-c", "copy", Mp4);
        await FfmpegAsync("-i", Mkv, "-map", "0", "-c", "copy", "-movflags", "+faststart", FastStart);
        await FfmpegAsync("-i", Mkv, "-map", "0", "-c", "copy", "-f", "matroska", "-live", "1", NoCues);
        await FfmpegAsync(
            "-f", "lavfi", "-i", "testsrc2=size=192x108:rate=24:duration=6",
            "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error:keyint=48:scenecut=0", Hevc);
    }

    public Task DisposeAsync()
    {
        System.IO.Directory.Delete(Directory, true);
        return Task.CompletedTask;
    }

    /// <summary>Keyframe PTS as ffmpeg's demuxer reports them.</summary>
    public static async Task<List<double>> ProbeKeyframesAsync(string path)
    {
        var output = await RunAsync("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path);
        return output.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Split(','))
            .Where(p => p.Length >= 2 && p[1].StartsWith('K'))
            .Select(p => double.Parse(p[0], CultureInfo.InvariantCulture))
            .Order()
            .ToList();
    }

    public static Task FfmpegAsync(params string[] args) => RunAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", .. args]);

    public static async Task<string> RunAsync(string tool, params string[] args)
    {
        var psi = new ProcessStartInfo(tool) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var a in args)
            psi.ArgumentList.Add(a);
        using var process = Process.Start(psi)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"{tool} failed ({process.ExitCode}): {await stderr}");
        return await stdout;
    }
}

public sealed class KeyframeIndexTests(KeyframeFixture fixture) : IClassFixture<KeyframeFixture>
{
    private static async Task<ContainerIndex?> ReadAsync(string path, Func<IRangeSource, CancellationToken, Task<ContainerIndex?>> reader)
    {
        await using var source = new FileRangeSource(path);
        return await reader(source, CancellationToken.None);
    }

    [Fact]
    public async Task MatroskaCues_MatchFfprobe_AndCarryTheAvcConfig()
    {
        var expected = await KeyframeFixture.ProbeKeyframesAsync(fixture.Mkv);

        var index = await ReadAsync(fixture.Mkv, MatroskaIndexReader.ReadAsync);

        Assert.NotNull(index);
        Assert.Equal(KeyframeIndexSource.MatroskaCues, index.Source);
        Assert.Equal(expected.Count, index.Keyframes.Count);
        Assert.All(expected.Zip(index.Keyframes), p => Assert.Equal(p.First, p.Second, 6));
        Assert.Equal([0, 1.5, 4, 9.25, 10, 16, 22.5, 30, 31], index.Keyframes.Select(k => Math.Round(k, 3)));
        Assert.True(index.OffsetsCoverAllStreams);
        Assert.Equal(new FileInfo(fixture.Mkv).Length, index.TotalBytes);
        Assert.True(index.ByteOffsets!.Zip(index.ByteOffsets!.Skip(1)).All(p => p.Second > p.First));
        Assert.Equal(VideoCodecConfig.AvcC, index.Config!.Format);
        Assert.StartsWith("avc1.64", CodecStrings.AvcFromAvcC(index.Config.Data));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Mp4SampleTable_GivesPresentationTimesIncludingTheEditList(bool faststart)
    {
        var path = faststart ? fixture.FastStart : fixture.Mp4;
        var expected = await KeyframeFixture.ProbeKeyframesAsync(path);

        var index = await ReadAsync(path, Mp4IndexReader.ReadAsync);

        Assert.NotNull(index);
        Assert.Equal(KeyframeIndexSource.Mp4SampleTable, index.Source);
        Assert.Equal(expected.Count, index.Keyframes.Count);
        Assert.All(expected.Zip(index.Keyframes), p => Assert.Equal(p.First, p.Second, 4));
        Assert.False(index.OffsetsCoverAllStreams);
        Assert.Equal(index.Keyframes.Count, index.ByteOffsets!.Count);
        Assert.Equal(VideoCodecConfig.AvcC, index.Config!.Format);
    }

    [Fact]
    public async Task MatroskaWithoutCues_FallsBackToTheFfprobeScan()
    {
        var expected = await KeyframeFixture.ProbeKeyframesAsync(fixture.NoCues);
        Assert.Null(await ReadAsync(fixture.NoCues, MatroskaIndexReader.ReadAsync));
        var service = Service();
        var media = new SourceMediaInfo { Container = "matroska,webm", DurationSeconds = 40, Video = new SourceVideoStream { Index = 0, Codec = "h264" } };

        var result = await service.BuildAsync(new TranscodeSource(TranscodeSource.SampleKind, fixture.NoCues, false, "no cues"), media);

        Assert.Null(result.Error);
        Assert.Equal(KeyframeIndexSource.FfprobeScan, result.Index!.Source);
        Assert.Equal(expected, result.Index.Keyframes);
        Assert.Equal(VideoCodecConfig.AvcC, result.Index.Config!.Format);
        Assert.StartsWith("avc1.64", CodecStrings.Video(media.Video, result.Index.Config));
    }

    [Fact]
    public async Task HevcMain10_CodecPrivate_GivesTheExactCodecsString()
    {
        var probe = await KeyframeFixture.RunAsync("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=level", "-of", "csv=p=0", fixture.Hevc);

        var index = await ReadAsync(fixture.Hevc, MatroskaIndexReader.ReadAsync);

        Assert.Equal(VideoCodecConfig.HvcC, index!.Config!.Format);
        Assert.StartsWith($"hvc1.2.4.L{probe.Trim()}", CodecStrings.HevcFromHvcC(index.Config.Data));
        Assert.Equal([0, 2, 4], index.Keyframes.Select(k => Math.Round(k, 3)));
    }

    [Fact]
    public async Task Service_RejectsIndexesWithGapsTooLongForHls()
    {
        var media = new SourceMediaInfo { Container = "matroska,webm", DurationSeconds = 70, Video = new SourceVideoStream { Index = 0, Codec = "h264" } };

        var result = await Service(scanSeconds: 1).BuildAsync(new TranscodeSource(TranscodeSource.SampleKind, fixture.Mkv, false, "gap"), media);

        Assert.Null(result.Index);
        Assert.Contains("apart", result.Error);
    }

    [Fact]
    public void Reject_ChecksEveryGapIncludingTheTail()
    {
        static ContainerIndex Index(params double[] keyframes) => new(KeyframeIndexSource.FfprobeScan, keyframes, null, true, null);
        var media = new SourceMediaInfo { DurationSeconds = 60, StartTime = -0.005 };

        Assert.Null(KeyframeIndexService.Reject(Index(0, 20, 40), media));
        Assert.Contains("25 s apart", KeyframeIndexService.Reject(Index(0, 5, 30), media));
        Assert.Contains("apart", KeyframeIndexService.Reject(Index(0, 20, 30), media));
        Assert.Contains("no keyframes", KeyframeIndexService.Reject(Index(), media));
    }

    [Theory]
    [InlineData("pts_time=12.345000|pos=1068|flags=K__", 12.345, 1068L)]
    [InlineData("pts_time=1.5|pos=N/A|flags=K_D", 1.5, -1L)]
    [InlineData("pts_time=2.000000|pos=10|flags=___", null, null)]
    [InlineData("pts_time=N/A|pos=10|flags=K__", null, null)]
    public void ParsePacket_KeepsOnlyKeyframes(string line, double? time, long? position)
    {
        var parsed = KeyframeIndexService.ParsePacket(line);

        Assert.Equal(time, parsed?.Time);
        Assert.Equal(position, parsed?.Position);
    }

    [Fact]
    public void Extradata_HexDumpIsDecodedAndClassified()
    {
        const string dump = "\n00000000: 0000 0167 6400 28ac d940 7802 27e5 c044  ...gd.(..@x.'..D\n00000010: 0000 0300 04                             .....\n";

        var bytes = KeyframeIndexService.ParseHexDump(dump);

        Assert.Equal(21, bytes.Length);
        Assert.Equal(VideoCodecConfig.AnnexB, KeyframeIndexService.ClassifyExtradata("h264", bytes)!.Format);
        Assert.Equal(VideoCodecConfig.AvcC, KeyframeIndexService.ClassifyExtradata("h264", [1, 0x64, 0, 0x28])!.Format);
        Assert.Equal(VideoCodecConfig.Av1C, KeyframeIndexService.ClassifyExtradata("av1", [0x81, 8, 12, 0])!.Format);
        Assert.Null(KeyframeIndexService.ClassifyExtradata("vp9", [1, 2, 3, 4]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SyntheticMatroska_UsesTheTimecodeScale_TheVideoTrack_AndNestedSeekHeads(bool nested)
    {
        var bytes = SyntheticMatroska.Build(nested);
        var path = Path.Combine(fixture.Directory, $"synthetic-{nested}.mkv");
        await File.WriteAllBytesAsync(path, bytes);

        var index = await ReadAsync(path, MatroskaIndexReader.ReadAsync);

        Assert.NotNull(index);
        Assert.Equal([0, 2, 4], index.Keyframes);
        Assert.Equal([SyntheticMatroska.SegmentStart + 100, SyntheticMatroska.SegmentStart + 2000, SyntheticMatroska.SegmentStart + 4000], index.ByteOffsets);
        Assert.Equal("hvc1.2.4.L150.90", CodecStrings.HevcFromHvcC(index.Config!.Data));
    }

    [Fact]
    public async Task NotAContainer_GivesNoIndex()
    {
        var path = Path.Combine(fixture.Directory, "garbage.bin");
        await File.WriteAllBytesAsync(path, Encoding.ASCII.GetBytes(new string('x', 5000)));

        Assert.Null(await ReadAsync(path, MatroskaIndexReader.ReadAsync));
        Assert.Null(await ReadAsync(path, Mp4IndexReader.ReadAsync));
    }

    [Fact]
    public void Mp4SampleTable_WithMoreKeyframesThanTheCap_IsRejectedBeforeAllocating()
    {
        const uint TooMany = KeyframeIndexService.MaxKeyframes + 1;

        Assert.Equal(1000, Mp4IndexReader.Parse(SyntheticMoov(1000, stssCount: null))!.Keyframes.Count);
        Assert.Null(Mp4IndexReader.Parse(SyntheticMoov(TooMany, stssCount: null)));
        Assert.Null(Mp4IndexReader.Parse(SyntheticMoov(TooMany, stssCount: TooMany)));
        Assert.Contains("more than", KeyframeIndexService.Reject(
            new ContainerIndex(KeyframeIndexSource.FfprobeScan, Enumerable.Range(0, (int)TooMany).Select(i => i * 0.01).ToList(), null, true, null),
            new SourceMediaInfo { DurationSeconds = TooMany * 0.01 }));
    }

    [Fact]
    public async Task Service_TurnsUnexpectedContainerErrorsIntoAnUncachedResult()
    {
        var directory = System.IO.Directory.CreateDirectory(Path.Combine(fixture.Directory, "not-a-file.mkv")).FullName;
        var service = Service(scanSeconds: 5);
        var source = new TranscodeSource(TranscodeSource.SampleKind, directory, false, "directory");
        var media = new SourceMediaInfo { Container = "matroska,webm", DurationSeconds = 10 };

        var first = await service.GetAsync(source, media, CancellationToken.None);
        var second = await service.GetAsync(source, media, CancellationToken.None);

        Assert.Null(first.Index);
        Assert.Contains("container index failed", first.Error);
        Assert.Null(second.Index);
    }

    /// <summary>A minimal moov: one video track whose stts lists <paramref name="samples"/> samples, optionally with a stss header.</summary>
    private static byte[] SyntheticMoov(uint samples, uint? stssCount)
    {
        static byte[] U32(params uint[] values) => values.SelectMany(v => BitConverter.GetBytes(v).Reverse()).ToArray();
        static byte[] Box(string type, params byte[][] children)
        {
            var content = children.SelectMany(c => c).ToArray();
            return [.. U32((uint)content.Length + 8), .. Encoding.ASCII.GetBytes(type), .. content];
        }
        var stbl = stssCount is { } count
            ? Box("stbl", Box("stts", U32(0, 1, samples, 1)), Box("stss", U32(0, count, 1)))
            : Box("stbl", Box("stts", U32(0, 1, samples, 1)));
        var mdia = Box("mdia", Box("mdhd", U32(0, 0, 0, 24, samples, 0)), Box("hdlr", U32(0, 0), Encoding.ASCII.GetBytes("vide"), U32(0, 0, 0), [0]), Box("minf", stbl));
        return Box("moov", Box("mvhd", U32(0, 0, 0, 1000, 0)), Box("trak", mdia));
    }

    private static KeyframeIndexService Service(int scanSeconds = 20)
        => new(new NoHttp(), new ProcessRunner(),
            Microsoft.Extensions.Options.Options.Create(new TranscodingOptions { KeyframeScanTimeoutSeconds = scanSeconds }), NullLogger<KeyframeIndexService>.Instance);

    private sealed class NoHttp : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("Local sources never use HTTP.");
    }
}

/// <summary>A hand-built Matroska file: audio track first, video track 1 with hvcC, Cues after an unknown-size Cluster.</summary>
internal static class SyntheticMatroska
{
    public const long SegmentStart = 30 + 12;

    public static byte[] Build(bool nestedSeekHead)
    {
        var info = El(0x1549A966, UInt(0x2AD7B1, 500_000));
        var tracks = El(0x1654AE6B,
            El(0xAE, UInt(0xD7, 2), UInt(0x83, 2), El(0x86, Encoding.ASCII.GetBytes("A_AC3"))),
            El(0xAE, UInt(0xD7, 1), UInt(0x83, 1), El(0x86, Encoding.ASCII.GetBytes("V_MPEGH/ISO/HEVC")),
                El(0x63A2, Convert.FromHexString("01022000000090000000000096F000FCFDFAFA00000F"))));
        byte[] cluster = [0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, .. new byte[5000]];
        var cues = El(0x1C53BB6B,
            CuePoint(0, 1, 100), CuePoint(0, 2, 90), CuePoint(4000, 1, 2000), CuePoint(6000, 2, 3000), CuePoint(8000, 1, 4000));

        var filler = El(0xEC, new byte[16]);

        byte[] Layout(long infoAt, long tracksAt, long cuesAt, long secondAt)
        {
            var seekHead = nestedSeekHead
                ? El(0x114D9B74, Seek(0x1549A966, infoAt), Seek(0x1654AE6B, tracksAt), Seek(0x114D9B74, secondAt))
                : El(0x114D9B74, Seek(0x1549A966, infoAt), Seek(0x1654AE6B, tracksAt), Seek(0x1C53BB6B, cuesAt));
            var second = El(0x114D9B74, Seek(0x1C53BB6B, cuesAt));
            return [.. seekHead, .. filler, .. info, .. tracks, .. cluster, .. cues, .. second];
        }

        var draft = Layout(0, 0, 0, 0);
        var seekLength = El(0x114D9B74, Seek(0x1549A966, 0), Seek(0x1654AE6B, 0), Seek(0x1C53BB6B, 0)).Length;
        var infoAt = seekLength + filler.Length;
        var tracksAt = infoAt + info.Length;
        var cuesAt = tracksAt + tracks.Length + cluster.Length;
        var secondAt = cuesAt + cues.Length;
        var payload = Layout(infoAt, tracksAt, cuesAt, secondAt);
        Assert.Equal(draft.Length, payload.Length);

        var header = El(0x1A45DFA3, El(0x4282, Encoding.ASCII.GetBytes("matroska")));
        byte[] segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, .. payload];
        var file = header.Concat(segment).ToArray();
        Assert.Equal(SegmentStart, header.Length + 12);
        return file;
    }

    private static byte[] CuePoint(ulong time, ulong track, ulong position)
        => El(0xBB, UInt(0xB3, time), El(0xB7, UInt(0xF7, track), UInt(0xF1, position)));

    private static byte[] Seek(uint id, long position)
        => El(0x4DBB, El(0x53AB, IdBytes(id)), El(0x53AC, BitConverter.GetBytes((ulong)position).Reverse().ToArray()));

    private static byte[] UInt(uint id, ulong value)
    {
        var bytes = BitConverter.GetBytes(value).Reverse().SkipWhile(b => b == 0).ToArray();
        return El(id, bytes.Length == 0 ? [0] : bytes);
    }

    private static byte[] El(uint id, params byte[][] children)
    {
        var content = children.SelectMany(c => c).ToArray();
        var size = new byte[8];
        size[0] = 0x01;
        for (var i = 0; i < 7; i++)
            size[7 - i] = (byte)((long)content.Length >> (8 * i));
        return [.. IdBytes(id), .. size, .. content];
    }

    private static byte[] IdBytes(uint id) => BitConverter.GetBytes(id).Reverse().SkipWhile(b => b == 0).ToArray();
}
