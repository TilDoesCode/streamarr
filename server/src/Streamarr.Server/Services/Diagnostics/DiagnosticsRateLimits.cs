using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>Per-client rate limits of the diagnostics report and the speed test transfers.</summary>
public static class DiagnosticsRateLimits
{
    public const string Report = "diagnostics";
    public const string SpeedTest = "speedtest";
    public const string Status = "diagnostics-status";

    /// <summary>One test is ~10 pings plus a handful of long transfers (~20 requests); this leaves room for several tests a minute.</summary>
    public const int SpeedTestPerMinute = 240;

    public const int ReportPerMinute = 20;

    /// <summary>The status banner polls every couple of minutes and on app focus; several devices per user stay well below this.</summary>
    public const int StatusPerMinute = 30;

    public static void Add(RateLimiterOptions o)
    {
        o.AddPolicy(Report, context => Window(context, ReportPerMinute));
        o.AddPolicy(SpeedTest, context => Window(context, SpeedTestPerMinute));
        o.AddPolicy(Status, context => Window(context, StatusPerMinute));
    }

    /// <summary>Signed-in callers get their own window (devices behind one NAT share an IP); anonymous requests fall back to the IP.</summary>
    internal static string PartitionKey(HttpContext context)
    {
        var user = context.User;
        if (user.Identity?.IsAuthenticated == true)
        {
            var id = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.Identity.Name;
            if (!string.IsNullOrEmpty(id))
                return $"{user.Identity.AuthenticationType}:{id}";
        }
        return "ip:" + (context.Connection.RemoteIpAddress?.ToString() ?? "unknown");
    }

    private static RateLimitPartition<string> Window(HttpContext context, int permits)
        => RateLimitPartition.GetFixedWindowLimiter(
            PartitionKey(context),
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = permits,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true,
            });
}
