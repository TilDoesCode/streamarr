using System.Buffers.Binary;

namespace Streamarr.Server.Transcoding;

public sealed record Fmp4Track(uint TrackId, string Handler, uint Timescale, uint DefaultSampleDuration, uint DefaultSampleFlags, int Width = 0, int Height = 0);

public sealed record Fmp4Init(IReadOnlyList<Fmp4Track> Tracks)
{
    public Fmp4Track? Video => Tracks.FirstOrDefault(t => t.Handler == "vide");
    public Fmp4Track? Audio => Tracks.FirstOrDefault(t => t.Handler == "soun");
}

public sealed record Fmp4TrackFragment(
    uint TrackId,
    long BaseDecodeTime,
    long Duration,
    int SampleCount,
    bool StartsWithSyncSample,
    long FirstCompositionOffset,
    int SyncSamples);

public sealed record Fmp4TrackTiming(string Handler, double StartSeconds, double DurationSeconds, int Samples, bool StartsWithKeyframe, int Keyframes);

public sealed record Fmp4Segment(IReadOnlyList<Fmp4TrackFragment> Fragments)
{
    public IReadOnlyList<Fmp4TrackTiming> Timings(Fmp4Init init)
    {
        var result = new List<Fmp4TrackTiming>();
        foreach (var group in Fragments.GroupBy(f => f.TrackId))
        {
            var track = init.Tracks.FirstOrDefault(t => t.TrackId == group.Key);
            if (track is null || track.Timescale == 0)
                continue;
            var first = group.OrderBy(f => f.BaseDecodeTime).First();
            var scale = (double)track.Timescale;
            result.Add(new Fmp4TrackTiming(
                track.Handler,
                (first.BaseDecodeTime + first.FirstCompositionOffset) / scale,
                group.Sum(f => f.Duration) / scale,
                group.Sum(f => f.SampleCount),
                first.StartsWithSyncSample,
                group.Sum(f => f.SyncSamples)));
        }
        return result;
    }
}

/// <summary>Minimal ISO-BMFF reader for fragmented MP4 HLS output: timing, sync samples and edit-list normalization.</summary>
public static class Fmp4
{
    private const uint NonSyncSampleFlag = 0x0001_0000;

    public static Fmp4Init ParseInit(ReadOnlySpan<byte> data)
    {
        var tracks = new List<Fmp4Track>();
        var trex = new Dictionary<uint, (uint Duration, uint Flags)>();
        foreach (var (type, start, size, header) in Boxes(data, 0, data.Length))
        {
            if (type != "moov")
                continue;
            foreach (var (childType, childStart, childSize, childHeader) in Boxes(data, start + header, start + size))
            {
                if (childType == "trak")
                    tracks.Add(ParseTrack(data, childStart + childHeader, childStart + childSize));
                else if (childType == "mvex")
                {
                    foreach (var (t, s, z, h) in Boxes(data, childStart + childHeader, childStart + childSize))
                    {
                        if (t == "trex" && z >= h + 24)
                        {
                            var body = data.Slice(s + h + 4);
                            trex[BinaryPrimitives.ReadUInt32BigEndian(body)] =
                                (BinaryPrimitives.ReadUInt32BigEndian(body[8..]), BinaryPrimitives.ReadUInt32BigEndian(body[16..]));
                        }
                    }
                }
            }
        }
        return new Fmp4Init(tracks.Select(t => trex.TryGetValue(t.TrackId, out var d)
            ? t with { DefaultSampleDuration = d.Duration, DefaultSampleFlags = d.Flags }
            : t).ToList());
    }

    public static Fmp4Segment ParseSegment(ReadOnlySpan<byte> data, Fmp4Init init)
    {
        var fragments = new List<Fmp4TrackFragment>();
        foreach (var (type, start, size, header) in Boxes(data, 0, data.Length))
        {
            if (type != "moof")
                continue;
            foreach (var (t, s, z, h) in Boxes(data, start + header, start + size))
            {
                if (t == "traf")
                    fragments.Add(ParseTraf(data, s + h, s + z, init));
            }
        }
        return new Fmp4Segment(fragments);
    }

    /// <summary>Zeroes empty-edit durations so every restart's init segment presents the same timeline.</summary>
    public static byte[] NormalizeInit(byte[] data)
    {
        var copy = (byte[])data.Clone();
        ZeroEmptyEdits(copy, 0, copy.Length);
        return copy;
    }

    private static void ZeroEmptyEdits(byte[] data, int from, int to)
    {
        foreach (var (type, start, size, header) in Boxes(data, from, to))
        {
            if (type is "moov" or "trak" or "edts")
                ZeroEmptyEdits(data, start + header, start + size);
            else if (type == "elst")
            {
                var span = data.AsSpan(start + header, size - header);
                var version = span[0];
                var count = (int)BinaryPrimitives.ReadUInt32BigEndian(span[4..]);
                var entrySize = version == 1 ? 20 : 12;
                for (var i = 0; i < count && 8 + (i + 1) * entrySize <= span.Length; i++)
                {
                    var entry = span.Slice(8 + i * entrySize, entrySize);
                    var mediaTime = version == 1
                        ? BinaryPrimitives.ReadInt64BigEndian(entry[8..])
                        : BinaryPrimitives.ReadInt32BigEndian(entry[4..]);
                    if (mediaTime != -1)
                        continue;
                    if (version == 1)
                        BinaryPrimitives.WriteUInt64BigEndian(entry, 0);
                    else
                        BinaryPrimitives.WriteUInt32BigEndian(entry, 0);
                }
            }
        }
    }

