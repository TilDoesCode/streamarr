using System.Data.Common;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Tests.Viewers.Downloads;

Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(Directory.GetCurrentDirectory(), "server/src/Streamarr.Server"));
using var factory = new ViewerDownloadFactory();
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
var original = factory.Services.GetRequiredService<DbContextOptions<StreamarrDbContext>>();
var intercept = new StopOnWrite();
var wrapped = new AccountingFactory(new DbContextOptionsBuilder<StreamarrDbContext>(original).AddInterceptors(intercept).Options);
var accounting = new DownloadAccounting(wrapped, TimeProvider.System, NullLogger<DownloadAccounting>.Instance);
// Use valid existing rows created through the public API, not a synthetic table.
var (viewer, _, _) = await Dl.ViewerAsync(factory, admin, "grace-account");
using (viewer)
{
    var list = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var release = list.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    var ids = new List<string>();
    for (var i = 0; i < 2; i++)
    {
        var prepared = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv }, 202);
        ids.Add(prepared.GetProperty("downloadId").GetString()!);
    }
    foreach (var id in ids) await Dl.WaitAsync(viewer, id);
    accounting.Add(ids[0], 111);
    accounting.Add(ids[1], 222);
    await accounting.StartAsync(CancellationToken.None);
    accounting.Wake();
    await intercept.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    // A pending async command is cancelled by BackgroundService.StopAsync.
    // Disable the gate so the promised final flush can use the database normally.
    intercept.Hold = false;
    await accounting.StopAsync(CancellationToken.None);
    await using var db = new StreamarrDbContext(original);
    // Both rows can share a millisecond CreatedAt; preserve request order explicitly.
    var savedById = await db.ViewerDownloads.Where(x => ids.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.BytesServed);
    var saved = ids.Select(id => savedById[id]).ToArray();
    Console.WriteLine("ACCOUNTING_SHUTDOWN " + JsonSerializer.Serialize(new { queued = new[] { 111, 222 }, saved, sqlExecuted = intercept.Executed }));
}

public sealed class StopOnWrite : DbCommandInterceptor
{
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public bool Hold { get; set; } = true;
    public int Executed;
    public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        if (command.CommandText.StartsWith("UPDATE \"ViewerDownloads\" SET \"BytesServed\"", StringComparison.Ordinal) && Hold)
        {
            Entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
        return result;
    }
    public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData eventData, int result, CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref Executed);
        return ValueTask.FromResult(result);
    }
}
public sealed class AccountingFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
{
    public StreamarrDbContext CreateDbContext() => new(options);
    public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
}
