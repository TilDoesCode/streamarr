using System.Globalization;
using System.Text;

namespace Streamarr.Server.Transcoding;

/// <summary>A video decoder configuration as stored by the container: avcC / hvcC / av1C records or Annex B parameter sets.</summary>
public sealed record VideoCodecConfig(string Format, byte[] Data)
{
    public const string AvcC = "avcC";
    public const string HvcC = "hvcC";
    public const string Av1C = "av1C";
    public const string AnnexB = "annexb";
}

/// <summary>RFC 6381 <c>CODECS</c> values for HLS, derived from the bitstream's configuration record where possible.</summary>
public static class CodecStrings
{
    public static string Video(SourceVideoStream video, VideoCodecConfig? config)
    {
        var derived = config is null ? null : video.Codec switch
        {
            "h264" => config.Format == VideoCodecConfig.AnnexB ? AvcFromAnnexB(config.Data) : AvcFromAvcC(config.Data),
            "hevc" => config.Format == VideoCodecConfig.AnnexB ? HevcFromAnnexB(config.Data) : HevcFromHvcC(config.Data),
            "av1" => config.Format == VideoCodecConfig.Av1C ? Av1FromAv1C(config.Data) : null,
            _ => null,
        };
        return derived ?? VideoFromProbe(video);
    }

    public static string? AvcFromAvcC(ReadOnlySpan<byte> avcC)
        => avcC.Length >= 4 && avcC[0] == 1 ? Avc(avcC[1], avcC[2], avcC[3]) : null;

    public static string? AvcFromAnnexB(ReadOnlySpan<byte> data)
    {
        var sps = FindNal(data, header => (header[0] & 0x1F) == 7, 1);
        return sps is { Length: >= 3 } ? Avc(sps[0], sps[1], sps[2]) : null;
    }

    /// <summary>ISO/IEC 14496-15 Annex E: profile space, profile, reversed compatibility flags, tier + level, constraint bytes.</summary>
    public static string? HevcFromHvcC(ReadOnlySpan<byte> hvcC)
        => hvcC.Length >= 13 && hvcC[0] == 1 ? Hevc(hvcC.Slice(1, 12)) : null;

    public static string? HevcFromAnnexB(ReadOnlySpan<byte> data)
    {
        var sps = FindNal(data, header => ((header[0] >> 1) & 0x3F) == 33, 2);
        return sps is { Length: >= 13 } ? Hevc(sps.AsSpan(1, 12)) : null;
    }

    public static string? Av1FromAv1C(ReadOnlySpan<byte> av1C)
    {
        if (av1C.Length < 4 || (av1C[0] & 0x80) == 0)
            return null;
        var profile = av1C[1] >> 5;
        var level = av1C[1] & 0x1F;
        var tier = (av1C[2] & 0x80) != 0 ? 'H' : 'M';
        var depth = (av1C[2] & 0x20) != 0 ? 12 : (av1C[2] & 0x40) != 0 ? 10 : 8;
        return string.Create(CultureInfo.InvariantCulture, $"av01.{profile}.{level:00}{tier}.{depth:00}");
    }

    /// <summary>Best effort when no configuration record is available (e.g. MPEG-TS without extradata).</summary>
    public static string VideoFromProbe(SourceVideoStream video)
    {
        switch (video.Codec)
        {
            case "h264":
                var (profile, constraints) = video.Profile switch
                {
                    "Constrained Baseline" => (66, 0x40),
                    "Baseline" => (66, 0x00),
                    "Main" => (77, 0x00),
                    "Extended" => (88, 0x00),
                    "High 10" or "High 10 Intra" => (110, 0x00),
                    "High 4:2:2" or "High 4:2:2 Intra" => (122, 0x00),
                    "High 4:4:4 Predictive" or "High 4:4:4 Intra" => (244, 0x00),
                    _ => (100, 0x00),
                };
                return Avc((byte)profile, (byte)constraints, (byte)Math.Clamp(video.Level ?? 40, 0, 255));
            case "hevc":
                var main10 = video.BitDepth > 8 || video.Profile == "Main 10";
                return string.Create(CultureInfo.InvariantCulture, $"hvc1.{(main10 ? "2.4" : "1.6")}.L{video.Level ?? 120}.B0");
            case "av1":
                var avProfile = video.Profile switch { "High" => 1, "Professional" => 2, _ => 0 };
                return string.Create(CultureInfo.InvariantCulture, $"av01.{avProfile}.{Math.Clamp(video.Level ?? 8, 0, 31):00}M.{video.BitDepth:00}");
            default:
                return video.Codec;
        }
    }

    public static string Audio(string codec, string? profile) => codec switch
    {
        "aac" => profile switch
        {
            "HE-AAC" => "mp4a.40.5",
            "HE-AACv2" => "mp4a.40.29",
            _ => "mp4a.40.2",
        },
        "ac3" => "ac-3",
        "eac3" => "ec-3",
        "flac" => "fLaC",
        "opus" => "Opus",
        _ => codec,
    };

    private static string Avc(byte profile, byte constraints, byte level)
        => string.Create(CultureInfo.InvariantCulture, $"avc1.{profile:x2}{constraints:x2}{level:x2}");

    private static string Hevc(ReadOnlySpan<byte> ptl)
    {
        var space = ptl[0] >> 6;
        var tier = (ptl[0] & 0x20) != 0 ? 'H' : 'L';
        var profile = ptl[0] & 0x1F;
        var compatibility = (uint)(ptl[1] << 24 | ptl[2] << 16 | ptl[3] << 8 | ptl[4]);
        uint reversed = 0;
        for (var i = 0; i < 32; i++)
            reversed |= ((compatibility >> i) & 1) << (31 - i);
        var constraints = ptl.Slice(5, 6);
        var last = 0;
        for (var i = 0; i < constraints.Length; i++)
        {
            if (constraints[i] != 0)
                last = i;
        }
        var builder = new StringBuilder("hvc1.");
        if (space > 0)
            builder.Append((char)('A' + space - 1));
        builder.Append(CultureInfo.InvariantCulture, $"{profile}.{reversed:X}.{tier}{ptl[11]}");
        for (var i = 0; i <= last; i++)
            builder.Append(CultureInfo.InvariantCulture, $".{constraints[i]:X2}");
        return builder.ToString();
    }

    /// <summary>First NAL unit matching <paramref name="match"/> after a start code, without its header and emulation-prevention bytes.</summary>
    private static byte[]? FindNal(ReadOnlySpan<byte> data, Func<byte[], bool> match, int headerLength)
    {
        for (var i = 0; i + 3 + headerLength < data.Length; i++)
        {
            if (data[i] != 0 || data[i + 1] != 0 || data[i + 2] != 1)
                continue;
            var start = i + 3;
            if (!match(data.Slice(start, headerLength).ToArray()))
                continue;
            var end = start + headerLength;
            while (end + 2 < data.Length && !(data[end] == 0 && data[end + 1] == 0 && data[end + 2] <= 1))
                end++;
            if (end + 2 >= data.Length)
                end = data.Length;
            return Unescape(data[(start + headerLength)..end]);
        }
        return null;
    }

    private static byte[] Unescape(ReadOnlySpan<byte> payload)
    {
        var output = new List<byte>(payload.Length);
        var zeros = 0;
        foreach (var b in payload)
        {
            if (zeros >= 2 && b == 3)
            {
                zeros = 0;
                continue;
            }
            zeros = b == 0 ? zeros + 1 : 0;
            output.Add(b);
        }
        return output.ToArray();
    }
}
