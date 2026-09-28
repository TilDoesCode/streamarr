using System.Globalization;
using System.Text.RegularExpressions;

namespace Streamarr.Server.Transcoding;

public enum GpuDeviceKind
{
    /// <summary>A DRM render node (<c>/dev/dri/renderD*</c>) used by VA-API and QSV.</summary>
    Drm,

    /// <summary>An NVIDIA GPU addressed by its CUDA index in PCI bus order (the numbering <c>nvidia-smi</c> shows).</summary>
    Cuda,
}

public sealed record GpuDevice
{
    public required string Id { get; init; }
    public required GpuDeviceKind Kind { get; init; }
    public string? Vendor { get; init; }
    public string? VendorId { get; init; }
    public string? DeviceId { get; init; }
    public string? Driver { get; init; }
    public string? Name { get; init; }
    public string? PciSlot { get; init; }
    public int? Index { get; init; }

    /// <summary>Quick H.264 encode self-test per backend, filled in by capability detection.</summary>
    public IReadOnlyDictionary<HardwareAcceleration, CapabilityCheck> Checks { get; init; } =
        new Dictionary<HardwareAcceleration, CapabilityCheck>();

    public bool IsNvidiaDriver => Driver is "nvidia" || VendorId == "0x10de";

    public string Label
    {
        get
        {
            var model = Name ?? Vendor ?? "Unknown GPU";
            var details = new[] { Name is null ? null : Vendor, Driver, PciSlot }.Where(d => d is { Length: > 0 });
            var where = Kind == GpuDeviceKind.Cuda ? $"GPU {Index}" : Path.GetFileName(Id);
            var suffix = string.Join(" · ", details);
            return suffix.Length == 0 ? $"{where} — {model}" : $"{where} — {model} ({suffix})";
        }
    }

    public static string CudaId(int index) => $"cuda:{index.ToString(CultureInfo.InvariantCulture)}";
}

public interface IGpuDeviceEnumerator
{
    Task<IReadOnlyList<GpuDevice>> EnumerateAsync(CancellationToken ct);
}

