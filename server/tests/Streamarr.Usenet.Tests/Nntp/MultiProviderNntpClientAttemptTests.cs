using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Tests.Shared;

namespace Streamarr.Usenet.Tests.Nntp;

public class MultiProviderNntpClientAttemptTests
{
    [Fact]
    public async Task PrimarySuccess_RecordsSingleSuccessfulAttempt()
    {
        await using var primary = new MockNntpServer();
        primary.StatOnlyArticles["present@test"] = 0;

        using var client = UsenetStreamingClient.Create([
            ProviderFor(primary, "primary", priority: 0),
        ]);

        var response = await client.StatAsync("present@test", CancellationToken.None);

        var attempt = Assert.Single(response.ProviderAttempts);
        Assert.Equal("primary", attempt.Provider);
        Assert.Equal("STAT", attempt.Operation);
        Assert.Equal(NntpProviderAttemptOutcome.Success, attempt.Outcome);
        Assert.Equal((int)NntpResponseType.ArticleExists, attempt.ResponseCode);
        Assert.True(attempt.DurationMs >= 0);
        Assert.Null(attempt.ErrorType);
        Assert.Null(attempt.ErrorMessage);
    }

    [Fact]
    public async Task PrimaryMissing_BackupSuccess_RecordsOrderedAttempts()
    {
        var data = YencTestEncoder.LcgBytes(31, 2_000);
        await using var primary = new MockNntpServer();
        await using var backup = new MockNntpServer();
        backup.Articles["backup@test"] = YencTestEncoder.Encode(data, "backup.bin");

        using var client = UsenetStreamingClient.Create([
            ProviderFor(primary, "primary", priority: 0),
            ProviderFor(backup, "backup", priority: 1),
        ]);

        var response = await client.DecodedBodyAsync("backup@test", CancellationToken.None);
        await using (response.Stream)
            await response.Stream.CopyToAsync(Stream.Null);

        Assert.Collection(
            response.ProviderAttempts,
            attempt =>
            {
                Assert.Equal("primary", attempt.Provider);
                Assert.Equal("BODY", attempt.Operation);
                Assert.Equal(NntpProviderAttemptOutcome.Missing, attempt.Outcome);
                Assert.Equal((int)NntpResponseType.NoArticleWithThatMessageId, attempt.ResponseCode);
                Assert.Equal("Usenet article <backup@test> was not found.", attempt.ErrorMessage);
            },
            attempt =>
            {
                Assert.Equal("backup", attempt.Provider);
                Assert.Equal("BODY", attempt.Operation);
                Assert.Equal(NntpProviderAttemptOutcome.Success, attempt.Outcome);
                Assert.Equal((int)NntpResponseType.ArticleRetrievedBodyFollows, attempt.ResponseCode);
            });
    }

    [Fact]
    public async Task PrimaryException_BackupSuccess_RecordsErrorThenSuccess()
    {
        var data = YencTestEncoder.LcgBytes(32, 2_000);
        await using var primary = new MockNntpServer();
        await using var backup = new MockNntpServer();
        primary.BodyScripts["fallback@test"] = _ => MockBodyBehavior.Disconnect;
        backup.Articles["fallback@test"] = YencTestEncoder.Encode(data, "fallback.bin");

        using var client = UsenetStreamingClient.Create([
            ProviderFor(primary, "primary", priority: 0),
            ProviderFor(backup, "backup", priority: 1),
        ]);

        var response = await client.DecodedBodyAsync("fallback@test", CancellationToken.None);
        await using (response.Stream)
            await response.Stream.CopyToAsync(Stream.Null);

        Assert.Collection(
            response.ProviderAttempts,
            attempt =>
            {
                Assert.Equal("primary", attempt.Provider);
                Assert.Equal(NntpProviderAttemptOutcome.Error, attempt.Outcome);
                Assert.NotNull(attempt.ErrorType);
                Assert.NotNull(attempt.ErrorMessage);
                Assert.InRange(attempt.ErrorMessage!.Length, 1, 512);
            },
            attempt =>
            {
                Assert.Equal("backup", attempt.Provider);
                Assert.Equal(NntpProviderAttemptOutcome.Success, attempt.Outcome);
            });
    }

    [Fact]
    public async Task MissingEverywhere_ReturnsFailureWithEveryAttempt()
    {
        await using var primary = new MockNntpServer();
        await using var backup = new MockNntpServer();

        using var client = UsenetStreamingClient.Create([
            ProviderFor(primary, "primary", priority: 0),
            ProviderFor(backup, "backup", priority: 1),
        ]);

        var response = await client.StatAsync("missing@test", CancellationToken.None);

        Assert.False(response.ArticleExists);
        Assert.Equal(
            ["primary", "backup"],
            response.ProviderAttempts.Select(attempt => attempt.Provider));
        Assert.All(response.ProviderAttempts, attempt =>
        {
            Assert.Equal("STAT", attempt.Operation);
            Assert.Equal(NntpProviderAttemptOutcome.Missing, attempt.Outcome);
            Assert.Equal((int)NntpResponseType.NoArticleWithThatMessageId, attempt.ResponseCode);
            Assert.Equal("430 No article with that message-id", attempt.ErrorMessage);
        });
    }

    [Fact]
    public async Task ExceptionsEverywhere_AttachesEveryAttemptToFinalException()
    {
        await using var primary = new MockNntpServer();
        await using var backup = new MockNntpServer();
        primary.BodyScripts["broken@test"] = _ => MockBodyBehavior.Disconnect;
        backup.BodyScripts["broken@test"] = _ => MockBodyBehavior.Disconnect;

        using var client = UsenetStreamingClient.Create([
            ProviderFor(primary, "primary", priority: 0),
            ProviderFor(backup, "backup", priority: 1),
        ]);

        var exception = await Assert.ThrowsAnyAsync<Exception>(
            () => client.DecodedBodyAsync("broken@test", CancellationToken.None));
        var attempts = NntpProviderAttemptMetadata.GetAttempts(exception);

        Assert.Same(attempts, exception.Data[NntpProviderAttemptMetadata.ExceptionDataKey]);
        Assert.Equal(["primary", "backup"], attempts.Select(attempt => attempt.Provider));
        Assert.All(attempts, attempt =>
        {
            Assert.Equal("BODY", attempt.Operation);
            Assert.Equal(NntpProviderAttemptOutcome.Error, attempt.Outcome);
            Assert.True(attempt.DurationMs >= 0);
            Assert.NotNull(attempt.ErrorType);
            Assert.NotNull(attempt.ErrorMessage);
        });
    }

    private static UsenetProvider ProviderFor(MockNntpServer server, string name, int priority) => new()
    {
        Name = name,
        Host = server.Host,
        Port = server.Port,
        UseSsl = false,
        Username = server.Username,
        Password = server.Password,
        MaxConnections = 1,
        Priority = priority,
    };
}
