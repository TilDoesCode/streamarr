namespace Streamarr.Server.Transcoding;

/// <summary>Per-backend ffmpeg device/decoder/encoder vocabulary shared by the capability probe and the argument builder.</summary>
public static class HardwareProfiles
{
    public static string EncoderName(HardwareAcceleration accel, string codec) => accel switch
    {
        HardwareAcceleration.VideoToolbox => $"{codec}_videotoolbox",
        HardwareAcceleration.Vaapi => $"{codec}_vaapi",
        HardwareAcceleration.Qsv => $"{codec}_qsv",
        HardwareAcceleration.Nvenc => $"{codec}_nvenc",
        _ => codec == "hevc" ? "libx265" : "libx264",
    };

    public static string? HwAccelName(HardwareAcceleration accel) => accel switch
    {
        HardwareAcceleration.VideoToolbox => "videotoolbox",
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv => "vaapi",
        HardwareAcceleration.Nvenc => "cuda",
        _ => null,
    };

    public static bool PlatformSupports(HardwareAcceleration accel) => accel switch
    {
        HardwareAcceleration.None => true,
        HardwareAcceleration.VideoToolbox => OperatingSystem.IsMacOS(),
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv => OperatingSystem.IsLinux() || OperatingSystem.IsFreeBSD(),
        HardwareAcceleration.Nvenc => OperatingSystem.IsLinux() || OperatingSystem.IsWindows(),
        _ => false,
    };

    public static IReadOnlyList<string> InitArgs(HardwareAcceleration accel, string vaapiDevice, int nvencDevice = 0) => accel switch
    {
        HardwareAcceleration.Vaapi => ["-init_hw_device", $"vaapi=va:{vaapiDevice}", "-filter_hw_device", "va"],
        HardwareAcceleration.Qsv => ["-init_hw_device", $"vaapi=va:{vaapiDevice}", "-init_hw_device", "qsv=qs@va", "-filter_hw_device", "qs"],
        HardwareAcceleration.Nvenc => ["-init_hw_device", $"cuda=cu:{nvencDevice.ToString(System.Globalization.CultureInfo.InvariantCulture)}", "-filter_hw_device", "cu"],
        _ => [],
    };

    /// <summary>Pins NVENC to the chosen GPU even when frames arrive from system memory (software decode).</summary>
    public static IReadOnlyList<string> EncoderDeviceArgs(HardwareAcceleration accel, int nvencDevice) => accel == HardwareAcceleration.Nvenc
        ? ["-gpu", nvencDevice.ToString(System.Globalization.CultureInfo.InvariantCulture)]
        : [];

    public static string? ConfiguredDevice(HardwareAcceleration accel, TranscodingSettings settings) => accel switch
    {
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv => settings.VaapiDevice,
        HardwareAcceleration.Nvenc => GpuDevice.CudaId(settings.NvencDevice),
        _ => null,
    };

    /// <summary>Decode arguments; QSV deliberately decodes through VA-API and maps surfaces, as Jellyfin does by default.</summary>
    public static IReadOnlyList<string> DecodeArgs(HardwareAcceleration accel) => accel switch
    {
        HardwareAcceleration.VideoToolbox => ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"],
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv =>
            ["-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi"],
        HardwareAcceleration.Nvenc => ["-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda"],
        _ => [],
    };

    /// <summary>Filter suffix that turns system-memory frames into something the backend's encoder accepts.</summary>
    public static string UploadFilter(HardwareAcceleration accel) => accel switch
    {
        HardwareAcceleration.Vaapi => "format=nv12,hwupload",
        HardwareAcceleration.Qsv => "format=nv12,hwupload=extra_hw_frames=64",
        _ => "format=nv12",
    };
}