/// <summary>Lists the GPUs this process can use: DRM render nodes from sysfs and NVIDIA GPUs from nvidia-smi.</summary>
public sealed partial class GpuDeviceEnumerator(IProcessRunner runner, string devRoot = "/dev", string sysRoot = "/sys")
    : IGpuDeviceEnumerator
{
    private static readonly IReadOnlyDictionary<string, string> Vendors = new Dictionary<string, string>
    {
        ["0x8086"] = "Intel",
        ["0x1002"] = "AMD",
        ["0x10de"] = "NVIDIA",
        ["0x1af4"] = "Virtio",
        ["0x15ad"] = "VMware",
        ["0x1414"] = "Microsoft",
    };

    public async Task<IReadOnlyList<GpuDevice>> EnumerateAsync(CancellationToken ct)
    {
        var devices = new List<GpuDevice>();
        devices.AddRange(RenderNodes());
        devices.AddRange(await NvidiaGpusAsync(ct));
        return devices;
    }

    private IEnumerable<GpuDevice> RenderNodes()
    {
        var dri = Path.Combine(devRoot, "dri");
        if (!Directory.Exists(dri))
            return [];
        return Directory.GetFiles(dri, "renderD*")
            .Select(path => (path, number: RenderNumber(path)))
            .Where(n => n.number is not null)
            .OrderBy(n => n.number)
            .Select(n => DescribeRenderNode(n.path))
            .ToList();
    }

    private GpuDevice DescribeRenderNode(string path)
    {
        var device = Path.Combine(sysRoot, "class", "drm", Path.GetFileName(path), "device");
        var vendorId = ReadTrimmed(Path.Combine(device, "vendor"))?.ToLowerInvariant();
        var uevent = ReadLines(Path.Combine(device, "uevent"));
        return new GpuDevice
        {
            Id = path,
            Kind = GpuDeviceKind.Drm,
            VendorId = vendorId,
            Vendor = vendorId is not null && Vendors.TryGetValue(vendorId, out var vendor) ? vendor : vendorId,
            DeviceId = ReadTrimmed(Path.Combine(device, "device"))?.ToLowerInvariant(),
            Driver = Value(uevent, "DRIVER"),
            PciSlot = ShortSlot(Value(uevent, "PCI_SLOT_NAME")),
            Name = ReadTrimmed(Path.Combine(device, "product_name")) ?? ReadTrimmed(Path.Combine(device, "label")),
        };
    }

    private async Task<IReadOnlyList<GpuDevice>> NvidiaGpusAsync(CancellationToken ct)
    {
        try
        {
            var result = await runner.RunAsync(
                "nvidia-smi", ["--query-gpu=index,name,pci.bus_id", "--format=csv,noheader"], TimeSpan.FromSeconds(10), ct);
            if (result.Succeeded)
            {
                var parsed = ParseNvidiaSmi(result.StandardOutput);
                if (parsed.Count > 0)
                    return parsed;
            }
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or FileNotFoundException or InvalidOperationException)
        {
        }

        if (!Directory.Exists(devRoot))
            return [];
        return Directory.GetFiles(devRoot, "nvidia*")
            .Select(path => NvidiaNode().Match(Path.GetFileName(path)))
            .Where(m => m.Success)
            .Select(m => int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture))
            .Order()
            .Select(index => new GpuDevice
            {
                Id = GpuDevice.CudaId(index),
                Kind = GpuDeviceKind.Cuda,
                Index = index,
                Vendor = "NVIDIA",
                VendorId = "0x10de",
                Driver = "nvidia",
            })
            .ToList();
    }

    internal static IReadOnlyList<GpuDevice> ParseNvidiaSmi(string output)
    {
        var devices = new List<GpuDevice>();
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = line.Split(',', StringSplitOptions.TrimEntries);
            if (parts.Length < 3 || !int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var index))
                continue;
            devices.Add(new GpuDevice
            {
                Id = GpuDevice.CudaId(index),
                Kind = GpuDeviceKind.Cuda,
                Index = index,
                Name = parts[1].Length is > 0 and <= 128 ? parts[1] : null,
                Vendor = "NVIDIA",
                VendorId = "0x10de",
                Driver = "nvidia",
                PciSlot = ShortSlot(parts[2]),
            });
        }
        return devices;
    }

    /// <summary><c>0000:01:00.0</c> / <c>00000000:01:00.0</c> → <c>01:00.0</c> unless the PCI domain is not zero.</summary>
    internal static string? ShortSlot(string? slot)
    {
        if (string.IsNullOrWhiteSpace(slot))
            return null;
        var parts = slot.Trim().Split(':');
        return parts.Length == 3 && parts[0].All(c => c == '0') ? $"{parts[1]}:{parts[2]}".ToLowerInvariant() : slot.Trim().ToLowerInvariant();
    }

    private static int? RenderNumber(string path)
    {
        var match = RenderNode().Match(Path.GetFileName(path));
        return match.Success ? int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) : null;
    }

    private static string? Value(IReadOnlyList<string> lines, string key)
        => lines.Where(l => l.StartsWith(key + "=", StringComparison.Ordinal)).Select(l => l[(key.Length + 1)..].Trim()).FirstOrDefault();

    private static IReadOnlyList<string> ReadLines(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllLines(path) : [];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static string? ReadTrimmed(string path)
    {
        var text = ReadLines(path).FirstOrDefault()?.Trim();
        return text is { Length: > 0 and <= 128 } && !text.Any(char.IsControl) ? text : null;
    }

    [GeneratedRegex(@"^renderD(\d{1,4})$", RegexOptions.CultureInvariant)]
    private static partial Regex RenderNode();

    [GeneratedRegex(@"^nvidia(\d{1,2})$", RegexOptions.CultureInvariant)]
    private static partial Regex NvidiaNode();
}

/// <summary>Environment every ffmpeg child gets, so device indices mean the same thing everywhere.</summary>
public static class FfmpegEnvironment
{
    public static void Apply(System.Diagnostics.ProcessStartInfo psi)
    {
        if (Environment.GetEnvironmentVariable("CUDA_DEVICE_ORDER") is null)
            psi.Environment["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID";
    }
}
