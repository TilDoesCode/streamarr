using System.Net;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;

namespace Streamarr.Core.Tests.Indexers;

/// <summary>Loads the canned Newznab XML fixtures copied next to the test assembly.</summary>
internal static class NewznabFixtures
{
    public static string Load(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "Newznab", name);
        return File.ReadAllText(path);
    }

    public static IndexerConfig Indexer(string name, int priority = 0, bool enabled = true, string baseUrl = "")
        => new()
        {
            Id = name.ToLowerInvariant(),
            Name = name,
            BaseUrl = string.IsNullOrEmpty(baseUrl) ? $"https://{name.ToLowerInvariant()}.example" : baseUrl,
            ApiKey = $"{name.ToLowerInvariant()}key",
            Categories = [2000],
            Enabled = enabled,
            Priority = priority,
        };
}

/// <summary>A settable-clock <see cref="TimeProvider"/> for deterministic cache/age tests.</summary>
internal sealed class ManualTimeProvider(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;
}

/// <summary>
/// Routes HTTP requests to canned responses by <c>request.RequestUri</c>. Used to
/// drive the real <see cref="NewznabClient"/> against fixtures without a network.
/// </summary>
internal sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
{
    public List<Uri> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request.RequestUri!);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(responder(request));
    }

    public static HttpResponseMessage Xml(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/xml") };

    public static HttpResponseMessage Status(HttpStatusCode code)
        => new(code) { Content = new StringContent(string.Empty) };
}

/// <summary>
/// Scriptable <see cref="INewznabClient"/> for fan-out tests: per-indexer canned
/// items, exceptions, or delays — no HTTP involved.
/// </summary>
internal sealed class FakeNewznabClient : INewznabClient
{
    private readonly Dictionary<string, Func<CancellationToken, Task<NewznabSearchResponse>>> _behaviours = new();

    public int SearchCallCount { get; private set; }

    public FakeNewznabClient Returns(string indexerName, params NewznabItem[] items)
    {
        _behaviours[indexerName] = _ => Task.FromResult(new NewznabSearchResponse { Items = items });
        return this;
    }

    public FakeNewznabClient Throws(string indexerName, Exception exception)
    {
        _behaviours[indexerName] = _ => Task.FromException<NewznabSearchResponse>(exception);
        return this;
    }

    public FakeNewznabClient Delays(string indexerName, TimeSpan delay, params NewznabItem[] items)
    {
        _behaviours[indexerName] = async ct =>
        {
            await Task.Delay(delay, ct);
            return new NewznabSearchResponse { Items = items };
        };
        return this;
    }

    public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
        => Task.FromResult(new NewznabCapabilities());

    public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
    {
        SearchCallCount++;
        return _behaviours.TryGetValue(indexer.Name, out var behaviour)
            ? behaviour(cancellationToken)
            : Task.FromResult(new NewznabSearchResponse { Items = [] });
    }

    public static NewznabItem Item(string title, long size, string guid, int grabs = 0)
        => new() { Title = title, Guid = guid, SizeBytes = size, Grabs = grabs, NzbUrl = $"https://x/{guid}.nzb" };
}
