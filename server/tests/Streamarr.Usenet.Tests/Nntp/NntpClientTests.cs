using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Nntp;
using Streamarr.Tests.Shared;

namespace Streamarr.Usenet.Tests.Nntp;

public class NntpClientTests
{
    private static async Task<SingleConnectionNntpClient> Connect(MockNntpServer server, bool authenticate = true)
    {
        var client = new SingleConnectionNntpClient();
        await client.ConnectAsync(server.Host, server.Port, useSsl: false, CancellationToken.None);
        if (authenticate)
            await client.AuthenticateAsync(server.Username, server.Password, CancellationToken.None);
        return client;
    }

    [Fact]
    public async Task Connect_And_Authenticate_Succeeds()
    {
        await using var server = new MockNntpServer();
        using var client = await Connect(server, authenticate: false);

        var response = await client.AuthenticateAsync("user", "pass", CancellationToken.None);
        Assert.Equal(NntpResponseType.AuthenticationAccepted, response.ResponseType);
    }

    [Fact]
    public async Task Authenticate_WrongPassword_Throws()
    {
        await using var server = new MockNntpServer();
        using var client = await Connect(server, authenticate: false);

        await Assert.ThrowsAsync<CouldNotLoginToUsenetException>(
            () => client.AuthenticateAsync("user", "WRONG", CancellationToken.None));
    }

    [Fact]
    public async Task Connect_UnreachableHost_Throws()
    {
        using var client = new SingleConnectionNntpClient();
        await Assert.ThrowsAsync<CouldNotConnectToUsenetException>(
            () => client.ConnectAsync("127.0.0.1", 1, useSsl: false, CancellationToken.None));
    }

    [Fact]
    public async Task Stat_ReportsExistingAndMissingArticles()
    {
        await using var server = new MockNntpServer();
        server.Articles["exists@test"] = YencTestEncoder.Encode([1, 2, 3], "x.bin");
        using var client = await Connect(server);

        var found = await client.StatAsync("exists@test", CancellationToken.None);
        Assert.True(found.ArticleExists);
        Assert.Equal(NntpResponseType.ArticleExists, found.ResponseType);

        var missing = await client.StatAsync("missing@test", CancellationToken.None);
        Assert.False(missing.ArticleExists);
        Assert.Equal(NntpResponseType.NoArticleWithThatMessageId, missing.ResponseType);
    }

    [Fact]
    public async Task DecodedBody_ReturnsDecodedContent()
    {
        var data = YencTestEncoder.LcgBytes(1, 50_000);
        await using var server = new MockNntpServer();
        server.Articles["body@test"] = YencTestEncoder.Encode(data, "file.bin");
        using var client = await Connect(server);

        var response = await client.DecodedBodyAsync("body@test", CancellationToken.None);
        await using var stream = response.Stream;
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(data, ms.ToArray());
    }

    [Fact]
    public async Task DecodedBody_MissingArticle_Throws()
    {
        await using var server = new MockNntpServer();
        using var client = await Connect(server);

        await Assert.ThrowsAsync<UsenetArticleNotFoundException>(
            () => client.DecodedBodyAsync("nope@test", CancellationToken.None));
    }

