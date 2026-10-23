using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>Per-client rate limits of the diagnostics report and the speed test transfers.</summary>
public static class DiagnosticsRateLimits
{
    public const string Report = "diagnostics";
    public const string SpeedTest = "speedtest";

    /// <summary>A full test is ~10 pings plus a few dozen download/upload chunks.</summary>
    public const int SpeedTestPerMinute = 240;

    public const int ReportPerMinute = 20;

    public static void Add(RateLimiterOptions o)
    {
        o.AddPolicy(Report, context => Window(context, ReportPerMinute));
        o.AddPolicy(SpeedTest, context => Window(context, SpeedTestPerMinute));
    }

    private static RateLimitPartition<string> Window(HttpContext context, int permits)
        => RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = permits,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true,
            });
}
