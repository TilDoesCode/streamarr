using System.Security.Cryptography;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nzb;
using Streamarr.Usenet.Par2;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Server.Services.Repair;

/// <summary>Result of materializing one NZB file into a sparse workspace file.</summary>
public sealed record MaterializedFile
{
    public required NzbFile NzbFile { get; init; }
    public required SparseRepairFile File { get; init; }
    public required IReadOnlyList<LongRange> MissingRanges { get; init; }
    public required int MissingArticles { get; init; }
    public required int CorruptArticles { get; init; }
    public required long DownloadedBytes { get; init; }
}

/// <summary>
/// Streams every available yEnc article of an NZB file to its validated decoded offset
/// inside a bounded sparse file — the 842 MiB case never touches RAM as a whole. Missing
/// (430) and corrupt (CRC) articles become exact missing ranges; offsets come from the
/// articles' own validated yEnc headers, holes are closed over verified neighbours.
/// </summary>
public sealed class RepairSourceMaterializer(INntpClient repairClient)
{
    /// <summary>Largest accepted single decoded article (matches the NNTP layer's cap).</summary>
    private const long MaxDecodedArticleBytes = 64L * 1024 * 1024;

    public async Task<MaterializedFile> MaterializeAsync(
        NzbFile nzbFile,
        SparseRepairFile target,
        int concurrency,
        Action<long>? onBytes = null,
        CancellationToken ct = default)
    {
        var missingArticles = 0;
        var corruptArticles = 0;
        long downloaded = 0;

        await Parallel.ForEachAsync(
            nzbFile.Segments,
            new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, concurrency), CancellationToken = ct },
            async (segment, token) =>
            {
                (long Offset, byte[] Payload) decoded;
                try
                {
                    decoded = await DownloadDecodedAsync(segment.MessageId, token).ConfigureAwait(false);
                }
                catch (UsenetArticleNotFoundException)
                {
                    Interlocked.Increment(ref missingArticles);
                    return;
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (YencCrcMismatchException)
                {
                    Interlocked.Increment(ref corruptArticles);
                    return;
                }
                catch (Exception e) when (e is UsenetException or TimeoutException or IOException)
                {
                    // Transport-level failure that survived the bounded retries: the article's
                    // range stays missing and PAR2 recovers it — one slow peer must never
                    // kill the whole job.
                    Interlocked.Increment(ref corruptArticles);
                    return;
                }

                if (decoded.Offset < 0 || decoded.Offset > target.Length - decoded.Payload.LongLength)
                {
                    Interlocked.Increment(ref corruptArticles);
                    return;
                }

                // Keep workspace I/O outside the recoverable NNTP catch; local failures abort the job.
                target.WriteAt(decoded.Offset, decoded.Payload);
                Interlocked.Add(ref downloaded, decoded.Payload.Length);
                onBytes?.Invoke(decoded.Payload.Length);
            }).ConfigureAwait(false);

