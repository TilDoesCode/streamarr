using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nzb;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Streams;
using Streamarr.Usenet.Yenc;
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

    [Fact]
    public async Task Seek_ReusesMatchedBodyInsteadOfDownloadingItTwice()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);
        await using var stream = client.GetFileStream(segmentIds, FileBytes.Length, articleBufferSize: 0);
        var before = server.BodiesServed;

        stream.Seek(157_003, SeekOrigin.Begin);
        var buffer = new byte[100];
        await stream.ReadExactlyAsync(buffer);

        Assert.Equal(FileBytes[157_003..157_103], buffer);
        Assert.Equal(1, server.BodiesServed - before);
    }

    [Fact]
    public async Task NearEndSeek_DisablesReadAheadForShortTailRanges()
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
            MaxConnections = 6,
        });
        await using var stream = new Streamarr.Usenet.Streams.NzbFileStream(
            segmentIds,
            FileBytes.Length,
            client,
            articleBufferSize: 3,
            startupArticleBufferSize: 6,
            startupReadAheadSegments: 6);
        var before = server.BodiesServed;

        stream.Seek(200_000, SeekOrigin.Begin); // second-last article
        var oneByte = new byte[1];
        await stream.ReadExactlyAsync(oneByte);
        await Task.Delay(50);

        Assert.Equal(FileBytes[200_000], oneByte[0]);
        Assert.Equal(1, server.BodiesServed - before);
    }

    [Fact]
    public async Task MidFileSeek_DoesNotRearmTheStartupReadAheadBurst()
    {
        // Regression guard for the resume-TTFF bug: every mid-file open (transcode restart,
        // resume, ffprobe cue probing) used to fire the enlarged startup read-ahead window,
        // downloading ~startup-window articles for a 1-byte ranged read. A seek-opened
        // stream must pay only the interpolation probe(s) plus the steady pipeline.
        const int parts = 24;
        await using var server = new MockNntpServer();
        var fileBytes = YencTestEncoder.LcgBytes(4321, PartSize * parts);
        var segmentIds = new string[parts];
        for (var i = 0; i < parts; i++)
        {
            var begin = (long)i * PartSize + 1;
            var id = $"mid{i + 1}@test";
            server.Articles[id] = YencTestEncoder.EncodePart(
                fileBytes, "movie.mkv", i + 1, parts, begin, begin + PartSize - 1);
            segmentIds[i] = id;
        }

        using var client = UsenetStreamingClient.CreateProviderClient(new()
        {
            Name = "mock",
            Host = server.Host,
            Port = server.Port,
            UseSsl = false,
            Username = server.Username,
            Password = server.Password,
            MaxConnections = 10,
        });
        await using var stream = new NzbFileStream(
            segmentIds,
            fileBytes.Length,
            client,
            articleBufferSize: 3,
            startupArticleBufferSize: 8,
            startupReadAheadSegments: 8);
        var before = server.BodiesServed;

        stream.Seek(12L * PartSize + 100, SeekOrigin.Begin); // middle of part 13 of 24
        var oneByte = new byte[1];
        await stream.ReadExactlyAsync(oneByte);
        await Task.Delay(100); // let any in-flight read-ahead land on the counter

        Assert.Equal(fileBytes[12 * PartSize + 100], oneByte[0]);
        // Probe hits part 13 directly (uniform parts), the matched body is reused, and the
        // steady window (3) pipelines a handful more. The pre-fix startup burst (8) made
        // this >= 9 bodies for a single byte.
        Assert.InRange(server.BodiesServed - before, 1, 5);
    }

    [Fact]
    public async Task BufferedNzb_DefaultPathCachesAndValidatesFirstArticleBeforeDelivery()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);
        using var cache = new SegmentCache(1024 * 1024);
        await using var stream = new NzbFileStream(
            segmentIds,
            FileBytes.Length,
            client,
            articleBufferSize: 3,
            segmentCache: cache);

        var oneByte = new byte[1];
        await stream.ReadExactlyAsync(oneByte);

        Assert.Equal(FileBytes[0], oneByte[0]);
        Assert.Equal(1, cache.GetStats([segmentIds[0]]).Count);
    }

    [Fact]
    public async Task NearEndOnDemandPath_RetainsCachePolicyForEveryTailArticle()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);
        using var cache = new SegmentCache(1024 * 1024);
        await using var stream = new NzbFileStream(
            segmentIds,
            FileBytes.Length,
            client,
            articleBufferSize: 3,
            segmentCache: cache);

        stream.Seek(200_000, SeekOrigin.Begin);
        using var output = new MemoryStream();
        await stream.CopyToAsync(output);

        Assert.Equal(FileBytes[200_000..], output.ToArray());
        Assert.Equal(2, cache.GetStats(segmentIds[^2..]).Count);
    }

    [Fact]
    public async Task StartupWindowSmallerThanSteadyWindow_IsClampedInsteadOfRejected()
    {
        await using var server = new MockNntpServer();
        var segmentIds = PublishSegments(server);
        using var client = await Connect(server);
        await using var stream = new NzbFileStream(
            segmentIds,
            FileBytes.Length,
            client,
            articleBufferSize: 3,
            startupArticleBufferSize: 1,
            startupReadAheadSegments: 1);

        var oneByte = new byte[1];
        await stream.ReadExactlyAsync(oneByte);

        Assert.Equal(FileBytes[0], oneByte[0]);
    }

    [Fact]
    public async Task SeekDiscardCancellation_DisposesTheMatchedBody()
    {
        var client = new BlockingSeekNntpClient();
        await using var stream = new NzbFileStream(
            ["blocking@test"],
            fileSize: 10,
            usenetClient: client,
            articleBufferSize: 0);
        stream.Seek(1, SeekOrigin.Begin);
        using var cancellation = new CancellationTokenSource();

        var read = stream.ReadAsync(new byte[1], cancellation.Token).AsTask();
        await client.Body.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => read.WaitAsync(TimeSpan.FromSeconds(1)));
        Assert.True(client.Body.IsDisposed);
    }

    private sealed class BlockingSeekNntpClient : NntpClientBase
    {
        public BlockingDecodedStream Body { get; } = new();

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken)
            => Task.FromResult(new NntpDecodedBodyResponse
            {
                ResponseCode = 222,
                ResponseMessage = "222 body follows",
                SegmentId = segmentId,
                Stream = Body,
            });

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            Action<ArticleBodyResult>? onConnectionReadyAgain,
            CancellationToken cancellationToken)
            => DecodedBodyAsync(segmentId, cancellationToken);

        public override Task ConnectAsync(
            string host,
            int port,
            bool useSsl,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task<NntpResponse> AuthenticateAsync(
            string user,
            string pass,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task<NntpStatResponse> StatAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task<NntpHeadResponse> HeadAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
            SegmentId segmentId,
            Action<ArticleBodyResult>? onConnectionReadyAgain,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken)
            => throw new NotSupportedException();
        public override void Dispose() { }
    }

    private sealed class BlockingDecodedStream : YencStream
    {
        public BlockingDecodedStream() : base(Stream.Null) { }

        public TaskCompletionSource ReadStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool IsDisposed { get; private set; }

        public override ValueTask<YencHeader?> GetYencHeadersAsync(
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<YencHeader?>(new YencHeader
            {
                FileName = "blocking.bin",
                FileSize = 10,
                PartOffset = 0,
                PartSize = 10,
                LineLength = 128,
                PartNumber = 1,
                TotalParts = 1,
            });

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            ReadStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }

        protected override void Dispose(bool disposing)
        {
            IsDisposed = true;
            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            IsDisposed = true;
            await base.DisposeAsync();
        }
    }
}
