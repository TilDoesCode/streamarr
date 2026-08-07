using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Options;
using Streamarr.Server.Services.Repair;

namespace Streamarr.Server.Tests.Services.Repair;

internal static class RepairTestSupport
{
    public static (RepairWorkspace Workspace, string Root) CreateWorkspace(
        StreamarrOptions? options = null,
        Func<long>? availableFreeBytes = null)
    {
        var root = Directory.CreateTempSubdirectory("streamarr-repair-test-").FullName;
        options ??= new StreamarrOptions();
        options.Repair.WorkspacePath = Path.Combine(root, "repair");
        var workspace = new RepairWorkspace(
            Microsoft.Extensions.Options.Options.Create(options),
            new FakeHostEnvironment(root),
            NullLogger<RepairWorkspace>.Instance,
            availableFreeBytes);
        workspace.EnsureLayout();
        return (workspace, root);
    }

    public static RepairArtifactCache CreateArtifactCache(
        RepairWorkspace workspace,
        StreamarrOptions options,
        TimeProvider? time = null)
        => new(
            workspace,
            Microsoft.Extensions.Options.Options.Create(options),
            NullLogger<RepairArtifactCache>.Instance,
            time);

    public static RepairWorkspace CreateWorkspaceAt(string contentRoot, string workspacePath)
    {
        var options = new StreamarrOptions();
        options.Repair.WorkspacePath = workspacePath;
        return new RepairWorkspace(
            Microsoft.Extensions.Options.Options.Create(options),
            new FakeHostEnvironment(contentRoot),
            NullLogger<RepairWorkspace>.Instance);
    }

    /// <summary>Builds a valid staged artifact directory and manifest for tests.</summary>
    public static (string Staging, RepairArtifactManifest Manifest) Stage(
        RepairWorkspace workspace,
        string fingerprint,
        int bytes = 1024,
        string title = "Test.Release")
    {
        var staging = workspace.StagingDirectory(fingerprint);
        RepairWorkspace.CreatePrivateDirectory(staging);
        var payload = new byte[bytes];
        new Random(42).NextBytes(payload);
        File.WriteAllBytes(Path.Combine(staging, RepairWorkspace.SourceFileName(0)), payload);
        var manifest = new RepairArtifactManifest
        {
            Fingerprint = fingerprint,
            ReleaseTitle = title,
            SetIdHex = new string('0', 32),
            SliceSize = 512,
            Files =
            [
                new RepairArtifactFile
                {
                    DisplayName = "video.mkv",
                    RelativePath = RepairWorkspace.SourceFileName(0),
                    Length = bytes,
                    Md5Hex = Convert.ToHexString(System.Security.Cryptography.MD5.HashData(payload)).ToLowerInvariant(),
                },
            ],
            MediaFileDisplayName = "video.mkv",
            IsRarWrapped = false,
            MediaSizeBytes = bytes,
            CreatedUtc = DateTimeOffset.UtcNow,
        };
        return (staging, manifest);
    }

    private sealed class FakeHostEnvironment(string root) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Streamarr.Tests";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    public sealed class ManualTime : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.Parse("2026-08-01T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }
}
