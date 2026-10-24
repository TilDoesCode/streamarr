using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Services.Diagnostics;

namespace Streamarr.Server.Tests.Diagnostics;

public sealed class DiagnosticsVerdictTests
{
    private static readonly DependencySnapshot Snapshot = new() { Indexers = [], Providers = [], CheckedAt = DateTimeOffset.UnixEpoch };

    private static DiagnosticsComponent C(string kind, string status, string? code = null, int n = 1)
        => new() { Id = $"{kind}:{n}", Kind = kind, Name = kind, Status = status, ErrorCode = code };

    private static List<DiagnosticsComponent> Healthy() =>
    [
        C("database", "ok"), C("metadata", "ok"), C("provider", "ok"), C("indexer", "ok"), C("disk", "ok"), C("streams", "ok"),
    ];

    [Fact]
    public void AllOk_IsOkWithoutHints()
    {
        var (status, hints) = DiagnosticsService.Verdict(Healthy(), Snapshot);
        Assert.Equal("ok", status);
        Assert.Empty(hints);
    }

    [Fact]
    public void AllProvidersDown_IsDown()
    {
        var components = Healthy();
        components[2] = C("provider", "down", "timeout");
        components.Add(C("provider", "down", "auth_failed", 2));

        var (status, hints) = DiagnosticsService.Verdict(components, Snapshot);

        Assert.Equal("down", status);
        Assert.Equal(["all_providers_down", "provider_auth_failed"], hints);
    }

    [Fact]
    public void NoIndexers_IsDown()
    {
        var components = Healthy().Where(c => c.Kind != "indexer").ToList();
        var (status, hints) = DiagnosticsService.Verdict(components, Snapshot);
        Assert.Equal("down", status);
        Assert.Equal(["no_indexers"], hints);
    }

    [Fact]
    public void DatabaseDown_IsDownAndFirst()
    {
        var components = Healthy();
        components[0] = C("database", "down", "unreachable");
        components[1] = C("metadata", "down", "unreachable");
        var (status, hints) = DiagnosticsService.Verdict(components, Snapshot);
        Assert.Equal("down", status);
        Assert.Equal(["database_unreachable", "tmdb_unreachable"], hints);
    }

    [Theory]
    [InlineData("metadata", "unconfigured", "not_configured", "tmdb_not_configured")]
    [InlineData("metadata", "degraded", "slow", "tmdb_slow")]
    [InlineData("disk", "degraded", "low_space", "disk_low")]
    [InlineData("streams", "degraded", "exhausted", "connections_exhausted")]
    [InlineData("provider", "degraded", "circuit_open", "provider_slow")]
    [InlineData("indexer", "degraded", "slow", "indexer_slow")]
    public void OneWeakComponent_IsDegradedWithItsHint(string kind, string status, string code, string hint)
    {
        var components = Healthy().Select(c => c.Kind == kind ? C(kind, status, code) : c).ToList();
        var (verdict, hints) = DiagnosticsService.Verdict(components, Snapshot);
        Assert.Equal("degraded", verdict);
        Assert.Equal([hint], hints);
    }

    [Theory]
    [InlineData(null, "unreachable")]
    [InlineData("authentication failed (NNTP 481)", "auth_failed")]
    [InlineData("timed out", "timeout")]
    [InlineData("Connection refused", "unreachable")]
    public void ProviderErrors_AreClassified(string? error, string code)
        => Assert.Equal(code, DeepHealthDiagnostics.ClassifyProvider(error));
}
