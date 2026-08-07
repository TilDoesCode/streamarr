using System.Text;
using Streamarr.Server.Tests.Services;
using Streamarr.Server.Services.Repair;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Tests.Services.Repair;

/// <summary>
/// Transient transport failures (disconnects, read timeouts) during source
/// materialization must retry on a fresh pooled connection and, once retries are
/// exhausted, degrade to a damaged range that PAR2 recovers — they must never
/// escape and kill the whole repair job (found live against a real provider).
/// </summary>
public class RepairSourceMaterializerTests
{
    private static async Task<NzbFile> ParseSingleFileAsync(PublishedNzbFile published)
    {
        using var ms = new MemoryStream(Encoding.UTF8.GetBytes(NzbTestFixtures.BuildNzbXml(published)));
        var document = await NzbDocument.LoadAsync(ms);
        return document.Files.Single();
    }

    private static MultiConnectionNntpClient Client(MockNntpServer server) => UsenetStreamingClient.CreateProviderClient(new()
    {
        Name = "mock",
        Host = server.Host,
        Port = server.Port,
        UseSsl = false,
        Username = server.Username,
        Password = server.Password,
        MaxConnections = 3,
    });

    [Fact]
    public async Task DisconnectOnFirstAttempt_RetriesAndMaterializesByteExactly()
    {
        var payload = new byte[300_000];
        new Random(11).NextBytes(payload);
        await using var server = new MockNntpServer { RequireAuth = true };
        var published = NzbTestFixtures.PublishFile(server, "video.mkv", payload, "retry", partSize: 64_000);

        // Every article's very first BODY attempt drops the connection mid-command.
        foreach (var id in published.SegmentIds)
            server.BodyScripts[id] = call => call == 1 ? MockBodyBehavior.Disconnect : MockBodyBehavior.Serve;

        using var client = Client(server);
        var materializer = new RepairSourceMaterializer(client);
        var nzbFile = await ParseSingleFileAsync(published);

        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            using var staging = workspace.CreateStaging("aaaa1111bbbb2222");
            var sparse = staging.OpenFile(RepairWorkspace.SourceFileName(0), payload.Length);
            var result = await materializer.MaterializeAsync(
                nzbFile, sparse, concurrency: 2, onBytes: null, CancellationToken.None);

            Assert.Equal(0, result.MissingArticles);
            Assert.Equal(0, result.CorruptArticles);
            Assert.Empty(result.MissingRanges);
            var actual = new byte[payload.Length];
            sparse.ReadAt(0, actual);
            Assert.Equal(payload, actual);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task PersistentDisconnect_BecomesADamagedRange_InsteadOfKillingTheJob()
    {
        var payload = new byte[300_000];
        new Random(12).NextBytes(payload);
        await using var server = new MockNntpServer { RequireAuth = true };
        var published = NzbTestFixtures.PublishFile(server, "video.mkv", payload, "dead-conn", partSize: 64_000);
        server.BodyScripts[published.SegmentIds[2]] = _ => MockBodyBehavior.Disconnect;

        using var client = Client(server);
        var materializer = new RepairSourceMaterializer(client);
        var nzbFile = await ParseSingleFileAsync(published);

        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            using var staging = workspace.CreateStaging("cccc3333dddd4444");
            var sparse = staging.OpenFile(RepairWorkspace.SourceFileName(0), payload.Length);
            var result = await materializer.MaterializeAsync(
                nzbFile, sparse, concurrency: 2, onBytes: null, CancellationToken.None);

            Assert.Equal(1, result.CorruptArticles);
            var range = Assert.Single(result.MissingRanges);
            Assert.Equal(2 * 64_000, range.StartInclusive);
            Assert.Equal(3 * 64_000, range.EndExclusive);

            // Everything around the failed article is present and byte-exact.
            var actual = new byte[payload.Length];
            sparse.ReadAt(0, actual);
            Assert.Equal(payload[..(2 * 64_000)], actual[..(2 * 64_000)]);
            Assert.Equal(payload[(3 * 64_000)..], actual[(3 * 64_000)..]);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task SmallFileDownload_RejectsAPartWhoseDecodedOffsetExceedsTheBound()
    {
        const string messageId = "malicious-offset@test";
        var client = new FakeNntpClient([messageId]);
        var payload = Enumerable.Range(0, 110).Select(i => (byte)i).ToArray();
        client.BodyOverrides[messageId] = YencTestEncoder.EncodePart(
            payload, "index.par2", 1, 1, 101, 110);
        var nzbFile = new NzbFile { Subject = "\"index.par2\" yEnc" };
        nzbFile.Segments.Add(new NzbSegment { Bytes = 10, Number = 1, MessageId = messageId });
        var materializer = new RepairSourceMaterializer(client);

        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            materializer.DownloadSmallFileAsync(nzbFile, maxBytes: 100, CancellationToken.None));

        Assert.Contains("out-of-range", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SmallFileDownload_BoundsCumulativeDecodedPayloadEvenWhenPartsOverlap()
    {
        var payload = new byte[60];
        var client = new FakeNntpClient(["part-1@test", "part-2@test"]);
        client.BodyOverrides["part-1@test"] = YencTestEncoder.Encode(payload, "index.par2");
        client.BodyOverrides["part-2@test"] = YencTestEncoder.Encode(payload, "index.par2");
        var nzbFile = new NzbFile { Subject = "\"index.par2\" yEnc" };
        nzbFile.Segments.Add(new NzbSegment { Bytes = 60, Number = 1, MessageId = "part-1@test" });
        nzbFile.Segments.Add(new NzbSegment { Bytes = 60, Number = 2, MessageId = "part-2@test" });
        var materializer = new RepairSourceMaterializer(client);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            materializer.DownloadSmallFileAsync(nzbFile, maxBytes: 100, CancellationToken.None));

        Assert.Contains("size limit", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecodedLengthProbe_SpreadsItsBoundedAttemptsAcrossLaterArticles()
    {
        const string lastMessageId = "segment-99@test";
        var client = new FakeNntpClient([lastMessageId]);
        client.BodyOverrides[lastMessageId] = YencTestEncoder.Encode(new byte[12_345], "volume.par2");
        var file = new NzbFile { Subject = "\"volume.par2\" yEnc" };
        for (var i = 0; i < 100; i++)
        {
            file.Segments.Add(new NzbSegment
            {
                Bytes = 1_000,
                Number = i + 1,
                MessageId = $"segment-{i}@test",
            });
        }

        var length = await RepairCoordinator.ProbeDecodedLengthAsync(
            file,
            client,
            CancellationToken.None);

        Assert.Equal(12_345, length);
        Assert.InRange(client.BodyRequestedSegments.Count, 4, 16);
        Assert.Equal(["segment-0@test", "segment-1@test", "segment-2@test"],
            client.BodyRequestedSegments.Take(3));
        Assert.Contains(lastMessageId, client.BodyRequestedSegments);
    }
}
