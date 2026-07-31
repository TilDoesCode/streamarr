// Encrypted-RAR variant: synthesizes AES-256-CBC slices (RAR5 crypto model, per-volume IV)
// without a RAR container, streams through the full production wiring, verifies the decoded
// payload bit-for-bit, and reports NNTP command amplification.
using System.Diagnostics;
using System.Security.Cryptography;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Rar;
using Streamarr.Usenet.Streams;

public static class EncDiag
{
    public static async Task Run(int fileMb, int partSize, int volumeMb, int latencyMs = 0, int bodyBps = 0)
    {
        const string password = "diag-password";
        var readAhead = 3;
        var startupReadAhead = 8;
        var startupSegments = 8;
        const int headerBytes = 512;

        Console.WriteLine($"[enc-diag] media={fileMb}MiB parts={partSize} volumes={volumeMb}MiB latency={latencyMs}ms bps={bodyBps}");
        var payload = new byte[fileMb * 1024 * 1024];
        new Random(42).NextBytes(payload);

        var salt = new byte[16];
        RandomNumberGenerator.Fill(salt);
        var key = RarAesCbcDecryptor.DeriveKey(password, salt, 3);

        var volumeSize = volumeMb * 1024 * 1024;
        var volumeCount = (payload.Length + volumeSize - 1) / volumeSize;
        var volumeBytes = new byte[volumeCount][];
        var slices = new List<RarStoredFileSlice>();
        long fileOffset = 0;
        for (var v = 0; v < volumeCount; v++)
        {
            var plain = payload.AsSpan(v * volumeSize, Math.Min(volumeSize, payload.Length - v * volumeSize)).ToArray();
            var iv = new byte[16];
            RandomNumberGenerator.Fill(iv);
            var padded = new byte[(plain.Length + 15) / 16 * 16];
            plain.CopyTo(padded, 0);
            using var aes = Aes.Create();
            aes.Key = key;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.None;
            aes.IV = iv;
            using var enc = aes.CreateEncryptor();
            var cipher = enc.TransformFinalBlock(padded, 0, padded.Length);

            var raw = new byte[headerBytes + cipher.Length];
            cipher.CopyTo(raw, headerBytes);
            volumeBytes[v] = raw;
            slices.Add(new RarStoredFileSlice
            {
                PartIndex = v,
                ByteRangeWithinPart = LongRange.FromStartAndSize(headerBytes, cipher.Length),
                ByteRangeWithinFile = LongRange.FromStartAndSize(fileOffset, plain.Length),
                Crypto = new RarFileCrypto { Salt = salt, InitV = iv, Lg2Count = 3 },
            });
            fileOffset += plain.Length;
        }
        var file = new RarStoredFile { PathWithinArchive = "diag.mkv", Size = payload.LongLength, Slices = slices };

        var bodyCounts = new System.Collections.Concurrent.ConcurrentDictionary<string, int>();
        await using var nntp = new MockNntpServer
        {
            RequireAuth = true,
            CommandLatency = TimeSpan.FromMilliseconds(latencyMs),
            BodyBytesPerSecond = bodyBps,
            OnBodyServed = id => bodyCounts.AddOrUpdate(id, 1, (_, c) => c + 1),
        };
        var publishedVolumes = volumeBytes
            .Select((bytes, i) => NzbTestFixtures.PublishFile(nntp, $"diag.part{i}.rar", bytes, $"encvol{i}", partSize))
            .ToArray();
        var volumes = publishedVolumes.Select((p, i) => (SegmentIds: p.SegmentIds.ToArray(), Size: (long)volumeBytes[i].Length)).ToArray();

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
        var segmentMetadata = new SegmentMetadataCache();

        long delivered = 0;
        Stream OpenStream() => new RarStoredFileStream(
            file,
            (partIndex, _) => new ValueTask<Stream>(new NzbFileStream(
                volumes[partIndex].SegmentIds, volumes[partIndex].Size, sessionClient, readAhead,
                segmentCache, 2, null, startupReadAhead, startupSegments,
                segmentMetadata: segmentMetadata)),
            password);

        var sw = Stopwatch.StartNew();
        long lastCmds = 0;
        double lastT = 0;
        long lastDelivered = 0;

        void Report(string phase)
        {
            var cmds = sessionUsage.TotalCommands;
            var t = sw.Elapsed.TotalSeconds;
            var rate = (Interlocked.Read(ref delivered) - lastDelivered) / Math.Max(0.001, t - lastT) / 1048576.0;
            Console.WriteLine(
                $"[{t,7:F1}s] {phase,-16} delivered={Interlocked.Read(ref delivered) / 1048576.0,8:F1}MiB rate={rate,7:F2}MiB/s " +
                $"mockBodies={nntp.BodiesServed,6} sessCmds={cmds,6} (+{cmds - lastCmds,5}) inFlight={sessionUsage.InFlight,3}");
            lastCmds = cmds;
            lastT = t;
            lastDelivered = Interlocked.Read(ref delivered);
        }

        var buf = new byte[256 * 1024];
        // mimic ffprobe head/tail/mid opens
        {
            var s1 = OpenStream(); await ReadVerify(s1, 0, 1 * 1024 * 1024); await s1.DisposeAsync();
            var s2 = OpenStream(); s2.Seek(file.Size - 8192, SeekOrigin.Begin); await ReadVerify(s2, file.Size - 8192, 8192); await s2.DisposeAsync();
            var s3 = OpenStream(); s3.Seek(5549, SeekOrigin.Begin); await ReadVerify(s3, 5549, 1 * 1024 * 1024); await s3.DisposeAsync();
            Report("ffprobe(3 opens)");
        }
        // sequential full read with verification
        {
            var s = OpenStream();
            long pos = 0;
            while (pos < file.Size)
            {
                var step = Math.Min(16L * 1024 * 1024, file.Size - pos);
                await ReadVerify(s, pos, step);
                pos += step;
                Report($"seq@{pos / 1048576}MiB");
            }
            await s.DisposeAsync();
        }

        await Task.Delay(500);
        Report("final(+0.5s)");
        var totalSegs = (double)delivered / partSize;
        var dupes = bodyCounts.Where(kv => kv.Value > 1).ToList();
        Console.WriteLine($"[enc-diag] amplification: mockBodies/segsDelivered = {nntp.BodiesServed / Math.Max(1, totalSegs):F2}x; " +
                          $"duplicates: {dupes.Count} ids / {dupes.Sum(kv => kv.Value - 1)} redundant bodies");
        Console.WriteLine("[enc-diag] PAYLOAD VERIFIED BYTE-FOR-BYTE ✔");
        globalGated.Dispose();
        return;

        async Task ReadVerify(Stream s, long expectedPos, long count)
        {
            long done = 0;
            while (done < count)
            {
                var n = await s.ReadAsync(buf.AsMemory(0, (int)Math.Min(buf.Length, count - done)));
                if (n == 0) throw new InvalidOperationException($"EOF at {expectedPos + done}");
                if (!buf.AsSpan(0, n).SequenceEqual(payload.AsSpan(checked((int)(expectedPos + done)), n)))
                    throw new InvalidOperationException($"PAYLOAD MISMATCH at {expectedPos + done}");
                done += n;
                Interlocked.Add(ref delivered, n);
            }
        }
    }
}