    [Fact]
    public async Task DecodedArticle_ReturnsHeadersAndDecodedContent()
    {
        var data = YencTestEncoder.LcgBytes(2, 10_000);
        await using var server = new MockNntpServer();
        server.Articles["article@test"] = YencTestEncoder.Encode(data, "file.bin");
        using var client = await Connect(server);

        var response = await client.DecodedArticleAsync("article@test", CancellationToken.None);
        Assert.Equal("<article@test>", response.ArticleHeaders.Headers["Message-ID"]);

        await using var stream = response.Stream;
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);
        Assert.Equal(data, ms.ToArray());
    }

    [Fact]
    public async Task DotStuffedLines_AreUnstuffedTransparently()
    {
        // every encoded byte 0x2E ('.') decodes from raw byte 0x04; a payload of
        // 0x04s makes every yEnc data line start with '.', forcing dot-stuffing.
        var data = new byte[600];
        Array.Fill(data, (byte)0x04);

        await using var server = new MockNntpServer();
        var article = YencTestEncoder.Encode(data, "dots.bin");
        Assert.Contains("\r\n.", article); // sanity: lines really start with '.'
        server.Articles["dots@test"] = article;
        using var client = await Connect(server);

        var response = await client.DecodedBodyAsync("dots@test", CancellationToken.None);
        await using var stream = response.Stream;
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(data, ms.ToArray());
    }

    [Fact]
    public async Task Date_ReturnsServerTime()
    {
        await using var server = new MockNntpServer();
        using var client = await Connect(server);

        var response = await client.DateAsync(CancellationToken.None);
        Assert.Equal(NntpResponseType.DateAndTime, response.ResponseType);
        Assert.Equal(new DateTimeOffset(2026, 7, 12, 12, 0, 0, TimeSpan.Zero), response.DateTime);
    }

    [Fact]
    public async Task GroupAndOverview_DiscoverRecentArticles()
    {
        await using var server = new MockNntpServer();
        server.Articles["small@test"] = YencTestEncoder.Encode([1, 2, 3], "small.bin");
        server.Articles["large@test"] = YencTestEncoder.Encode(
            YencTestEncoder.LcgBytes(91, 128 * 1024),
            "large.bin");
        using var connection = new NntpConnection();
        await connection.ConnectAsync(server.Host, server.Port, useSsl: false, CancellationToken.None);

        var group = await connection.GroupAsync("alt.binaries.test", CancellationToken.None);
        var overview = await connection.OverviewAsync(
            group.LowArticleNumber,
            group.HighArticleNumber,
            CancellationToken.None);

        Assert.Equal(NntpResponseType.GroupSelected, group.ResponseType);
        Assert.Equal(2, group.EstimatedArticleCount);
        Assert.Equal(NntpResponseType.OverviewInformationFollows, overview.ResponseType);
        Assert.Contains(overview.Entries, entry =>
            entry.SegmentId.ToString() == "large@test" && entry.Bytes >= 128 * 1024);
    }

    [Fact]
    public async Task Head_ReturnsHeaders()
    {
        await using var server = new MockNntpServer();
        server.Articles["head@test"] = YencTestEncoder.Encode([9], "x.bin");
        using var client = await Connect(server);

        var response = await client.HeadAsync("head@test", CancellationToken.None);
        Assert.Equal("<head@test>", response.ArticleHeaders!.Headers["Message-ID"]);
    }

    [Fact]
    public async Task Head_RejectsExcessiveHeaderCounts()
    {
        await using var server = new MockNntpServer { ExtraHeadHeaders = 300 };
        server.Articles["headers@test"] = YencTestEncoder.Encode([9], "x.bin");
        using var client = await Connect(server);

        await Assert.ThrowsAsync<UsenetProtocolException>(() =>
            client.HeadAsync("headers@test", CancellationToken.None));
    }

    [Fact]
    public async Task Body_RejectsOverlongWireLines_AndSignalsConnectionFailure()
    {
        await using var server = new MockNntpServer();
        server.Articles["long-line@test"] = new string('x', 1024 * 1024 + 1) + "\r\n";
        using var connection = new NntpConnection();
        await connection.ConnectAsync(server.Host, server.Port, useSsl: false, CancellationToken.None);
        var completed = new TaskCompletionSource<ArticleBodyResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        var response = await connection.BodyAsync(
            "long-line@test",
            result => completed.TrySetResult(result),
            CancellationToken.None);
        await using var body = response.Stream!;

        await Assert.ThrowsAnyAsync<Exception>(() => body.CopyToAsync(Stream.Null));
        Assert.Equal(
            ArticleBodyResult.NotRetrieved,
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task GetYencHeaders_ProbesPartOffsets()
    {
        var whole = YencTestEncoder.LcgBytes(4, 9000);
        await using var server = new MockNntpServer();
        server.Articles["p2@test"] = YencTestEncoder.EncodePart(whole, "file.bin", 2, 3, 3001, 6000);
        using var client = await Connect(server);

        var header = await client.GetYencHeadersAsync("p2@test", CancellationToken.None);
        Assert.Equal(3000, header.PartOffset);
        Assert.Equal(3000, header.PartSize);
    }

    [Fact]
    public async Task SequentialCommands_ReuseTheConnection()
    {
        var data = YencTestEncoder.LcgBytes(8, 5000);
        await using var server = new MockNntpServer();
        server.Articles["a@test"] = YencTestEncoder.Encode(data, "a.bin");
        server.Articles["b@test"] = YencTestEncoder.Encode(data, "b.bin");
        using var client = await Connect(server);

        foreach (var id in new[] { "a@test", "b@test", "a@test" })
        {
            var response = await client.DecodedBodyAsync(id, CancellationToken.None);
            await using var stream = response.Stream;
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms);
            Assert.Equal(data, ms.ToArray());
        }

        Assert.Equal(1, server.MaxObservedConnections);
    }

    [Fact]
    public async Task CheckAllSegments_ThrowsOnFirstMissingArticle()
    {
        await using var server = new MockNntpServer();
        server.Articles["ok1@test"] = YencTestEncoder.Encode([1], "x.bin");
        server.Articles["ok2@test"] = YencTestEncoder.Encode([2], "x.bin");
        using var client = await Connect(server);

        // all present: passes
        await client.CheckAllSegmentsAsync(["ok1@test", "ok2@test"], 2, null, CancellationToken.None);

        // one missing: throws
        await Assert.ThrowsAsync<UsenetArticleNotFoundException>(() =>
            client.CheckAllSegmentsAsync(["ok1@test", "gone@test"], 1, null, CancellationToken.None));
    }
}
