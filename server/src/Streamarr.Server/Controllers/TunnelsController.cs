using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Tunnels;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Built-in WireGuard tunnels (docs/vpn.md): CRUD, <c>.conf</c> import, provider presets, live status and a
/// handshake/exit-IP test. Private and preshared keys are write-only. Admin session required.
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/tunnels")]
public sealed class TunnelsController(
    TunnelConfigService tunnels,
    ITunnelSupervisor supervisor,
    TimeProvider time) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<TunnelResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<TunnelResponse>>> List(CancellationToken ct)
    {
        var rows = await tunnels.ListAsync(ct);
        var usage = await tunnels.UsageMapAsync(ct);
        var statuses = supervisor.Snapshot();
        return Ok(rows.Select(row => tunnels.ToResponse(
            row,
            statuses.TryGetValue(row.Id, out var status) ? status : Unknown(row.Enabled),
            usage.TryGetValue(row.Id, out var used) ? used : TunnelUsage.Empty)).ToArray());
    }

    /// <summary>The static provider catalog: where to get a configuration, default DNS and port, exit-IP check.</summary>
    [HttpGet("presets")]
    [ProducesResponseType(typeof(IReadOnlyList<TunnelPresetResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<TunnelPresetResponse>> Presets()
        => Ok(TunnelPresets.All.Select(p => new TunnelPresetResponse
        {
            Id = p.Id,
            Name = p.Name,
            HelpUrl = p.HelpUrl,
            DefaultDns = p.DefaultDns,
            DefaultEndpointPort = p.DefaultEndpointPort,
            ExitIpCheckUrl = p.ExitIpCheckUrl,
            Hint = p.Hint,
        }).ToArray());

    /// <summary>State of every tunnel; cheap enough to poll.</summary>
    [HttpGet("status")]
    [ProducesResponseType(typeof(TunnelStatusListResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<TunnelStatusListResponse>> Status(CancellationToken ct)
    {
        var rows = await tunnels.ListAsync(ct);
        var statuses = supervisor.Snapshot();
        return Ok(new TunnelStatusListResponse
        {
            Tunnels = rows.Select(row => new TunnelStatusEntry
            {
                Id = row.Id,
                Name = row.Name,
                Enabled = row.Enabled,
                Status = statuses.TryGetValue(row.Id, out var status) ? status : Unknown(row.Enabled),
            }).ToArray(),
            CheckedAt = time.GetUtcNow(),
        });
    }

    /// <summary>Parses a WireGuard <c>.conf</c> into a prefilled tunnel with per-field errors; nothing is stored.</summary>
    [HttpPost("import")]
    [ProducesResponseType(typeof(TunnelImportResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public ActionResult<TunnelImportResponse> Import([FromBody] TunnelImportRequest request)
    {
        if (request is null)
            return BadRequest(ErrorResponse.Of("invalid_tunnel_import", "A request body with 'text' is required."));
        if (request.Text is { Length: > WireGuardConfParser.MaxTextLength })
            return BadRequest(ErrorResponse.Of("invalid_tunnel_import", $"'text' must not exceed {WireGuardConfParser.MaxTextLength / 1024} KiB."));
        return Ok(WireGuardConfParser.Parse(request.Text));
    }

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(TunnelResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TunnelResponse>> Get(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_tunnel_id", "The tunnel id is invalid."));

        var entity = await tunnels.GetAsync(id, ct);
        if (entity is null)
            return NotFound(ErrorResponse.Of("not_found", $"No tunnel with id '{id}'."));
        return Ok(tunnels.ToResponse(entity, supervisor.GetStatus(id) ?? Unknown(entity.Enabled), await tunnels.UsageAsync(id, ct)));
    }

    [HttpPost]
    [ProducesResponseType(typeof(TunnelResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<TunnelResponse>> Create([FromBody] TunnelWrite write, CancellationToken ct)
    {
        if (write is null)
            return BadRequest(ErrorResponse.Of("invalid_tunnel", "A request body is required."));
        var errors = TunnelValidation.Validate(write, requirePrivateKey: true, requireName: true, out var settings);
        if (errors.Count > 0)
            return BadRequest(Invalid(errors));

        Persistence.Entities.TunnelEntity entity;
        try
        {
            entity = await tunnels.CreateAsync(settings, write.Enabled ?? true, ct);
        }
        catch (InvalidOperationException e)
        {
            return Conflict(ErrorResponse.Of("tunnel_limit", e.Message));
        }
        await supervisor.ReloadAsync(ct);
        return CreatedAtAction(nameof(Get), new { id = entity.Id },
            tunnels.ToResponse(entity, supervisor.GetStatus(entity.Id) ?? Unknown(entity.Enabled), TunnelUsage.Empty));
    }

    [HttpPut("{id}")]
    [ProducesResponseType(typeof(TunnelResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TunnelResponse>> Update(string id, [FromBody] TunnelWrite write, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_tunnel_id", "The tunnel id is invalid."));
        if (write is null)
            return BadRequest(ErrorResponse.Of("invalid_tunnel", "A request body is required."));

        var existing = await tunnels.GetAsync(id, ct);
        if (existing is null)
            return NotFound(ErrorResponse.Of("not_found", $"No tunnel with id '{id}'."));

        var requirePrivateKey = string.IsNullOrEmpty(existing.PrivateKeyEncrypted);
        var errors = TunnelValidation.Validate(write, requirePrivateKey, requireName: true, out var settings);
        if (errors.Count > 0)
            return BadRequest(Invalid(errors));

        var entity = await tunnels.UpdateAsync(id, settings, write.Enabled, clearPresharedKey: write.PresharedKey is { Length: 0 }, ct);
        if (entity is null)
            return NotFound(ErrorResponse.Of("not_found", $"No tunnel with id '{id}'."));
        await supervisor.ReloadAsync(ct);
        return Ok(tunnels.ToResponse(entity, supervisor.GetStatus(id) ?? Unknown(entity.Enabled), await tunnels.UsageAsync(id, ct)));
    }

    /// <summary>
    /// Deletes a tunnel. <c>409 tunnel_in_use</c> names the providers and indexers still routed through it (also in
    /// <c>error.params.providers</c> / <c>error.params.indexers</c>); <c>force=true</c> sets them to direct and deletes anyway.
    /// </summary>
    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<IActionResult> Delete(string id, [FromQuery] bool force = false, CancellationToken ct = default)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_tunnel_id", "The tunnel id is invalid."));

        var (outcome, usage) = await tunnels.DeleteAsync(id, force, ct);
        switch (outcome)
        {
            case TunnelDeleteOutcome.NotFound:
                return NotFound(ErrorResponse.Of("not_found", $"No tunnel with id '{id}'."));
            case TunnelDeleteOutcome.InUse:
                var parts = new List<string>();
                if (usage.Providers.Count > 0)
                    parts.Add("providers " + string.Join(", ", usage.Providers.Select(p => $"'{p.Name}'")));
                if (usage.Indexers.Count > 0)
                    parts.Add("indexers " + string.Join(", ", usage.Indexers.Select(i => $"'{i.Name}'")));
                return Conflict(new ErrorResponse
                {
                    Error = new ErrorDetail
                    {
                        Code = "tunnel_in_use",
                        Message = $"The tunnel is still used by {string.Join(" and ", parts)}. Set them to direct or delete with force=true.",
                        Params = new Dictionary<string, string>
                        {
                            ["providers"] = string.Join(", ", usage.Providers.Select(p => p.Name)),
                            ["indexers"] = string.Join(", ", usage.Indexers.Select(i => i.Name)),
                        },
                    },
                });
            default:
                await supervisor.ReloadAsync(ct);
                return NoContent();
        }
    }

    /// <summary>Starts the helper if needed and reports handshake, exit IP and latency through the tunnel.</summary>
    [HttpPost("{id}/test")]
    [ProducesResponseType(typeof(TunnelTestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TunnelTestResult>> Test(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_tunnel_id", "The tunnel id is invalid."));
        if (!await tunnels.ExistsAsync(id, ct))
            return NotFound(ErrorResponse.Of("not_found", $"No tunnel with id '{id}'."));
        return Ok(await supervisor.TestAsync(id, ct));
    }

    private TunnelStatus Unknown(bool enabled) => new()
    {
        State = enabled ? TunnelStates.Down : TunnelStates.Disabled,
        Since = time.GetUtcNow(),
        LastError = enabled ? "tunnel status unknown" : null,
    };

    private static ErrorResponse Invalid(IReadOnlyList<TunnelFieldError> errors) => new()
    {
        Error = new ErrorDetail
        {
            Code = "invalid_tunnel",
            Message = $"'{errors[0].Field}': {errors[0].Message}",
            Params = errors.GroupBy(e => e.Field, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First().Message, StringComparer.Ordinal),
        },
    };

    private static bool InvalidId(string id)
        => string.IsNullOrWhiteSpace(id) || id.Length > 128 || Options.StreamarrOptionsValidator.ContainsControl(id);
}
