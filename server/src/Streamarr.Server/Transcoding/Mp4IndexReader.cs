using System.Buffers.Binary;
using System.Text;

namespace Streamarr.Server.Transcoding;

/// <summary>Reads the first video track's keyframe presentation times from an MP4/MOV sample table (stss, stts, ctts, elst).</summary>
public static class Mp4IndexReader
{
    private const int MaxMoovBytes = 64 * 1024 * 1024;
    private const int MaxTopLevelBoxes = 256;

    public static async Task<ContainerIndex?> ReadAsync(IRangeSource source, CancellationToken ct)
    {
        long offset = 0;
        for (var i = 0; i < MaxTopLevelBoxes && offset + 8 <= source.Length; i++)
        {
            var header = await source.ReadAsync(offset, (int)Math.Min(16, source.Length - offset), ct);
            long size = BinaryPrimitives.ReadUInt32BigEndian(header);
            var type = Encoding.ASCII.GetString(header, 4, 4);
            if (size == 1 && header.Length >= 16)
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
            else if (size == 0)
                size = source.Length - offset;
            if (size < 8 || offset + size > source.Length)
                return null;
            if (type == "moov")
            {
                if (size > MaxMoovBytes)
                    return null;
                return Parse(await source.ReadAsync(offset, (int)size, ct)) is { } index ? index with { TotalBytes = source.Length } : null;
            }
            offset += size;
        }
        return null;
    }

    public static ContainerIndex? Parse(byte[] moovBox)
    {
        var moov = Box.Children(moovBox, 8, moovBox.Length);
        uint movieTimescale = 1000;
        foreach (var box in moov)
        {
            if (box.Type == "mvhd")
            {
                var body = box.Body(moovBox);
                movieTimescale = BinaryPrimitives.ReadUInt32BigEndian(body[(body[0] == 1 ? 20 : 12)..]);
            }
        }
        foreach (var trak in moov.Where(b => b.Type == "trak"))
        {
            var track = ParseTrack(moovBox, trak, movieTimescale);
            if (track is not null)
                return track;
        }
        return null;
    }

