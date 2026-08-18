namespace Streamarr.Server.Services;

/// <summary>
/// One sequentially materialized media file. The written prefix is readable while the low-priority
/// transfer continues; completion atomically renames the partial file.
/// </summary>
public sealed class PreDownloadCacheFile : IDisposable
{
    private const int CopyBufferBytes = 1024 * 1024;
    private readonly string _partialPath;
    private readonly string _completePath;
    private readonly CancellationTokenSource _lifetime = new();
    private long _downloadedBytes;
    private int _complete;
    private int _disposed;

    public PreDownloadCacheFile(PreDownloadWorkspace workspace, string token, long totalBytes)
    {
        if (totalBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(totalBytes));
        var paths = workspace.Paths(token);
        _partialPath = paths.Partial;
        _completePath = paths.Complete;
        TotalBytes = totalBytes;
    }

    public long TotalBytes { get; }
    public long DownloadedBytes => Math.Min(TotalBytes, Interlocked.Read(ref _downloadedBytes));
    public bool IsComplete => Volatile.Read(ref _complete) != 0;
    public bool IsCancelled => Volatile.Read(ref _disposed) != 0;
    public CancellationToken LifetimeToken => _lifetime.Token;

    public async Task DownloadAsync(
        Stream source,
        Action<long>? onProgress,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            _lifetime.Token);
        var ct = linked.Token;
        TryDelete(_partialPath);
        TryDelete(_completePath);

        try
        {
            var buffer = new byte[CopyBufferBytes];
            await using (var target = new FileStream(
                             _partialPath,
                             FileMode.CreateNew,
                             FileAccess.Write,
                             FileShare.Read | FileShare.Delete,
                             bufferSize: 1,
                             FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                while (true)
                {
                    var read = await source.ReadAsync(buffer, ct).ConfigureAwait(false);
                    if (read == 0)
                        break;
                    await target.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    var downloaded = Interlocked.Add(ref _downloadedBytes, read);
                    if (downloaded > TotalBytes)
                        throw new InvalidDataException("The pre-download exceeded its declared media size.");
                    onProgress?.Invoke(downloaded);
                }

                await target.FlushAsync(ct).ConfigureAwait(false);
            }

            if (DownloadedBytes != TotalBytes)
                throw new EndOfStreamException("The pre-download ended before the complete media file arrived.");

            ct.ThrowIfCancellationRequested();
            File.Move(_partialPath, _completePath, overwrite: false);
            Volatile.Write(ref _complete, 1);
            onProgress?.Invoke(TotalBytes);
        }
        catch
        {
            TryDelete(_partialPath);
            TryDelete(_completePath);
            throw;
        }
    }

    public FileStream? TryOpenReadablePrefix()
    {
        if (DownloadedBytes <= 0 || Volatile.Read(ref _disposed) != 0)
            return null;
        var path = IsComplete ? _completePath : _partialPath;
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 1,
                FileOptions.Asynchronous | FileOptions.RandomAccess);
        }
        catch (Exception e) when (e is FileNotFoundException or IOException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
            return;
        _lifetime.Cancel();
        TryDelete(_partialPath);
        TryDelete(_completePath);
        _lifetime.Dispose();
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
