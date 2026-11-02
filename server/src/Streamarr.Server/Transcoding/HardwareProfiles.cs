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
        HardwareAcceleration.MediaCodec => $"{codec}_mediacodec",
        _ => codec == "hevc" ? "libx265" : "libx264",
    };

    public static string? HwAccelName(HardwareAcceleration accel) => accel switch
    {
        HardwareAcceleration.VideoToolbox => "videotoolbox",
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv => "vaapi",
        HardwareAcceleration.Nvenc => "cuda",
        HardwareAcceleration.MediaCodec => "mediacodec",
        _ => null,
    };

    /// <summary>
    /// The embedded Android server: the bionic .NET build reports Linux, so the app's <c>Streamarr__Host=android</c>
    /// or Android's own process environment (<c>ANDROID_ROOT</c>/<c>ANDROID_DATA</c>) identifies the platform.
    /// </summary>
    public static bool IsAndroid { get; } =
        OperatingSystem.IsAndroid()
        || string.Equals(Environment.GetEnvironmentVariable("Streamarr__Host"), "android", StringComparison.OrdinalIgnoreCase)
        || (Environment.GetEnvironmentVariable("ANDROID_ROOT") is not null && Environment.GetEnvironmentVariable("ANDROID_DATA") is not null);

    public static bool PlatformSupports(HardwareAcceleration accel) => accel switch
    {
        HardwareAcceleration.None => true,
        HardwareAcceleration.VideoToolbox => OperatingSystem.IsMacOS(),
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv => !IsAndroid && (OperatingSystem.IsLinux() || OperatingSystem.IsFreeBSD()),
        HardwareAcceleration.Nvenc => !IsAndroid && (OperatingSystem.IsLinux() || OperatingSystem.IsWindows()),
        HardwareAcceleration.MediaCodec => IsAndroid,
        _ => false,
    };

    /// <summary>MediaCodec decoders are selected by name (<c>-c:v h264_mediacodec</c>) and hand back system-memory frames.</summary>
    public static string? MediaCodecDecoder(string? codec) => codec switch
    {
        "h264" => "h264_mediacodec",
        "hevc" => "hevc_mediacodec",
        "vp8" => "vp8_mediacodec",
        "vp9" => "vp9_mediacodec",
        "av1" => "av1_mediacodec",
        "mpeg2video" => "mpeg2_mediacodec",
        "mpeg4" => "mpeg4_mediacodec",
        _ => null,
    };

    /// <summary>Whether decoded frames stay in GPU memory (hwdownload/scale_* chains) or arrive as plain frames (MediaCodec).</summary>
    public static bool DecodesToSystemMemory(HardwareAcceleration accel) => accel == HardwareAcceleration.MediaCodec;

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
    public static IReadOnlyList<string> DecodeArgs(HardwareAcceleration accel, string? sourceCodec = null) => accel switch
    {
        HardwareAcceleration.VideoToolbox => ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"],
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv =>
            ["-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi"],
        HardwareAcceleration.Nvenc => ["-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda"],
        HardwareAcceleration.MediaCodec => MediaCodecDecoder(sourceCodec) is { } decoder ? ["-c:v", decoder] : [],
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
