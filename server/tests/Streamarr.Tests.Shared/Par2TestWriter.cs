using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Streamarr.Usenet.Par2;

namespace Streamarr.Tests.Shared;

/// <summary>A deterministic in-memory PAR2 set for tests: one index file plus recovery volumes.</summary>
public sealed record Par2TestSet
{
    public required byte[] SetId { get; init; }
    public required byte[] IndexBytes { get; init; }
    public required IReadOnlyList<(string Name, byte[] Bytes)> Volumes { get; init; }
}

/// <summary>
/// Writes spec-shaped PAR 2.0 sets for test fixtures (Main, FileDesc, IFSC, RecvSlic,
/// Creator packets). Recovery data is computed with the production GF(2^16) primitives;
/// the layout is cross-validated against a par2cmdline golden fixture in the test suite.
/// </summary>
public static class Par2TestWriter
{
    public static Par2TestSet Create(
        IReadOnlyList<(string Name, byte[] Data)> files,
        int sliceSize,
        int recoverySliceCount,
        int recoverySlicesPerVolume = 2,
        uint firstExponent = 0)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(sliceSize, 4);
        if (sliceSize % 4 != 0)
            throw new ArgumentException("Slice size must be a multiple of 4.", nameof(sliceSize));

        // FileDesc + IFSC per file; recovery-set order = ascending file id (PAR2 spec).
        var described = files
            .Select(f => (f.Name, f.Data, FileId: ComputeFileId(f.Name, f.Data)))
            .OrderBy(f => f.FileId.ToArray(), ByteArrayComparer.Instance)
            .ToList();

        var mainBody = BuildMainBody(described.Select(f => f.FileId).ToList(), sliceSize);
        var setId = MD5.HashData(mainBody);

        var critical = new List<byte[]> { BuildPacket(setId, Par2PacketTypes.Main, mainBody) };
        foreach (var file in described)
        {
            critical.Add(BuildPacket(setId, Par2PacketTypes.FileDesc, BuildFileDescBody(file.FileId, file.Name, file.Data)));
            critical.Add(BuildPacket(setId, Par2PacketTypes.InputFileSliceChecksum, BuildIfscBody(file.FileId, file.Data, sliceSize)));
        }
        var creator = BuildPacket(setId, Par2PacketTypes.Creator, PadTo4(Encoding.ASCII.GetBytes("Streamarr.Tests Par2TestWriter")));

        var index = new MemoryStream();
        foreach (var packet in critical)
            index.Write(packet);
        index.Write(creator);

        // Recovery slices: R_e = XOR_i C_i^e * D_i over all global input slices.
        var slices = ComputeRecoverySlices(described.Select(f => f.Data).ToList(), sliceSize, recoverySliceCount, firstExponent);
        var volumes = new List<(string, byte[])>();
        for (var v = 0; v * recoverySlicesPerVolume < slices.Count; v++)
        {
            var stream = new MemoryStream();
            foreach (var (exponent, data) in slices.Skip(v * recoverySlicesPerVolume).Take(recoverySlicesPerVolume))
            {
                var body = new byte[4 + data.Length];
                BinaryPrimitives.WriteUInt32LittleEndian(body, exponent);
                data.CopyTo(body.AsSpan(4));
                stream.Write(BuildPacket(setId, Par2PacketTypes.RecoverySlice, body));
                // Interleave critical-packet copies like real tools do.
                foreach (var packet in critical)
                    stream.Write(packet);
            }
            stream.Write(creator);
            volumes.Add(($"testset.vol{v * recoverySlicesPerVolume:00}+{recoverySlicesPerVolume:00}.par2", stream.ToArray()));
        }

