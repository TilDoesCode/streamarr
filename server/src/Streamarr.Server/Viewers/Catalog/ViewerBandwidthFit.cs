namespace Streamarr.Server.Viewers.Catalog;

/// <summary>The measured legs of the streaming path: this device ↔ server (sent by the client) and server ↔ Usenet (the server's last test).</summary>
public sealed record BandwidthLegs(int? DeviceKbps, int? UsenetKbps)
{
    public static readonly BandwidthLegs None = new(null, null);

    public bool Any => DeviceKbps is > 0 || UsenetKbps is > 0;
}

/// <summary>Whether a version's bitrate fits the measured connection; <see cref="Leg"/> is the slower leg that decided it.</summary>
public sealed record BandwidthFitResult(string Fit, string? Leg, int? NeededKbps, int? AvailableKbps, bool ViaTranscode);

/// <summary>
/// Bitrate vs. bandwidth for the version list (one place so TV, phone and web agree). A version needs its average bitrate
/// times <see cref="Headroom"/> (peaks of variable-bitrate video); <c>ok</c> when that fits the slowest relevant leg,
/// <c>tight</c> when only the average fits, <c>tooHigh</c> when not even the average fits. The Usenet leg counts only for
/// versions not already downloaded on the server; the device leg not when the server transcodes (it sends its own bitrate).
/// </summary>
public static class ViewerBandwidthFit
{
    public const double Headroom = 1.3;
    public const string Ok = "ok";
    public const string Tight = "tight";
    public const string TooHigh = "tooHigh";
    public const string Unknown = "unknown";
    public const string DeviceLeg = "device";
    public const string UsenetLeg = "usenet";

    /// <summary>Measurements older than this are not used (the client stops sending its own after the same time).</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);

    /// <summary>Null when nothing is measured at all.</summary>
    public static BandwidthFitResult? Evaluate(int? estimatedKbps, string? local, bool transcodes, BandwidthLegs legs)
    {
        if (!legs.Any)
            return null;
        int? device = transcodes ? null : legs.DeviceKbps is > 0 ? legs.DeviceKbps : null;
        int? usenet = local == "ready" ? null : legs.UsenetKbps is > 0 ? legs.UsenetKbps : null;
        (string Leg, int Kbps)? limit = (device, usenet) switch
        {
            ({ } d, { } u) => u < d ? (UsenetLeg, u) : (DeviceLeg, d),
            ({ } d, null) => (DeviceLeg, d),
            (null, { } u) => (UsenetLeg, u),
            _ => null,
        };
        var needed = estimatedKbps is > 0 and var kbps ? (int)Math.Ceiling(kbps * Headroom) : (int?)null;
        if (limit is not { } slowest || estimatedKbps is not > 0)
            return new BandwidthFitResult(Unknown, limit?.Leg, needed, limit?.Kbps, transcodes);
        var fit = needed <= slowest.Kbps ? Ok : estimatedKbps <= slowest.Kbps ? Tight : TooHigh;
        return new BandwidthFitResult(fit, slowest.Leg, needed, slowest.Kbps, transcodes);
    }
}
