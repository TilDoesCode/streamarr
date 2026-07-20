using Streamarr.Core.Media;

namespace Streamarr.Core.Profiles;

/// <summary>
/// Source of the ranking profile a search should use (BRIEF §7.3). A SQLite-backed,
/// CRUD-able store replaces this in M3; for now only the built-in default exists, so an
/// unknown <c>profileId</c> falls back to it rather than failing the search.
/// </summary>
public interface IProfileProvider
{
    /// <summary>The profile to rank with; <paramref name="profileId"/> null selects the default.</summary>
    QualityProfile Get(string? profileId, MediaType? mediaType = null);
}

/// <summary>Trivial provider returning the built-in <see cref="DefaultProfiles.Standard"/> profile.</summary>
public sealed class DefaultProfileProvider : IProfileProvider
{
    public QualityProfile Get(string? profileId, MediaType? mediaType = null) => DefaultProfiles.Standard;
}
