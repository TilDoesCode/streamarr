using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Fix round 5 (V4b-01): a request ending while it is cancelled is harmless, and download maintenance never stops the host.</summary>
public sealed class DownloadLeaseDisposalTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>
{
    private static readonly DateTimeOffset Past = DateTimeOffset.UnixEpoch;

    private static DownloadTransferGovernor Governor() => new(() => new ViewerDownloadSettings(), new FakeLiveSignal());

    private static TransferLease Admit(DownloadTransferGovernor governor, string downloadId = "a", string capability = "h", DateTimeOffset? deadline = null)
        => governor.TryAdmit(downloadId, "viewer", "tmdb-movie-1", null, governor.Stamp(downloadId, "viewer", capability), deadline ?? Past, default,
            out _, capability, 1)!;

    private static int Run(DownloadTransferGovernor governor, string operation) => operation switch
    {
        "terminal" => governor.EndDownload("a", 1),
        "capability" => governor.RetireCapability("a", "h"),
        "snapshot" => governor.Cancel(governor.ActiveLeases()),
        _ => governor.ExpireDue(Past.AddSeconds(1)),
    };

    [Theory]
    [InlineData("terminal")]
    [InlineData("capability")]
    [InlineData("snapshot")]
    [InlineData("expiry")]
    public void CancellingAFirstRequestThatEndsASecond_EndsBoth_WithoutThrowing(string operation)
    {
        var governor = Governor();
        using var first = Admit(governor);
        using var second = Admit(governor);
        using var _ = first.Token.Register(second.Dispose);

        var ended = Run(governor, operation);

        Assert.Equal(1, ended);
        Assert.True(first.Token.IsCancellationRequested);
        first.Dispose();
        Assert.Equal(0, governor.ActiveTransfers);
        Assert.Empty(governor.ActiveLeases());
    }

    [Fact]
    public void ALease_IsSafeToReadAndAbort_AfterItWasDisposed_AndAbortsOnce()
    {
        var governor = Governor();
        var live = Admit(governor);
        var ended = Admit(governor, "b");

        ended.Dispose();

        Assert.False(ended.Token.IsCancellationRequested);
        Assert.False(ended.Abort());
        Assert.True(live.Abort());
        Assert.False(live.Abort());
        Assert.True(live.Token.IsCancellationRequested);
        live.Dispose();
        Assert.True(live.Token.IsCancellationRequested);
        Assert.False(live.Abort());
        Assert.Equal(0, governor.ActiveTransfers);
    }

    [Theory]
    [InlineData("terminal")]
    [InlineData("capability")]
    [InlineData("snapshot")]
    [InlineData("expiry")]
    public void ARequestWhoseCancellationThrows_NeverKeepsTheOthersAlive(string operation)
    {
        var governor = Governor();
        using var throwing = Admit(governor);
        using var _ = throwing.Token.Register(() => throw new InvalidOperationException("a broken cancellation callback"));
        using var after = Admit(governor);

        var ended = Run(governor, operation);

        Assert.Equal(1, ended);
        Assert.True(throwing.Token.IsCancellationRequested);
        Assert.True(after.Token.IsCancellationRequested);
    }

    [Theory]
    [InlineData("terminal")]
    [InlineData("capability")]
    [InlineData("snapshot")]
    [InlineData("expiry")]
    public async Task RequestsEndingWhileTheyAreCancelled_NeverThrow_In2000ParallelTrials(string operation)
    {
        var errors = 0;
        string? firstError = null;
        for (var n = 0; n < 2000; n++)
        {
            var governor = Governor();
            var first = Admit(governor);
            var second = Admit(governor);
            using var barrier = new Barrier(2);
            await Task.WhenAll(
                Task.Run(() =>
                {
                    barrier.SignalAndWait();
                    try
                    {
                        Run(governor, operation);
                    }
                    catch (Exception e)
                    {
                        Interlocked.Increment(ref errors);
                        Interlocked.CompareExchange(ref firstError, e.GetType().Name, null);
                    }
                }),
                Task.Run(() =>
                {
                    barrier.SignalAndWait();
                    second.Dispose();
                    first.Dispose();
                }));
            Assert.Equal(0, governor.ActiveTransfers);
        }

        Assert.True(errors == 0, $"{errors} of 2000 trials threw ({firstError})");
    }

