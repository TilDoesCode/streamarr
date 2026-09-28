using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Transcoding;

/// <summary>Server-side transcoding: settings, hardware diagnostics, test media, benchmarks and HLS session creation.</summary>
[ApiController]
[Route("api/v1/transcoding")]
public sealed class TranscodingController(
    TranscodingSettingsService settings,
    FfmpegCapabilityService capabilities,
    TranscodingSampleLibrary samples,
    TranscodingBenchmarkService benchmarks,
    TranscodeSessionManager sessions,
    TranscodeSourceResolver sources,
    TranscodingWorkspace workspace,
    IOptions<TranscodingOptions> options) : ControllerBase
{
    [HttpGet("config")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(TranscodingConfigResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<TranscodingConfigResponse>> GetConfig(CancellationToken ct)
        => Ok(TranscodingResponses.Config(await settings.GetAsync(ct), options.Value, workspace, capabilities.Cached));

    [HttpPut("config")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(TranscodingConfigResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<TranscodingConfigResponse>> UpdateConfig([FromBody] TranscodingConfigWrite write, CancellationToken ct)
    {
        if (write is null)
            return BadRequest(ErrorResponse.Of("invalid_transcoding_config", "A config body is required."));
        var current = await settings.GetAsync(ct);
        var next = TranscodingResponses.Apply(current, write, out var error);
        var errors = error is null ? next.Validate() : [error];
        if (errors.Count > 0)
            return BadRequest(ErrorResponse.Of("invalid_transcoding_config", string.Join(" ", errors)));

        await settings.SaveAsync(next, ct);
        if (next.Acceleration != current.Acceleration || next.VaapiDevice != current.VaapiDevice || next.NvencDevice != current.NvencDevice)
            _ = capabilities.RefreshAsync(CancellationToken.None);
        return Ok(TranscodingResponses.Config(next, options.Value, workspace, capabilities.Cached));
    }

    [HttpGet("capabilities")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(TranscodingCapabilitiesResponse), StatusCodes.Status200OK)]
    public ActionResult<TranscodingCapabilitiesResponse> GetCapabilities()
    {
        if (capabilities.Cached is null && !capabilities.Detecting)
            _ = capabilities.RefreshAsync(CancellationToken.None);
        return Ok(TranscodingResponses.Capabilities(capabilities.Cached, capabilities.Detecting));
    }

    /// <summary>Re-runs detection including the real hardware encode/decode self-tests; poll GET until <c>detecting</c> is false.</summary>
    [HttpPost("capabilities/refresh")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(TranscodingCapabilitiesResponse), StatusCodes.Status202Accepted)]
    public ActionResult<TranscodingCapabilitiesResponse> RefreshCapabilities()
    {
        _ = capabilities.RefreshAsync(CancellationToken.None);
        return Accepted(TranscodingResponses.Capabilities(capabilities.Cached, detecting: true));
    }

    [HttpGet("samples")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(IReadOnlyList<TranscodingSampleResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<TranscodingSampleResponse>>> GetSamples(CancellationToken ct)
        => Ok((await samples.ListAsync(ct)).Select(TranscodingResponses.Sample).ToList());

    [HttpPost("samples/{sampleId}/generate")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(TranscodingSampleResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TranscodingSampleResponse>> GenerateSample(string sampleId, CancellationToken ct)
    {
        var sample = TranscodingSampleLibrary.Find(sampleId);
        if (sample is null)
            return NotFound(ErrorResponse.Of("unknown_sample", $"Unknown sample '{sampleId}'."));
        return Accepted(TranscodingResponses.Sample(await samples.EnsureStartedAsync(sample, ct)));
    }

    [HttpGet("benchmarks")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(IReadOnlyList<BenchmarkResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<BenchmarkResponse>> GetBenchmarks()
        => Ok(benchmarks.Runs.Select(r => TranscodingResponses.Benchmark(r, settings.Current)).ToList());

    [HttpGet("benchmarks/{id}")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(BenchmarkResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public ActionResult<BenchmarkResponse> GetBenchmark(string id)
        => benchmarks.Find(id) is { } run
            ? Ok(TranscodingResponses.Benchmark(run, settings.Current))
            : NotFound(ErrorResponse.Of("unknown_benchmark", "No benchmark run with this id."));

    /// <summary>Queues a flat-out transcode of a test sample with the live pipeline; runs execute one at a time.</summary>
    [HttpPost("benchmarks")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(BenchmarkResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<BenchmarkResponse>> StartBenchmark([FromBody] BenchmarkCreateRequest request, CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        HardwareAcceleration? accel = null;
        if (request.Acceleration is { Length: > 0 } name)
        {
            if (!HardwareAccelerationNames.TryParse(name, out var parsed))
                return BadRequest(ErrorResponse.Of("invalid_benchmark", $"Unknown acceleration '{name}'."));
            accel = parsed;
        }
        var maxHeight = Math.Clamp(request.MaxHeight ?? 1080, 240, 4320);
        var bitrate = Math.Clamp(request.BitrateKbps ?? Math.Min(current.MaxBitrateKbps, 8_000), 500, 200_000);
        return Execute(() => Accepted(TranscodingResponses.Benchmark(
            benchmarks.Start(new BenchmarkRequest(request.SampleId, maxHeight, bitrate, accel)), current)));
    }

    [HttpGet("sessions")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(IReadOnlyList<TranscodeSessionResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<TranscodeSessionResponse>> GetSessions()
        => Ok(sessions.Sessions.OrderByDescending(s => s.CreatedAt).Select(TranscodingResponses.Session).ToList());

    [HttpDelete("sessions/{handle}")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> StopSession(string handle)
    {
        if (sessions.FindByHandle(handle) is not { } session)
            return NotFound(ErrorResponse.Of("unknown_transcode", "No transcode session with this handle."));
        await sessions.CloseAsync(session, "stopped by an administrator");
        return NoContent();
    }

    /// <summary>Explains what a transcode of this source would do for this client, without starting ffmpeg.</summary>
    [HttpPost("plan")]
    [ProducesResponseType(typeof(TranscodePlanResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<TranscodePlanResponse>> Plan([FromBody] TranscodeSessionCreateRequest request, CancellationToken ct)
    {
        try
        {
            var (source, _) = await ResolveSourceAsync(request, ct);
            var (media, plan, _, _) = await sessions.PlanAsync(source, ToClient(request.Client), ToLimits(request), ct);
            return Ok(TranscodingResponses.Plan(plan, media));
        }
        catch (TranscodeException e)
        {
            return Error(e);
        }
    }

    /// <summary>Starts an HLS transcode of a live stream capability (or a test sample) and returns its playlist capability.</summary>
    [HttpPost("sessions")]
    [ProducesResponseType(typeof(TranscodeSessionCreatedResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<TranscodeSessionCreatedResponse>> CreateSession(
        [FromBody] TranscodeSessionCreateRequest request, CancellationToken ct)
    {
        try
        {
            var (source, title) = await ResolveSourceAsync(request, ct);
            var clientName = string.IsNullOrWhiteSpace(request.ClientName) || request.ClientName.Any(char.IsControl)
                ? (User.IsInRole(AuthRoles.Admin) ? "web" : "api")
                : request.ClientName.Trim();
            var session = await sessions.CreateAsync(
                source, title, ToClient(request.Client), ToLimits(request), clientName,
                Math.Max(0, request.StartPositionSeconds ?? 0), ct);
            var basePath = $"/api/v1/transcode/{session.Id}";
            return StatusCode(StatusCodes.Status201Created, new TranscodeSessionCreatedResponse
            {
                Handle = session.Handle,
                PlaylistUrl = $"{basePath}/master.m3u8",
                MediaPlaylistUrl = $"{basePath}/{HlsPlaylist.MediaPlaylistName}",
                DurationSeconds = session.Plan.DurationSeconds,
                SegmentLengthSeconds = session.Timeline.SegmentLength,
                SegmentCount = session.Timeline.Count,
                Plan = TranscodingResponses.Plan(session.Plan, session.Media),
            });
        }
        catch (TranscodeException e)
        {
            return Error(e);
        }
    }

    private async Task<(TranscodeSource Source, string Title)> ResolveSourceAsync(TranscodeSessionCreateRequest request, CancellationToken ct)
    {
        if (request is null || (request.StreamToken is null) == (request.SampleId is null))
            throw new TranscodeException("invalid_transcode_request", "Provide exactly one of 'streamToken' or 'sampleId'.", 400);
        if (request.SampleId is { } sampleId)
        {
            if (!User.IsInRole(AuthRoles.Admin))
                throw new TranscodeException("forbidden", "Only administrators can transcode test samples.", 403);
            var sample = await sources.FromSampleAsync(sampleId, ct);
            return (sample, sample.DisplayName);
        }
        var token = request.StreamToken!.Trim();
        if (token.Length is 0 or > 128 || token.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            throw new TranscodeException("invalid_transcode_request", "'streamToken' is malformed.", 400);
        var source = sources.FromStreamToken(token, out var title);
        return (source, title);
    }

    private static ClientProfile ToClient(ClientProfileRequest? request)
    {
        if (request is null)
            return ClientProfile.Default;
        static IReadOnlyList<string>? Clean(IReadOnlyList<string>? values)
            => values?.Where(v => v is { Length: > 0 and <= 32 }).Select(v => v.Trim().ToLowerInvariant()).Distinct().Take(16).ToList();
        return new ClientProfile
        {
            VideoCodecs = Clean(request.VideoCodecs) ?? ClientProfile.Default.VideoCodecs,
            AudioCodecs = Clean(request.AudioCodecs) ?? ClientProfile.Default.AudioCodecs,
            Containers = Clean(request.Containers) ?? ClientProfile.Default.Containers,
            MaxAudioChannels = Math.Clamp(request.MaxAudioChannels ?? 2, 1, 8),
            SupportsHdr = request.SupportsHdr ?? false,
            Supports10Bit = request.Supports10Bit ?? false,
        };
    }

    private static TranscodeLimits ToLimits(TranscodeSessionCreateRequest request) => new(
        request.MaxHeight is { } h ? Math.Clamp(h, 144, 4320) : null,
        request.MaxBitrateKbps is { } b ? Math.Clamp(b, 300, 200_000) : null,
        request.AudioStreamIndex);

    private ActionResult Execute(Func<ActionResult> action)
    {
        try
        {
            return action();
        }
        catch (TranscodeException e)
        {
            return Error(e);
        }
    }

    private ObjectResult Error(TranscodeException e) => StatusCode(e.StatusCode, ErrorResponse.Of(e.Code, e.Message));
}
