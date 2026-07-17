using System.Reflection;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.AspNetCore.Authorization;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Tests;

public class PluginSecurityTests
{
    [Fact]
    public void Configuration_controller_requires_real_jellyfin_elevation_policy()
    {
        var authorize = typeof(StreamarrPluginController).GetCustomAttribute<AuthorizeAttribute>();

        Assert.NotNull(authorize);
        Assert.Equal(Policies.RequiresElevation, authorize.Policy);
    }

    [Fact]
    public void Tag_alone_never_establishes_plugin_ownership()
    {
        var folderId = Guid.NewGuid();
        var tagOnly = new Movie
        {
            Id = Guid.NewGuid(),
            ParentId = folderId,
            Tags = [EphemeralLibraryService.EphemeralTag],
        };
        var owned = new Movie
        {
            Id = Guid.NewGuid(),
            ParentId = folderId,
            ProviderIds = new Dictionary<string, string>
            {
                [EphemeralLibraryService.OwnerProviderKey] = EphemeralLibraryService.OwnerProviderValue,
                [EphemeralLibraryService.WorkIdProviderKey] = "tmdb-1",
            },
        };

        Assert.False(EphemeralLibraryService.IsOwnedItem(tagOnly, folderId));
        Assert.True(EphemeralLibraryService.IsOwnedItem(owned, folderId));
        Assert.False(EphemeralLibraryService.IsOwnedItem(owned, Guid.NewGuid()));
    }

    [Fact]
    public void Ephemeral_folder_is_a_scan_safe_library_surface()
    {
        var folder = new StreamarrEphemeralFolder();

        // The folder is a plugin library (top parent + user view), which is what integrates its
        // children into Continue Watching / Next Up / Favorites when placed below the user root.
        Assert.IsAssignableFrom<MediaBrowser.Controller.Entities.BasePluginFolder>(folder);
        Assert.IsAssignableFrom<MediaBrowser.Controller.Entities.ICollectionFolder>(folder);
        Assert.Null(folder.CollectionType);
        Assert.False(folder.IsHidden);
        // Library validation must never be able to remove the folder (its children are DB-only).
        Assert.False(folder.CanDelete());
        Assert.Equal("Folder", folder.GetClientTypeName());
    }

    [Fact]
    public void Plugin_configuration_bounds_secrets_identifiers_ttl_and_server_origin()
    {
        var config = new PluginConfiguration
        {
            EphemeralTtlMinutes = 0,
            PinnedWorkQuery = new string('q', PluginConfiguration.MaxPinnedQueryLength + 20),
        };

        Assert.Equal(PluginConfiguration.MinEphemeralTtlMinutes, config.EphemeralTtlMinutes);
        Assert.Equal(PluginConfiguration.MaxPinnedQueryLength, config.PinnedWorkQuery.Length);
        Assert.Throws<ArgumentException>(() => config.ServerUrl = "ftp://core.example");
        Assert.Throws<ArgumentException>(() => config.ServerUrl = "https://user:password@core.example");
        Assert.Throws<ArgumentException>(() => config.PublicStreamUrl = "ftp://media.example");
        Assert.Throws<ArgumentException>(() => config.PublicStreamUrl = "https://user:password@media.example");
        Assert.Throws<ArgumentException>(() => config.ApiKey = new string('k', PluginConfiguration.MaxApiKeyLength + 1));
        Assert.Throws<ArgumentException>(() => config.ProfileId = new string('p', PluginConfiguration.MaxProfileIdLength + 1));
        Assert.Throws<ArgumentException>(() => config.PinnedWorkQuery = "movie\nforged-log-line");
    }
}
