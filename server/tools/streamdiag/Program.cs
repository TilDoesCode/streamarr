// Streaming-engine diagnostic harness: real NNTP stack + mock server, no HTTP.
// Reproduces the production wiring (pool -> provider fanout -> global gate ->
// session gate -> SegmentCache -> NzbFileStream) and prints command amplification.

using System.Diagnostics;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Streams;

if (args.Length > 0 && args[0] == "enc")
{
    await EncDiag.Run(
        args.Length > 1 ? int.Parse(args[1]) : 96,
        args.Length > 2 ? int.Parse(args[2]) : 600_000,
        args.Length > 3 ? int.Parse(args[3]) : 15,
        args.Length > 4 ? int.Parse(args[4]) : 0,
        args.Length > 5 ? int.Parse(args[5]) : 0);
    return;
}

if (args.Length > 0 && args[0] == "repair")
{
    // repair [mediaSeconds=150] [damagedArticles=1] [recoverySlices=4] [hold]
    await RepairDiag.Run(
        args.Length > 1 ? int.Parse(args[1]) : 150,
        args.Length > 2 ? int.Parse(args[2]) : 1,
        args.Length > 3 ? int.Parse(args[3]) : 4,
        hold: args.Contains("hold"));
    return;
}

if (args.Length > 0 && args[0] == "rar")
{
    await RarDiag.Run(
        args.Length > 1 ? int.Parse(args[1]) : 96,
        args.Length > 2 ? int.Parse(args[2]) : 600_000,
        args.Length > 3 ? int.Parse(args[3]) : 15,
        args.Length > 4 ? int.Parse(args[4]) : 0,
        args.Length > 5 ? int.Parse(args[5]) : 0);
    return;
}

var fileMb = args.Length > 0 ? int.Parse(args[0]) : 96;
var partSize = args.Length > 1 ? int.Parse(args[1]) : 600_000;
var readAhead = 3;
var startupReadAhead = 8;
var startupSegments = 8;

Console.WriteLine($"[diag] generating {fileMb} MiB file, partSize={partSize}");
var bytes = new byte[fileMb * 1024 * 1024];
new Random(42).NextBytes(bytes);

await using var nntp = new MockNntpServer { RequireAuth = true };
var published = NzbTestFixtures.PublishFile(nntp, "diag.bin", bytes, "diag", partSize);
var segmentIds = published.SegmentIds.ToArray();
Console.WriteLine($"[diag] published {segmentIds.Length} segments on mock NNTP {nntp.Host}:{nntp.Port}");

var provider = new UsenetProvider
{
    Name = "mock",
    Host = nntp.Host,
    Port = nntp.Port,
    UseSsl = false,
    Username = nntp.Username,
    Password = nntp.Password,
    MaxConnections = 20,
    Priority = 0,
    Type = UsenetProviderType.Pooled,
};

var multiProvider = UsenetStreamingClient.Create([provider], null, TimeSpan.FromSeconds(300));
var globalGated = new GatedNntpClient(multiProvider, new SemaphoreNntpGate(20), disposeInner: true);
var sessionUsage = new CountingNntpGate();
var sessionClient = new GatedNntpClient(globalGated, sessionUsage);
using var segmentCache = new SegmentCache(512L * 1024 * 1024);

long delivered = 0;
var requestedChunks = new HashSet<string>();
void OnSegment(string id) { lock (requestedChunks) requestedChunks.Add(id); }

Stream OpenStream() => new NzbFileStream(
    segmentIds, bytes.LongLength, sessionClient, readAhead, segmentCache,
    articleRetryCount: 2, onSegmentRequested: OnSegment,
    startupArticleBufferSize: startupReadAhead, startupReadAheadSegments: startupSegments);

async Task<long> ReadSome(Stream s, long count, byte[] buf)
{
    long total = 0;
    while (total < count)
    {
        var n = await s.ReadAsync(buf.AsMemory(0, (int)Math.Min(buf.Length, count - total)));
        if (n == 0) break;
        total += n; Interlocked.Add(ref delivered, n);
    }
    return total;
}

var buf = new byte[256 * 1024];
var sw = Stopwatch.StartNew();

void Report(string phase)
{
    var segsDelivered = (double)Interlocked.Read(ref delivered) / partSize;
    Console.WriteLine(
        $"[{sw.Elapsed.TotalSeconds,7:F1}s] {phase,-28} delivered={Interlocked.Read(ref delivered) / 1048576.0,8:F1}MiB " +
        $"(~{segsDelivered,6:F0} segs) uniqueChunksRequested={requestedChunks.Count,5} " +
        $"mockCommands={nntp.CommandsServed,6} mockBodies={nntp.BodiesServed,6} " +
        $"sessionCmds={sessionUsage.TotalCommands,6} inFlight={sessionUsage.InFlight,3} maxConns={nntp.MaxObservedConnections}");
}

// --- mimic ffprobe: open at 0 (read 1MB), open at tail (read 8KB), open at ~5KB (read 1MB)
{
    var s1 = OpenStream(); await ReadSome(s1, 1 * 1024 * 1024, buf); await s1.DisposeAsync();
    Report("ffprobe-head(1MiB)");
    var s2 = OpenStream(); s2.Seek(bytes.LongLength - 8192, SeekOrigin.Begin); await ReadSome(s2, 8192, buf); await s2.DisposeAsync();
    Report("ffprobe-tail(8KiB)");
    var s3 = OpenStream(); s3.Seek(5549, SeekOrigin.Begin); await ReadSome(s3, 1 * 1024 * 1024, buf); await s3.DisposeAsync();
    Report("ffprobe-mid(1MiB)");
}

// --- main sequential fast read, reporting every ~32MiB
{
    var s = OpenStream();
    long target = bytes.LongLength;
    long readTotal = 0;
    while (readTotal < target)
    {
        var step = Math.Min(32L * 1024 * 1024, target - readTotal);
        var n = await ReadSome(s, step, buf);
        readTotal += n;
        Report($"seq-read@{readTotal / 1048576}MiB");
        if (n == 0) break;
    }
    await s.DisposeAsync();
}

Report("final");
var totalSegs = (double)delivered / partSize;
Console.WriteLine($"[diag] amplification: mockBodies/segmentsDelivered = {nntp.BodiesServed / Math.Max(1, totalSegs):F2}x, " +
                  $"bytes on wire vs delivered ≈ {(double)nntp.BodiesServed * partSize / Math.Max(1, delivered):F2}x");
globalGated.Dispose();
