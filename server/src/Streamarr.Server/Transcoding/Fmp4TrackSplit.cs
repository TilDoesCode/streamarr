using System.Buffers.Binary;
using System.Text;

namespace Streamarr.Server.Transcoding;

/// <summary>Extracts one track of a multi-track fMP4 init or media segment, so a muxed session can serve demuxed HLS renditions with identical boundaries.</summary>
public static class Fmp4TrackSplit
{
    private const uint BaseDataOffsetPresent = 0x01;
    private const uint DefaultBaseIsMoof = 0x02_0000;
    private const uint DataOffsetPresent = 0x01;
    private const uint FirstSampleFlagsPresent = 0x04;
    private const uint SampleDurationPresent = 0x100;
    private const uint SampleSizePresent = 0x200;
    private const uint SampleFlagsPresent = 0x400;
    private const uint SampleCtoPresent = 0x800;

    /// <summary>ftyp + a moov holding only <paramref name="trackId"/>'s trak and trex.</summary>
    public static byte[] Init(ReadOnlySpan<byte> data, uint trackId)
    {
        var output = new List<byte[]>();
        foreach (var (type, start, size, header) in Boxes(data, 0, data.Length))
        {
            if (type != "moov")
            {
                output.Add(data.Slice(start, size).ToArray());
                continue;
            }
            var children = new List<byte[]>();
            foreach (var (t, s, z, h) in Boxes(data, start + header, start + size))
            {
                if (t == "trak" && TrakId(data, s + h, s + z) != trackId)
                    continue;
                if (t == "mvex")
                {
                    var mvex = new List<byte[]>();
                    foreach (var c in Boxes(data, s + h, s + z))
                    {
                        if (c.Type != "trex" || BinaryPrimitives.ReadUInt32BigEndian(data[(c.Start + c.Header + 4)..]) == trackId)
                            mvex.Add(data.Slice(c.Start, c.Size).ToArray());
                    }
                    children.Add(Box("mvex", mvex));
                    continue;
                }
                children.Add(data.Slice(s, z).ToArray());
            }
            output.Add(Box("moov", children));
        }
        return Concat(output);
    }

    /// <summary>A literal box (<see cref="Bytes"/>) or a byte range of the muxed segment to copy.</summary>
    public readonly record struct Part(byte[]? Bytes, long Offset, long Length)
    {
        public long Size => Bytes?.Length ?? Length;
    }

    /// <summary>Every moof/mdat pair reduced to <paramref name="trackId"/>'s traf and sample data (offsets relative to the new moof).</summary>
    public static byte[] Segment(byte[] data, uint trackId)
    {
        using var source = new MemoryStream(data, writable: false);
        using var output = new MemoryStream();
        CopyAsync(source, PlanAsync(source, trackId, CancellationToken.None).GetAwaiter().GetResult(), output, CancellationToken.None).GetAwaiter().GetResult();
        return output.ToArray();
    }

    /// <summary>Reads only the moof boxes of a seekable muxed segment and plans the single-track output.</summary>
    public static async Task<IReadOnlyList<Part>> PlanAsync(Stream source, uint trackId, CancellationToken ct)
    {
        var parts = new List<Part>();
        var header = new byte[16];
        long position = 0;
        var length = source.Length;
        while (position + 8 <= length)
        {
            source.Position = position;
            await source.ReadExactlyAsync(header.AsMemory(0, 8), ct);
            long size = BinaryPrimitives.ReadUInt32BigEndian(header);
            var type = Encoding.ASCII.GetString(header, 4, 4);
            if (size == 1)
            {
                await source.ReadExactlyAsync(header.AsMemory(8, 8), ct);
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
            }
            else if (size == 0)
            {
                size = length - position;
            }
            if (size < 8 || position + size > length)
                throw new InvalidDataException($"Truncated '{type}' box in a muxed segment.");
            if (type is "styp" or "moof")
            {
                var box = new byte[size];
                source.Position = position;
                await source.ReadExactlyAsync(box, ct);
                if (type == "styp")
                    parts.Add(new Part(box, 0, 0));
                else
                    PlanFragment(box, position, length, trackId, parts);
            }
            position += size;
        }
        return parts;
    }