    /// <summary>The production service with its own governor (and optionally its own database access), in a real Generic Host.</summary>
    private (IHost Host, ViewerDownloadService Service, Task Stopping) Host(DownloadTransferGovernor governor, IDbContextFactory<StreamarrDbContext>? db = null)
    {
        var service = db is null
            ? ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, governor)
            : ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, governor, db);
        var host = new HostBuilder().ConfigureServices(s => s.AddSingleton<IHostedService>(service)).Build();
        var stopping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping.Register(() => stopping.TrySetResult());
        Assert.Equal(BackgroundServiceExceptionBehavior.StopHost, host.Services.GetRequiredService<IOptions<HostOptions>>().Value.BackgroundServiceExceptionBehavior);
        return (host, service, stopping.Task);
    }

    private static async Task<bool> EndedWithinAsync(TransferLease lease, TimeSpan within)
    {
        var deadline = DateTime.UtcNow + within;
        while (!lease.Token.IsCancellationRequested && DateTime.UtcNow < deadline)
            await Task.Delay(20);
        return lease.Token.IsCancellationRequested;
    }

    private static async Task AssertKeepsRunningAsync(Task stopping, ViewerDownloadService service, TimeSpan forAtLeast)
    {
        Assert.NotSame(stopping, await Task.WhenAny(stopping, Task.Delay(forAtLeast)));
        Assert.False(service.ExecuteTask!.IsCompleted, $"the download service stopped: {service.ExecuteTask.Exception?.GetBaseException()}");
    }

    [Fact]
    public async Task ExpiringRequestsThatEndEachOtherOrThrow_NeverStopTheHost_AndTheNextSweepsRun()
    {
        var governor = Governor();
        var (host, service, stopping) = Host(governor);
        using (host)
        {
            await host.StartAsync();
            using var first = Admit(governor);
            using var second = Admit(governor);
            using var disposes = first.Token.Register(second.Dispose);
            using var throwing = Admit(governor, "b");
            using var breaks = throwing.Token.Register(() => throw new InvalidOperationException("a broken cancellation callback"));

            await AssertKeepsRunningAsync(stopping, service, TimeSpan.FromSeconds(2));
            Assert.True(first.Token.IsCancellationRequested);
            Assert.True(throwing.Token.IsCancellationRequested);

            // The ended requests finish; a later sweep still runs and ends a request expiring now as well.
            first.Dispose();
            throwing.Dispose();
            using var later = Admit(governor, "c");
            Assert.True(await EndedWithinAsync(later, TimeSpan.FromSeconds(5)), "no sweep ran after the failure");
            await AssertKeepsRunningAsync(stopping, service, TimeSpan.FromMilliseconds(200));
            await host.StopAsync();
        }
    }

    /// <summary>Throws an exception no sweep expects (not a database error) for the first reads of the download table.</summary>
    private sealed class BreakDownloadReads(int times) : DbCommandInterceptor
    {
        private int _left = times;

        public int Thrown => times - Math.Max(0, Volatile.Read(ref _left));

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("\"ViewerDownloads\"", StringComparison.Ordinal) && Interlocked.Decrement(ref _left) >= 0)
                throw new NotSupportedException("an unexpected failure inside the download maintenance");
            return ValueTask.FromResult(result);
        }
    }

    private sealed class OptionsFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);

        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
    }

    [Fact]
    public async Task AnUnexpectedFailureInTheStartupOrTheSweep_NeverStopsTheHost_AndTheSweepRecovers()
    {
        string connection;
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
            connection = db.Database.GetConnectionString()!;
        var breaks = new BreakDownloadReads(3);
        var broken = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite(connection).AddInterceptors(breaks).Options);
        var governor = Governor();
        using var orphan = Admit(governor, "no-such-download", deadline: DateTimeOffset.MaxValue);
        var (host, service, stopping) = Host(governor, broken);
        using (host)
        {
            await host.StartAsync();

            // The startup resume and two sweeps fail; the following sweep ends the request whose download does not exist.
            var recovered = await EndedWithinAsync(orphan, TimeSpan.FromSeconds(10));

            Assert.Equal(3, breaks.Thrown);
            Assert.True(recovered, "the sweep never recovered");
            await AssertKeepsRunningAsync(stopping, service, TimeSpan.FromMilliseconds(500));
            await host.StopAsync();
        }
    }
}
