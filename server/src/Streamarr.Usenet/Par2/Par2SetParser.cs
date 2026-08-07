using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Streamarr.Usenet.Par2;

/// <summary>
/// Parses and fully validates a PAR2 index file held in memory: packet-header bounds,
/// per-packet MD5, set-id consistency, Main/FileDesc/IFSC cross-checks, and hard limits
/// against untrusted allocations. Resyncs on the packet magic after damaged regions.
/// </summary>
public static class Par2SetParser
{
    private const int MaxPacketHashWorkFactor = 8;
    private const int HashChunkBytes = 256 * 1024;

    public static Par2SetInfo Parse(ReadOnlySpan<byte> data, Par2ParserLimits? limits = null)
        => Parse(data, limits, CancellationToken.None);

    public static Par2SetInfo Parse(ReadOnlySpan<byte> data, CancellationToken cancellationToken)
        => Parse(data, limits: null, cancellationToken);

    public static Par2SetInfo Parse(
        ReadOnlySpan<byte> data,
        Par2ParserLimits? limits,
        CancellationToken cancellationToken)
    {
        limits ??= Par2ParserLimits.Default;
        cancellationToken.ThrowIfCancellationRequested();
        var hashBudget = new PacketHashBudget(checked((long)data.Length * MaxPacketHashWorkFactor));

        var selectedMain = SelectMain(data, limits, hashBudget, cancellationToken);
        var main = selectedMain.Packet;
        var mainPacketMd5 = selectedMain.PacketMd5;
        var setId = selectedMain.SetId;
        var fileDescriptions = new Dictionary<Par2FileId, Par2FileDescription>();
        var fileChecksums = new Dictionary<Par2FileId, Par2FileSliceChecksums>();
        var foreignPackets = 0;
        var packetsSeen = 0;

        long pos = 0;
        while (pos + Par2PacketHeader.Size <= data.Length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!data.Slice((int)pos, 8).SequenceEqual(Par2PacketHeader.Magic))
            {
                pos++;
                continue;
            }
            var header = Par2PacketHeader.TryParse(data[(int)pos..], pos, limits.MaxPacketBytes);
            if (header is null || pos + header.Length > data.Length)
            {
                pos += 4;
                continue;
            }
            if (++packetsSeen > limits.MaxPacketsPerFile)
                throw new Par2FormatException("The PAR2 index contains more packets than allowed.");
            var packet = data.Slice((int)pos, (int)header.Length);
            hashBudget.Consume(packet.Length - 32);
            if (!PacketMd5Matches(packet[32..], header.PacketMd5, cancellationToken))
            {
                pos += 4;
                continue;
            }

            if (!header.SetId.AsSpan().SequenceEqual(setId))
            {
                foreignPackets++;
                pos += header.Length;
                continue;
            }

            var body = packet[Par2PacketHeader.Size..];
            if (header.IsType(Par2PacketTypes.Main))
            {
                if (!header.PacketMd5.AsSpan().SequenceEqual(mainPacketMd5))
                    throw new Par2FormatException("The PAR2 set contains conflicting Main packets.");
            }
            else if (header.IsType(Par2PacketTypes.FileDesc))
            {
                var description = ParseFileDescription(body, limits);
                if (fileDescriptions.TryGetValue(description.FileId, out var existing))
                {
                    if (existing != description && !Equivalent(existing, description))
                        throw new Par2FormatException("The PAR2 set contains conflicting file descriptions.");
                }
                else
                {
                    fileDescriptions[description.FileId] = description;
                }
            }
            else if (header.IsType(Par2PacketTypes.InputFileSliceChecksum))
            {
                var checksums = ParseChecksums(body, limits);
                if (fileChecksums.TryGetValue(checksums.FileId, out var existing))
                {
                    if (!Equivalent(existing, checksums))
                        throw new Par2FormatException("The PAR2 set contains conflicting slice-checksum packets.");
                }
                else
                {
                    fileChecksums[checksums.FileId] = checksums;
                }
            }
            // RecoverySlice / Creator / unknown packet types are ignored here.

            pos += header.Length;
        }

