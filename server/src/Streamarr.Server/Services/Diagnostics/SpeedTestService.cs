using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Http.Features;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>
/// Client-to-server throughput tests: streams incompressible bytes from one shared random buffer and drains uploads,
/// with a per-caller and a global cap on parallel transfers so the endpoints cannot be turned into a load generator.
/// </summary>
public sealed class SpeedTestService
{
    public const long MaxDownloadBytes = 2L * 1024 * 1024 * 1024;
    public const long MaxUploadBytes = 100L * 1024 * 1024;
    public const long DefaultDownloadBytes = 10L * 1024 * 1024;
    public const int MaxParallelPerCaller = 6;
    public const int MaxParallelGlobal = 16;

    private const int BufferBytes = 4 * 1024 * 1024;
    private const int ChunkBytes = 64 * 1024;

    private readonly byte[] _random = RandomNumberGenerator.GetBytes(BufferBytes);
    private readonly ConcurrentDictionary<string, int> _perCaller = new(StringComparer.Ordinal);
    private int _global;

    /// <summary>Limits for the client, echoed by the ping endpoint.</summary>
    public SpeedTestPingResponse Ping(DateTimeOffset now) => new()
    {
        ServerTime = now,
        MaxDownloadBytes = MaxDownloadBytes,
        MaxUploadBytes = MaxUploadBytes,
        MaxParallelTransfers = MaxParallelPerCaller,
    };

    /// <summary>Takes a transfer slot for <paramref name="caller"/>; null when the caller or the server is at its cap.</summary>
    public IDisposable? TryAcquire(string caller)
    {
        if (Interlocked.Increment(ref _global) > MaxParallelGlobal)
        {
            Interlocked.Decrement(ref _global);
            return null;
        }

        var count = _perCaller.AddOrUpdate(caller, 1, (_, current) => current + 1);
        if (count > MaxParallelPerCaller)
        {
            Release(caller);
            return null;
        }

        return new Lease(this, caller);
    }

    /// <summary>Currently running transfers (tests and metrics).</summary>
    public int ActiveTransfers => Volatile.Read(ref _global);

    /// <summary>Writes <paramref name="bytes"/> random bytes; stops quietly when the client goes away.</summary>
    public async Task WriteDownloadAsync(HttpContext context, long bytes, CancellationToken ct)
    {
        var response = context.Response;
        response.ContentType = "application/octet-stream";
        response.ContentLength = bytes;
        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        var offset = RandomNumberGenerator.GetInt32(0, BufferBytes - ChunkBytes);
        var remaining = bytes;
        try
        {
            while (remaining > 0)
            {
                var size = (int)Math.Min(ChunkBytes, remaining);
                await response.Body.WriteAsync(_random.AsMemory(offset, size), ct);
                remaining -= size;
                // A step coprime to the window keeps consecutive chunks from repeating at short distances.
                offset = (offset + ChunkBytes + 4_099) % (BufferBytes - ChunkBytes);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (IOException) when (ct.IsCancellationRequested || context.RequestAborted.IsCancellationRequested)
        {
        }
    }

    /// <summary>Reads and discards the request body, returning its size and the server-side read time.</summary>
    public async Task<SpeedTestUploadResponse> DrainUploadAsync(Stream body, CancellationToken ct)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(ChunkBytes);
        try
        {
            long total = 0;
            var sw = Stopwatch.StartNew();
            int read;
            while ((read = await body.ReadAsync(buffer.AsMemory(0, ChunkBytes), ct)) > 0)
            {
                total += read;
                if (total > MaxUploadBytes)
                    throw new InvalidDataException("Upload exceeds the speed test limit.");
            }
            sw.Stop();
            return new SpeedTestUploadResponse { Bytes = total, DurationMs = Math.Round(sw.Elapsed.TotalMilliseconds, 2) };
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private void Release(string caller)
    {
        _perCaller.AddOrUpdate(caller, 0, (_, current) => Math.Max(0, current - 1));
        _perCaller.TryRemove(new KeyValuePair<string, int>(caller, 0));
        Interlocked.Decrement(ref _global);
    }

    private sealed class Lease(SpeedTestService owner, string caller) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                owner.Release(caller);
        }
    }
}
