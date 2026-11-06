using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>Viewer device downloads: candidates, similarity plan, asynchronous preparation and the persisted records.</summary>
public sealed class ViewerDownloadService
{
    public Task<DownloadCandidatesResponse> CandidatesAsync(ViewerEntity viewer, DownloadCandidatesRequest request, string? acceptLanguage, CancellationToken ct)
        => throw Pending();

    public Task<DownloadSeasonCandidatesResponse> SeasonCandidatesAsync(ViewerEntity viewer, DownloadSeasonCandidatesRequest request, string? acceptLanguage, CancellationToken ct)
        => throw Pending();

    public Task<DownloadPlanResponse> PlanAsync(ViewerEntity viewer, DownloadPlanRequest request, string? acceptLanguage, CancellationToken ct)
        => throw Pending();

    public Task<DownloadResponse> PrepareAsync(ViewerCaller caller, ViewerEntity viewer, DownloadPrepareRequest request, CancellationToken ct)
        => throw Pending();

    public Task<DownloadListResponse> ListAsync(ViewerCaller caller, ViewerEntity viewer, string? device, string? deviceId, CancellationToken ct)
        => throw Pending();

    public Task<DownloadResponse> GetAsync(ViewerCaller caller, string downloadId, int waitMs, string? deviceId, CancellationToken ct)
        => throw Pending();

    public Task<DownloadResponse> RenewAsync(ViewerCaller caller, ViewerEntity viewer, string downloadId, CancellationToken ct)
        => throw Pending();

    public Task<DownloadResponse> CompleteAsync(ViewerCaller caller, string downloadId, DownloadCompleteRequest request, CancellationToken ct)
        => throw Pending();

    public Task DeleteAsync(ViewerCaller caller, string downloadId, CancellationToken ct)
        => throw Pending();

    public Task<DownloadAdminListResponse> AdminListAsync(string? viewerId, bool activeOnly, CancellationToken ct)
        => throw Pending();

    public Task AdminDeleteAsync(string downloadId, CancellationToken ct)
        => throw Pending();

    private static ViewerProblem Pending() => new(StatusCodes.Status501NotImplemented, "not_implemented", "Downloads are not implemented yet.");
}
