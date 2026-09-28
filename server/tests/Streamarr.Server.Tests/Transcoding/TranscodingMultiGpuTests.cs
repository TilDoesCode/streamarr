using System.Collections.Concurrent;
using System.ComponentModel;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class TranscodingMultiGpuTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("streamarr-gpu-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public async Task Enumerator_DescribesEveryRenderNode_AndNumbersNvidiaGpusLikeNvidiaSmi()
    {
        var dev = FakeDev("renderD128", "renderD129", "renderD130", "card0", "nvidia0", "nvidia1", "nvidiactl");
        FakeRenderNode("renderD128", "0x10de", "0x2504", "nvidia", "0000:01:00.0");
        FakeRenderNode("renderD129", "0x8086", "0x4680", "i915", "0000:00:02.0");
        FakeRenderNode("renderD130", "0x1002", "0x73bf", "amdgpu", "0000:03:00.0", productName: "Radeon RX 6800");
        var runner = new ScriptedRunner(args => args.Contains("--query-gpu=index,name,pci.bus_id")
            ? Ok("0, NVIDIA GeForce RTX 3060, 00000000:01:00.0\n1, NVIDIA T400, 00000000:05:00.0\n")
            : Ok(""));

        var devices = await new GpuDeviceEnumerator(runner, dev, Path.Combine(_root, "sys")).EnumerateAsync(default);

        Assert.Equal(["renderD128", "renderD129", "renderD130"], devices.Where(d => d.Kind == GpuDeviceKind.Drm).Select(d => Path.GetFileName(d.Id)));
        var intel = devices.Single(d => d.Id.EndsWith("renderD129", StringComparison.Ordinal));
        Assert.Equal(("Intel", "i915", "00:02.0"), (intel.Vendor, intel.Driver, intel.PciSlot));
        Assert.True(devices.Single(d => d.Id.EndsWith("renderD128", StringComparison.Ordinal)).IsNvidiaDriver);
        Assert.Equal("renderD130 — Radeon RX 6800 (AMD · amdgpu · 03:00.0)", devices.Single(d => d.Id.EndsWith("renderD130", StringComparison.Ordinal)).Label);
        var cuda = devices.Where(d => d.Kind == GpuDeviceKind.Cuda).ToList();
        Assert.Equal(["cuda:0", "cuda:1"], cuda.Select(d => d.Id));
        Assert.Equal("GPU 1 — NVIDIA T400 (NVIDIA · nvidia · 05:00.0)", cuda[1].Label);
    }

    [Fact]
    public async Task Enumerator_WithoutNvidiaSmi_FallsBackToDeviceNodes_AndWithoutDriIsEmpty()
    {
        var dev = FakeDev("nvidia1", "nvidia0", "nvidiactl", "nvidia-uvm");
        var runner = new ScriptedRunner(_ => throw new Win32Exception("nvidia-smi not found"));

        var devices = await new GpuDeviceEnumerator(runner, dev, Path.Combine(_root, "sys")).EnumerateAsync(default);

        Assert.Equal(["cuda:0", "cuda:1"], devices.Select(d => d.Id));
        Assert.All(devices, d => Assert.Equal(GpuDeviceKind.Cuda, d.Kind));
    }

    [Theory]
    [InlineData("0000:00:02.0", "00:02.0")]
    [InlineData("00000000:01:00.0", "01:00.0")]
    [InlineData("0001:3b:00.0", "0001:3b:00.0")]
    [InlineData("", null)]
    public void PciSlots_AreShortenedOnlyInDomainZero(string slot, string? expected)
        => Assert.Equal(expected, GpuDeviceEnumerator.ShortSlot(slot));

    [Fact]
    public async Task Detection_TestsEveryGpu_AndPointsAtTheOneThatWorks()
    {
        var runner = new ScriptedRunner(args =>
        {
            var joined = string.Join(' ', args);
            if (joined.Contains("-version"))
                return Ok(joined.Contains("ffprobe") ? "ffprobe version 7.1" : "ffmpeg version 7.1 Copyright (c) 2000-2024");
            if (joined.Contains("-encoders"))
                return Ok(" V....D libx264  H.264\n V....D h264_vaapi  VAAPI\n V....D hevc_vaapi  VAAPI\n V....D h264_nvenc  NVENC\n A....D aac  AAC\n");
            if (joined.Contains("-hwaccels"))
                return Ok("Hardware acceleration methods:\nvaapi\ncuda\n");
            if (joined.Contains("vaapi=va:/dev/dri/renderD128"))
                return Fail("[AVHWDeviceContext] Failed to initialise VAAPI connection: -1 (unknown libva error).");
            if (joined.Contains("cuda=cu:0"))
                return Fail("[h264_nvenc] OpenEncodeSessionEx failed: unsupported device (2): (no details)");
            return Ok("");
        });
        var enumerator = new StubEnumerator(
            new GpuDevice { Id = "/dev/dri/renderD128", Kind = GpuDeviceKind.Drm, Vendor = "AMD", VendorId = "0x1002", Driver = "amdgpu" },
            new GpuDevice { Id = "/dev/dri/renderD129", Kind = GpuDeviceKind.Drm, Vendor = "Intel", VendorId = "0x8086", Driver = "i915", PciSlot = "00:02.0" },
            new GpuDevice { Id = "/dev/dri/renderD130", Kind = GpuDeviceKind.Drm, Vendor = "NVIDIA", VendorId = "0x10de", Driver = "nvidia" },
            new GpuDevice { Id = "cuda:0", Kind = GpuDeviceKind.Cuda, Index = 0, Name = "NVIDIA T400", Vendor = "NVIDIA", VendorId = "0x10de", Driver = "nvidia" },
            new GpuDevice { Id = "cuda:1", Kind = GpuDeviceKind.Cuda, Index = 1, Name = "NVIDIA GeForce RTX 3060", Vendor = "NVIDIA", VendorId = "0x10de", Driver = "nvidia" });

        var caps = await Probe(runner, enumerator).DetectAsync(new TranscodingSettings { VaapiDevice = "/dev/dri/renderD128", NvencDevice = 0 }, default);

        var vaapi = caps.For(HardwareAcceleration.Vaapi)!;
        Assert.False(vaapi.H264Encode.Passed);
        Assert.Equal("/dev/dri/renderD129", vaapi.AlternativeDevice);
        Assert.Contains(vaapi.Notes, n => n.Contains("renderD129") && n.Contains("select it"));
        Assert.DoesNotContain("/dev/dri/renderD130", vaapi.DeviceChecks.Keys);

        var nvenc = caps.For(HardwareAcceleration.Nvenc)!;
        Assert.Equal("cuda:1", nvenc.AlternativeDevice);
        Assert.Contains(runner.Calls, c => c.Contains("cuda=cu:1") && c.Contains("-gpu 1"));

        var intel = caps.Devices.Single(d => d.Id == "/dev/dri/renderD129");
        Assert.True(intel.Checks[HardwareAcceleration.Vaapi].Passed);
        Assert.False(caps.Devices.Single(d => d.Id == "/dev/dri/renderD128").Checks[HardwareAcceleration.Vaapi].Passed);
        Assert.True(caps.Devices.Single(d => d.Id == "cuda:1").Checks[HardwareAcceleration.Nvenc].Passed);
    }

    [Fact]
    public async Task Detection_WarnsWhenTheSelectedRenderNodeBelongsToTheNvidiaDriver()
    {
        var runner = new ScriptedRunner(args => string.Join(' ', args) switch
        {
            var a when a.Contains("-version") => Ok("ffmpeg version 7.1"),
            var a when a.Contains("-encoders") => Ok(" V....D libx264  H.264\n V....D h264_vaapi  VAAPI\n A....D aac  AAC\n"),
            var a when a.Contains("-hwaccels") => Ok("Hardware acceleration methods:\nvaapi\n"),
            var a when a.Contains("renderD128") => Fail("Failed to initialise VAAPI connection"),
            _ => Ok(""),
        });
        var enumerator = new StubEnumerator(
            new GpuDevice { Id = "/dev/dri/renderD128", Kind = GpuDeviceKind.Drm, Vendor = "NVIDIA", VendorId = "0x10de", Driver = "nvidia" },
            new GpuDevice { Id = "/dev/dri/renderD129", Kind = GpuDeviceKind.Drm, Vendor = "Intel", VendorId = "0x8086", Driver = "i915" });

        var caps = await Probe(runner, enumerator).DetectAsync(new TranscodingSettings(), default);

        var vaapi = caps.For(HardwareAcceleration.Vaapi)!;
        Assert.Contains(vaapi.Notes, n => n.Contains("NVIDIA driver") && n.Contains("no VA-API"));
        Assert.Equal("/dev/dri/renderD129", vaapi.AlternativeDevice);
    }

    [Fact]
    public async Task Detection_NamesTheAvailableGpus_WhenTheSelectedIndexDoesNotExist()
    {
        var runner = new ScriptedRunner(args => string.Join(' ', args) switch
        {
            var a when a.Contains("-version") => Ok("ffmpeg version 7.1"),
            var a when a.Contains("-encoders") => Ok(" V....D libx264  H.264\n V....D h264_nvenc  NVENC\n A....D aac  AAC\n"),
            var a when a.Contains("-hwaccels") => Ok("Hardware acceleration methods:\ncuda\n"),
            _ => Ok(""),
        });
        var enumerator = new StubEnumerator(
            new GpuDevice { Id = "cuda:0", Kind = GpuDeviceKind.Cuda, Index = 0, Name = "NVIDIA T400", Vendor = "NVIDIA", Driver = "nvidia" });

        var caps = await Probe(runner, enumerator).DetectAsync(new TranscodingSettings { NvencDevice = 2 }, default);

        var nvenc = caps.For(HardwareAcceleration.Nvenc)!;
        Assert.False(nvenc.DevicePresent);
        Assert.Contains(nvenc.Notes, n => n.Contains("GPU 2 does not exist") && n.Contains("NVIDIA T400"));
        Assert.Equal("cuda:0", nvenc.AlternativeDevice);
        Assert.Null(nvenc.H264Encode.Passed);
    }

    [Fact]
    public void Nvenc_IsPinnedToTheSelectedGpu_ForDeviceInitAndTheEncoder()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Nvenc, NvencDevice = 1 };
        var caps = Capabilities(Accelerator(HardwareAcceleration.Nvenc, decode: [DecodeCodecs.H264]));
        var args = string.Join(' ', FfmpegArgumentBuilder.Build(Spec(Plan(settings: settings, capabilities: caps), settings, caps)));

        Assert.Contains("-init_hw_device cuda=cu:1", args);
        Assert.Contains("-c:v h264_nvenc", args);
        Assert.Contains("-gpu 1", args);
    }

    [Fact]
    public void Vaapi_UsesTheSelectedRenderNode()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi, VaapiDevice = "/dev/dri/renderD129" };
        var caps = Capabilities(Accelerator(HardwareAcceleration.Vaapi, decode: [DecodeCodecs.H264]));
        var args = string.Join(' ', FfmpegArgumentBuilder.Build(Spec(Plan(settings: settings, capabilities: caps), settings, caps)));

        Assert.Contains("-init_hw_device vaapi=va:/dev/dri/renderD129", args);
        Assert.DoesNotContain("-gpu", args);
    }

    [Fact]
    public void FfmpegChildren_NumberCudaGpusInPciBusOrder()
    {
        var psi = new System.Diagnostics.ProcessStartInfo("ffmpeg");
        FfmpegEnvironment.Apply(psi);
        Assert.Equal(Environment.GetEnvironmentVariable("CUDA_DEVICE_ORDER") ?? "PCI_BUS_ID", psi.Environment["CUDA_DEVICE_ORDER"]);
    }

    [Theory]
    [InlineData(-1, false)]
    [InlineData(0, true)]
    [InlineData(15, true)]
    [InlineData(16, false)]
    public void NvencDevice_IsValidated(int index, bool valid)
        => Assert.Equal(valid, new TranscodingSettings { NvencDevice = index }.Validate().Count == 0);

    private FfmpegCapabilityProbe Probe(IProcessRunner runner, IGpuDeviceEnumerator enumerator)
    {
        var environment = new FakeEnvironment(_root);
        var options = Microsoft.Extensions.Options.Options.Create(new TranscodingOptions { WorkspacePath = Path.Combine(_root, "workspace") });
        return new FfmpegCapabilityProbe(
            runner, options, new TranscodingWorkspace(options, environment), enumerator,
            NullLogger<FfmpegCapabilityProbe>.Instance, platformSupports: kind => kind != HardwareAcceleration.VideoToolbox);
    }

    private string FakeDev(params string[] nodes)
    {
        var dev = Path.Combine(_root, "dev");
        Directory.CreateDirectory(Path.Combine(dev, "dri"));
        foreach (var node in nodes)
            File.WriteAllText(node.StartsWith("render", StringComparison.Ordinal) || node.StartsWith("card", StringComparison.Ordinal)
                ? Path.Combine(dev, "dri", node)
                : Path.Combine(dev, node), string.Empty);
        return dev;
    }

    private void FakeRenderNode(string node, string vendor, string device, string driver, string slot, string? productName = null)
    {
        var directory = Path.Combine(_root, "sys", "class", "drm", node, "device");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "vendor"), vendor + "\n");
        File.WriteAllText(Path.Combine(directory, "device"), device + "\n");
        File.WriteAllText(Path.Combine(directory, "uevent"), $"DRIVER={driver}\nPCI_CLASS=30000\nPCI_SLOT_NAME={slot}\n");
        if (productName is not null)
            File.WriteAllText(Path.Combine(directory, "product_name"), productName + "\n");
    }

    private static ProcessResult Ok(string stdout) => new(0, stdout, string.Empty, TimeSpan.FromMilliseconds(5), TimeSpan.Zero, false);

    private static ProcessResult Fail(string stderr) => new(1, string.Empty, stderr, TimeSpan.FromMilliseconds(5), TimeSpan.Zero, false);

    private sealed class ScriptedRunner(Func<IReadOnlyList<string>, ProcessResult> script) : IProcessRunner
    {
        public ConcurrentBag<string> Calls { get; } = [];

        public Task<ProcessResult> RunAsync(string fileName, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken ct)
        {
            Calls.Add(string.Join(' ', arguments));
            return Task.FromResult(script([fileName, .. arguments]));
        }
    }

    private sealed class StubEnumerator(params GpuDevice[] devices) : IGpuDeviceEnumerator
    {
        public Task<IReadOnlyList<GpuDevice>> EnumerateAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<GpuDevice>>(devices);
    }

    private sealed class FakeEnvironment(string root) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ApplicationName { get; set; } = "tests";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
