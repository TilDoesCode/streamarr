using Microsoft.AspNetCore.Mvc;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>Serves the file of a prepared download over its capability.</summary>
public sealed class ViewerDownloadFileService
{
    public Task<IActionResult> HeadAsync(HttpContext context, string capability, CancellationToken ct)
        => throw new ViewerProblem(StatusCodes.Status501NotImplemented, "not_implemented", "Downloads are not implemented yet.");

    public Task<IActionResult> GetAsync(HttpContext context, string capability, CancellationToken ct)
        => throw new ViewerProblem(StatusCodes.Status501NotImplemented, "not_implemented", "Downloads are not implemented yet.");
}
