using System.Buffers.Binary;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>Writes a raw HDMV PGS (<c>.sup</c>) stream of solid white boxes, so image-subtitle paths can be tested without Blu-ray sources.</summary>
public static class PgsFixture
{
    public sealed record Box(double StartSeconds, double EndSeconds, int X, int Y, int Width, int Height);

    public static byte[] Write(int canvasWidth, int canvasHeight, IReadOnlyList<Box> boxes)
    {
        var output = new MemoryStream();
        var composition = 0;
        foreach (var box in boxes)
        {
            var show = Pts(box.StartSeconds);
            Segment(output, 0x16, show, Composition(canvasWidth, canvasHeight, composition++, epochStart: true, box));
            Segment(output, 0x17, show, Window(box));
            Segment(output, 0x14, show, [0, 0, 1, 235, 128, 128, 255]);
            Segment(output, 0x15, show, Object(box));
            Segment(output, 0x80, show, []);
            var hide = Pts(box.EndSeconds);
            Segment(output, 0x16, hide, Composition(canvasWidth, canvasHeight, composition++, epochStart: false, null));
            Segment(output, 0x17, hide, Window(box));
            Segment(output, 0x80, hide, []);
        }
        return output.ToArray();
    }

    private static uint Pts(double seconds) => (uint)Math.Round(seconds * 90_000);

    private static void Segment(Stream output, byte type, uint pts, byte[] data)
    {
        Span<byte> header = stackalloc byte[13];
        header[0] = (byte)'P';
        header[1] = (byte)'G';
        BinaryPrimitives.WriteUInt32BigEndian(header[2..], pts);
        BinaryPrimitives.WriteUInt32BigEndian(header[6..], 0);
        header[10] = type;
        BinaryPrimitives.WriteUInt16BigEndian(header[11..], (ushort)data.Length);
        output.Write(header);
        output.Write(data);
    }

    private static byte[] Composition(int width, int height, int number, bool epochStart, Box? box)
    {
        var data = new List<byte>();
        Add16(data, width);
        Add16(data, height);
        data.Add(0x10);
        Add16(data, number);
        data.AddRange([epochStart ? (byte)0x80 : (byte)0x00, 0x00, 0x00, box is null ? (byte)0 : (byte)1]);
        if (box is not null)
        {
            Add16(data, 0);
            data.AddRange([0, 0]);
            Add16(data, box.X);
            Add16(data, box.Y);
        }
        return [.. data];
    }

    private static byte[] Window(Box box)
    {
        var data = new List<byte> { 1, 0 };
        Add16(data, box.X);
        Add16(data, box.Y);
        Add16(data, box.Width);
        Add16(data, box.Height);
        return [.. data];
    }

    private static byte[] Object(Box box)
    {
        var line = box.Width >= 64
            ? new byte[] { 0x00, (byte)(0xC0 | (box.Width >> 8)), (byte)(box.Width & 0xFF), 0x01, 0x00, 0x00 }
            : [0x00, (byte)(0x80 | box.Width), 0x01, 0x00, 0x00];
        var rle = Enumerable.Repeat(line, box.Height).SelectMany(l => l).ToArray();
        var data = new List<byte>();
        Add16(data, 0);
        data.AddRange([0, 0xC0]);
        var length = rle.Length + 4;
        data.AddRange([(byte)(length >> 16), (byte)(length >> 8), (byte)length]);
        Add16(data, box.Width);
        Add16(data, box.Height);
        data.AddRange(rle);
        return [.. data];
    }

    private static void Add16(List<byte> data, int value) => data.AddRange([(byte)(value >> 8), (byte)value]);
}