        target.Flush();
        return new MaterializedFile
        {
            NzbFile = nzbFile,
            File = target,
            MissingRanges = target.MissingRanges(),
            MissingArticles = missingArticles,
            CorruptArticles = corruptArticles,
            DownloadedBytes = downloaded,
        };
    }

    /// <summary>Downloads a whole NZB file (e.g. the PAR2 index) into bounded memory.</summary>
    public async Task<byte[]> DownloadSmallFileAsync(NzbFile nzbFile, long maxBytes, CancellationToken ct)
    {
        if (maxBytes <= 0 || maxBytes > int.MaxValue)
            throw new ArgumentOutOfRangeException(nameof(maxBytes));
        var parts = new List<(long Offset, byte[] Payload)>();
        long total = 0;
        long length = 0;
        foreach (var segment in nzbFile.Segments)
        {
            var (offset, payload) = await DownloadDecodedAsync(segment.MessageId, ct).ConfigureAwait(false);
            total = checked(total + payload.LongLength);
            if (total > maxBytes)
                throw new InvalidOperationException("The PAR2 index exceeds the configured size limit.");
            if (offset < 0 || offset > maxBytes - payload.LongLength)
                throw new InvalidDataException("The PAR2 index declares an out-of-range decoded offset.");
            length = Math.Max(length, checked(offset + payload.LongLength));
            parts.Add((offset, payload));
        }
        var buffer = new byte[checked((int)length)];
        foreach (var (offset, payload) in parts)
            payload.CopyTo(buffer.AsSpan(checked((int)offset)));
        return buffer;
    }

    /// <summary>
    /// Bounded retry around one decoded article download. A read timeout or dropped
    /// connection re-enters the pooled multi-provider path on a fresh connection;
    /// definitive 430s are never retried here (the provider failover already ran).
    /// </summary>
    private async Task<(long Offset, byte[] Payload)> DownloadDecodedAsync(string messageId, CancellationToken ct)
    {
        const int maxAttempts = 3;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await DownloadDecodedOnceAsync(messageId, ct).ConfigureAwait(false);
            }
            catch (Exception e) when (
                attempt < maxAttempts
                && !ct.IsCancellationRequested
                && e is TimeoutException or IOException or (UsenetException and not UsenetArticleNotFoundException))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(250 * attempt), ct).ConfigureAwait(false);
            }
        }
    }

    private async Task<(long Offset, byte[] Payload)> DownloadDecodedOnceAsync(string messageId, CancellationToken ct)
    {
        var body = await repairClient.DecodedBodyAsync(messageId, ct).ConfigureAwait(false);
        await using var stream = body.Stream;
        var yenc = (YencStream)stream;
        var headers = await yenc.GetYencHeadersAsync(ct).ConfigureAwait(false)
            ?? throw new YencCrcMismatchException("An article carries no yEnc headers.");
        var declaredSize = headers.IsFilePart ? headers.PartSize : headers.FileSize;
        if (declaredSize is <= 0 or > MaxDecodedArticleBytes)
            throw new YencCrcMismatchException("An article declares an implausible decoded size.");

        var payload = new byte[declaredSize];
        var read = 0;
        while (read < payload.Length)
        {
            var n = await yenc.ReadAsync(payload.AsMemory(read), ct).ConfigureAwait(false);
            if (n == 0)
                break;
            read += n;
        }
        if (read != payload.Length)
            throw new YencCrcMismatchException("An article body ended before its declared decoded size.");
        // Drain the trailer so the yEnc CRC/size validation runs.
        var drain = new byte[1];
        if (await yenc.ReadAsync(drain, ct).ConfigureAwait(false) != 0)
            throw new YencCrcMismatchException("An article body exceeded its declared decoded size.");

        return (headers.IsFilePart ? headers.PartOffset : 0, payload);
    }

    /// <summary>
    /// Verifies a materialized file slice-by-slice against the PAR2 checksums. A slice is
    /// damaged when it overlaps a missing range or its MD5 mismatches. Returns global indices.
    /// </summary>
    public static IReadOnlyList<int> FindDamagedSlices(
        Par2SetInfo set,
        int fileIndex,
        SparseRepairFile file,
        CancellationToken ct)
    {
        var info = set.Files[fileIndex];
        var damaged = new SortedSet<int>();
        foreach (var range in file.MissingRanges())
        {
            foreach (var slice in set.SliceIndicesForRange(fileIndex, range.StartInclusive, range.EndExclusive))
                damaged.Add(slice);
        }

        var buffer = new byte[set.SliceSize];
        for (var slice = 0; slice < info.SliceCount; slice++)
        {
            ct.ThrowIfCancellationRequested();
            var global = checked((int)(info.GlobalSliceOffset + slice));
            if (damaged.Contains(global))
                continue;
            var start = slice * set.SliceSize;
            var length = (int)Math.Min(set.SliceSize, info.Description.FileLength - start);
            Array.Clear(buffer);
            file.ReadAt(start, buffer.AsSpan(0, length));
            if (!MD5.HashData(buffer).AsSpan().SequenceEqual(info.Checksums.Slices[slice].Md5))
                damaged.Add(global);
        }
        return [.. damaged];
    }
}
