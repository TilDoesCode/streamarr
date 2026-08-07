using Streamarr.Server.Options;
using Streamarr.Server.Services.Repair;

namespace Streamarr.Server.Tests.Services.Repair;

public class RepairArtifactCacheTests
{
    private const string Fp1 = "1111aaaa2222bbbb";
    private const string Fp2 = "3333cccc4444dddd";
    private const string Fp3 = "5555eeee6666ffff";

    private sealed class CancelAfterFirstReadStream(byte[] data, CancellationTokenSource cancellation)
        : MemoryStream(data)
    {
        private bool _cancelled;

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = base.Read(buffer, offset, count);
            if (!_cancelled && read > 0)
            {
                _cancelled = true;
                cancellation.Cancel();
            }
            return read;
        }
    }

    [Fact]
    public void PublishAndHit_ServesTheArtifactAtomically()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options);
            var (staging, manifest) = RepairTestSupport.Stage(workspace, Fp1);

            Assert.Null(cache.TryGetReady(Fp1));
            var artifact = cache.Publish(Fp1, staging, manifest);

            Assert.False(Directory.Exists(staging));
            Assert.True(File.Exists(artifact.FilePath(manifest.Files[0])));
            Assert.NotNull(cache.TryGetReady(Fp1));
            Assert.Equal(1024, cache.TotalBytes);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Publish_HonorsCancellationBeforeTheAtomicCommit()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var cache = RepairTestSupport.CreateArtifactCache(workspace, new StreamarrOptions());
            var (staging, manifest) = RepairTestSupport.Stage(workspace, Fp1);
            using var cts = new CancellationTokenSource();
            cts.Cancel();

            Assert.Throws<OperationCanceledException>(() =>
                cache.Publish(Fp1, staging, manifest, cts.Token));

            Assert.True(Directory.Exists(staging));
            Assert.False(Directory.Exists(workspace.ArtifactDirectory(Fp1)));
            Assert.Null(cache.TryGetReady(Fp1));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ArtifactHashing_ObservesCancellationBetweenBoundedChunks()
    {
        using var cts = new CancellationTokenSource();
        using var stream = new CancelAfterFirstReadStream(new byte[2 * 1024 * 1024], cts);

        Assert.Throws<OperationCanceledException>(() =>
            RepairArtifactCache.ComputeMd5(stream, cts.Token));
    }

    [Fact]
    public void Publish_IsIdempotentPerFingerprint()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options);
            var (stagingA, manifestA) = RepairTestSupport.Stage(workspace, Fp1);
            var first = cache.Publish(Fp1, stagingA, manifestA);

            var stagingB = Path.Combine(workspace.PartialRoot, Fp1);
            RepairWorkspace.CreatePrivateDirectory(stagingB);
            File.WriteAllBytes(Path.Combine(stagingB, "source-0.bin"), new byte[1024]);
            var second = cache.Publish(Fp1, stagingB, manifestA);

            Assert.Same(first.Manifest, second.Manifest);
            Assert.False(Directory.Exists(stagingB));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LruEviction_UnderBudget_SkipsPinnedArtifacts()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            options.Repair.CacheBudgetBytes = 64L * 1024 * 1024; // validator minimum
            var time = new RepairTestSupport.ManualTime();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options, time);

            var large = (int)(options.Repair.CacheBudgetBytes / 2) + 1024;
            var (s1, m1) = RepairTestSupport.Stage(workspace, Fp1, large);
            cache.Publish(Fp1, s1, m1);
            using var pin = cache.TryPin(Fp1);
            time.Advance(TimeSpan.FromMinutes(1));

            var (s2, m2) = RepairTestSupport.Stage(workspace, Fp2, large);
            cache.Publish(Fp2, s2, m2);
            time.Advance(TimeSpan.FromMinutes(1));

            // Publishing a third would evict the LRU — but Fp1 is pinned, so Fp2 goes.
            var (s3, m3) = RepairTestSupport.Stage(workspace, Fp3, large);
            cache.Publish(Fp3, s3, m3);

            Assert.NotNull(cache.TryGetReady(Fp1));
            Assert.Null(cache.TryGetReady(Fp2));
            Assert.NotNull(cache.TryGetReady(Fp3));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void TtlSweep_EvictsIdleArtifacts_AndEvictionRaisesTheEvent()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            options.Repair.ArtifactTtlSeconds = 3600;
            var time = new RepairTestSupport.ManualTime();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options, time);
            var evicted = new List<string>();
            cache.ArtifactEvicted += evicted.Add;

            var (staging, manifest) = RepairTestSupport.Stage(workspace, Fp1);
            cache.Publish(Fp1, staging, manifest);

            time.Advance(TimeSpan.FromMinutes(30));
            Assert.Equal(0, cache.Sweep());

            time.Advance(TimeSpan.FromMinutes(31));
            Assert.Equal(1, cache.Sweep());
            Assert.Null(cache.TryGetReady(Fp1));
            Assert.Equal([Fp1], evicted);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Restart_RecoversValidManifests_AndDiscardsBrokenDirectories()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options);
            var (staging, manifest) = RepairTestSupport.Stage(workspace, Fp1);
            cache.Publish(Fp1, staging, manifest);

            // Corrupt the second artifact without changing its size. Restart validation
            // must authenticate content, not trust only names and lengths.
            var (s2, m2) = RepairTestSupport.Stage(workspace, Fp2);
            cache.Publish(Fp2, s2, m2);
            File.WriteAllBytes(
                Path.Combine(workspace.ArtifactDirectory(Fp2), RepairWorkspace.SourceFileName(0)),
                new byte[1024]);

            // Third directory has no manifest at all.
            var bogus = workspace.ArtifactDirectory(Fp3);
            Directory.CreateDirectory(bogus);
            File.WriteAllText(Path.Combine(bogus, "junk.bin"), "junk");

            var restarted = RepairTestSupport.CreateArtifactCache(workspace, options);
            restarted.LoadExisting();

            Assert.NotNull(restarted.TryGetReady(Fp1));
            Assert.Null(restarted.TryGetReady(Fp2));
            Assert.Null(restarted.TryGetReady(Fp3));
            Assert.False(Directory.Exists(workspace.ArtifactDirectory(Fp2)));
            Assert.False(Directory.Exists(bogus));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Pin_BlocksEvictionUntilDisposed()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options);
            var (staging, manifest) = RepairTestSupport.Stage(workspace, Fp1);
            cache.Publish(Fp1, staging, manifest);

            var pin = cache.TryAcquire(Fp1);
            Assert.NotNull(pin);
            Assert.False(cache.Evict(Fp1));
            pin!.Dispose();
            Assert.True(cache.Evict(Fp1));
            Assert.Null(cache.TryGetReady(Fp1));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task AcquireAndEvict_AreAtomicUnderContention()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options);

            for (var attempt = 0; attempt < 100; attempt++)
            {
                var (staging, manifest) = RepairTestSupport.Stage(workspace, Fp1);
                cache.Publish(Fp1, staging, manifest);
                using var start = new Barrier(2);
                RepairArtifactLease? lease = null;
                var evicted = false;
                var acquire = Task.Run(() =>
                {
                    start.SignalAndWait();
                    lease = cache.TryAcquire(Fp1);
                });
                var evict = Task.Run(() =>
                {
                    start.SignalAndWait();
                    evicted = cache.Evict(Fp1);
                });

                await Task.WhenAll(acquire, evict);
                Assert.NotEqual(lease is not null, evicted);
                if (lease is not null)
                {
                    Assert.True(File.Exists(lease.Artifact.FilePath(lease.Artifact.Manifest.Files[0])));
                    lease.Dispose();
                    Assert.True(cache.Evict(Fp1));
                }
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Publish_RejectsAManifestForAnotherFingerprint()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var options = new StreamarrOptions();
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options);
            var (staging, manifest) = RepairTestSupport.Stage(workspace, Fp1);

            Assert.Throws<InvalidDataException>(() => cache.Publish(
                Fp1,
                staging,
                manifest with { Fingerprint = Fp2 }));
            Assert.False(Directory.Exists(workspace.ArtifactDirectory(Fp1)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
