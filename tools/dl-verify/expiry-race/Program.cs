using System.Text.Json;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;

static TransferLease Admit(DownloadTransferGovernor g)
{
#if BEFORE_FIX
    return g.TryAdmit("a", "v", "w", null, g.Stamp("a", "v"), DateTimeOffset.UnixEpoch, default, out _, "hash")!;
#else
    return g.TryAdmit("a", "v", "w", null, g.Stamp("a", "v", "hash"), DateTimeOffset.UnixEpoch, default, out _, "hash", 1)!;
#endif
}
var g = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
using var first = Admit(g);
using var second = Admit(g);
using var registration = first.Token.Register(second.Dispose);
string? error = null;
try { g.ExpireDue(DateTimeOffset.UtcNow); } catch (Exception ex) { error = ex.GetType().Name; }
Console.WriteLine(JsonSerializer.Serialize(new { schedule = "first cancellation disposes second request", error }));

var errors = 0;
for (var n = 0; n < 2000; n++)
{
    var local = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
    using var a = Admit(local);
    using var b = Admit(local);
    using var gate = new Barrier(2);
    await Task.WhenAll(Task.Run(() => { gate.SignalAndWait(); try { local.ExpireDue(DateTimeOffset.UtcNow); } catch (ObjectDisposedException) { Interlocked.Increment(ref errors); } }),
        Task.Run(() => { gate.SignalAndWait(); b.Dispose(); a.Dispose(); }));
}
Console.WriteLine(JsonSerializer.Serialize(new { schedule = "two parallel tasks", trials = 2000, errors }));
public sealed class Idle : ILiveStreamSignal { public int LiveStreams => 0; public bool Active => false; }
