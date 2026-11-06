using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Net.Http.Headers;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>
/// Serves the file of a prepared download over its capability: a static-file contract (Range/206, strong ETag, If-Range, If-Match,
/// If-None-Match, 416) over bytes passed through from Usenet, within the transfer limits and the shared download bandwidth. Every
/// request is authorized again (permission, account, age gate, expiry, revocation) and admitted atomically against revocations.
/// </summary>
public sealed class ViewerDownloadFileService(
    ViewerModule module,
    ViewerDownloadService downloads,
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerContentPolicy policy,
    DownloadTransferGovernor governor,
    IDownloadFileSource files,
    TimeProvider time,
    ILogger<ViewerDownloadFileService> logger)
{
    private const int BufferBytes = 64 * 1024;
    private const int MaxAdmissionAttempts = 3;
    private static readonly TimeSpan AccountingInterval = TimeSpan.FromSeconds(2);

    /// <summary>Test seam: runs between authorization and admission.</summary>
    internal Func<string, Task>? BeforeAdmit { get; set; }

    private sealed record Access(ViewerDownloadEntity Download, ViewerEntity Viewer, AccessStamp Stamp);

    public async Task<IActionResult> HeadAsync(HttpContext context, string capability, CancellationToken ct)
    {
        var access = await AuthorizeAsync(context, capability, ct);
        WriteFileHeaders(context.Response, access.Download);
        if (Preconditions(context, access.Download) is { } answer)
            return answer;
        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentLength = access.Download.SizeBytes;
        return new EmptyResult();
    }

    public async Task<IActionResult> GetAsync(HttpContext context, string capability, CancellationToken ct)
    {
        Access access;
        TransferLease? lease = null;
        for (var attempt = 1; ; attempt++)
        {
            access = await AuthorizeAsync(context, capability, ct);
            if (Preconditions(context, access.Download) is { } answer)
            {
                WriteFileHeaders(context.Response, access.Download);
                return answer;
            }
            if (BeforeAdmit is { } hook)
                await hook(access.Download.Id);
            var (download, viewer) = (access.Download, access.Viewer);
            lease = governor.TryAdmit(download.Id, viewer.Id, download.WorkId, viewer.MaxConcurrentDownloads, access.Stamp, download.ExpiresAt, ct, out var scope);
            if (lease is not null)
                break;
            if (scope != DownloadTransferGovernor.Revoked)
                throw TooMany(scope!);
            if (attempt == MaxAdmissionAttempts)
                throw ViewerProblem.RetryLater(StatusCodes.Status503ServiceUnavailable, "download_source_unavailable", "The download's access changed; retry.", TimeSpan.FromSeconds(1));
        }

        using (lease)
        {
            var download = access.Download;
            var size = download.SizeBytes!.Value;
            var range = RequestedRange(context.Request, download.ETag, size);
            if (range is { Satisfiable: false })
            {
                context.Response.Headers[HeaderNames.ContentRange] = $"bytes */{size}";
                throw new ViewerProblem(StatusCodes.Status416RangeNotSatisfiable, "range_not_satisfiable", $"The file has {size} bytes.");
            }
            var (start, length) = range is { } r ? (r.Start, r.Length) : (0L, size);

            IDownloadFileLease source;
            try
            {
                source = await files.OpenAsync(Target(download, access.Viewer), lease.Token);
            }
            catch (DownloadSourceException e)
            {
                throw e.RetryAfter is { } wait ? ViewerProblem.RetryLater(e.Status, e.Code, e.Message, wait) : new ViewerProblem(e.Status, e.Code, e.Message);
            }
            catch (OperationCanceledException) when (lease.Token.IsCancellationRequested && !ct.IsCancellationRequested)
            {
                throw await RevokedMeanwhileAsync(context, capability, ct);
            }

            await using (source)
            {
                Stream stream;
                try
                {
                    stream = source.Open(start);
                }
                catch (Exception e) when (e is SessionUnavailableException or IOException)
                {
                    throw ViewerProblem.RetryLater(StatusCodes.Status503ServiceUnavailable, "download_source_unavailable", "The stream session closed; retry.", TimeSpan.FromSeconds(2));
                }
                await using (stream)
                {
                    // The last moment an error can still be an answer instead of a cut-off body.
                    if (lease.Token.IsCancellationRequested && !ct.IsCancellationRequested)
                        throw await RevokedMeanwhileAsync(context, capability, ct);
                    var response = context.Response;
                    WriteFileHeaders(response, download);
                    response.ContentLength = length;
                    if (range is not null)
                    {
                        response.StatusCode = StatusCodes.Status206PartialContent;
                        response.Headers[HeaderNames.ContentRange] = $"bytes {start}-{start + length - 1}/{size}";
                    }
                    else
                    {
                        response.StatusCode = StatusCodes.Status200OK;
                    }
                    await CopyAsync(context, download.Id, stream, length, lease.Token);
                }
            }
        }
        return new EmptyResult();
    }

    /// <summary>The answer for a request whose access ended while it was being admitted: the current refusal, else a retry.</summary>
    private async Task<ViewerProblem> RevokedMeanwhileAsync(HttpContext context, string capability, CancellationToken ct)
    {
        try
        {
            await AuthorizeAsync(context, capability, ct);
        }
        catch (ViewerProblem refusal)
        {
            return refusal;
        }
        return ViewerProblem.RetryLater(StatusCodes.Status503ServiceUnavailable, "download_source_unavailable", "The download's access changed; retry.", TimeSpan.FromSeconds(1));
    }

    /// <summary>RFC 9110 preconditions in order: If-Match (412 when no tag matches), then If-None-Match (304 for GET/HEAD).</summary>
    internal static IActionResult? Preconditions(HttpContext context, ViewerDownloadEntity download)
    {
        var request = context.Request;
        var etag = download.ETag!;
        if (request.Headers.IfMatch.Count > 0 && !Matches(request.Headers.IfMatch, etag, weak: false))
        {
            return new ObjectResult(Contracts.ErrorResponse.Of("precondition_failed", "If-Match does not name the current ETag of the file."))
            {
                StatusCode = StatusCodes.Status412PreconditionFailed,
            };
        }
        if (request.Headers.IfNoneMatch.Count > 0 && Matches(request.Headers.IfNoneMatch, etag, weak: true))
            return new StatusCodeResult(StatusCodes.Status304NotModified);
        return null;
    }

    /// <summary>Whether a conditional header lists <c>*</c> or <paramref name="etag"/> (weak comparison ignores <c>W/</c>; strong never matches a weak tag).</summary>
    internal static bool Matches(Microsoft.Extensions.Primitives.StringValues header, string etag, bool weak)
    {
        if (!EntityTagHeaderValue.TryParseList(header.OfType<string>().ToList(), out var tags))
            return false;
        var current = EntityTagHeaderValue.Parse(etag);
        return tags.Any(t => t.Equals(EntityTagHeaderValue.Any) || t.Compare(current, useStrongComparison: !weak));
    }

    private async Task CopyAsync(HttpContext context, string downloadId, Stream source, long length, CancellationToken ct)
    {
        var buffer = new byte[BufferBytes];
        long remaining = length, pending = 0;
        var flushedAt = time.GetUtcNow();
        try
        {
            await context.Response.StartAsync(ct);
            while (remaining > 0)
            {
                var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), ct);
                if (read == 0)
                    throw new EndOfStreamException("The source ended before the requested range.");
                await governor.ThrottleAsync(read, ct);
                await context.Response.Body.WriteAsync(buffer.AsMemory(0, read), ct);
                governor.Record(downloadId, read);
                remaining -= read;
                pending += read;
                if (time.GetUtcNow() - flushedAt >= AccountingInterval)
                {
                    await downloads.AddBytesServedAsync(downloadId, pending, time.GetUtcNow(), CancellationToken.None);
                    (pending, flushedAt) = (0, time.GetUtcNow());
                }
            }
        }
        catch (Exception e) when (e is OperationCanceledException or IOException or ObjectDisposedException or EndOfStreamException
                                      or Usenet.Exceptions.UsenetException or InvalidDataException)
        {
            if (e is not OperationCanceledException)
                logger.LogInformation("Download {DownloadId} transfer broke off after {Sent} of {Length} bytes: {Error}", downloadId, length - remaining, length, e.GetType().Name);
            // The client sees a short body and resumes with a Range request.
            context.Abort();
        }
        finally
        {
            await downloads.AddBytesServedAsync(downloadId, pending, time.GetUtcNow(), CancellationToken.None);
        }
    }

    private async Task<Access> AuthorizeAsync(HttpContext context, string capability, CancellationToken ct)
    {
        var headers = context.Response.Headers;
        headers.Pragma = "no-cache";
        headers.Expires = "0";
        headers["Referrer-Policy"] = "no-referrer";
        if (!await module.IsEnabledAsync(ct))
            throw ViewerProblem.NotFound("module_disabled", "The viewer module is disabled.");
        if (capability is not { Length: 64 } || !capability.All(Uri.IsHexDigit))
            throw UnknownDownload();
        var hash = ViewerDownloadService.Hash(capability.ToLowerInvariant());
        var found = await downloads.FindByCapabilityHashAsync(hash, ct) ?? throw UnknownDownload();
        var stamp = governor.Stamp(found.Id, found.ViewerId);
        // Read again after stamping: a revocation commits its state before it bumps the generation.
        var download = await downloads.FindByIdAsync(found.Id, ct) ?? throw UnknownDownload();
        if (download.CapabilityHash != hash)
            throw download.RevokedCapabilityHash == hash ? Revoked() : UnknownDownload();
        if (download is not { State: ViewerDownloadService.States.Ready, SizeBytes: > 0, ETag: not null, FileName: not null, ReleaseId: not null })
            throw UnknownDownload();
        if (download.ExpiresAt is { } expires && expires <= time.GetUtcNow())
            throw new ViewerProblem(StatusCodes.Status410Gone, "download_expired", "The file URL of this download expired; renew it.");
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await db.Viewers.AsNoTracking().FirstOrDefaultAsync(v => v.Id == download.ViewerId, ct) ?? throw UnknownDownload();
        if (viewer.IsDisabled || !viewer.AllowDownloads)
            throw ViewerProblem.Forbidden("downloads_not_allowed", "Downloads are turned off for this profile.");
        if (WorkKey.TryParse(download.WorkId) is { } work && await policy.EvaluateAsync(viewer, work, ct) is { Allowed: false } refused)
            throw ViewerContentPolicy.AgeRestricted(refused);
        return new Access(download, viewer, stamp);
    }

    private static void WriteFileHeaders(HttpResponse response, ViewerDownloadEntity download)
    {
        response.ContentType = ContainerContentTypes.For(download.Container ?? Path.GetExtension(download.FileName ?? "").TrimStart('.'));
        response.Headers.AcceptRanges = "bytes";
        response.Headers.ETag = download.ETag;
        var disposition = new ContentDispositionHeaderValue("attachment");
        disposition.SetHttpFileName(Path.GetFileName(download.FileName ?? "download"));
        response.Headers.ContentDisposition = disposition.ToString();
    }

    /// <summary>One byte range of a single-range request; null for the whole file (no Range, several ranges, or an If-Range that no longer matches).</summary>
    internal static (long Start, long Length, bool Satisfiable)? RequestedRange(HttpRequest request, string? etag, long size)
    {
        var header = request.Headers.Range.ToString();
        if (string.IsNullOrWhiteSpace(header))
            return null;
        var ifRange = request.Headers.IfRange.ToString();
        if (ifRange.Length > 0 && !string.Equals(ifRange.Trim(), etag, StringComparison.Ordinal))
            return null;
        if (!RangeHeaderValue.TryParse(header, out var parsed) || !string.Equals(parsed.Unit.Value, "bytes", StringComparison.OrdinalIgnoreCase)
            || parsed.Ranges.Count != 1)
            return null;
        var item = parsed.Ranges.First();
        long start, end;
        if (item.From is null)
        {
            if (item.To is not > 0)
                return (0, 0, false);
            start = Math.Max(0, size - item.To.Value);
            end = size - 1;
        }
        else
        {
            start = item.From.Value;
            end = Math.Min(item.To ?? size - 1, size - 1);
        }
        if (start >= size || end < start)
            return (0, 0, false);
        return (start, end - start + 1, true);
    }

    private static DownloadFileTarget Target(ViewerDownloadEntity d, ViewerEntity viewer)
        => new(d.Id, viewer.Id, viewer.Username, d.ReleaseId!, d.WorkId, d.FileName!, d.SizeBytes!.Value);

    private static ViewerProblem TooMany(string scope)
        => ViewerProblem.RetryLater(StatusCodes.Status429TooManyRequests, "too_many_downloads",
            scope switch
            {
                "download" => "This download already has the most parallel requests.",
                "viewer" => "This profile is already downloading as many files as it may at once.",
                _ => "The server is already transferring as many downloads as it may at once.",
            },
            TimeSpan.FromSeconds(10),
            new Dictionary<string, string> { ["scope"] = scope });

    private static ViewerProblem Revoked()
        => new(StatusCodes.Status410Gone, "download_revoked", "This file URL was revoked by a security sign-out; sign in again and renew the download.");

    private static ViewerProblem UnknownDownload() => ViewerProblem.NotFound("unknown_download", "No ready download exists for this file URL (removed, completed or revoked).");
}
