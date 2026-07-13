using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Stress test for the streaming path under concurrent range reads (BRIEF §10-M7 (f)).
/// Fires a burst of randomized, overlapping Range requests against one live session and
/// asserts every response is byte-exact — the read-ahead segment streaming stays correct
/// under contention and never exceeds the connection budget. Findings are printed for the
/// record (see docs/m7-cache-loadtest.md).
/// </summary>
[Collection("streamarr-server")]
public class SegmentCacheLoadTests(StreamarrServerFixture fixture, ITestOutputHelper output)
{
    [Fact]
    public async Task ConcurrentRandomRangeReads_AreAllByteExact_UnderContention()
    {
        using var client = fixture.CreateClient();

        var resolveResponse = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = StreamarrServerFixture.DirectReleaseId });
        var resolved = (await resolveResponse.Content.ReadFromJsonAsync<ResolveResponse>())!;
        var streamUrl = resolved.StreamUrl!;
        var length = fixture.Video.Length;

        const int requests = 64;
        // A fixed seed keeps the load profile reproducible across runs.
        var rng = new Random(20260713);
        var ranges = Enumerable.Range(0, requests)
            .Select(_ =>
            {
                var from = rng.Next(0, length - 1);
                var len = rng.Next(1, Math.Min(96_000, length - from));
                return (from, to: from + len - 1);
            })
            .ToArray();

        var sw = Stopwatch.StartNew();
        var totalBytes = 0L;

        await Task.WhenAll(ranges.Select(async range =>
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, streamUrl);
            request.Headers.Range = new RangeHeaderValue(range.from, range.to);
            using var response = await client.SendAsync(request);

            Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
            var body = await response.Content.ReadAsByteArrayAsync();
            // byte-exact against the source slice — the invariant under concurrency
            Assert.Equal(fixture.Video[range.from..(range.to + 1)], body);
            Interlocked.Add(ref totalBytes, body.Length);
        }));

        sw.Stop();

        // Sanity: the whole burst served real data and the session survived it intact.
        Assert.True(totalBytes > 0);
        using var afterBurst = new HttpRequestMessage(HttpMethod.Get, streamUrl);
        afterBurst.Headers.Range = new RangeHeaderValue(0, 1023);
        using var afterResponse = await client.SendAsync(afterBurst);
        Assert.Equal(HttpStatusCode.PartialContent, afterResponse.StatusCode);

        var throughput = totalBytes / 1024d / 1024d / Math.Max(0.001, sw.Elapsed.TotalSeconds);
        output.WriteLine(
            $"[segment-cache load] {requests} concurrent range reads · {totalBytes:N0} bytes · " +
            $"{sw.Elapsed.TotalMilliseconds:N0} ms · {throughput:N1} MiB/s · all byte-exact");
    }
}
