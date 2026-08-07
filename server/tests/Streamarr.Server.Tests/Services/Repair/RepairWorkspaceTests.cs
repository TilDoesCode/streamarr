using Streamarr.Usenet.Models;
using Streamarr.Server.Options;
using Streamarr.Server.Services.Repair;

namespace Streamarr.Server.Tests.Services.Repair;

public class RepairWorkspaceTests
{
    [Fact]
    public void Reservations_PreventConcurrentJobsFromClaimingTheSameFreeBytes()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace(
            availableFreeBytes: () => 1_000);
        try
        {
            var first = workspace.TryReserve(workspaceBytes: 600, minimumFreeBytes: 100);

            Assert.NotNull(first);
            Assert.Equal(600, workspace.ReservedBytes);
            Assert.Null(workspace.TryReserve(workspaceBytes: 301, minimumFreeBytes: 100));

            first!.Dispose();
            first.Dispose();
            Assert.Equal(0, workspace.ReservedBytes);

            using var replacement = workspace.TryReserve(workspaceBytes: 301, minimumFreeBytes: 100);
            Assert.NotNull(replacement);
            Assert.Equal(301, workspace.ReservedBytes);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReservationConsumption_ReleasesOnlyNewCoverageAndAvoidsFreeSpaceDoubleCounting()
    {
        long availableFreeBytes = 1_000;
        var (workspace, root) = RepairTestSupport.CreateWorkspace(
            availableFreeBytes: () => availableFreeBytes);
        try
        {
            var first = workspace.TryReserve(workspaceBytes: 600, minimumFreeBytes: 100);
            Assert.NotNull(first);
            Assert.Null(workspace.TryReserve(workspaceBytes: 301, minimumFreeBytes: 100));

            using (var staging = workspace.CreateStaging("aaaabbbbccccdddd", first))
            {
                var file = staging.OpenFile(RepairWorkspace.SourceFileName(0), 600);
                Assert.Throws<ArgumentOutOfRangeException>(() =>
                    file.WriteAt(550, new byte[100]));
                Assert.Equal(600, first!.RemainingBytes);

                file.WriteAt(0, new byte[300]);
                Assert.Equal(300, first.RemainingBytes);
                Assert.Equal(300, workspace.ReservedBytes);

                file.WriteAt(100, new byte[100]); // fully overlapping
                Assert.Equal(300, first.RemainingBytes);
                Assert.Equal(300, workspace.ReservedBytes);

                file.WriteAt(250, new byte[150]); // 50 overlap + 100 new
                Assert.Equal(200, first.RemainingBytes);
                Assert.Equal(200, workspace.ReservedBytes);

                // The filesystem now reports the 400 written bytes as used. Only the
                // unconsumed 200-byte promise is subtracted from that current reading.
                availableFreeBytes = 600;
                var later = workspace.TryReserve(workspaceBytes: 300, minimumFreeBytes: 100);
                Assert.NotNull(later);
                Assert.Equal(500, workspace.ReservedBytes);
                later!.Dispose();
                later.Dispose();
                Assert.Equal(200, workspace.ReservedBytes);
            }

            first!.Dispose();
            first.Dispose();
            Assert.Equal(0, workspace.ReservedBytes);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SparseFile_TracksCoverageAndMissingRangesByteExactly()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            using var staging = workspace.CreateStaging("aaaabbbbccccdddd");
            var file = staging.OpenFile("source-0.bin", 10_000);

            file.WriteAt(0, new byte[2_000]);
            file.WriteAt(5_000, new byte[1_000]);
            file.WriteAt(2_000, new byte[500]);   // extends the first range
            file.WriteAt(1_000, new byte[1_500]); // overlaps + merges

            Assert.Equal(
                new[] { new LongRange(2_500, 5_000), new LongRange(6_000, 10_000) },
                file.MissingRanges());
            Assert.True(file.IsCovered(0, 2_500));
            Assert.False(file.IsCovered(2_400, 2_600));
            Assert.Equal(3_500, file.CoveredBytes);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SparseFile_ReadsBackWrittenBytesAtOffsets()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            using var staging = workspace.CreateStaging("aaaabbbbccccdddd");
            var file = staging.OpenFile("source-0.bin", 4_096);
            var payload = Enumerable.Range(0, 256).Select(i => (byte)i).ToArray();
            file.WriteAt(1_000, payload);

            var read = new byte[256];
            file.ReadAt(1_000, read);
            Assert.Equal(payload, read);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SparseFile_RejectsWritesBeyondTheDeclaredLength()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            using var staging = workspace.CreateStaging("aaaabbbbccccdddd");
            var file = staging.OpenFile("source-0.bin", 1_024);
            Assert.Throws<ArgumentOutOfRangeException>(() => file.WriteAt(1_000, new byte[100]));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData("not-a-fingerprint!")]
    [InlineData("ABCDEF0123456789")] // uppercase is rejected — fingerprints are lowercase hex
    [InlineData("")]
    public void InvalidFingerprints_NeverBecomePaths(string fingerprint)
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            Assert.Throws<ArgumentException>(() => workspace.StagingDirectory(fingerprint));
            Assert.Throws<ArgumentException>(() => workspace.ArtifactDirectory(fingerprint));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DeleteBounded_RefusesPathsOutsideTheWorkspace()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        var outside = Directory.CreateTempSubdirectory("streamarr-outside-").FullName;
        try
        {
            Assert.Throws<InvalidOperationException>(() => workspace.DeleteBounded(outside));
            Assert.True(Directory.Exists(outside));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            Directory.Delete(outside, recursive: true);
        }
    }

    [Fact]
    public void CleanStaleStaging_RemovesOnlyFingerprintShapedDirectories()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            var stale = workspace.StagingDirectory("aaaabbbbccccdddd");
            Directory.CreateDirectory(stale);
            File.WriteAllText(Path.Combine(stale, "leftover.bin"), "x");
            var foreign = Path.Combine(workspace.PartialRoot, "unexpected-dir");
            Directory.CreateDirectory(foreign);

            workspace.CleanStaleStaging();

            Assert.False(Directory.Exists(stale));
            Assert.True(Directory.Exists(foreign));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DisposingFailedStaging_RemovesAllPartialFiles()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        string stagingDirectory;
        try
        {
            using (var staging = workspace.CreateStaging("aaaabbbbccccdddd"))
            {
                stagingDirectory = staging.Directory;
                var file = staging.OpenFile(RepairWorkspace.SourceFileName(0), 1024);
                file.WriteAt(0, new byte[256]);
                Assert.True(Directory.Exists(stagingDirectory));
            }

            Assert.False(Directory.Exists(stagingDirectory));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DisposingPublishedStaging_DoesNotDeleteTheAtomicArtifact()
    {
        var options = new StreamarrOptions();
        var (workspace, root) = RepairTestSupport.CreateWorkspace(options);
        try
        {
            var cache = RepairTestSupport.CreateArtifactCache(workspace, options);
            var payload = Enumerable.Range(0, 1024).Select(i => (byte)i).ToArray();
            using var staging = workspace.CreateStaging("aaaabbbbccccdddd");
            staging.OpenFile(RepairWorkspace.SourceFileName(0), payload.Length).WriteAt(0, payload);
            staging.CloseFiles();
            var manifest = new RepairArtifactManifest
            {
                Fingerprint = "aaaabbbbccccdddd",
                ReleaseTitle = "Published.Test",
                SetIdHex = new string('0', 32),
                SliceSize = 512,
                Files =
                [
                    new RepairArtifactFile
                    {
                        DisplayName = "video.mkv",
                        RelativePath = RepairWorkspace.SourceFileName(0),
                        Length = payload.Length,
                        Md5Hex = Convert.ToHexString(
                            System.Security.Cryptography.MD5.HashData(payload)).ToLowerInvariant(),
                    },
                ],
                MediaFileDisplayName = "video.mkv",
                IsRarWrapped = false,
                MediaSizeBytes = payload.Length,
                CreatedUtc = DateTimeOffset.UtcNow,
            };

            var artifact = cache.Publish(manifest.Fingerprint, staging.Directory, manifest);
            staging.Dispose();

            Assert.True(File.Exists(artifact.FilePath(manifest.Files[0])));
            using var lease = cache.TryAcquire(manifest.Fingerprint);
            Assert.NotNull(lease);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void WorkspaceLayout_RejectsASymlinkedChildWithoutFollowingIt()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        var outside = Directory.CreateTempSubdirectory("streamarr-repair-outside-").FullName;
        var sentinel = Path.Combine(outside, "keep.txt");
        File.WriteAllText(sentinel, "keep");
        try
        {
            Directory.Delete(workspace.PartialRoot);
            Directory.CreateSymbolicLink(workspace.PartialRoot, outside);

            Assert.Throws<IOException>(workspace.EnsureLayout);
            Assert.Equal("keep", File.ReadAllText(sentinel));
        }
        finally
        {
            var partial = new DirectoryInfo(workspace.PartialRoot);
            if (partial.LinkTarget is not null)
                partial.Delete();
            Directory.Delete(root, recursive: true);
            Directory.Delete(outside, recursive: true);
        }
    }

    [Fact]
    public void Staging_RejectsCallerControlledFileNamesAndOverflowingRanges()
    {
        var (workspace, root) = RepairTestSupport.CreateWorkspace();
        try
        {
            using var staging = workspace.CreateStaging("aaaabbbbccccdddd");
            Assert.Throws<ArgumentException>(() => staging.OpenFile("../escape.bin", 1024));
            var file = staging.OpenFile(RepairWorkspace.SourceFileName(0), 1024);
            Assert.Throws<ArgumentOutOfRangeException>(() => file.WriteAt(long.MaxValue, [1]));
            Assert.Throws<ArgumentOutOfRangeException>(() => file.ReadAt(long.MaxValue, new byte[1]));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void WorkspaceLayout_RejectsTheFilesystemRootBeforeChangingIt()
    {
        var contentRoot = Directory.CreateTempSubdirectory("streamarr-repair-root-guard-").FullName;
        try
        {
            var filesystemRoot = Path.GetPathRoot(contentRoot)!;
            var workspace = RepairTestSupport.CreateWorkspaceAt(contentRoot, filesystemRoot);

            Assert.Throws<InvalidOperationException>(workspace.EnsureLayout);
        }
        finally
        {
            Directory.Delete(contentRoot, recursive: true);
        }
    }
}
