using System.Text.Json;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Media;
using Streamarr.Server.Viewers.Playback;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld.Faults;

/// <summary>Wires the fault layer into the Dev World host (never into the product): config, decorators, middleware, /devworld/faults.</summary>
public static class DevWorldFaults
{
    public const string WrapperName = "ffmpeg-fault.sh";

    /// <summary>Config overrides that must be in place before the server reads its options (ffmpeg wrapper path, log level).</summary>
    public static Dictionary<string, string?> Configuration(DevWorldOptions options)
    {
        var paths = new FaultPaths(Path.Combine(options.StateDir, "faults"));
        Directory.CreateDirectory(paths.PidDir);
        Directory.CreateDirectory(paths.SlowDir);
        var wrapper = Path.Combine(paths.Root, WrapperName);
        File.Copy(Path.Combine(AppContext.BaseDirectory, "tools", WrapperName), wrapper, overwrite: true);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(wrapper, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        Environment.SetEnvironmentVariable("DEVWORLD_FAULT_STATE", paths.Root);
        if (Environment.GetEnvironmentVariable("DEVWORLD_FFMPEG") is not { Length: > 0 })
            Environment.SetEnvironmentVariable("DEVWORLD_FFMPEG", FindOnPath("ffmpeg") ?? "ffmpeg");
        return new Dictionary<string, string?>
        {
            ["Streamarr:Transcoding:FfmpegPath"] = wrapper,
            [$"Serilog:MinimumLevel:Override:{FaultRegistry.LoggerName}"] = "Information",
        };
    }

    public static void AddDevWorldFaults(this IServiceCollection services, DevWorldOptions options, MockNntpServer nntp, PublicationStore store)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton(new FaultPaths(Path.Combine(options.StateDir, "faults")));
        services.AddSingleton(sp => new PlaybackMap(sp.GetRequiredService<TimeProvider>()));
        services.AddSingleton<FaultRegistry>();
        services.AddSingleton<FaultIdentity>();
        services.AddSingleton(sp => new FaultActions(
            sp.GetRequiredService<FaultRegistry>(), sp, nntp, store, sp.GetRequiredService<FaultPaths>(), sp.GetRequiredService<ILoggerFactory>()));

        var health = services.Last(d => d.ServiceType == typeof(IReleaseHealthCache));
        services.Remove(health);
        services.AddSingleton(sp => new ResettableHealthCache((IReleaseHealthCache)(health.ImplementationFactory?.Invoke(sp)
            ?? health.ImplementationInstance ?? ActivatorUtilities.CreateInstance(sp, health.ImplementationType!))));
        services.AddSingleton<IReleaseHealthCache>(sp => sp.GetRequiredService<ResettableHealthCache>());

        services.RemoveAll<IPlaybackMedia>();
        services.AddSingleton<ServerPlaybackMedia>();
        services.AddSingleton<IPlaybackMedia>(sp => new FaultPlaybackMedia(sp.GetRequiredService<ServerPlaybackMedia>(), sp.GetRequiredService<FaultRegistry>()));
        services.RemoveAll<IPlaybackResolver>();
        services.AddSingleton<ServerPlaybackResolver>();
        services.AddSingleton<IPlaybackResolver>(sp => new FaultPlaybackResolver(
            sp.GetRequiredService<ServerPlaybackResolver>(), sp.GetRequiredService<FaultRegistry>(), sp.GetRequiredService<FaultActions>()));
    }

    public static void UseDevWorldFaults(this WebApplication app) => app.UseMiddleware<DevWorldFaultMiddleware>();

    public static void MapDevWorldFaults(this WebApplication app)
    {
        var group = app.MapGroup("/devworld").AllowAnonymous().ExcludeFromDescription();

        group.MapPost("/faults", async (HttpRequest request, FaultRegistry registry, FaultActions actions, CancellationToken ct) =>
        {
            JsonElement body;
            try
            {
                body = (await JsonDocument.ParseAsync(request.Body, cancellationToken: ct)).RootElement;
            }
            catch (JsonException e)
            {
                return Invalid($"body is not JSON: {e.Message}");
            }
            var (fault, error) = registry.Arm(body);
            if (fault is null)
                return Invalid(error!);
            string? action;
            try
            {
                action = await actions.OnArmedAsync(fault, ct);
            }
            catch (Exception e)
            {
                registry.Remove(fault.Id);
                return Invalid($"{fault.Name} could not be applied: {e.Message}");
            }
            return Results.Json(new { id = fault.Id, fault = fault.Name, scope = fault.Scope.ToString(), expiresAt = fault.ExpiresAt, action },
                statusCode: StatusCodes.Status201Created);
        });

        group.MapGet("/faults", (FaultRegistry registry) => Results.Ok(registry.List().Select(f => f.ToSummary())));

        group.MapGet("/faults/{id}", (string id, FaultRegistry registry) => registry.Get(id) is { } fault
            ? Results.Ok(new { fault = fault.ToSummary(), lastHits = fault.LastHits.ToList() })
            : Results.NotFound(new { error = new { code = "unknown_fault", message = $"No armed fault {id}." } }));

        group.MapDelete("/faults/{id}", (string id, FaultRegistry registry) => registry.Remove(id)
            ? Results.NoContent()
            : Results.NotFound(new { error = new { code = "unknown_fault", message = $"No armed fault {id}." } }));

        group.MapDelete("/faults", (string? scope, FaultRegistry registry) =>
        {
            registry.Clear(scope);
            return Results.NoContent();
        });

        group.MapGet("/playbacks", (PlaybackMap playbacks) => Results.Ok(playbacks.List().Select(p => p.ToSummary())));
    }

    private static IResult Invalid(string reason)
        => Results.Json(new { error = new { code = "invalid_fault", message = reason } }, statusCode: StatusCodes.Status400BadRequest);

    private static string? FindOnPath(string name)
        => (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator)
            .Select(dir => Path.Combine(dir, name)).FirstOrDefault(File.Exists);
}
