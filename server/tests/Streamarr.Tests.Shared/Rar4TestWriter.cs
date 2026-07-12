using Streamarr.Usenet.Yenc;

namespace Streamarr.Tests.Shared;

/// <summary>
/// Writes stored (method m0) RAR 4.x archives in memory, following the RAR 4.x
/// "technote" specification — the same layout as the checked-in fixtures built by
/// Streamarr.Usenet.Tests/Fixtures/rar/generate_fixtures.py. Used to RAR-wrap
/// in-test media files (release RARs are stored, so this matches reality).
/// </summary>
public static class Rar4TestWriter
{
    private static readonly byte[] Marker = "Rar!\x1a\x07\x00"u8.ToArray();

    /// <summary>
    /// Splits <paramref name="data"/> into multiple stored RAR4 volumes named
    /// old-style: <c>{baseName}.rar</c>, <c>{baseName}.r00</c>, <c>{baseName}.r01</c>, …
    /// </summary>
    public static IReadOnlyList<(string FileName, byte[] Bytes)> WriteMultiVolume(
        string baseName, string entryName, byte[] data, int chunkSize)
    {
        var chunks = new List<byte[]>();
        for (var offset = 0; offset < data.Length; offset += chunkSize)
            chunks.Add(data[offset..Math.Min(offset + chunkSize, data.Length)]);

        var volumes = new List<(string, byte[])>(chunks.Count);
        for (var i = 0; i < chunks.Count; i++)
        {
            var extension = i == 0 ? ".rar" : $".r{i - 1:00}";
            using var ms = new MemoryStream();
            ms.Write(Marker);
            ms.Write(MainHeader(volume: true, firstVolume: i == 0));
            ms.Write(FileHeader(
                entryName, chunks[i], data.Length,
                splitBefore: i > 0,
                splitAfter: i < chunks.Count - 1));
            volumes.Add((baseName + extension, ms.ToArray()));
        }

        return volumes;
    }

    /// <summary>A single-volume stored RAR4 archive containing the given entries.</summary>
    public static byte[] WriteSingleVolume(params (string EntryName, byte[] Data)[] entries)
    {
        using var ms = new MemoryStream();
        ms.Write(Marker);
        ms.Write(MainHeader(volume: false, firstVolume: false));
        foreach (var (name, data) in entries)
            ms.Write(FileHeader(name, data, data.Length, splitBefore: false, splitAfter: false));
        return ms.ToArray();
    }

    private static byte[] MainHeader(bool volume, bool firstVolume)
    {
        ushort flags = 0;
        if (volume)
        {
            flags |= 0x0001; // MHD_VOLUME
            if (firstVolume)
                flags |= 0x0100; // MHD_FIRSTVOLUME
        }

        using var body = new MemoryStream();
        using var w = new BinaryWriter(body);
        w.Write((byte)0x73); // HEAD_TYPE: main header
        w.Write(flags);
        w.Write((ushort)13); // HEAD_SIZE
        w.Write((ushort)0);  // reserved
        w.Write((uint)0);    // reserved
        w.Flush();
        return WithCrc16(body.ToArray());
    }

    private static byte[] FileHeader(string name, byte[] chunk, long unpackedSize,
        bool splitBefore, bool splitAfter)
    {
        var nameBytes = System.Text.Encoding.ASCII.GetBytes(name);

        ushort flags = 0x8000; // long block: ADD_SIZE (PACK_SIZE) present
        if (splitBefore) flags |= 0x0001; // LHD_SPLIT_BEFORE
        if (splitAfter) flags |= 0x0002;  // LHD_SPLIT_AFTER

        using var body = new MemoryStream();
        using var w = new BinaryWriter(body);
        w.Write((byte)0x74);                        // HEAD_TYPE: file header
        w.Write(flags);                             // HEAD_FLAGS
        w.Write((ushort)(32 + nameBytes.Length));   // HEAD_SIZE
        w.Write((uint)chunk.Length);                // PACK_SIZE
        w.Write((uint)unpackedSize);                // UNP_SIZE
        w.Write((byte)2);                           // HOST_OS: win32
        w.Write(Crc32.Compute(chunk));              // FILE_CRC (this volume's chunk)
        w.Write((uint)0x5A21A020);                  // FTIME (arbitrary DOS time)
        w.Write((byte)20);                          // UNP_VER
        w.Write((byte)0x30);                        // METHOD: stored (m0)
        w.Write((ushort)nameBytes.Length);          // NAME_SIZE
        w.Write((uint)0x20);                        // ATTR
        w.Write(nameBytes);
        w.Flush();

        var header = WithCrc16(body.ToArray());
        var block = new byte[header.Length + chunk.Length];
        header.CopyTo(block, 0);
        chunk.CopyTo(block, header.Length);
        return block;
    }

    private static byte[] WithCrc16(byte[] body)
    {
        var crc = (ushort)(Crc32.Compute(body) & 0xFFFF);
        var result = new byte[body.Length + 2];
        result[0] = (byte)(crc & 0xFF);
        result[1] = (byte)(crc >> 8);
        body.CopyTo(result, 2);
        return result;
    }
}
