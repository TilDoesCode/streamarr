using System.Text;

namespace Streamarr.Server.Transcoding;

/// <summary>Reads the first video track's keyframes from Matroska <c>Cues</c> with a handful of range reads (header, SeekHead, Cues).</summary>
public static class MatroskaIndexReader
{
    private const uint EbmlId = 0x1A45DFA3;
    private const uint SegmentId = 0x18538067;
    private const uint SeekHeadId = 0x114D9B74;
    private const uint SeekId = 0x4DBB;
    private const uint SeekIdId = 0x53AB;
    private const uint SeekPositionId = 0x53AC;
    private const uint InfoId = 0x1549A966;
    private const uint TimecodeScaleId = 0x2AD7B1;
    private const uint TracksId = 0x1654AE6B;
    private const uint TrackEntryId = 0xAE;
    private const uint TrackNumberId = 0xD7;
    private const uint TrackTypeId = 0x83;
    private const uint CodecIdId = 0x86;
    private const uint CodecPrivateId = 0x63A2;
    private const uint ClusterId = 0x1F43B675;
    private const uint CuesId = 0x1C53BB6B;
    private const uint CuePointId = 0xBB;
    private const uint CueTimeId = 0xB3;
    private const uint CueTrackPositionsId = 0xB7;
    private const uint CueTrackId = 0xF7;
    private const uint CueClusterPositionId = 0xF1;
    private const int HeadBytes = 64 * 1024;
    private const int MaxElementBytes = 32 * 1024 * 1024;

    public static async Task<ContainerIndex?> ReadAsync(IRangeSource source, CancellationToken ct)
    {
        var head = await source.ReadAsync(0, (int)Math.Min(HeadBytes, source.Length), ct);
        var offset = 0;
        if (!TryHeader(head, ref offset, out var id, out var size, out _) || id != EbmlId)
            return null;
        offset += (int)size;
        if (!TryHeader(head, ref offset, out id, out _, out _) || id != SegmentId)
            return null;
        long segmentStart = offset;

        var seeks = new Dictionary<uint, long>();
        byte[]? info = null, tracks = null;
        while (offset < head.Length)
        {
            var elementStart = offset;
            if (!TryHeader(head, ref offset, out id, out size, out var unknown) || id == ClusterId || unknown)
                break;
            var body = offset + size <= head.Length
                ? head.AsSpan(offset, (int)size).ToArray()
                : id is SeekHeadId or InfoId or TracksId ? await ReadBodyAsync(source, elementStart, ct) : null;
            switch (id)
            {
                case SeekHeadId when body is not null:
                    ParseSeekHead(body, seeks);
                    break;
                case InfoId:
                    info = body;
                    break;
                case TracksId:
                    tracks = body;
                    break;
            }
            offset += (int)Math.Min(size, int.MaxValue - offset);
            if (offset < elementStart)
                break;
        }

        if (!seeks.ContainsKey(CuesId) && seeks.TryGetValue(SeekHeadId, out var nested)
            && await ReadBodyAsync(source, segmentStart + nested, ct) is { } nestedBody)
        {
            ParseSeekHead(nestedBody, seeks);
        }
        if (info is null && seeks.TryGetValue(InfoId, out var infoPosition))
            info = await ReadBodyAsync(source, segmentStart + infoPosition, ct);
        if (tracks is null && seeks.TryGetValue(TracksId, out var tracksPosition))
            tracks = await ReadBodyAsync(source, segmentStart + tracksPosition, ct);
        if (tracks is null || !seeks.TryGetValue(CuesId, out var cuesPosition))
            return null;

        var timecodeScale = 1_000_000UL;
        if (info is not null)
        {
            foreach (var (childId, start, length) in Children(info))
            {
                if (childId == TimecodeScaleId)
                    timecodeScale = Math.Max(1, ReadUInt(info.AsSpan(start, length)));
            }
        }

        var video = FirstVideoTrack(tracks);
        if (video is null)
            return null;
        var cues = await ReadBodyAsync(source, segmentStart + cuesPosition, ct);
        if (cues is null)
            return null;

        var points = new SortedDictionary<long, long>();
        foreach (var (pointId, pointStart, pointLength) in Children(cues))
        {
            if (pointId != CuePointId)
                continue;
            var point = cues.AsSpan(pointStart, pointLength).ToArray();
            ulong? time = null;
            long? position = null;
            foreach (var (childId, start, length) in Children(point))
            {
                if (childId == CueTimeId)
                    time = ReadUInt(point.AsSpan(start, length));
                else if (childId == CueTrackPositionsId && ParseTrackPosition(point.AsSpan(start, length).ToArray(), video.Value.Number) is { } p)
                    position = p;
            }
            if (time is { } t && position is { } pos)
                points.TryAdd((long)t, segmentStart + pos);
            if (points.Count > KeyframeIndexService.MaxKeyframes)
                return null;
        }
        if (points.Count == 0)
            return null;

        var keyframes = points.Keys.Select(t => t * (double)timecodeScale / 1e9).ToList();
        var offsets = points.Values.ToList();
        return new ContainerIndex(KeyframeIndexSource.MatroskaCues, keyframes, IsMonotonic(offsets) ? offsets : null, true, video.Value.Config, source.Length);
    }

