using Streamarr.Tests.Shared;
using Streamarr.Server.Services;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Tests.Services;

public sealed class ArticleTrackingNntpClientTests
{
    [Fact]
    public async Task BodyDecodeFailure_ReclassifiesTheFinalProviderAttemptAsError()
    {
        const string messageId = "broken@example";
        var data = YencTestEncoder.LcgBytes(41, 4_096);
        var lines = YencTestEncoder.Encode(data, "broken.bin").Split("\r\n").ToList();
        lines.RemoveAt(2);

        var inner = new FakeNntpClient([messageId])
        {
            BodyProviderName = "primary",
        };
        inner.BodyOverrides[messageId] = string.Join("\r\n", lines);
        var tracker = new ArticleDownloadTracker(
            "release-1",
            [new ArticleManifestEntry(messageId)],
            TimeProvider.System);
        using var client = new ArticleTrackingNntpClient(inner, tracker);

        var response = await client.DecodedBodyAsync(messageId, CancellationToken.None);
        await using (response.Stream)
        {
            await Assert.ThrowsAsync<YencCrcMismatchException>(async () =>
                await response.Stream.CopyToAsync(Stream.Null));
        }

        var article = Assert.Single(tracker.Snapshot().Articles);
        var attempt = Assert.Single(article.Attempts);
        Assert.Equal("primary", attempt.Provider);
        Assert.Equal("error", attempt.Outcome);
        Assert.Equal(nameof(YencCrcMismatchException), attempt.ErrorType);
        Assert.Contains("size mismatch", attempt.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        Assert.Null(article.SuccessfulProvider);
        var provider = Assert.Single(tracker.Snapshot().Providers);
        Assert.Equal(0, provider.Successes);
        Assert.Equal(1, provider.Errors);
    }
}
