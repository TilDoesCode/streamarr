using System.Net;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

[Collection("streamarr-server")]
public class StorageEndpointTests(StreamarrServerFixture fixture)
{
    [Fact]
    public async Task Storage_ReportsCachesBudgetsAndDisk()
    {
        using var client = fixture.CreateClient();

        // Materialize at least one session so the ephemeral section is non-trivial.
        var resolveResponse = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = StreamarrServerFixture.DirectReleaseId });
        var resolved = (await resolveResponse.Content.ReadFromJsonAsync<ResolveResponse>())!;
        _ = await client.GetByteArrayAsync(resolved.StreamUrl!);

        await client.AuthenticateAsAdminAsync();

        var storage = await client.GetFromJsonAsync<StorageResponse>("/api/v1/storage");
        Assert.NotNull(storage);

        Assert.True(storage!.SegmentCache.CapacityBytes > 0);
        Assert.True(storage.SegmentCache.UsedBytes >= 0);
        Assert.True(storage.SegmentCache.Entries >= 0);

        Assert.True(storage.Ephemeral.Files >= 1);
        Assert.True(storage.Ephemeral.UsedBytes > 0);
        Assert.True(storage.Ephemeral.BudgetBytes > 0);

        Assert.True(storage.NzbLibrary.BudgetBytes > 0);
        Assert.True(storage.NzbLibrary.MaxEntries > 0);

        Assert.False(string.IsNullOrWhiteSpace(storage.PreDownload.Path));
        Assert.True(storage.Disk.MinimumFreeBytes >= 0);
        if (storage.Disk.FreeBytes is { } free && storage.Disk.TotalBytes is { } total)
            Assert.True(free <= total);
    }

    [Fact]
    public async Task Storage_RequiresAuthentication()
    {
        using var anonymous = fixture.CreateClient(authenticated: false);
        using var response = await anonymous.GetAsync("/api/v1/storage");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
