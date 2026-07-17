using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class OutboundHttpHandlerFactoryTests
{
    [Fact]
    public void IndexerHandlerUsesConfiguredProxyWithoutBypass()
    {
        var options = new StreamarrOptions { IndexerProxy = "http://gluetun:8888" };

        using var handler = OutboundHttpHandlerFactory.CreateIndexer(options, maxConnectionsPerServer: 8);

        Assert.True(handler.UseProxy);
        var proxy = Assert.IsType<WebProxy>(handler.Proxy);
        Assert.Equal(new Uri("http://gluetun:8888"), proxy.Address);
        Assert.False(proxy.BypassProxyOnLocal);
        Assert.Equal(8, handler.MaxConnectionsPerServer);
    }

    [Fact]
    public void UnconfiguredIndexerAndDirectHandlersDisableAmbientProxyDiscovery()
    {
        using var indexerHandler = OutboundHttpHandlerFactory.CreateIndexer(new StreamarrOptions());
        using var directHandler = OutboundHttpHandlerFactory.CreateDirect();

        Assert.False(indexerHandler.UseProxy);
        Assert.Null(indexerHandler.Proxy);
        Assert.False(directHandler.UseProxy);
        Assert.Null(directHandler.Proxy);
    }

    [Fact]
    public void TopLevelIndexerProxyAliasOverridesNestedConfiguration()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Development,
        });
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:IndexerProxy"] = "http://nested-proxy:8080",
            [StreamarrOptions.IndexerProxyEnvironmentVariable] = "http://gluetun:8888",
        });
        builder.AddStreamarrServer();
        using var app = builder.Build();

        var options = app.Services.GetRequiredService<IOptions<StreamarrOptions>>().Value;

        Assert.Equal("http://gluetun:8888", options.IndexerProxy);
    }
}