    private static ContainerIndex? ParseTrack(byte[] data, Box trak, uint movieTimescale)
    {
        var children = trak.Children(data);
        var mdia = children.FirstOrDefault(b => b.Type == "mdia");
        if (mdia.Type is null)
            return null;
        var mdiaChildren = mdia.Children(data);
        var hdlr = mdiaChildren.FirstOrDefault(b => b.Type == "hdlr");
        if (hdlr.Type is null || Encoding.ASCII.GetString(hdlr.Body(data).Slice(8, 4)) != "vide")
            return null;
        var mdhd = mdiaChildren.First(b => b.Type == "mdhd").Body(data);
        var timescale = BinaryPrimitives.ReadUInt32BigEndian(mdhd[(mdhd[0] == 1 ? 20 : 12)..]);
        var stbl = mdiaChildren.FirstOrDefault(b => b.Type == "minf").Children(data).FirstOrDefault(b => b.Type == "stbl");
        if (timescale == 0 || stbl.Type is null)
            return null;
        var tables = stbl.Children(data).GroupBy(b => b.Type, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        if (!tables.TryGetValue("stts", out var stts))
            return null;

        var durations = Runs(stts.Body(data));
        long sampleCount = durations.Sum(r => (long)r.Count);
        if (sampleCount is 0 or > 20_000_000)
            return null;
        var offsets = tables.TryGetValue("ctts", out var ctts) ? Runs(ctts.Body(data)) : [];
        HashSet<long>? sync = null;
        if (tables.TryGetValue("stss", out var stss))
        {
            var body = stss.Body(data);
            var count = BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
            if (count > KeyframeIndexService.MaxKeyframes)
                return null;
            sync = new HashSet<long>();
            for (var i = 0; i < count && 8 + i * 4 + 4 <= body.Length; i++)
                sync.Add(BinaryPrimitives.ReadUInt32BigEndian(body[(8 + i * 4)..]));
        }
        if (sync is null && sampleCount > KeyframeIndexService.MaxKeyframes)
            return null;
        var sizes = tables.TryGetValue("stsz", out var stsz) ? SampleSizes(stsz.Body(data)) : null;

        var (mediaTime, emptyEdit) = EditList(data, children, movieTimescale);
        var shift = emptyEdit - mediaTime / (double)timescale;
        var keyframes = new List<double>();
        var bytes = new List<long>();
        long dts = 0, cumulative = 0, sample = 0;
        var ctsRun = 0;
        long ctsLeft = offsets.Count > 0 ? offsets[0].Count : 0;
        foreach (var (count, delta) in durations)
        {
            for (long i = 0; i < count; i++, sample++)
            {
                long cto = 0;
                if (ctsRun < offsets.Count)
                {
                    cto = (int)offsets[ctsRun].Value;
                    if (--ctsLeft == 0 && ++ctsRun < offsets.Count)
                        ctsLeft = offsets[ctsRun].Count;
                }
                if (sync is null || sync.Contains(sample + 1))
                {
                    keyframes.Add((dts + cto) / (double)timescale + shift);
                    bytes.Add(cumulative);
                }
                cumulative += sizes is null ? 0 : sizes(sample);
                dts += delta;
            }
        }
        if (keyframes.Count == 0)
            return null;

        var order = Enumerable.Range(0, keyframes.Count).OrderBy(i => keyframes[i]).ToList();
        return new ContainerIndex(
            KeyframeIndexSource.Mp4SampleTable,
            order.Select(i => keyframes[i]).ToList(),
            sizes is null ? null : order.Select(i => bytes[i]).ToList(),
            false,
            tables.TryGetValue("stsd", out var stsd) ? CodecConfig(data, stsd) : null);
    }

    private static (long MediaTime, double EmptyEditSeconds) EditList(byte[] data, List<Box> trakChildren, uint movieTimescale)
    {
        var edts = trakChildren.FirstOrDefault(b => b.Type == "edts");
        var elst = edts.Type is null ? default : edts.Children(data).FirstOrDefault(b => b.Type == "elst");
        if (elst.Type is null)
            return (0, 0);
        var body = elst.Body(data);
        var wide = body[0] == 1;
        var count = BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
        double empty = 0;
        for (var i = 0; i < count; i++)
        {
            var entry = body[(8 + i * (wide ? 20 : 12))..];
            var duration = wide ? (long)BinaryPrimitives.ReadUInt64BigEndian(entry) : BinaryPrimitives.ReadUInt32BigEndian(entry);
            var mediaTime = wide ? BinaryPrimitives.ReadInt64BigEndian(entry[8..]) : BinaryPrimitives.ReadInt32BigEndian(entry[4..]);
            if (mediaTime == -1)
            {
                empty += duration / (double)Math.Max(1, movieTimescale);
                continue;
            }
            return (mediaTime, empty);
        }
        return (0, empty);
    }

    private static VideoCodecConfig? CodecConfig(byte[] data, Box stsd)
    {
        var entries = Box.Children(data, stsd.Start + stsd.Header + 8, stsd.Start + stsd.Size);
        if (entries.Count == 0)
            return null;
        var entry = entries[0];
        var format = entry.Type switch
        {
            "avc1" or "avc3" => VideoCodecConfig.AvcC,
            "hvc1" or "hev1" or "dvh1" or "dvhe" => VideoCodecConfig.HvcC,
            "av01" => VideoCodecConfig.Av1C,
            _ => null,
        };
        if (format is null || entry.Size < entry.Header + 78)
            return null;
        var config = Box.Children(data, entry.Start + entry.Header + 78, entry.Start + entry.Size).FirstOrDefault(b => b.Type == format);
        return config.Type is null ? null : new VideoCodecConfig(format, config.Body(data).ToArray());
    }

    private static List<(uint Count, uint Value)> Runs(ReadOnlySpan<byte> body)
    {
        var count = BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
        var runs = new List<(uint, uint)>((int)Math.Min(count, 1_000_000));
        for (var i = 0; i < count && 8 + i * 8 + 8 <= body.Length; i++)
            runs.Add((BinaryPrimitives.ReadUInt32BigEndian(body[(8 + i * 8)..]), BinaryPrimitives.ReadUInt32BigEndian(body[(12 + i * 8)..])));
        return runs;
    }

    private static Func<long, long>? SampleSizes(ReadOnlySpan<byte> body)
    {
        var constant = BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
        if (constant != 0)
            return _ => constant;
        var count = BinaryPrimitives.ReadUInt32BigEndian(body[8..]);
        var table = new uint[Math.Min(count, (uint)Math.Max(0, (body.Length - 12) / 4))];
        for (var i = 0; i < table.Length; i++)
            table[i] = BinaryPrimitives.ReadUInt32BigEndian(body[(12 + i * 4)..]);
        return index => index < table.Length ? table[index] : 0;
    }

    private readonly record struct Box(string Type, int Start, int Size, int Header)
    {
        public ReadOnlySpan<byte> Body(byte[] data) => data.AsSpan(Start + Header, Size - Header);

        public List<Box> Children(byte[] data) => Children(data, Start + Header, Start + Size);

        public static List<Box> Children(byte[] data, int from, int to)
        {
            var boxes = new List<Box>();
            var offset = from;
            while (offset + 8 <= to)
            {
                long size = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(offset));
                var header = 8;
                if (size == 1)
                {
                    if (offset + 16 > to)
                        break;
                    size = (long)BinaryPrimitives.ReadUInt64BigEndian(data.AsSpan(offset + 8));
                    header = 16;
                }
                else if (size == 0)
                {
                    size = to - offset;
                }
                if (size < header || offset + size > to)
                    break;
                boxes.Add(new Box(Encoding.ASCII.GetString(data, offset + 4, 4), offset, (int)size, header));
                offset += (int)size;
            }
            return boxes;
        }
    }
}
