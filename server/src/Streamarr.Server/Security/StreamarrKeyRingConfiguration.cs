using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Security;

/// <summary>
/// Points the Data Protection key ring at the configured directory (BRIEF §6.3 —
/// secrets encrypted at rest, surviving restarts). Configured through
/// <see cref="IConfigureOptions{TOptions}"/> so the path resolves from the fully-bound
/// <see cref="StreamarrOptions"/> at first use, honoring test/host config overrides.
/// </summary>
public sealed class StreamarrKeyRingConfiguration(IOptions<StreamarrOptions> options, IHostEnvironment env)
    : IConfigureOptions<KeyManagementOptions>
{
    public void Configure(KeyManagementOptions target)
    {
        var configured = options.Value.DataProtectionKeysPath;
        var path = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "keys")
            : configured;

        Directory.CreateDirectory(path);
        target.XmlRepository = new FileSystemXmlRepository(new DirectoryInfo(path), NullLoggerFactory.Instance);
    }
}
