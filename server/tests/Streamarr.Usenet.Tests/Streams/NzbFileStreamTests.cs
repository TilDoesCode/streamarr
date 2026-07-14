using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nzb;
using Streamarr.Tests.Shared;

namespace Streamarr.Usenet.Tests.Streams;

public class NzbFileStreamTests
{
    private const int PartSize = 50_000;
    private const int PartCount = 6;

    private static readonly byte[] FileBytes = YencTestEncoder.LcgBytes(1234, PartSize * PartCount);

    /// <summary>Publishes FileBytes to the mock server as a 6-part yEnc file.</summary>
    private static string[] PublishSegments(MockNntpServer server)
    {
        var segmentIds = new string[PartCount];
        for (var i = 0; i < PartCount; i++)
        {
            var begin = (long)i * PartSize + 1;
            var end = begin + PartSize - 1;
            var id = $"part{i + 1}@test";
            server.Articles[id] = YencTestEncoder.EncodePart(
                FileBytes, "movie.mkv", i + 1, PartCount, begin, end);
            segmentIds[i] = id;
        }

        return segmentIds;
    }

    private static async Task<SingleConnectionNntpClient> Connect(MockNntpServer server)
    {
        var client = new SingleConnectionNntpClient();
        await client.ConnectAsync(server.Host, server.Port, useSsl: false, CancellationToken.None);
        await client.AuthenticateAsync(server.Username, server.Password, CancellationToken.None);
        return client;
    }

    [Fact]
    public async Task GetFileSize_ProbesLastSegmentOnly()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);

        var file = new NzbFile { Subject = "test" };
        for (var i = 0; i < PartCount; i++)
            file.Segments.Add(new NzbSegment { Bytes = 64000, Number = i + 1, MessageId = segmentIds[i] });

        var size = await client.GetFileSizeAsync(file, CancellationToken.None);
        Assert.Equal(FileBytes.Length, size);
    }

    [Fact]
    public async Task ReadWholeFile_MatchesOriginalBytes()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);

        await using var stream = client.GetFileStream(segmentIds, FileBytes.Length, articleBufferSize: 0);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(FileBytes, ms.ToArray());
    }

    [Fact]
    public async Task ReadWholeFile_WithReadAhead_MatchesOriginalBytes()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);

        using var client = UsenetStreamingClient.CreateProviderClient(new()
        {
            Name = "mock",
            Host = server.Host,
            Port = server.Port,
            UseSsl = false,
            Username = server.Username,
            Password = server.Password,
            MaxConnections = 3,
        });

        await using var stream = client.GetFileStream(segmentIds, FileBytes.Length, articleBufferSize: 2);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(FileBytes, ms.ToArray());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(49_999)]        // last byte of first segment
    [InlineData(50_000)]        // first byte of second segment
    [InlineData(157_003)]       // middle of fourth segment
    [InlineData(299_999)]       // last byte of the file
    public async Task Seek_ThenRead_ReturnsCorrectBytes(long offset)
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);

        await using var stream = client.GetFileStream(segmentIds, FileBytes.Length, articleBufferSize: 0);
        stream.Seek(offset, SeekOrigin.Begin);

        var expectedLength = (int)Math.Min(1000, FileBytes.Length - offset);
        var buffer = new byte[expectedLength];
        var read = 0;
        while (read < expectedLength)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read));
            if (n == 0) break;
            read += n;
        }

        Assert.Equal(expectedLength, read);
        Assert.Equal(FileBytes[(int)offset..(int)(offset + expectedLength)], buffer);
    }

    [Fact]
    public async Task SeekBackwards_AfterReading_Works()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);

        await using var stream = client.GetFileStream(segmentIds, FileBytes.Length, articleBufferSize: 0);

        // read some bytes at the end first
        stream.Seek(250_000, SeekOrigin.Begin);
        var tail = new byte[100];
        await stream.ReadAsync(tail.AsMemory());

        // then seek back to the start
        stream.Seek(0, SeekOrigin.Begin);
        var head = new byte[100];
        var read = 0;
        while (read < head.Length)
        {
            var n = await stream.ReadAsync(head.AsMemory(read));
            if (n == 0) break;
            read += n;
        }

        Assert.Equal(FileBytes[..100], head);
    }

    [Fact]
    public async Task ReadPastEnd_ReturnsZero()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);

        await using var stream = client.GetFileStream(segmentIds, FileBytes.Length, articleBufferSize: 0);
        stream.Seek(0, SeekOrigin.End);

        var buffer = new byte[16];
        Assert.Equal(0, await stream.ReadAsync(buffer.AsMemory()));
    }

    [Fact]
    public async Task Read_IsBoundedByAdvertisedLength_AndDisposedReadThrows()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);

        var stream = client.GetFileStream(segmentIds, 100, articleBufferSize: 0);
        var buffer = new byte[1000];
        Assert.Equal(100, await stream.ReadAsync(buffer));
        Assert.Equal(100, stream.Position);
        Assert.Equal(0, await stream.ReadAsync(buffer));

        await stream.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            await stream.ReadAsync(buffer));
        Assert.Throws<ObjectDisposedException>(() => stream.Seek(0, SeekOrigin.Begin));
        Assert.Throws<ObjectDisposedException>(() => _ = stream.Position);
    }

    [Fact]
    public async Task ZeroLengthRead_DoesNotOpenAnArticle()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);
        var before = server.CommandsServed;

        await using var stream = client.GetFileStream(segmentIds, FileBytes.Length, articleBufferSize: 0);
        Assert.Equal(0, await stream.ReadAsync(Memory<byte>.Empty));
        Assert.Equal(before, server.CommandsServed);
    }
}
