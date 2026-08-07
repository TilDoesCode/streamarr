using System.Buffers.Binary;
using System.Security.Cryptography;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Par2;

/// <summary>Random-access view of a partially available recovery file.</summary>
public interface IPar2ScanSource
{
    long Length { get; }

    /// <summary>Sorted, non-overlapping byte ranges that are actually present.</summary>
    IReadOnlyList<LongRange> CoveredRanges { get; }

    /// <summary>Reads fully covered bytes at <paramref name="offset"/>.</summary>
    void ReadAt(long offset, Span<byte> destination);
}

/// <summary>
/// Scans a partially available PAR2 recovery volume for recovery-slice packets. Damaged
/// volumes are the norm for this scanner: it walks only covered ranges, resyncs on the
/// packet magic, and reports a slice as verified only when the complete packet is
/// present and its MD5 matches. Foreign set ids are skipped.
/// </summary>
public static class Par2VolumeScanner
{
    private const int ChunkSize = 256 * 1024;

    public static IReadOnlyList<Par2RecoverySliceRef> ScanRecoverySlices(
        IPar2ScanSource source,
        ReadOnlySpan<byte> expectedSetId,
        long expectedSliceSize,
        Par2ParserLimits? limits = null,
        CancellationToken ct = default)
    {
        limits ??= Par2ParserLimits.Default;
        var results = new List<Par2RecoverySliceRef>();
        var header = new byte[Par2PacketHeader.Size + 4];
        var packetsSeen = 0;

        foreach (var range in source.CoveredRanges)
        {
            var scanner = new MagicScanner(source, range.StartInclusive, range.EndExclusive);
            long searchFrom = range.StartInclusive;
            while (scanner.FindNext(searchFrom, ct) is { } pos)
            {
                ct.ThrowIfCancellationRequested();
                searchFrom = pos + 1;
                if (range.EndExclusive - pos < Par2PacketHeader.Size)
                    break;
                if (++packetsSeen > limits.MaxPacketsPerFile)
                    throw new Par2FormatException("The recovery volume contains more packets than allowed.");

                source.ReadAt(pos, header.AsSpan(0, Par2PacketHeader.Size));
                var parsed = Par2PacketHeader.TryParse(
                    header.AsSpan(0, Par2PacketHeader.Size),
                    pos,
                    limits.MaxPacketBytes);
                if (parsed is null)
                    continue;

                var fullyCovered = parsed.Length <= range.EndExclusive - pos;
                if (!fullyCovered || !VerifyPacketMd5(source, parsed, ct))
                    continue;
                searchFrom = pos + parsed.Length;

                if (!parsed.SetId.AsSpan().SequenceEqual(expectedSetId)
                    || !parsed.IsType(Par2PacketTypes.RecoverySlice)
                    || parsed.Length < Par2PacketHeader.Size + 4)
                    continue;

                var dataLength = parsed.Length - Par2PacketHeader.Size - 4;
                source.ReadAt(pos + Par2PacketHeader.Size, header.AsSpan(Par2PacketHeader.Size, 4));
                var exponent = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(Par2PacketHeader.Size, 4));
                if (dataLength != expectedSliceSize)
                    continue;

                results.Add(new Par2RecoverySliceRef
                {
                    Exponent = exponent,
                    DataOffset = pos + Par2PacketHeader.Size + 4,
                    DataLength = dataLength,
                    Verified = true,
                });
            }
        }

        return results
            .GroupBy(r => r.Exponent)
            .Select(g => g.First())
            .OrderBy(r => r.Exponent)
            .ToList();
    }

    private static bool VerifyPacketMd5(IPar2ScanSource source, Par2PacketHeader header, CancellationToken ct)
    {
        using var md5 = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        var buffer = new byte[(int)Math.Min(ChunkSize, header.Length - 32)];
        var remaining = header.Length - 32;
        var offset = header.Offset + 32;
        while (remaining > 0)
        {
            ct.ThrowIfCancellationRequested();
            var take = (int)Math.Min(buffer.Length, remaining);
            source.ReadAt(offset, buffer.AsSpan(0, take));
            md5.AppendData(buffer.AsSpan(0, take));
            offset += take;
            remaining -= take;
        }
        return md5.GetHashAndReset().AsSpan().SequenceEqual(header.PacketMd5);
    }

    private sealed class MagicScanner(IPar2ScanSource source, long start, long end)
    {
        private readonly byte[] _buffer = new byte[ChunkSize];
        private long _bufferStart;
        private int _bufferLength;
        private int _searchIndex;
        private bool _loaded;

        public long? FindNext(long minimumOffset, CancellationToken ct)
        {
            minimumOffset = Math.Max(minimumOffset, start);
            if (minimumOffset > end - Par2PacketHeader.Magic.Length)
                return null;

            if (!_loaded
                || minimumOffset < _bufferStart
                || minimumOffset > _bufferStart + _bufferLength - Par2PacketHeader.Magic.Length)
            {
                Load(minimumOffset);
            }
            else
            {
                _searchIndex = Math.Max(_searchIndex, checked((int)(minimumOffset - _bufferStart)));
            }

            while (_bufferLength >= Par2PacketHeader.Magic.Length)
            {
                ct.ThrowIfCancellationRequested();
                var remaining = _buffer.AsSpan(_searchIndex, _bufferLength - _searchIndex);
                var relative = remaining.IndexOf(Par2PacketHeader.Magic);
                if (relative >= 0)
                {
                    var index = _searchIndex + relative;
                    _searchIndex = index + 1;
                    return _bufferStart + index;
                }

                var loadedEnd = _bufferStart + _bufferLength;
                if (loadedEnd >= end)
                    return null;
                Load(loadedEnd - (Par2PacketHeader.Magic.Length - 1));
            }
            return null;
        }

        private void Load(long offset)
        {
            _bufferStart = offset;
            _bufferLength = (int)Math.Min(_buffer.Length, end - offset);
            source.ReadAt(offset, _buffer.AsSpan(0, _bufferLength));
            _searchIndex = 0;
            _loaded = true;
        }
    }
}