    public static async Task CopyAsync(Stream source, IReadOnlyList<Part> parts, Stream destination, CancellationToken ct)
    {
        var buffer = new byte[81920];
        foreach (var part in parts)
        {
            if (part.Bytes is { } bytes)
            {
                await destination.WriteAsync(bytes, ct);
                continue;
            }
            source.Position = part.Offset;
            for (var left = part.Length; left > 0;)
            {
                var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, left)), ct);
                if (read == 0)
                    throw new EndOfStreamException("The muxed segment ended inside a sample range.");
                await destination.WriteAsync(buffer.AsMemory(0, read), ct);
                left -= read;
            }
        }
    }

    private static void PlanFragment(byte[] moofBox, long moofOffset, long fileLength, uint trackId, List<Part> parts)
    {
        var data = moofBox.AsSpan();
        var header = BinaryPrimitives.ReadUInt32BigEndian(data) == 1 ? 16 : 8;
        var children = new List<byte[]>();
        var runs = new List<(int Start, int Length)>();
        var trafEnd = 0;
        foreach (var (t, s, z, h) in Boxes(data, header, data.Length))
        {
            if (t != "traf")
            {
                if (t == "mfhd")
                    children.Add(data.Slice(s, z).ToArray());
                continue;
            }
            var traf = ReadTraf(data, s + h, s + z, 0, ref trafEnd);
            if (traf.TrackId != trackId)
                continue;
            var trafChildren = new List<byte[]>();
            foreach (var child in traf.Children)
            {
                trafChildren.Add(child.Box);
                if (child.Run is { } run)
                    runs.Add((run.DataStart, run.DataLength));
            }
            children.Add(Box("traf", trafChildren));
        }
        if (runs.Count == 0)
            return;
        var moof = Box("moof", children);
        var cursor = moof.Length + 8;
        var ranges = new List<Part>();
        var trunIndex = 0;
        foreach (var position in TrunDataOffsets(moof))
        {
            var (start, length) = runs[trunIndex++];
            if (start < moofBox.Length || moofOffset + start + length > fileLength)
                throw new InvalidDataException("A trun points outside its fragment's mdat.");
            BinaryPrimitives.WriteInt32BigEndian(moof.AsSpan(position), cursor);
            ranges.Add(new Part(null, moofOffset + start, length));
            cursor += length;
        }
        var mdatHeader = new byte[8];
        BinaryPrimitives.WriteUInt32BigEndian(mdatHeader, (uint)(8 + ranges.Sum(r => r.Length)));
        "mdat"u8.CopyTo(mdatHeader.AsSpan(4));
        parts.Add(new Part(moof, 0, 0));
        parts.Add(new Part(mdatHeader, 0, 0));
        parts.AddRange(ranges);
    }

    private sealed record TrunCopy(byte[] Box, int DataStart, int DataLength);

    private sealed record TrafChild(byte[] Box, TrunCopy? Run);

    private sealed record TrafCopy(uint TrackId, List<TrafChild> Children);

    private static TrafCopy ReadTraf(ReadOnlySpan<byte> data, int from, int to, int moofStart, ref int previousDataEnd)
    {
        uint trackId = 0;
        uint defaultSize = 0;
        long baseOffset = moofStart;
        var children = new List<TrafChild>();
        int? next = null;
        foreach (var (type, start, size, header) in Boxes(data, from, to))
        {
            var body = data.Slice(start + header, size - header);
            if (type == "tfhd")
            {
                var flags = BinaryPrimitives.ReadUInt32BigEndian(body) & 0x00FF_FFFF;
                trackId = BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
                var offset = 8;
                // An absolute base offset points into the original file, which a stored segment no longer knows.
                if ((flags & BaseDataOffsetPresent) != 0)
                    throw new InvalidDataException("Track fragments with an explicit base_data_offset cannot be split; write them with default-base-is-moof.");
                if ((flags & DefaultBaseIsMoof) == 0 && previousDataEnd > moofStart)
                    baseOffset = previousDataEnd;
                if ((flags & 0x02) != 0) offset += 4;
                if ((flags & 0x08) != 0) offset += 4;
                if ((flags & 0x10) != 0) defaultSize = BinaryPrimitives.ReadUInt32BigEndian(body[offset..]);
                var newBody = body.ToArray();
                BinaryPrimitives.WriteUInt32BigEndian(newBody, (uint)(body[0] << 24) | flags | DefaultBaseIsMoof);
                children.Add(new TrafChild(Box("tfhd", [newBody]), null));
            }
            else if (type == "trun")
            {
                var flags = BinaryPrimitives.ReadUInt32BigEndian(body) & 0x00FF_FFFF;
                var count = (int)BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
                var offset = 8;
                var dataStart = next ?? (int)baseOffset;
                if ((flags & DataOffsetPresent) != 0)
                {
                    dataStart = (int)(baseOffset + BinaryPrimitives.ReadInt32BigEndian(body[offset..]));
                    offset += 4;
                }
                var afterOffset = offset;
                if ((flags & FirstSampleFlagsPresent) != 0) offset += 4;
                var length = 0L;
                for (var i = 0; i < count; i++)
                {
                    if ((flags & SampleDurationPresent) != 0) offset += 4;
                    if ((flags & SampleSizePresent) != 0)
                    {
                        length += BinaryPrimitives.ReadUInt32BigEndian(body[offset..]);
                        offset += 4;
                    }
                    else
                    {
                        length += defaultSize;
                    }
                    if ((flags & SampleFlagsPresent) != 0) offset += 4;
                    if ((flags & SampleCtoPresent) != 0) offset += 4;
                }
                var tail = body[afterOffset..];
                var newBody = new byte[12 + tail.Length];
                BinaryPrimitives.WriteUInt32BigEndian(newBody, (uint)(body[0] << 24) | flags | DataOffsetPresent);
                BinaryPrimitives.WriteInt32BigEndian(newBody.AsSpan(4), count);
                tail.CopyTo(newBody.AsSpan(12));
                var trun = Box("trun", [newBody]);
                children.Add(new TrafChild(trun, new TrunCopy(trun, dataStart, (int)length)));
                next = dataStart + (int)length;
                previousDataEnd = next.Value;
            }
            else
            {
                children.Add(new TrafChild(data.Slice(start, size).ToArray(), null));
            }
        }
        return new TrafCopy(trackId, children);
    }

    /// <summary>Positions of every trun's data_offset field inside a built moof, in order.</summary>
    private static IEnumerable<int> TrunDataOffsets(byte[] moof)
    {
        var result = new List<int>();
        foreach (var (_, start, size, header) in Boxes(moof, 0, moof.Length))
        {
            foreach (var (t, s, z, h) in Boxes(moof, start + header, start + size))
            {
                if (t != "traf")
                    continue;
                foreach (var (bt, bs, _, bh) in Boxes(moof, s + h, s + z))
                {
                    if (bt == "trun")
                        result.Add(bs + bh + 8);
                }
            }
        }
        return result;
    }

    private static uint TrakId(ReadOnlySpan<byte> data, int from, int to)
    {
        foreach (var (type, start, _, header) in Boxes(data, from, to))
        {
            if (type != "tkhd")
                continue;
            var body = data[(start + header)..];
            return BinaryPrimitives.ReadUInt32BigEndian(body[(body[0] == 1 ? 20 : 12)..]);
        }
        return 0;
    }

    private static byte[] Box(string type, IEnumerable<byte[]> children)
    {
        var parts = children.ToList();
        var size = 8 + parts.Sum(p => p.Length);
        var box = new byte[size];
        BinaryPrimitives.WriteUInt32BigEndian(box, (uint)size);
        Encoding.ASCII.GetBytes(type, box.AsSpan(4));
        var offset = 8;
        foreach (var part in parts)
        {
            part.CopyTo(box, offset);
            offset += part.Length;
        }
        return box;
    }

    private static byte[] Concat(List<byte[]> parts)
    {
        var result = new byte[parts.Sum(p => p.Length)];
        var offset = 0;
        foreach (var part in parts)
        {
            part.CopyTo(result, offset);
            offset += part.Length;
        }
        return result;
    }

    private static List<(string Type, int Start, int Size, int Header)> Boxes(ReadOnlySpan<byte> data, int from, int to)
    {
        var boxes = new List<(string, int, int, int)>();
        var offset = from;
        while (offset + 8 <= to)
        {
            long size = BinaryPrimitives.ReadUInt32BigEndian(data[offset..]);
            var type = Encoding.ASCII.GetString(data.Slice(offset + 4, 4));
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
