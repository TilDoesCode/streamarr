using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence;
using Streamarr.Server.Security;

namespace Streamarr.Server.Tests.Services;

public sealed class GeneralConfigServiceTests
{
    [Fact]
    public async Task ConcurrentCredentialUpdates_SerializeCommitAndLiveAssignment()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-general-config-");
        try
        {
            var options = new DbContextOptionsBuilder<StreamarrDbContext>()
                .UseSqlite($"Data Source={Path.Combine(directory.FullName, "config.db")}")
                .Options;
            await using (var setup = new StreamarrDbContext(options))
                await setup.Database.EnsureCreatedAsync();

            var factory = new BlockingFirstDbContextFactory(options);
            var protector = new TestSecretProtector();
            var live = new TmdbOptions();
            var service = new GeneralConfigService(factory, protector, live);

            var first = service.UpdateAsync(new GeneralConfigWrite { TmdbApiKey = "credential-a" }, default);
            await factory.FirstCallEntered.WaitAsync(TimeSpan.FromSeconds(2));

            var second = service.UpdateAsync(new GeneralConfigWrite { TmdbApiKey = "credential-b" }, default);

            // The first update is deliberately stopped before opening its DbContext. A
            // second update must remain outside the complete commit/live-update section.
            var callCountWhileFirstWasBlocked = factory.CallCount;

            factory.ReleaseFirstCall();
            await Task.WhenAll(first, second);

            Assert.Equal(1, callCountWhileFirstWasBlocked);
            await using var verification = new StreamarrDbContext(options);
            var persisted = await verification.GeneralConfig.SingleAsync(entity => entity.Id == 1);
            Assert.Equal("credential-b", protector.Unprotect(persisted.TmdbApiKeyEncrypted));
            Assert.Equal("credential-b", live.ApiKey);
            Assert.Equal(2, factory.CallCount);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    private sealed class BlockingFirstDbContextFactory(DbContextOptions<StreamarrDbContext> options)
        : IDbContextFactory<StreamarrDbContext>
    {
        private readonly TaskCompletionSource _firstCallEntered =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseFirstCall =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _callCount;

        public int CallCount => Volatile.Read(ref _callCount);
        public Task FirstCallEntered => _firstCallEntered.Task;

        public StreamarrDbContext CreateDbContext() => new(options);

        public async Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default)
        {
            if (Interlocked.Increment(ref _callCount) == 1)
            {
                _firstCallEntered.TrySetResult();
                await _releaseFirstCall.Task.WaitAsync(cancellationToken);
            }

            return CreateDbContext();
        }

        public void ReleaseFirstCall() => _releaseFirstCall.TrySetResult();
    }

    private sealed class TestSecretProtector : ISecretProtector
    {
        public string? Protect(string? plaintext)
            => string.IsNullOrEmpty(plaintext) ? null : $"protected:{plaintext}";

        public string Unprotect(string? ciphertext)
            => ciphertext?.StartsWith("protected:", StringComparison.Ordinal) == true
                ? ciphertext["protected:".Length..]
                : string.Empty;
    }
}
