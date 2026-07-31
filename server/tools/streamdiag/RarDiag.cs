// RAR-wrapped variant of the diagnostic harness, mirroring MediaFileMaterializer.MaterializeRarAsync.
using System.Diagnostics;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Rar;
using Streamarr.Usenet.Streams;

public static class RarDiag
{
    public static async Task Run(int fileMb, int partSize, int volumeMb, int latencyMs = 0, int bodyBps = 0)
    {
        var readAhead = 3;
        var startupReadAhead = 8;
        var startupSegments = 8;

        Console.WriteLine($"[rar-diag] media={fileMb}MiB parts={partSize} volumes={volumeMb}MiB latency={latencyMs}ms bps={bodyBps}");
        var media = new byte[fileMb * 1024 * 1024];
        new Random(42).NextBytes(media);
        var volumesRaw = Rar4TestWriter.WriteMultiVolume("diag", "diag.mkv", media, volumeMb * 1024 * 1024);
        Console.WriteLine($"[rar-diag] rar volumes: {volumesRaw.Count}");

        var bodyCounts = new System.Collections.Concurrent.ConcurrentDictionary<string, int>();
        await using var nntp = new MockNntpServer
        {
            RequireAuth = true,
            CommandLatency = TimeSpan.FromMilliseconds(latencyMs),
            BodyBytesPerSecond = bodyBps,
            OnBodyServed = id => bodyCounts.AddOrUpdate(id, 1, (_, c) => c + 1),
        };
        var publishedVolumes = volumesRaw
            .Select((v, i) => NzbTestFixtures.PublishFile(nntp, v.FileName, v.Bytes, $"diagvol{i}", partSize))
            .ToArray();

        var provider = new UsenetProvider
        {
            Name = "mock", Host = nntp.Host, Port = nntp.Port, UseSsl = false,
            Username = nntp.Username, Password = nntp.Password,
            MaxConnections = 20, Priority = 0, Type = UsenetProviderType.Pooled,
        };
        var multiProvider = UsenetStreamingClient.Create([provider], null, TimeSpan.FromSeconds(300));
        var globalGated = new GatedNntpClient(multiProvider, new SemaphoreNntpGate(20), disposeInner: true);
        var sessionUsage = new CountingNntpGate();
        var sessionClient = new GatedNntpClient(globalGated, sessionUsage);
        using var segmentCache = new SegmentCache(512L * 1024 * 1024);

        // Materialize: parse volume headers over NzbFileStreams (like MaterializeRarAsync)
        var volumes = new (string[] SegmentIds, long Size)[publishedVolumes.Length];
        var parsed = new RarVolume[publishedVolumes.Length];
        for (var i = 0; i < publishedVolumes.Length; i++)
        {
            var segIds = publishedVolumes[i].SegmentIds.ToArray();
            var size = volumesRaw[i].Bytes.LongLength;
            volumes[i] = (segIds, size);
            await using var headerStream = new NzbFileStream(segIds, size, globalGated, articleBufferSize: 0);
            parsed[i] = await RarVolumeReader.ReadAsync(headerStream, volumesRaw[i].FileName, CancellationToken.None);
        }
        var stored = RarArchiveIndexer.Index(parsed);
        var file = stored.MaxBy(f => f.Size)!;
        Console.WriteLine($"[rar-diag] stored file {file.PathWithinArchive} size={file.Size} slices={file.Slices.Count}");

        long delivered = 0;
        var requestedChunks = new HashSet<string>();
        void OnSegment(string id) { lock (requestedChunks) requestedChunks.Add(id); }

        Stream OpenStream() => new RarStoredFileStream(
            file,
            (partIndex, _) => new ValueTask<Stream>(new NzbFileStream(
                volumes[partIndex].SegmentIds, volumes[partIndex].Size, sessionClient, readAhead,
                segmentCache, 2, OnSegment, startupReadAhead, startupSegments)),
            null);

        var buf = new byte[256 * 1024];
        var sw = Stopwatch.StartNew();
        long lastCmds = 0;

        void Report(string phase)
        {
            var segsDelivered = (double)Interlocked.Read(ref delivered) / partSize;
            var cmds = sessionUsage.TotalCommands;
            Console.WriteLine(
                $"[{sw.Elapsed.TotalSeconds,7:F1}s] {phase,-24} delivered={Interlocked.Read(ref delivered) / 1048576.0,8:F1}MiB " +
                $"(~{segsDelivered,5:F0} segs) uniq={requestedChunks.Count,5} " +
                $"mockCmds={nntp.CommandsServed,6} mockBodies={nntp.BodiesServed,6} " +
                $"sessCmds={cmds,6} (+{cmds - lastCmds,5}) inFlight={sessionUsage.InFlight,3} conns={nntp.MaxObservedConnections}");
            lastCmds = cmds;
        }

        async Task<long> ReadSome(Stream s, long count)
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

        // ffprobe mimicry
        {
            var s1 = OpenStream(); await ReadSome(s1, 1 * 1024 * 1024); await s1.DisposeAsync();
            Report("ffprobe-head");
            var s2 = OpenStream(); s2.Seek(file.Size - 8192, SeekOrigin.Begin); await ReadSome(s2, 8192); await s2.DisposeAsync();
            Report("ffprobe-tail");
            var s3 = OpenStream(); s3.Seek(5549, SeekOrigin.Begin); await ReadSome(s3, 1 * 1024 * 1024); await s3.DisposeAsync();
            Report("ffprobe-mid");
        }

        // sequential fast read
        {
            var s = OpenStream();
            long readTotal = 0;
            while (readTotal < file.Size)
            {
                var n = await ReadSome(s, Math.Min(16L * 1024 * 1024, file.Size - readTotal));
                readTotal += n;
                Report($"seq@{readTotal / 1048576}MiB");
                if (n == 0) break;
            }
            await s.DisposeAsync();
        }

        await Task.Delay(500);
        Report("final(+0.5s)");
        var totalSegs = (double)delivered / partSize;
        Console.WriteLine($"[rar-diag] amplification: mockBodies/segsDelivered = {nntp.BodiesServed / Math.Max(1, totalSegs):F2}x");
        var dupes = bodyCounts.Where(kv => kv.Value > 1).OrderByDescending(kv => kv.Value).ToList();
        Console.WriteLine($"[rar-diag] duplicate downloads: {dupes.Count} ids, {dupes.Sum(kv => kv.Value - 1)} redundant bodies");
        foreach (var kv in dupes.Take(15))
            Console.WriteLine($"   {kv.Value,3}x {kv.Key}");
        globalGated.Dispose();
    }
}
