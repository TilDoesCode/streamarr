using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services.Repair;

/// <summary>
/// Connects streaming sessions to the repair coordinator: classifies damage, records
/// origin evidence without killing sessions, attaches waiters to the single-flight job,
/// and opens pinned local projections over published artifacts.
/// </summary>
public sealed class RepairStreamGateway(
    RepairCoordinator coordinator,
    RepairArtifactCache artifactCache,
    IOptions<StreamarrOptions> options,
    ILogger<RepairStreamGateway> logger,
    IReleaseHealthCache? healthCache = null,
    StreamarrMetrics? metrics = null) : IRepairStreamGateway
{
    public bool Enabled => coordinator.Enabled;

    public bool AllowsPlaybackWhileDead(string releaseId)
        => coordinator.AllowsPlaybackWhileDead(releaseId);

    public async Task<Stream?> TryOpenLocalMediaAsync(string releaseId, CancellationToken ct)
    {
        if (!Enabled)
            return null;
        var fingerprint = coordinator.FingerprintForRelease(releaseId);
        if (fingerprint is null || artifactCache.TryAcquire(fingerprint) is not { } lease)
            return null;
        try
        {
            var projection = await BuildProjectionAsync(lease.Artifact, releaseId, ct).ConfigureAwait(false);
            return OpenPinnedProjectionStream(projection, lease);
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    public async Task<IRepairHoleTicket?> TryBeginHoleWaitAsync(
        RepairStreamContext context,
        long position,
        Exception failure,
        CancellationToken ct)
    {
        if (!Enabled || !RepairAwareStream.IsRepairableFailure(failure))
            return null;

        // Origin evidence first: the upstream release is dead regardless of local repair.
        healthCache?.Record(context.ReleaseId, ReleaseHealth.Dead);
        logger.LogWarning(
            "Streaming hit a definitive damaged article for release {ReleaseId} at media offset {Offset}; engaging repair",
            context.ReleaseId,
            position);

        var handle = await coordinator.GetOrStartJobAsync(
            context.ReleaseId, context.WorkId, context.ReleaseTitle, RepairTrigger.Runtime, ct)
            .ConfigureAwait(false);
        if (handle is null)
        {
            logger.LogInformation(
                "Repair did not engage for release {ReleaseId}; falling back to the legacy behavior",
                context.ReleaseId);
            return null;
        }

        metrics?.RepairWaitAtHoleStarted();
        return new HoleTicket(this, handle, context.ReleaseId);
    }

    internal async Task<Stream> OpenPinnedProjectionAsync(
        RepairArtifact artifact,
        string releaseId,
        CancellationToken ct)
    {
        var lease = artifactCache.TryAcquire(artifact.Fingerprint)
            ?? throw new FileNotFoundException("The repaired artifact was evicted before it could be opened.");
        try
        {
            var projection = await BuildProjectionAsync(lease.Artifact, releaseId, ct).ConfigureAwait(false);
            return OpenPinnedProjectionStream(projection, lease);
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    private async Task<LocalMediaProjection> BuildProjectionAsync(
        RepairArtifact artifact,
        string releaseId,
        CancellationToken ct)
    {
        string? password = null;
        if (artifact.Manifest.IsRarWrapped)
        {
            try
            {
                var context = await coordinator.BuildContextAsync(releaseId, ct).ConfigureAwait(false);
                password = context.Candidate.Password;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogWarning(
                    "Could not recover the RAR password context for release {ReleaseId} ({FailureType})",
                    releaseId, e.GetType().Name);
            }
        }

        return await LocalArtifactProjector.BuildAsync(
            artifact.Directory, artifact.Manifest.Files, password, ct).ConfigureAwait(false);
    }

    /// <summary>Opens one pinned stream over an already-built local projection.</summary>
    public Stream OpenPinnedProjectionStream(LocalMediaProjection projection, string fingerprint)
    {
        var lease = artifactCache.TryAcquire(fingerprint)
            ?? throw new FileNotFoundException("The repaired artifact was evicted before it could be opened.");
        try
        {
            return OpenPinnedProjectionStream(projection, lease);
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    private Stream OpenPinnedProjectionStream(LocalMediaProjection projection, RepairArtifactLease lease)
    {
        var stream = projection.OpenStream();
        metrics?.RepairCacheHit();
        return new PinnedStream(stream, lease);
    }

    private TimeSpan WaitAtHoleTimeout
        => TimeSpan.FromSeconds(Math.Max(1, options.Value.Repair.WaitAtHoleTimeoutSeconds));

    private void RecordResumed(double seconds) => metrics?.RepairWaitAtHoleResumed(seconds);

    private void LogWaitTimeout(string releaseId)
        => logger.LogWarning(
            "A reader for release {ReleaseId} exceeded the wait-at-hole budget; the repair job continues in the background",
            releaseId);

    private sealed class HoleTicket(RepairStreamGateway gateway, RepairJobHandle handle, string releaseId)
        : IRepairHoleTicket
    {
        public async Task<Stream> WaitForLocalStreamAsync(CancellationToken readerCt)
        {
            var start = System.Diagnostics.Stopwatch.GetTimestamp();
            try
            {
                var artifact = await handle.WaitAsync(gateway.WaitAtHoleTimeout, readerCt).ConfigureAwait(false);
                var stream = await gateway.OpenPinnedProjectionAsync(artifact, releaseId, readerCt)
                    .ConfigureAwait(false);
                gateway.RecordResumed(System.Diagnostics.Stopwatch.GetElapsedTime(start).TotalSeconds);
                return stream;
            }
            catch (TimeoutException)
            {
                gateway.LogWaitTimeout(releaseId);
                throw;
            }
        }
    }

    /// <summary>Holds the artifact pin for exactly the lifetime of one projection stream.</summary>
    private sealed class PinnedStream(Stream inner, IDisposable pin) : Stream
    {
        private int _disposed;

        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => false;
        public override long Length => inner.Length;

        public override long Position
        {
            get => inner.Position;
            set => inner.Position = value;
        }

        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => inner.ReadAsync(buffer, cancellationToken);

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => inner.ReadAsync(buffer, offset, count, cancellationToken);

        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void Flush() => inner.Flush();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing && Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                try
                {
                    inner.Dispose();
                }
                finally
                {
                    pin.Dispose();
                }
            }
            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                try
                {
                    await inner.DisposeAsync().ConfigureAwait(false);
                }
                finally
                {
                    pin.Dispose();
                }
            }
            await base.DisposeAsync().ConfigureAwait(false);
        }
    }
}
