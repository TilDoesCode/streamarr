namespace Streamarr.Server.Viewers;

/// <summary>
/// Sessions ended by an explicit security action: <see cref="OnlySessionId"/> just that device, <see cref="KeepSessionId"/> every
/// session but that one, neither = all of the viewer's sessions.
/// </summary>
public sealed record ViewerSessionRevocation(string ViewerId, string Reason, string? OnlySessionId = null, string? KeepSessionId = null)
{
    /// <summary>Whether a download bound to <paramref name="sessionId"/> loses its server access.</summary>
    public bool Covers(string sessionId)
        => OnlySessionId is { } only ? only == sessionId : KeepSessionId is not { } keep || keep != sessionId;
}

/// <summary>Reacts to account and session changes of a viewer (download access).</summary>
public interface IViewerAccessListener
{
    /// <summary>Permissions, the disabled flag or the account itself changed (also deleted).</summary>
    Task AccessChangedAsync(string viewerId, CancellationToken ct);

    /// <summary>An explicit security sign-out ended sessions (never an ordinary logout or expiry).</summary>
    Task SessionsRevokedAsync(ViewerSessionRevocation revocation, CancellationToken ct);
}

/// <summary>Publishes viewer access changes to every <see cref="IViewerAccessListener"/>; listeners are resolved per call, so they may depend on the publishers.</summary>
public sealed class ViewerAccessEvents(IServiceProvider services)
{
    /// <summary>Session revocation reasons that are no security action (the viewer's own sign-out of this device).</summary>
    public static readonly IReadOnlySet<string> OrdinaryReasons = new HashSet<string>(StringComparer.Ordinal) { "logout" };

    public async Task AccessChangedAsync(string viewerId, CancellationToken ct)
    {
        foreach (var listener in services.GetServices<IViewerAccessListener>())
            await listener.AccessChangedAsync(viewerId, ct);
    }

    public async Task SessionsRevokedAsync(ViewerSessionRevocation revocation, CancellationToken ct)
    {
        if (OrdinaryReasons.Contains(revocation.Reason))
            return;
        foreach (var listener in services.GetServices<IViewerAccessListener>())
            await listener.SessionsRevokedAsync(revocation, ct);
    }
}