        var files = new List<Par2SourceFileInfo>(main.RecoverySetFileIds.Count);
        long globalSlices = 0;
        foreach (var fileId in main.RecoverySetFileIds)
        {
            if (!fileDescriptions.TryGetValue(fileId, out var description))
                throw new Par2FormatException("A recovery-set file has no file-description packet.");
            if (!fileChecksums.TryGetValue(fileId, out var checksums))
                throw new Par2FormatException("A recovery-set file has no slice-checksum packet.");
            if (description.FileLength > limits.MaxFileLength)
                throw new Par2FormatException("A recovery-set file exceeds the allowed file length.");

            var expectedSlices = checked((description.FileLength + main.SliceSize - 1) / main.SliceSize);
            if (checksums.Slices.Count != expectedSlices)
                throw new Par2FormatException(
                    "The slice-checksum packet does not match the declared file length.");

            files.Add(new Par2SourceFileInfo
            {
                Description = description,
                Checksums = checksums,
                SliceCount = checked((int)expectedSlices),
                GlobalSliceOffset = globalSlices,
            });
            globalSlices = checked(globalSlices + expectedSlices);
            if (globalSlices > limits.MaxTotalSlices)
                throw new Par2FormatException("The PAR2 set exceeds the allowed total slice count.");
        }

