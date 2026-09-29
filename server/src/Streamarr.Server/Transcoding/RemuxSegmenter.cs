using System.Buffers.Binary;
using System.Text;

namespace Streamarr.Server.Transcoding;

/// <summary>Splits ffmpeg's fMP4 stdout (one fragment per keyframe) into the planned segments, writing each atomically once it reaches the next boundary.</summary>
public sealed class RemuxSegmenter(
    string directory,
    string initFileName,
    SegmentTimeline timeline,
    int startSegment,
    double tolerance,
    Func<byte[], Fmp4Init> adoptInit,
    Action<int, int> segmentWritten,
    Action<double, long> progress,
    ILogger logger)
{
    private const long MaxBoxBytes = 1L << 30;

    private readonly List<byte[]> _pending = [];
    private readonly List<byte[]> _orphans = [];
    private Fmp4Init? _init;
    private Dictionary<uint, long> _editShift = [];
    private byte[]? _ftyp;
    private byte[]? _moof;
    private int? _current;
    private double? _firstStart;
    private long _frames;

    public int SegmentsWritten { get; private set; }

    /// <summary>Consumes the stream until EOF; the last segment is only written when <paramref name="exitedCleanly"/> confirms a normal end.</summary>
    public async Task RunAsync(Stream input, Func<Task<bool>> exitedCleanly, CancellationToken ct)
    {
        var header = new byte[16];
        while (true)
        {
            if (!await FillAsync(input, header.AsMemory(0, 8), ct))
                break;
            long size = BinaryPrimitives.ReadUInt32BigEndian(header);
            var type = Encoding.ASCII.GetString(header, 4, 4);
            var headerLength = 8;
            if (size == 1)
            {
                if (!await FillAsync(input, header.AsMemory(8, 8), ct))
                    throw new InvalidDataException("Truncated 64-bit box header in the remux output.");
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
                headerLength = 16;
            }
            if (size < headerLength || size > MaxBoxBytes)
                throw new InvalidDataException($"Unexpected '{type}' box of {size} bytes in the remux output.");
            var box = new byte[size];
            header.AsSpan(0, headerLength).CopyTo(box);
            if (!await FillAsync(input, box.AsMemory(headerLength), ct))
                throw new InvalidDataException($"Truncated '{type}' box in the remux output.");
            await HandleAsync(type, box, ct);
        }

        if (await exitedCleanly())
        {
            if (_current is { } last)
                await FlushAsync(last, ct);
        }
        else
        {
            _pending.Clear();
        }
    }

    private async Task HandleAsync(string type, byte[] box, CancellationToken ct)
    {
        switch (type)
        {
            case "ftyp":
                _ftyp = box;
                break;
            case "moov":
                var init = _ftyp is null ? box : [.. _ftyp, .. box];
                _init = Fmp4.ParseInit(init);
                var served = adoptInit(init);
                _editShift = _init.Tracks
                    .Select(t => (t.TrackId, Shift: served.Tracks.FirstOrDefault(r => r.TrackId == t.TrackId && r.Timescale == t.Timescale) is { } r
                        ? r.EditMediaTime - t.EditMediaTime
                        : 0))
                    .Where(t => t.Shift != 0)
                    .ToDictionary(t => t.TrackId, t => t.Shift);
                if (_editShift.Count > 0)
                    logger.LogDebug("Remux run from segment {Start} shifts decode times to the served init: {Shifts}", startSegment, _editShift);
                _init = served;
                await WriteAtomicallyAsync(Path.Combine(directory, initFileName), [init], ct);
                break;
            case "moof":
                _moof = box;
                break;
            case "mdat" when _moof is not null && _init is not null:
                var moof = _moof;
                _moof = null;
                await RouteAsync(moof, box, ct);
                break;
        }
    }

    private async Task RouteAsync(byte[] moof, byte[] mdat, CancellationToken ct)
    {
        if (_editShift.Count > 0)
            Fmp4.ShiftDecodeTimes(moof, _editShift);
        var fragment = Fmp4.ParseSegment(moof, _init!);
        var video = fragment.Timings(_init!).FirstOrDefault(t => t.Handler == "vide");
        if (video is null)
        {
            if (_current is not null)
                _pending.AddRange([moof, mdat]);
            else
                _orphans.AddRange([moof, mdat]);
            return;
        }

        var start = video.StartSeconds;
        var end = start + video.DurationSeconds;
        var segment = timeline.IndexAt(start + tolerance);
        _frames += video.Samples;
        _firstStart ??= start;
        progress(end - _firstStart.Value, _frames);

        if (start + tolerance < timeline.StartOf(startSegment))
        {
            _orphans.Clear();
            return;
        }
        if (_current is { } open && segment != open)
            await FlushAsync(open, ct);
        if (_current is null)
        {
            if (SegmentsWritten == 0 && segment > startSegment)
                logger.LogWarning("Remux run from segment {Start} began at segment {Actual} ({Seconds:0.000}s); earlier segments are unavailable", startSegment, segment, start);
            _current = segment;
            _pending.AddRange(_orphans);
            _orphans.Clear();
        }
        _pending.AddRange([moof, mdat]);
        if (segment + 1 < timeline.Count && end >= timeline.StartOf(segment + 1) - tolerance)
            await FlushAsync(segment, ct);
    }

    private async Task FlushAsync(int segment, CancellationToken ct)
    {
        _current = null;
        if (_pending.Count == 0)
            return;
        await WriteAtomicallyAsync(Path.Combine(directory, $"{segment}.m4s"), _pending, ct);
        _pending.Clear();
        SegmentsWritten++;
        segmentWritten(startSegment, segment);
    }

    private static async Task WriteAtomicallyAsync(string path, IReadOnlyList<byte[]> parts, CancellationToken ct)
    {
        var temp = path + ".tmp";
        await using (var file = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true))
        {
            foreach (var part in parts)
                await file.WriteAsync(part, ct);
        }
        File.Move(temp, path, overwrite: true);
    }

    private static async Task<bool> FillAsync(Stream input, Memory<byte> buffer, CancellationToken ct)
    {
        var read = 0;
        while (read < buffer.Length)
        {
            var n = await input.ReadAsync(buffer[read..], ct);
            if (n == 0)
            {
                if (read == 0)
                    return false;
                throw new EndOfStreamException("The remux output ended inside a box.");
            }
            read += n;
        }
        return true;
    }
}
