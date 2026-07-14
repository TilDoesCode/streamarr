using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Controllers;

/// <summary>
/// GET /api/v1/metrics (BRIEF §10-M7 observability): a JSON snapshot of sessions,
/// NNTP connections vs the global budget, cumulative bytes streamed, resolve/fallback
/// counts, search-cache hit rate, and per-indexer latency. Admin-only, like session
/// listing, because provider/indexer names and circuit state are operational inventory.
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/metrics")]
public class MetricsController(
    StreamarrMetrics metrics,
    SessionManager sessions,
    SearchCache searchCache,
    MultiProviderNntpClient nntp,
    IOptions<StreamarrOptions> options) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(MetricsResponse), StatusCodes.Status200OK)]
    public ActionResult<MetricsResponse> Get()
    {
        var live = sessions.ListSessions();
        var hits = searchCache.Hits;
        var misses = searchCache.Misses;
        var lookups = hits + misses;

        return Ok(new MetricsResponse
        {
            Sessions = new SessionMetrics
            {
                Active = live.Count,
                OpenedTotal = metrics.SessionsOpenedTotal,
                ClosedTotal = metrics.SessionsClosedTotal,
            },
            Connections = new ConnectionMetrics
            {
                Budget = Math.Max(1, options.Value.ConnectionBudget),
                InUse = sessions.NntpConnectionsInUse,
                Providers = nntp.Providers.Select(p => new ProviderConnectionMetric
                {
                    Name = p.ProviderName,
                    Priority = p.Priority,
                    LiveConnections = p.LiveConnections,
                    ActiveConnections = p.ActiveConnections,
                    IdleConnections = p.IdleConnections,
                    AvailableConnections = p.AvailableConnections,
                    Tripped = p.IsTripped,
                }).ToList(),
            },
            Resolves = new ResolveMetrics
            {
                Total = metrics.ResolvesTotal,
                ViaFallback = metrics.ResolveFallbacksTotal,
            },
            SearchCache = new SearchCacheMetrics
            {
                Entries = searchCache.Count,
                Hits = hits,
                Misses = misses,
                HitRate = lookups == 0 ? 0 : Math.Round((double)hits / lookups, 4),
            },
            BytesServedTotal = metrics.BytesServedTotal,
            Indexers = metrics.IndexerLatencies().Select(i => new IndexerLatencyMetric
            {
                Id = i.Id,
                Name = i.Name,
                Requests = i.Requests,
                Failures = i.Failures,
                LastLatencyMs = i.LastLatencyMs,
                AvgLatencyMs = i.AvgLatencyMs,
            }).ToList(),
        });
    }
}
