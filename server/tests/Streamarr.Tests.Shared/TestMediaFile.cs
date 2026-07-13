using System.Diagnostics;

namespace Streamarr.Tests.Shared;

/// <summary>
/// Generates a small but real video file with ffmpeg at test time (testsrc video +
/// sine audio), as mandated by the M1 test plan: integration tests must exercise
/// real, probe-able media rather than random bytes.
/// </summary>
public static class TestMediaFile
{
    /// <summary>
    /// Produces an mkv (h264 + aac) of the given duration and returns its bytes.
    /// Requires <c>ffmpeg</c> on the PATH.
    /// </summary>
    public static async Task<byte[]> GenerateMkvAsync(int durationSeconds = 30, CancellationToken ct = default)
    {
        var path = Path.Combine(Path.GetTempPath(), $"streamarr-test-{Guid.NewGuid():N}.mkv");
        try
        {
            var psi = new ProcessStartInfo("ffmpeg")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add("-y");
            psi.ArgumentList.Add("-hide_banner");
            psi.ArgumentList.Add("-loglevel");
            psi.ArgumentList.Add("error");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("lavfi");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add($"testsrc2=duration={durationSeconds}:size=320x240:rate=10");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("lavfi");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add($"sine=frequency=440:duration={durationSeconds}:sample_rate=44100");
            psi.ArgumentList.Add("-c:v");
            psi.ArgumentList.Add("libx264");
            psi.ArgumentList.Add("-preset");
            psi.ArgumentList.Add("ultrafast");
            psi.ArgumentList.Add("-pix_fmt");
            psi.ArgumentList.Add("yuv420p");
            psi.ArgumentList.Add("-c:a");
            psi.ArgumentList.Add("aac");
            psi.ArgumentList.Add("-b:a");
            psi.ArgumentList.Add("64k");
            psi.ArgumentList.Add("-shortest");
            psi.ArgumentList.Add(path);

            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("Could not start ffmpeg.");
            var stderr = await process.StandardError.ReadToEndAsync(ct);
            await process.WaitForExitAsync(ct);
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"ffmpeg failed ({process.ExitCode}): {stderr}");

            return await File.ReadAllBytesAsync(path, ct);
        }
        finally
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }

    /// <summary>
    /// Produces a WebM (VP8 + Vorbis) of the given duration and returns its bytes.
    /// Unlike the h264/mkv fixture, WebM/VP8 is decodable by the open-source Chromium
    /// that Playwright bundles (which ships without the proprietary H.264/AAC codecs),
    /// so the Playwright smoke E2E can actually play the resolved stream in a
    /// <c>&lt;video&gt;</c> element. Requires <c>ffmpeg</c> (with libvpx + libvorbis)
    /// on the PATH.
    /// </summary>
    public static async Task<byte[]> GenerateWebmAsync(int durationSeconds = 10, CancellationToken ct = default)
    {
        var path = Path.Combine(Path.GetTempPath(), $"streamarr-test-{Guid.NewGuid():N}.webm");
        try
        {
            var psi = new ProcessStartInfo("ffmpeg")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add("-y");
            psi.ArgumentList.Add("-hide_banner");
            psi.ArgumentList.Add("-loglevel");
            psi.ArgumentList.Add("error");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("lavfi");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add($"testsrc2=duration={durationSeconds}:size=320x240:rate=10");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("lavfi");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add($"sine=frequency=440:duration={durationSeconds}:sample_rate=44100");
            psi.ArgumentList.Add("-c:v");
            psi.ArgumentList.Add("libvpx");
            psi.ArgumentList.Add("-b:v");
            psi.ArgumentList.Add("500k");
            psi.ArgumentList.Add("-deadline");
            psi.ArgumentList.Add("realtime");
            psi.ArgumentList.Add("-cpu-used");
            psi.ArgumentList.Add("8");
            psi.ArgumentList.Add("-pix_fmt");
            psi.ArgumentList.Add("yuv420p");
            psi.ArgumentList.Add("-c:a");
            psi.ArgumentList.Add("libopus");
            psi.ArgumentList.Add("-b:a");
            psi.ArgumentList.Add("64k");
            psi.ArgumentList.Add("-shortest");
            psi.ArgumentList.Add(path);

            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("Could not start ffmpeg.");
            var stderr = await process.StandardError.ReadToEndAsync(ct);
            await process.WaitForExitAsync(ct);
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"ffmpeg failed ({process.ExitCode}): {stderr}");

            return await File.ReadAllBytesAsync(path, ct);
        }
        finally
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }
}