        return new Par2SetInfo
        {
            SetId = setId,
            SliceSize = main.SliceSize,
            Files = files,
            TotalSlices = globalSlices,
            ForeignPackets = foreignPackets,
        };
    }

    private static SelectedMain SelectMain(
        ReadOnlySpan<byte> data,
        Par2ParserLimits limits,
        PacketHashBudget hashBudget,
        CancellationToken cancellationToken)
    {
        SelectedMain? selected = null;
        var packetsSeen = 0;
        long pos = 0;
        while (pos + Par2PacketHeader.Size <= data.Length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!data.Slice((int)pos, 8).SequenceEqual(Par2PacketHeader.Magic))
            {
                pos++;
                continue;
            }

            var header = Par2PacketHeader.TryParse(data[(int)pos..], pos, limits.MaxPacketBytes);
            if (header is null || pos + header.Length > data.Length)
            {
                pos += 4;
                continue;
            }
            if (++packetsSeen > limits.MaxPacketsPerFile)
                throw new Par2FormatException("The PAR2 index contains more packets than allowed.");

            var packet = data.Slice((int)pos, (int)header.Length);
            hashBudget.Consume(packet.Length - 32);
            if (!PacketMd5Matches(packet[32..], header.PacketMd5, cancellationToken))
            {
                pos += 4;
                continue;
            }
            if (selected is null && header.IsType(Par2PacketTypes.Main))
            {
                try
                {
                    selected = new SelectedMain(
                        ParseMain(packet[Par2PacketHeader.Size..], limits),
                        header.SetId,
                        header.PacketMd5);
                }
                catch (Par2FormatException)
                {
                }
            }
            pos += header.Length;
        }

        return selected ?? throw new Par2FormatException("The PAR2 index contains no valid Main packet.");
    }

    private static bool PacketMd5Matches(
        ReadOnlySpan<byte> packetBody,
        ReadOnlySpan<byte> expected,
        CancellationToken cancellationToken)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        while (!packetBody.IsEmpty)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var length = Math.Min(packetBody.Length, HashChunkBytes);
            hash.AppendData(packetBody[..length]);
            packetBody = packetBody[length..];
        }
        return hash.GetHashAndReset().AsSpan().SequenceEqual(expected);
    }

    private sealed class PacketHashBudget(long remainingBytes)
    {
        private long _remainingBytes = remainingBytes;

        public void Consume(long bytes)
        {
            if (bytes < 0 || bytes > _remainingBytes)
            {
                throw new Par2FormatException(
                    "The PAR2 index exceeds the allowed packet-verification work.");
            }
            _remainingBytes -= bytes;
        }
    }

    private static Par2MainPacket ParseMain(ReadOnlySpan<byte> body, Par2ParserLimits limits)
    {
        if (body.Length < 12)
            throw new Par2FormatException("The Main packet is truncated.");
        var sliceSize = BinaryPrimitives.ReadUInt64LittleEndian(body[..8]);
        if (sliceSize == 0 || sliceSize % 4 != 0 || sliceSize > (ulong)limits.MaxSliceSize)
            throw new Par2FormatException("The Main packet declares an invalid slice size.");
        var fileCount = BinaryPrimitives.ReadUInt32LittleEndian(body[8..12]);
        if (fileCount == 0 || fileCount > (uint)limits.MaxFiles)
            throw new Par2FormatException("The Main packet declares an invalid recovery-set file count.");
        if (body.Length < 12 + 16L * fileCount)
            throw new Par2FormatException("The Main packet is shorter than its declared file-id list.");

        var ids = new List<Par2FileId>((int)fileCount);
        var seen = new HashSet<Par2FileId>();
        for (var i = 0; i < fileCount; i++)
        {
            var id = new Par2FileId(body.Slice(12 + 16 * i, 16));
            if (!seen.Add(id))
                throw new Par2FormatException("The Main packet lists a duplicate file id.");
            ids.Add(id);
        }
        return new Par2MainPacket { SliceSize = (long)sliceSize, RecoverySetFileIds = ids };
    }

    private static Par2FileDescription ParseFileDescription(ReadOnlySpan<byte> body, Par2ParserLimits limits)
    {
        if (body.Length < 56 + 1)
            throw new Par2FormatException("A file-description packet is truncated.");
        var nameBytes = body[56..];
        if (nameBytes.Length > limits.MaxFileNameBytes)
            throw new Par2FormatException("A declared file name exceeds the allowed length.");
        var nameEnd = nameBytes.LastIndexOfAnyExcept((byte)0) + 1;
        if (nameEnd <= 0)
            throw new Par2FormatException("A file-description packet declares an empty file name.");
        var length = BinaryPrimitives.ReadUInt64LittleEndian(body[48..56]);
        if (length == 0 || length > (ulong)limits.MaxFileLength)
            throw new Par2FormatException("A file-description packet declares an invalid file length.");

        return new Par2FileDescription
        {
            FileId = new Par2FileId(body[..16]),
            FileMd5 = body[16..32].ToArray(),
            FileMd5OfFirst16K = body[32..48].ToArray(),
            FileLength = (long)length,
            FileName = Encoding.UTF8.GetString(nameBytes[..nameEnd]),
        };
    }

    private static Par2FileSliceChecksums ParseChecksums(ReadOnlySpan<byte> body, Par2ParserLimits limits)
    {
        if (body.Length < 16 || (body.Length - 16) % 20 != 0)
            throw new Par2FormatException("A slice-checksum packet has an invalid length.");
        var count = (body.Length - 16) / 20;
        if (count == 0 || count > limits.MaxTotalSlices)
            throw new Par2FormatException("A slice-checksum packet has an invalid slice count.");

        var slices = new List<(byte[] Md5, uint Crc32)>(count);
        for (var i = 0; i < count; i++)
        {
            var entry = body.Slice(16 + 20 * i, 20);
            slices.Add((entry[..16].ToArray(), BinaryPrimitives.ReadUInt32LittleEndian(entry[16..20])));
        }
        return new Par2FileSliceChecksums { FileId = new Par2FileId(body[..16]), Slices = slices };
    }

    private static bool Equivalent(Par2FileDescription a, Par2FileDescription b)
        => a.FileId == b.FileId
           && a.FileLength == b.FileLength
           && a.FileMd5.AsSpan().SequenceEqual(b.FileMd5)
           && a.FileMd5OfFirst16K.AsSpan().SequenceEqual(b.FileMd5OfFirst16K)
           && string.Equals(a.FileName, b.FileName, StringComparison.Ordinal);

    private static bool Equivalent(Par2FileSliceChecksums a, Par2FileSliceChecksums b)
    {
        if (a.FileId != b.FileId || a.Slices.Count != b.Slices.Count)
            return false;
        for (var i = 0; i < a.Slices.Count; i++)
        {
            if (a.Slices[i].Crc32 != b.Slices[i].Crc32
                || !a.Slices[i].Md5.AsSpan().SequenceEqual(b.Slices[i].Md5))
                return false;
        }
        return true;
    }

    private sealed record SelectedMain(Par2MainPacket Packet, byte[] SetId, byte[] PacketMd5);
}