    private static (ulong Number, VideoCodecConfig? Config)? FirstVideoTrack(byte[] tracks)
    {
        foreach (var (entryId, entryStart, entryLength) in Children(tracks))
        {
            if (entryId != TrackEntryId)
                continue;
            var entry = tracks.AsSpan(entryStart, entryLength).ToArray();
            ulong number = 0, type = 0;
            string? codec = null;
            byte[]? codecPrivate = null;
            foreach (var (childId, start, length) in Children(entry))
            {
                switch (childId)
                {
                    case TrackNumberId:
                        number = ReadUInt(entry.AsSpan(start, length));
                        break;
                    case TrackTypeId:
                        type = ReadUInt(entry.AsSpan(start, length));
                        break;
                    case CodecIdId:
                        codec = Encoding.ASCII.GetString(entry, start, length).TrimEnd('\0');
                        break;
                    case CodecPrivateId:
                        codecPrivate = entry.AsSpan(start, length).ToArray();
                        break;
                }
            }
            if (type != 1)
                continue;
            var format = codec switch
            {
                "V_MPEG4/ISO/AVC" => VideoCodecConfig.AvcC,
                "V_MPEGH/ISO/HEVC" => VideoCodecConfig.HvcC,
                "V_AV1" => VideoCodecConfig.Av1C,
                _ => null,
            };
            return (number, format is not null && codecPrivate is { Length: > 0 } ? new VideoCodecConfig(format, codecPrivate) : null);
        }
        return null;
    }

    private static long? ParseTrackPosition(byte[] positions, ulong track)
    {
        ulong? cueTrack = null;
        long? cluster = null;
        foreach (var (childId, start, length) in Children(positions))
        {
            if (childId == CueTrackId)
                cueTrack = ReadUInt(positions.AsSpan(start, length));
            else if (childId == CueClusterPositionId)
                cluster = (long)ReadUInt(positions.AsSpan(start, length));
        }
        return cueTrack == track ? cluster : null;
    }

    private static void ParseSeekHead(byte[] body, Dictionary<uint, long> seeks)
    {
        foreach (var (seekId, seekStart, seekLength) in Children(body))
        {
            if (seekId != SeekId)
                continue;
            var seek = body.AsSpan(seekStart, seekLength).ToArray();
            uint? target = null;
            long? position = null;
            foreach (var (childId, start, length) in Children(seek))
            {
                if (childId == SeekIdId && length is > 0 and <= 4)
                    target = (uint)ReadUInt(seek.AsSpan(start, length));
                else if (childId == SeekPositionId)
                    position = (long)ReadUInt(seek.AsSpan(start, length));
            }
            if (target is { } t && position is { } p)
                seeks.TryAdd(t, p);
        }
    }

    private static async Task<byte[]?> ReadBodyAsync(IRangeSource source, long elementOffset, CancellationToken ct)
    {
        if (elementOffset < 0 || elementOffset >= source.Length)
            return null;
        var header = await source.ReadAsync(elementOffset, (int)Math.Min(12, source.Length - elementOffset), ct);
        var offset = 0;
        if (!TryHeader(header, ref offset, out _, out var size, out var unknown) || unknown || size > MaxElementBytes
            || elementOffset + offset + size > source.Length)
        {
            return null;
        }
        return await source.ReadAsync(elementOffset + offset, (int)size, ct);
    }

    internal static IEnumerable<(uint Id, int Start, int Length)> Children(byte[] body)
    {
        var offset = 0;
        while (offset < body.Length)
        {
            if (!TryHeader(body, ref offset, out var id, out var size, out var unknown) || unknown || offset + size > body.Length)
                yield break;
            yield return (id, offset, (int)size);
            offset += (int)size;
        }
    }

    internal static bool TryHeader(ReadOnlySpan<byte> data, ref int offset, out uint id, out long size, out bool unknown)
    {
        id = 0;
        size = 0;
        unknown = false;
        if (offset >= data.Length)
            return false;
        var idLength = VintLength(data[offset]);
        if (idLength is 0 or > 4 || offset + idLength > data.Length)
            return false;
        for (var i = 0; i < idLength; i++)
            id = id << 8 | data[offset + i];
        var sizeOffset = offset + idLength;
        if (sizeOffset >= data.Length)
            return false;
        var sizeLength = VintLength(data[sizeOffset]);
        if (sizeLength == 0 || sizeOffset + sizeLength > data.Length)
            return false;
        ulong value = (ulong)(data[sizeOffset] & (0xFF >> sizeLength));
        var allOnes = value == (ulong)(0xFF >> sizeLength);
        for (var i = 1; i < sizeLength; i++)
        {
            value = value << 8 | data[sizeOffset + i];
            allOnes &= data[sizeOffset + i] == 0xFF;
        }
        unknown = allOnes;
        if (!unknown && value > long.MaxValue / 2)
            return false;
        size = unknown ? 0 : (long)value;
        offset = sizeOffset + sizeLength;
        return true;
    }

    private static int VintLength(byte first)
    {
        for (var i = 0; i < 8; i++)
        {
            if ((first & (0x80 >> i)) != 0)
                return i + 1;
        }
        return 0;
    }

    private static ulong ReadUInt(ReadOnlySpan<byte> data)
    {
        ulong value = 0;
        foreach (var b in data[..Math.Min(8, data.Length)])
            value = value << 8 | b;
        return value;
    }

    private static bool IsMonotonic(List<long> values)
    {
        for (var i = 1; i < values.Count; i++)
        {
            if (values[i] < values[i - 1])
                return false;
        }
        return true;
    }
}
