using System.Globalization;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Streamarr.Plugin.Configuration;

namespace Streamarr.Plugin;

/// <summary>
/// The Streamarr Jellyfin plugin (BRIEF §8). A thin adapter: it translates between the
/// Core Server's interface-agnostic API and Jellyfin's data model and contains ZERO
/// domain logic — no parsing, ranking, rejecting, health-checking or fallback decisions
/// (BRIEF §1.1, §3.1 rule 3, §11).
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>Singleton accessor used by services that need live configuration.</summary>
    public static Plugin? Instance { get; private set; }

    public override string Name => "Streamarr";

    public override Guid Id => Guid.Parse("6f8d5c7a-9b2e-4a1f-8c3d-2e5a7b9c0d11");

    public override string Description =>
        "Stream Usenet content on demand through the Streamarr Core Server. Thin adapter — no download-to-disk.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = string.Format(
                CultureInfo.InvariantCulture,
                "{0}.Configuration.configPage.html",
                GetType().Namespace),
        };
    }
}
