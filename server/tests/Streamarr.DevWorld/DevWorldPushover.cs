using System.Collections.Concurrent;
using System.Net;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Services;

namespace Streamarr.DevWorld;

/// <summary>Pushover never leaves the harness: messages land in an in-memory outbox (GET /devworld/pushover).</summary>
public sealed class PushoverOutbox
{
    private readonly ConcurrentQueue<(DateTimeOffset At, string Title, string Message)> _messages = new();

    public IReadOnlyList<(DateTimeOffset At, string Title, string Message)> List() => _messages.ToArray();

    internal void Add(string title, string message)
    {
        _messages.Enqueue((DateTimeOffset.UtcNow, title, message));
        while (_messages.Count > 200 && _messages.TryDequeue(out _))
        {
        }
    }

    internal sealed class Handler(PushoverOutbox outbox) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var form = (await request.Content!.ReadAsStringAsync(cancellationToken))
                .Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(pair => pair.Split('=', 2))
                .ToDictionary(p => WebUtility.UrlDecode(p[0]), p => p.Length > 1 ? WebUtility.UrlDecode(p[1]) : "");
            outbox.Add(form.GetValueOrDefault("title", ""), form.GetValueOrDefault("message", ""));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"status":1,"request":"devworld"}""", Encoding.UTF8, "application/json"),
            };
        }
    }
}

public static class DevWorldPushover
{
    public static void AddDevWorldPushover(this IServiceCollection services)
    {
        var outbox = new PushoverOutbox();
        services.AddSingleton(outbox);
        services.AddHttpClient<PushoverClient>().ConfigurePrimaryHttpMessageHandler(() => new PushoverOutbox.Handler(outbox));
    }

    public static void MapDevWorldPushover(this WebApplication app)
        => app.MapGet("/devworld/pushover", (PushoverOutbox outbox) => Results.Ok(outbox.List().Select(m => new { at = m.At, title = m.Title, message = m.Message })))
            .AllowAnonymous().ExcludeFromDescription();
}
