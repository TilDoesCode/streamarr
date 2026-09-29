using Streamarr.Tests.Shared;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Usenet.Tests.Nntp;

/// <summary>Covers the lazy article source and STAT-disconnect hooks the Dev World harness relies on.</summary>
public class MockArticleSourceTests
{
    private const int PartSize = 10_000;

    private sealed class SlicingSource(byte[] file, string name, int missingPart) : IMockArticleSource
    {
        private int Parts => (file.Length + PartSize - 1) / PartSize;

        public bool Contains(string messageId) => Part(messageId) is { } part && part != missingPart;

        public string? Get(string messageId)
        {
            if (Part(messageId) is not { } part || part == missingPart)
                return null;
            var begin = (part - 1) * PartSize;
            var slice = file.AsSpan(begin, Math.Min(PartSize, file.Length - begin));
            return YencTestEncoder.EncodePartSlice(slice, name, part, Parts, begin + 1, file.Length);
        }

        private int? Part(string messageId)
            => messageId.StartsWith("lazy-", StringComparison.Ordinal)
               && int.TryParse(messageId.AsSpan(5, messageId.IndexOf('@') - 5), out var part)
               && part >= 1 && part <= Parts
                ? part
                : null;
    }

    private static UsenetProvider ProviderFor(MockNntpServer server) => new()
    {
        Name = "mock",
        Host = server.Host,
        Port = server.Port,
        UseSsl = false,
        Username = server.Username,
        Password = server.Password,
        MaxConnections = 2,
    };

    [Fact]
    public void EncodePartSlice_MatchesWholeFileEncoder_AndPredictedLength()
    {
        var file = YencTestEncoder.LcgBytes(21, 25_000);
        for (var part = 1; part <= 3; part++)
        {
            var begin = (part - 1) * PartSize + 1L;
            var end = Math.Min(begin + PartSize - 1, file.Length);
            var slice = file.AsSpan((int)begin - 1, (int)(end - begin + 1));

            var expected = YencTestEncoder.EncodePart(file, "f.bin", part, 3, begin, end);
            var actual = YencTestEncoder.EncodePartSlice(slice, "f.bin", part, 3, begin, file.Length);

            Assert.Equal(expected, actual);
            Assert.Equal(actual.Length, YencTestEncoder.EncodedPartLength(slice, "f.bin", part, 3, begin, file.Length));
        }
    }

    [Fact]
    public async Task ArticleSource_ServesLazyBodies_AndReportsMissingParts()
    {
        var file = YencTestEncoder.LcgBytes(22, 25_000);
        await using var server = new MockNntpServer { ArticleSource = new SlicingSource(file, "lazy.bin", missingPart: 3) };
        using var client = UsenetStreamingClient.CreateProviderClient(ProviderFor(server));

        var body = await client.DecodedBodyAsync("lazy-2@test", CancellationToken.None);
        await using (var stream = body.Stream)
        {
            using var copy = new MemoryStream();
            await stream.CopyToAsync(copy);
            Assert.Equal(file.AsSpan(PartSize, PartSize).ToArray(), copy.ToArray());
        }

        Assert.True((await client.StatAsync("lazy-1@test", CancellationToken.None)).ArticleExists);
        Assert.False((await client.StatAsync("lazy-3@test", CancellationToken.None)).ArticleExists);
    }

    [Fact]
    public async Task StatDisconnects_FailTheProbeInsteadOfReportingMissing()
    {
        var file = YencTestEncoder.LcgBytes(23, 5_000);
        await using var server = new MockNntpServer { ArticleSource = new SlicingSource(file, "lazy.bin", missingPart: 0) };
        server.StatDisconnects["lazy-1@test"] = 0;
        using var client = UsenetStreamingClient.CreateProviderClient(ProviderFor(server));

        await Assert.ThrowsAsync<UsenetProtocolException>(() => client.StatAsync("lazy-1@test", CancellationToken.None));
        Assert.False((await client.StatAsync("lazy-2@test", CancellationToken.None)).ArticleExists);
        Assert.Equal(0, server.BodiesServed);
    }
}
