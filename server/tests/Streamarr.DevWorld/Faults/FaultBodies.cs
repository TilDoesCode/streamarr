using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.DevWorld.Faults;

/// <summary>Pure body rewrites (segments, playlists, WebVTT).</summary>
public static partial class FaultBodies
{
    public static byte[] Corrupt(byte[] body, string mode)
    {
        var copy = (byte[])body.Clone();
        switch (mode)
        {
            case "box" when copy.Length >= 4:
                BinaryPrimitives.WriteUInt32BigEndian(copy, 0x7FFFFFF0);
                break;
            case "garbage":
                new Random(body.Length).NextBytes(copy);
                break;
            default:
                var mdat = FindBox(copy, "mdat");
                var from = mdat >= 0 ? mdat + 8 : Math.Min(copy.Length, 64);
                for (var i = from; i < copy.Length; i += 7)
                    copy[i] ^= 0xFF;
                break;
        }
        return copy;
    }

    /// <summary>Offset of the first top-level box of this type, or -1.</summary>
    public static int FindBox(byte[] data, string type)
    {
        var offset = 0;
        while (offset + 8 <= data.Length)
        {
            var size = (long)BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(offset));
            if (Encoding.ASCII.GetString(data, offset + 4, 4) == type)
                return offset;
            if (size == 1 && offset + 16 <= data.Length)
                size = (long)BinaryPrimitives.ReadUInt64BigEndian(data.AsSpan(offset + 8));
            if (size < 8)
                return -1;
            offset += (int)Math.Min(size, int.MaxValue - offset);
        }
        return -1;
    }

    public static string CorruptVtt(string vtt, string mode) => mode == "timing"
        ? CueTimingRegex().Replace(vtt, "99:77:xx.000 --> 00:00:-1.000")
        : string.Join('\n', vtt.Split('\n').SkipWhile(l => l.TrimStart('﻿').StartsWith("WEBVTT", StringComparison.Ordinal)));

    /// <summary>Keeps the first <paramref name="segments"/> entries, drops ENDLIST and VOD (or marks EVENT): a playlist that never grows.</summary>
    public static string Playlist(string playlist, int segments, bool eventType)
    {
        var output = new List<string>();
        var count = 0;
        var typed = false;
        foreach (var raw in playlist.Replace("\r\n", "\n").Split('\n'))
        {
            var line = raw.TrimEnd();
            if (line.StartsWith("#EXT-X-ENDLIST", StringComparison.Ordinal))
                continue;
            if (line.StartsWith("#EXT-X-PLAYLIST-TYPE:", StringComparison.Ordinal))
            {
                if (eventType)
                {
                    output.Add("#EXT-X-PLAYLIST-TYPE:EVENT");
                    typed = true;
                }
                continue;
            }
            if (count >= segments && (line.StartsWith("#EXTINF", StringComparison.Ordinal) || (line.Length > 0 && !line.StartsWith('#'))
                                      || line.StartsWith("#EXT-X-PROGRAM-DATE-TIME", StringComparison.Ordinal) || line.StartsWith("#EXT-X-DISCONTINUITY", StringComparison.Ordinal)))
                continue;
            if (line.Length > 0 && !line.StartsWith('#'))
                count++;
            output.Add(line);
        }
        if (eventType && !typed)
            output.Insert(Math.Min(1, output.Count), "#EXT-X-PLAYLIST-TYPE:EVENT");
        while (output.Count > 0 && output[^1].Length == 0)
            output.RemoveAt(output.Count - 1);
        return string.Join('\n', output) + "\n";
    }

    [GeneratedRegex(@"\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}\.\d{3}")]
    private static partial Regex CueTimingRegex();
}

/// <summary>Token bucket for paced writes (kbit/s).</summary>
public sealed class Pacer(double kbps)
{
    private readonly double _bytesPerSecond = Math.Max(1, kbps) * 1000 / 8;
    private readonly System.Diagnostics.Stopwatch _clock = System.Diagnostics.Stopwatch.StartNew();
    private long _sent;

    public int Chunk => (int)Math.Clamp(_bytesPerSecond / 10, 256, 64 * 1024);

    public async Task WaitAsync(int bytes, CancellationToken ct)
    {
        _sent += bytes;
        var due = TimeSpan.FromSeconds(_sent / _bytesPerSecond) - _clock.Elapsed;
        if (due > TimeSpan.Zero)
            await Task.Delay(due, ct);
    }
}

/// <summary>Response body wrapper for /stream: abort after N bytes and/or pace the writes.</summary>
public sealed class FaultingStream(Stream inner, HttpContext context, long? abortAfter, Pacer? pacer) : Stream
{
    public long Written { get; private set; }
    public bool Aborted { get; private set; }

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            if (Aborted)
                throw new OperationCanceledException("Dev World fault reset the connection");
            var n = Math.Min(buffer.Length - offset, pacer?.Chunk ?? buffer.Length);
            if (abortAfter is { } limit && Written + n >= limit)
            {
                n = (int)Math.Max(0, limit - Written);
                if (n > 0)
                    await inner.WriteAsync(buffer.Slice(offset, n), ct);
                Written += n;
                await inner.FlushAsync(ct);
                Aborted = true;
                await DevWorldFaultMiddleware.DrainThenAbortAsync(context);
                throw new OperationCanceledException("Dev World fault reset the connection");
            }
            await inner.WriteAsync(buffer.Slice(offset, n), ct);
            Written += n;
            offset += n;
            if (pacer is not null)
            {
                await inner.FlushAsync(ct);
                await pacer.WaitAsync(n, ct);
            }
        }
    }

    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct)
        => WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();

    public override void Write(byte[] buffer, int offset, int count) => WriteAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

    public override Task FlushAsync(CancellationToken ct) => Aborted ? Task.CompletedTask : inner.FlushAsync(ct);

    public override void Flush() => FlushAsync(CancellationToken.None).GetAwaiter().GetResult();

    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => Written; set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
}

/// <summary>Viewer of an access or refresh token, read from the session table (cached per token hash).</summary>
public sealed class FaultIdentity(IDbContextFactory<StreamarrDbContext> dbFactory)
{
    private readonly ConcurrentDictionary<string, string> _viewers = new();

    public async Task<string?> ViewerByAccessAsync(string? token, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(token) || !token.StartsWith(ViewerAuth.AccessTokenPrefix, StringComparison.Ordinal))
            return null;
        var hash = ViewerAuth.Hash(token);
        if (_viewers.TryGetValue(hash, out var cached))
            return cached;
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var name = await (from s in db.ViewerSessions
                          join v in db.Viewers on s.ViewerId equals v.Id
                          where s.AccessTokenHash == hash
                          select v.Username).FirstOrDefaultAsync(ct);
        if (name is not null)
            _viewers[hash] = name;
        return name;
    }

    public async Task<string?> ViewerByRefreshAsync(string? token, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(token))
            return null;
        var hash = ViewerAuth.Hash(token);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await (from s in db.ViewerSessions
                      join v in db.Viewers on s.ViewerId equals v.Id
                      where s.RefreshTokenHash == hash || s.PreviousRefreshTokenHash == hash
                      select v.Username).FirstOrDefaultAsync(ct);
    }
}
