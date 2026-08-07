using System.Buffers.Binary;

namespace Streamarr.Usenet.Par2;

// PAR 2.0 packet models. Layout per the PAR 2.0 specification; header struct layout
// cross-checked against nzbdav's Par2Recovery reader (MIT, Peter M. Lemmen — see NOTICE).

/// <summary>The 64-byte PAR2 packet header.</summary>
public sealed record Par2PacketHeader
{
    public const int Size = 64;
    public static ReadOnlySpan<byte> Magic => "PAR2\0PKT"u8;

    /// <summary>Absolute offset of the packet within its recovery file.</summary>
    public required long Offset { get; init; }

    /// <summary>Total packet length including the header. Multiple of 4, at least 64.</summary>
    public required long Length { get; init; }

    /// <summary>MD5 of bytes [Offset+32, Offset+Length).</summary>
    public required byte[] PacketMd5 { get; init; }

    /// <summary>Recovery set id (16 bytes).</summary>
    public required byte[] SetId { get; init; }

    /// <summary>16-byte packet type signature.</summary>
    public required byte[] TypeSignature { get; init; }

    public bool IsType(ReadOnlySpan<byte> signature) => TypeSignature.AsSpan().SequenceEqual(signature);

    /// <summary>
    /// Parses the fixed header at the start of <paramref name="buffer"/>. Returns null when
    /// the magic does not match or the declared length is structurally invalid.
    /// </summary>
    public static Par2PacketHeader? TryParse(ReadOnlySpan<byte> buffer, long offset, long maxPacketLength)
    {
        if (buffer.Length < Size || !buffer[..8].SequenceEqual(Magic))
            return null;
        var length = BinaryPrimitives.ReadUInt64LittleEndian(buffer[8..16]);
        if (length < Size || length % 4 != 0 || length > (ulong)maxPacketLength)
            return null;
        return new Par2PacketHeader
        {
            Offset = offset,
            Length = (long)length,
            PacketMd5 = buffer[16..32].ToArray(),
            SetId = buffer[32..48].ToArray(),
            TypeSignature = buffer[48..64].ToArray(),
        };
    }
}

public static class Par2PacketTypes
{
    public static ReadOnlySpan<byte> Main => "PAR 2.0\0Main\0\0\0\0"u8;
    public static ReadOnlySpan<byte> FileDesc => "PAR 2.0\0FileDesc"u8;
    public static ReadOnlySpan<byte> InputFileSliceChecksum => "PAR 2.0\0IFSC\0\0\0\0"u8;
    public static ReadOnlySpan<byte> RecoverySlice => "PAR 2.0\0RecvSlic"u8;
    public static ReadOnlySpan<byte> Creator => "PAR 2.0\0Creator\0"u8;
}

/// <summary>Main packet: slice size plus the ordered recovery-set file ids.</summary>
public sealed record Par2MainPacket
{
    public required long SliceSize { get; init; }

    /// <summary>File ids of the recovery set, in the order that defines global slice indexing.</summary>
    public required IReadOnlyList<Par2FileId> RecoverySetFileIds { get; init; }
}

/// <summary>A 16-byte PAR2 file id with value equality.</summary>
public readonly struct Par2FileId : IEquatable<Par2FileId>
{
    private readonly ulong _lo;
    private readonly ulong _hi;

    public Par2FileId(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != 16)
            throw new ArgumentException("A PAR2 file id is exactly 16 bytes.", nameof(bytes));
        _lo = BinaryPrimitives.ReadUInt64LittleEndian(bytes[..8]);
        _hi = BinaryPrimitives.ReadUInt64LittleEndian(bytes[8..16]);
    }

    public byte[] ToArray()
    {
        var bytes = new byte[16];
        BinaryPrimitives.WriteUInt64LittleEndian(bytes.AsSpan(0, 8), _lo);
        BinaryPrimitives.WriteUInt64LittleEndian(bytes.AsSpan(8, 8), _hi);
        return bytes;
    }

    public bool Equals(Par2FileId other) => _lo == other._lo && _hi == other._hi;
    public override bool Equals(object? obj) => obj is Par2FileId other && Equals(other);
    public override int GetHashCode() => HashCode.Combine(_lo, _hi);
    public override string ToString() => Convert.ToHexString(ToArray()).ToLowerInvariant();
    public static bool operator ==(Par2FileId left, Par2FileId right) => left.Equals(right);
    public static bool operator !=(Par2FileId left, Par2FileId right) => !left.Equals(right);
}

/// <summary>File description packet: identity and whole-file hashes of one source file.</summary>
public sealed record Par2FileDescription
{
    public required Par2FileId FileId { get; init; }

    /// <summary>MD5 of the entire file.</summary>
    public required byte[] FileMd5 { get; init; }

    /// <summary>MD5 of the first 16 KiB.</summary>
    public required byte[] FileMd5OfFirst16K { get; init; }

    public required long FileLength { get; init; }

    /// <summary>
    /// Declared file name. Untrusted: used only for matching against NZB subject names,
    /// never as any filesystem path component.
    /// </summary>
    public required string FileName { get; init; }
}

/// <summary>Per-slice MD5 + CRC32 of one source file (IFSC packet).</summary>
public sealed record Par2FileSliceChecksums
{
    public required Par2FileId FileId { get; init; }

    /// <summary>One entry per slice, in file order. MD5 is 16 bytes; CRC32 of the zero-padded slice.</summary>
    public required IReadOnlyList<(byte[] Md5, uint Crc32)> Slices { get; init; }
}

/// <summary>Location of a verified recovery slice inside a recovery file.</summary>
public sealed record Par2RecoverySliceRef
{
    public required uint Exponent { get; init; }

    /// <summary>Absolute offset of the slice payload (after header + exponent) in its file.</summary>
    public required long DataOffset { get; init; }

    public required long DataLength { get; init; }

    /// <summary>True when the full packet was readable and its MD5 verified.</summary>
    public required bool Verified { get; init; }
}
