namespace Streamarr.Server.Viewers;

/// <summary>
/// Sessions ended by an explicit security action: <see cref="OnlySessionId"/> just that device, <see cref="KeepSessionId"/> every
/// session but that one, neither = all of the viewer's sessions.
/// </summary>
public sealed record ViewerSessionRevocation(string ViewerId, string Reason, string? OnlySessionId = null, string? KeepSessionId = null)
{
    /// <summary>The ready downloads whose file URL the sign-out's transaction retired.</summary>
    public IReadOnlyList<string> RetiredDownloads { get; init; } = [];

    /// <summary>Whether a download bound to <paramref name="sessionId"/> loses its server access.</summary>
    public bool Covers(string sessionId)
        => OnlySessionId is { } only ? only == sessionId : KeepSessionId is not { } keep || keep != sessionId;
}

/// <summary>Reacts to account and session changes of a viewer (download access).</summary>
public interface IViewerAccessListener
{
    /// <summary>Permissions, the disabled flag or the account itself changed (also deleted).</summary>
    Task AccessChangedAsync(string viewerId, CancellationToken ct);

    /// <summary>
    /// An explicit security sign-out ended sessions and committed (never an ordinary logout or expiry). The persisted state is final;
    /// this follow-up is best effort and runs even when the request that signed out is gone.
    /// </summary>
    Task SessionsRevokedAsync(ViewerSessionRevocation revocation, CancellationToken ct);
}

/// <summary>Publishes viewer access changes to every <see cref="IViewerAccessListener"/>; listeners are resolved per call, so they may depend on the publishers.</summary>
public sealed class ViewerAccessEvents(IServiceProvider services)
{
    /// <summary>
    /// Session revocations that leave download file URLs alone: the app's own logout, and disabling the account (the URLs answer
    /// 403 while it is disabled and work again when it is enabled).
    /// </summary>
    public static readonly IReadOnlySet<string> NonRotatingReasons = new HashSet<string>(StringComparer.Ordinal) { "logout", "account_disabled" };

    public async Task AccessChangedAsync(string viewerId, CancellationToken ct)
    {
        foreach (var listener in services.GetServices<IViewerAccessListener>())
            await listener.AccessChangedAsync(viewerId, ct);
    }

    public async Task SessionsRevokedAsync(ViewerSessionRevocation revocation, CancellationToken ct)
    {
        if (NonRotatingReasons.Contains(revocation.Reason))
            return;
        foreach (var listener in services.GetServices<IViewerAccessListener>())
            await listener.SessionsRevokedAsync(revocation, ct);
    }
}
