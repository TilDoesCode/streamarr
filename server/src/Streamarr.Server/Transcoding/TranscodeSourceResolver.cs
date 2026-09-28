using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Transcoding;

/// <summary>Turns a request's stream capability or sample id into an ffmpeg input without touching the stream path itself.</summary>
public sealed class TranscodeSourceResolver(
    SessionManager streams,
    TranscodingSampleLibrary samples,
    IServer server,
    IOptions<TranscodingOptions> options)
{
    public TranscodeSource FromStreamToken(string token, out string title)
    {
        if (!streams.TryGetSession(token, out var session))
            throw new TranscodeException("unknown_stream", "No live stream session exists for this token (closed or expired).", 404);
        title = session.Title;
        return new TranscodeSource(TranscodeSource.StreamKind, $"{LocalBaseUrl()}/api/v1/stream/{Uri.EscapeDataString(token)}", true, session.Title);
    }

    public async Task<TranscodeSource> FromSampleAsync(string sampleId, CancellationToken ct)
    {
        var sample = TranscodingSampleLibrary.Find(sampleId)
                     ?? throw new TranscodeException("unknown_sample", $"Unknown sample '{sampleId}'.", 404);
        var path = await samples.EnsureReadyAsync(sample, ct);
        return new TranscodeSource(TranscodeSource.SampleKind, path, false, sample.Title);
    }

    internal string LocalBaseUrl()
    {
        if (Uri.TryCreate(options.Value.LocalSourceBaseUrl, UriKind.Absolute, out var configured)
            && configured.Scheme is "http" or "https")
        {
            return configured.GetLeftPart(UriPartial.Authority);
        }

        var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses;
        var address = addresses?.FirstOrDefault(a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                      ?? addresses?.FirstOrDefault();
        if (string.IsNullOrEmpty(address))
            throw new TranscodeException("no_local_listener", "The server has no local HTTP listener ffmpeg could read the stream from.", 503);

        var loopback = address
            .Replace("://+", "://127.0.0.1")
            .Replace("://*", "://127.0.0.1")
            .Replace("0.0.0.0", "127.0.0.1")
            .Replace("[::]", "127.0.0.1");
        return new Uri(loopback).GetLeftPart(UriPartial.Authority);
    }
}
