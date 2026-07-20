using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

[Collection("streamarr-server")]
public class StreamingIntegrationTests(StreamarrServerFixture fixture)
{
    private async Task<ResolveResponse> ResolveAsync(HttpClient client, string releaseId)
    {
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = releaseId, Client = "tests" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ResolveResponse>();
        Assert.NotNull(body);
        return body!;
    }

    // ---------------------------------------------------------------- resolve + ffprobe

    [Fact]
    public async Task Resolve_DirectRelease_IsReady_WithProbedMediaInfo()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DirectReleaseId);

        Assert.Equal("ready", resolved.Status);
        Assert.Equal("mkv", resolved.Container);
        Assert.Equal(fixture.Video.Length, resolved.SizeBytes);
        Assert.NotNull(resolved.StreamUrl);
        Assert.Contains("/api/v1/stream/", resolved.StreamUrl);
        Assert.Equal(300, resolved.SessionTtlSeconds);
        Assert.Null(resolved.SuggestedFallbackReleaseId);

        // ffprobe ran against the stream URL and pre-probed the media info
        Assert.NotNull(resolved.RunTimeTicks);
        Assert.InRange(resolved.RunTimeTicks!.Value, 25 * TimeSpan.TicksPerSecond, 35 * TimeSpan.TicksPerSecond);

        var video = Assert.Single(resolved.MediaStreams, s => s.Type == "Video");
        Assert.Equal("h264", video.Codec);
        Assert.Equal(320, video.Width);
        Assert.Equal(240, video.Height);

        var audio = Assert.Single(resolved.MediaStreams, s => s.Type == "Audio");
        Assert.Equal("aac", audio.Codec);
    }

    [Fact]
    public async Task Resolve_UnknownRelease_Is404WithErrorEnvelope()
    {
        using var client = fixture.CreateClient();
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = "does-not-exist" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ErrorResponse>();
        Assert.Equal("release_not_found", error!.Error.Code);
    }

    // ---------------------------------------------------------------- full-body streaming

    [Fact]
    public async Task Stream_FullBody_IsByteIdenticalToSource()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DirectReleaseId);

        using var response = await client.GetAsync(resolved.StreamUrl);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("bytes", response.Headers.AcceptRanges.Single());
        Assert.Equal("video/x-matroska", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal(fixture.Video.Length, response.Content.Headers.ContentLength);

        var body = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(fixture.Video, body);
    }

    // ---------------------------------------------------------------- ranged reads

    public static TheoryData<long, long> Ranges()
    {
        var data = new TheoryData<long, long>
        {
            { 0, 1023 },              // head
            { 1, 1 },                 // single byte
            { 63_999, 64_002 },       // crossing a yEnc article boundary
            { 100_000, 131_071 },     // mid-file
        };
        return data;
    }

    [Theory]
    [MemberData(nameof(Ranges))]
    public async Task Stream_RangeRequest_Returns206WithExactBytes(long from, long to)
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DirectReleaseId);

        using var request = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl);
        request.Headers.Range = new RangeHeaderValue(from, to);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
        var contentRange = response.Content.Headers.ContentRange!;
        Assert.Equal("bytes", contentRange.Unit);
        Assert.Equal(from, contentRange.From);
        Assert.Equal(to, contentRange.To);
        Assert.Equal(fixture.Video.Length, contentRange.Length);

        var body = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(fixture.Video[(int)from..(int)(to + 1)], body);
    }

    [Fact]
    public async Task Stream_OpenEndedAndSuffixRanges_Work()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DirectReleaseId);
        var length = fixture.Video.Length;

        // open-ended: bytes=N-
        using (var request = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl))
        {
            request.Headers.Range = new RangeHeaderValue(length - 5000, null);
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
            Assert.Equal(fixture.Video[^5000..], await response.Content.ReadAsByteArrayAsync());
        }

        // suffix: bytes=-N (the last N bytes)
        using (var request = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl))
        {
            request.Headers.Range = new RangeHeaderValue(null, 700);
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
            Assert.Equal(fixture.Video[^700..], await response.Content.ReadAsByteArrayAsync());
        }
    }

    // ---------------------------------------------------------------- RAR-wrapped variant

    [Fact]
    public async Task Resolve_RarWrappedRelease_UnwrapsToTheInnerMkv()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.RarReleaseId);

        Assert.Equal("ready", resolved.Status);
        Assert.Equal("mkv", resolved.Container);
        Assert.Equal(fixture.Video.Length, resolved.SizeBytes);
        Assert.NotNull(resolved.RunTimeTicks); // ffprobe read the stream through the RAR layer
        Assert.Contains(resolved.MediaStreams, s => s is { Type: "Video", Codec: "h264" });
    }

    [Fact]
    public async Task Stream_RarWrapped_RangesAcrossVolumeBoundaries_AreByteIdentical()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.RarReleaseId);

        // crosses from volume 1 into volume 2 of the RAR set
        var from = StreamarrServerFixture.RarChunkSize - 1000;
        var to = StreamarrServerFixture.RarChunkSize + 999;
        using (var request = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl))
        {
            request.Headers.Range = new RangeHeaderValue(from, to);
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
            Assert.Equal(fixture.Video[from..(to + 1)], await response.Content.ReadAsByteArrayAsync());
        }

        // deep seek into the last volume
        var tailFrom = fixture.Video.Length - 4096;
        using (var request = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl))
        {
            request.Headers.Range = new RangeHeaderValue(tailFrom, null);
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
            Assert.Equal(fixture.Video[tailFrom..], await response.Content.ReadAsByteArrayAsync());
        }
    }

    [Fact]
    public async Task Stream_RarWrapped_FullBody_IsByteIdenticalToSource()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.RarReleaseId);

        using var response = await client.GetAsync(resolved.StreamUrl);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(fixture.Video, await response.Content.ReadAsByteArrayAsync());
    }

    // ---------------------------------------------------------------- health classification

    [Fact]
    public async Task Resolve_ReleaseWithMissingArticle_IsDegraded_ButStreamable()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DegradedReleaseId);

        Assert.Equal("degraded", resolved.Status);
        Assert.NotNull(resolved.StreamUrl);

        // the intact head of the file still streams
        using var request = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl);
        request.Headers.Range = new RangeHeaderValue(0, 1023);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
        Assert.Equal(fixture.Video[..1024], await response.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task Resolve_DeadRelease_AutoFallsBackToHealthySibling()
    {
        using var client = fixture.CreateClient();
        // Auto-fallback is on by default: a dead release transparently retries the
        // next-best release of the same work and returns the healthy one (BRIEF §10-M7).
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DeadReleaseId);

        Assert.Equal("ready", resolved.Status);
        Assert.Equal(StreamarrServerFixture.FallbackReleaseId, resolved.ReleaseId);
        Assert.Equal(StreamarrServerFixture.DeadReleaseId, resolved.FallbackFromReleaseId);
        Assert.NotNull(resolved.StreamUrl);

        // The response surfaces exactly what happened: dead → ready.
        Assert.Collection(resolved.Attempts,
            a => { Assert.Equal(StreamarrServerFixture.DeadReleaseId, a.ReleaseId); Assert.Equal("dead", a.Status); },
            a => { Assert.Equal(StreamarrServerFixture.FallbackReleaseId, a.ReleaseId); Assert.Equal("ready", a.Status); });
    }

    [Fact]
    public async Task Resolve_DeadRelease_WithAutoFallbackOff_IsDead_WithSuggestedFallback()
    {
        using var client = fixture.CreateClient();
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve",
            new ResolveRequest { ReleaseId = StreamarrServerFixture.DeadReleaseId, AutoFallback = false });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var resolved = (await response.Content.ReadFromJsonAsync<ResolveResponse>())!;

        Assert.Equal("dead", resolved.Status);
        Assert.Null(resolved.StreamUrl);
        Assert.Empty(resolved.MediaStreams);
        Assert.Equal(StreamarrServerFixture.FallbackReleaseId, resolved.SuggestedFallbackReleaseId);
        var attempt = Assert.Single(resolved.Attempts);
        Assert.Equal(StreamarrServerFixture.DeadReleaseId, attempt.ReleaseId);
    }

    [Fact]
    public async Task Resolve_DeadOnlyWork_ExhaustsFallback_AndReportsDead()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DeadOnlyReleaseId);

        Assert.Equal("dead", resolved.Status);
        Assert.Null(resolved.StreamUrl);
        Assert.Null(resolved.SuggestedFallbackReleaseId); // nothing left to suggest
        var attempt = Assert.Single(resolved.Attempts);
        Assert.Equal(StreamarrServerFixture.DeadOnlyReleaseId, attempt.ReleaseId);
        Assert.Equal("dead", attempt.Status);
    }

    // ---------------------------------------------------------------- sessions

    [Fact]
    public async Task Sessions_ListAndClose_LifecycleWorks()
    {
        using var client = fixture.CreateClient();
        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.DirectReleaseId);
        var token = resolved.StreamUrl!.Split('/').Last();

        var sessions = await admin.GetFromJsonAsync<List<SessionResponse>>("/api/v1/sessions");
        var session = Assert.Single(sessions!, s => s.Token == token);
        Assert.Equal(StreamarrServerFixture.DirectReleaseId, session.ReleaseId);
        Assert.Equal("tests", session.Client);
        Assert.Equal(fixture.Video.Length, session.SizeBytes);
        // A persistent media-probe cache can make this zero; the opened source must
        // still carry the same pre-probed metadata either way.
        Assert.NotEmpty(resolved.MediaStreams);
        Assert.InRange(session.BytesServed, 0, session.SizeBytes);

        using var close = await client.PostAsync($"/api/v1/sessions/{token}/close", null);
        Assert.Equal(HttpStatusCode.NoContent, close.StatusCode);

        using var afterClose = await client.GetAsync(resolved.StreamUrl);
        Assert.Equal(HttpStatusCode.NotFound, afterClose.StatusCode);

        var remaining = await admin.GetFromJsonAsync<List<SessionResponse>>("/api/v1/sessions");
        Assert.DoesNotContain(remaining!, s => s.Token == token);

        using var closeAgain = await client.PostAsync($"/api/v1/sessions/{token}/close", null);
        Assert.Equal(HttpStatusCode.NotFound, closeAgain.StatusCode);
    }

    // ---------------------------------------------------------------- auth

    [Fact]
    public async Task Endpoints_RejectMissingOrWrongBearer()
    {
        using var authed = fixture.CreateClient();
        var resolved = await ResolveAsync(authed, StreamarrServerFixture.DirectReleaseId);

        using var anonymous = fixture.CreateClient(authenticated: false);

        using (var response = await anonymous.PostAsJsonAsync(
                   "/api/v1/resolve", new ResolveRequest { ReleaseId = StreamarrServerFixture.DirectReleaseId }))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }

        // The unguessable session URL is the only credential required for streaming.
        using (var response = await anonymous.GetAsync(resolved.StreamUrl))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        using (var response = await anonymous.GetAsync("/api/v1/sessions"))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }

        anonymous.DefaultRequestHeaders.Authorization = new("Bearer", "wrong-key");
        using (var response = await anonymous.GetAsync(resolved.StreamUrl))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        // the liveness probe stays open
        using (var response = await anonymous.GetAsync("/api/v1/health"))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
    }

    // A browser <video> element cannot send an Authorization header, so the path's
    // 192-bit session token is itself a narrowly-scoped capability credential.

    [Fact]
    public async Task Stream_CapabilityWorksWithoutBroadBearer_ForBrowserVideoElement()
    {
        using var authed = fixture.CreateClient();
        var resolved = await ResolveAsync(authed, StreamarrServerFixture.DirectReleaseId);

        // Any unrelated access_token query value is ignored; only the capability path
        // token authorizes the byte stream.
        using var anonymous = fixture.CreateClient(authenticated: false);
        var url = $"{resolved.StreamUrl}?access_token={StreamarrServerFixture.ApiKey}";
        using var response = await anonymous.GetAsync(url);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(fixture.Video, await response.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task Stream_IgnoresWrongAccessTokenQueryParam()
    {
        using var authed = fixture.CreateClient();
        var resolved = await ResolveAsync(authed, StreamarrServerFixture.DirectReleaseId);

        using var anonymous = fixture.CreateClient(authenticated: false);
        using var response = await anonymous.GetAsync($"{resolved.StreamUrl}?access_token=wrong-key");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AccessTokenQueryParam_IsIgnoredOutsideStreamEndpoint()
    {
        // The query-param credential is scoped to /stream; it must NOT authenticate
        // other endpoints (defensive: keeps credentials out of query strings elsewhere).
        using var anonymous = fixture.CreateClient(authenticated: false);
        using var response = await anonymous.GetAsync(
            $"/api/v1/sessions?access_token={StreamarrServerFixture.ApiKey}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