    private static Fmp4Track ParseTrack(ReadOnlySpan<byte> data, int from, int to)
    {
        uint id = 0, timescale = 0;
        int width = 0, height = 0;
        var handler = "unknown";
        foreach (var (type, start, size, header) in Boxes(data, from, to))
        {
            if (type == "tkhd")
            {
                var body = data.Slice(start + header, size - header);
                id = BinaryPrimitives.ReadUInt32BigEndian(body[(body[0] == 1 ? 20 : 12)..]);
                if (body.Length >= 8)
                {
                    width = (int)(BinaryPrimitives.ReadUInt32BigEndian(body[^8..]) >> 16);
                    height = (int)(BinaryPrimitives.ReadUInt32BigEndian(body[^4..]) >> 16);
                }
            }
            else if (type == "mdia")
            {
                foreach (var (t, s, z, h) in Boxes(data, start + header, start + size))
                {
                    var body = data.Slice(s + h, z - h);
                    if (t == "mdhd")
                        timescale = BinaryPrimitives.ReadUInt32BigEndian(body[(body[0] == 1 ? 20 : 12)..]);
                    else if (t == "hdlr" && body.Length >= 12)
                        handler = System.Text.Encoding.ASCII.GetString(body.Slice(8, 4));
                }
            }
        }
        return new Fmp4Track(id, handler, timescale, 0, 0, width, height);
    }

    private static Fmp4TrackFragment ParseTraf(ReadOnlySpan<byte> data, int from, int to, Fmp4Init init)
    {
        uint trackId = 0;
        long baseTime = 0;
        uint? defaultDuration = null, defaultFlags = null;
        long duration = 0, firstCto = 0;
        int samples = 0, syncSamples = 0;
        bool? firstSync = null;

        foreach (var (type, start, size, header) in Boxes(data, from, to))
        {
            var body = data.Slice(start + header, size - header);
            if (type is not ("tfhd" or "tfdt" or "trun") || body.Length < 8)
                continue;
            var flags = BinaryPrimitives.ReadUInt32BigEndian(body) & 0x00FF_FFFF;
            if (type == "tfhd")
            {
                trackId = BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
                var offset = 8;
                if ((flags & 0x01) != 0) offset += 8;
                if ((flags & 0x02) != 0) offset += 4;
                if ((flags & 0x08) != 0) { defaultDuration = BinaryPrimitives.ReadUInt32BigEndian(body[offset..]); offset += 4; }
                if ((flags & 0x10) != 0) offset += 4;
                if ((flags & 0x20) != 0) defaultFlags = BinaryPrimitives.ReadUInt32BigEndian(body[offset..]);
            }
            else if (type == "tfdt")
            {
                baseTime = body[0] == 1
                    ? BinaryPrimitives.ReadInt64BigEndian(body[4..])
                    : BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
            }
            else if (type == "trun")
            {
                var track = init.Tracks.FirstOrDefault(t => t.TrackId == trackId);
                var sampleDuration = defaultDuration ?? track?.DefaultSampleDuration ?? 0;
                var sampleFlags = defaultFlags ?? track?.DefaultSampleFlags ?? 0;
                var count = (int)BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
                var offset = 8;
                if ((flags & 0x001) != 0) offset += 4;
                uint? firstFlags = null;
                if ((flags & 0x004) != 0) { firstFlags = BinaryPrimitives.ReadUInt32BigEndian(body[offset..]); offset += 4; }
                var perSample = 4 * (((flags & 0x100) != 0 ? 1 : 0) + ((flags & 0x200) != 0 ? 1 : 0) + ((flags & 0x400) != 0 ? 1 : 0) + ((flags & 0x800) != 0 ? 1 : 0));
                for (var i = 0; i < count && offset + perSample <= body.Length; i++)
                {
                    var d = sampleDuration;
                    var f = i == 0 && firstFlags is { } ff ? ff : sampleFlags;
                    long cto = 0;
                    if ((flags & 0x100) != 0) { d = BinaryPrimitives.ReadUInt32BigEndian(body[offset..]); offset += 4; }
                    if ((flags & 0x200) != 0) offset += 4;
                    if ((flags & 0x400) != 0) { f = BinaryPrimitives.ReadUInt32BigEndian(body[offset..]); offset += 4; }
                    if ((flags & 0x800) != 0)
                    {
                        cto = body[0] == 1 ? BinaryPrimitives.ReadInt32BigEndian(body[offset..]) : BinaryPrimitives.ReadUInt32BigEndian(body[offset..]);
                        offset += 4;
                    }
                    var sync = (f & NonSyncSampleFlag) == 0;
                    if (samples == 0)
                    {
                        firstSync = sync;
                        firstCto = cto;
                    }
                    if (sync)
                        syncSamples++;
                    duration += d;
                    samples++;
                }
            }
        }

        return new Fmp4TrackFragment(trackId, baseTime, duration, samples, firstSync ?? false, firstCto, syncSamples);
    }

    private static List<(string Type, int Start, int Size, int Header)> Boxes(ReadOnlySpan<byte> data, int from, int to)
    {
        var boxes = new List<(string, int, int, int)>();
        var offset = from;
        while (offset + 8 <= to)
        {
            long size = BinaryPrimitives.ReadUInt32BigEndian(data[offset..]);
            var type = System.Text.Encoding.ASCII.GetString(data.Slice(offset + 4, 4));
            var header = 8;
            if (size == 1)
            {
                if (offset + 16 > to)
                    break;
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(data[(offset + 8)..]);
                header = 16;
            }
            else if (size == 0)
            {
                size = to - offset;
            }
            if (size < header || offset + size > to)
                break;
            boxes.Add((type, offset, (int)size, header));
            offset += (int)size;
        }
        return boxes;
    }
}