        return new Par2TestSet { SetId = setId, IndexBytes = index.ToArray(), Volumes = volumes };
    }

    public static List<(uint Exponent, byte[] Data)> ComputeRecoverySlices(
        IReadOnlyList<byte[]> filesInRecoverySetOrder,
        int sliceSize,
        int recoverySliceCount,
        uint firstExponent = 0)
    {
        var results = new List<(uint, byte[])>();
        for (var e = 0; e < recoverySliceCount; e++)
            results.Add(((uint)(firstExponent + e), new byte[sliceSize]));

        var globalIndex = 0;
        var padded = new byte[sliceSize];
        foreach (var data in filesInRecoverySetOrder)
        {
            for (long offset = 0; offset < data.Length; offset += sliceSize, globalIndex++)
            {
                Array.Clear(padded);
                var take = (int)Math.Min(sliceSize, data.Length - offset);
                data.AsSpan((int)offset, take).CopyTo(padded);
                var constant = GaloisField16.InputConstant(globalIndex);
                foreach (var (exponent, accumulator) in results)
                    ReedSolomon16.MultiplyAccumulate(padded, accumulator, GaloisField16.Pow(constant, (int)exponent));
            }
        }
        return results;
    }

    public static byte[] BuildPacket(byte[] setId, ReadOnlySpan<byte> type, byte[] body)
    {
        if (body.Length % 4 != 0)
            throw new ArgumentException("PAR2 packet bodies must be multiples of 4 bytes.", nameof(body));
        var packet = new byte[Par2PacketHeader.Size + body.Length];
        Par2PacketHeader.Magic.CopyTo(packet);
        BinaryPrimitives.WriteUInt64LittleEndian(packet.AsSpan(8, 8), (ulong)packet.Length);
        setId.CopyTo(packet.AsSpan(32, 16));
        type.CopyTo(packet.AsSpan(48, 16));
        body.CopyTo(packet.AsSpan(64));
        MD5.HashData(packet.AsSpan(32)).CopyTo(packet.AsSpan(16, 16));
        return packet;
    }

    private static byte[] BuildMainBody(IReadOnlyList<Par2FileId> fileIds, int sliceSize)
    {
        var body = new byte[12 + 16 * fileIds.Count];
        BinaryPrimitives.WriteUInt64LittleEndian(body.AsSpan(0, 8), (ulong)sliceSize);
        BinaryPrimitives.WriteUInt32LittleEndian(body.AsSpan(8, 4), (uint)fileIds.Count);
        for (var i = 0; i < fileIds.Count; i++)
            fileIds[i].ToArray().CopyTo(body.AsSpan(12 + 16 * i, 16));
        return body;
    }

    private static byte[] BuildFileDescBody(Par2FileId fileId, string name, byte[] data)
    {
        var nameBytes = PadTo4(Encoding.UTF8.GetBytes(name));
        var body = new byte[56 + nameBytes.Length];
        fileId.ToArray().CopyTo(body.AsSpan(0, 16));
        MD5.HashData(data).CopyTo(body.AsSpan(16, 16));
        MD5.HashData(data.AsSpan(0, Math.Min(16384, data.Length))).CopyTo(body.AsSpan(32, 16));
        BinaryPrimitives.WriteUInt64LittleEndian(body.AsSpan(48, 8), (ulong)data.Length);
        nameBytes.CopyTo(body.AsSpan(56));
        return body;
    }

    private static byte[] BuildIfscBody(Par2FileId fileId, byte[] data, int sliceSize)
    {
        var sliceCount = (data.Length + sliceSize - 1) / sliceSize;
        var body = new byte[16 + 20 * sliceCount];
        fileId.ToArray().CopyTo(body.AsSpan(0, 16));
        var padded = new byte[sliceSize];
        for (var i = 0; i < sliceCount; i++)
        {
            Array.Clear(padded);
            var take = Math.Min(sliceSize, data.Length - i * sliceSize);
            data.AsSpan(i * sliceSize, take).CopyTo(padded);
            MD5.HashData(padded).CopyTo(body.AsSpan(16 + 20 * i, 16));
            BinaryPrimitives.WriteUInt32LittleEndian(body.AsSpan(32 + 20 * i, 4), Streamarr.Usenet.Yenc.Crc32.Compute(padded));
        }
        return body;
    }

    /// <summary>File id per PAR2 spec: MD5 of (md5-16k, length, padded name).</summary>
    private static Par2FileId ComputeFileId(string name, byte[] data)
    {
        var nameBytes = PadTo4(Encoding.UTF8.GetBytes(name));
        var buffer = new byte[16 + 8 + nameBytes.Length];
        MD5.HashData(data.AsSpan(0, Math.Min(16384, data.Length))).CopyTo(buffer.AsSpan(0, 16));
        BinaryPrimitives.WriteUInt64LittleEndian(buffer.AsSpan(16, 8), (ulong)data.Length);
        nameBytes.CopyTo(buffer.AsSpan(24));
        return new Par2FileId(MD5.HashData(buffer));
    }

    private static byte[] PadTo4(byte[] bytes)
    {
        var padded = (bytes.Length + 3) / 4 * 4;
        if (padded == bytes.Length)
            return bytes;
        var result = new byte[padded];
        bytes.CopyTo(result, 0);
        return result;
    }

    private sealed class ByteArrayComparer : IComparer<byte[]>
    {
        public static ByteArrayComparer Instance { get; } = new();
        public int Compare(byte[]? x, byte[]? y) => x!.AsSpan().SequenceCompareTo(y!.AsSpan());
    }
}
