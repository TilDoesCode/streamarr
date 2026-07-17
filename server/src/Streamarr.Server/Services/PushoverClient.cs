using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Services;

public sealed class PushoverClient(HttpClient http)
{
    public async Task SendAsync(
        NotificationConfigEntity config,
        string appToken,
        string userKey,
        string title,
        string message,
        int priority,
        CancellationToken ct)
    {
        var fields = new Dictionary<string, string>
        {
            ["token"] = appToken,
            ["user"] = userKey,
            ["title"] = Truncate(title, 250),
            ["message"] = Truncate(message, 1024),
            ["priority"] = priority.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
        if (!string.IsNullOrWhiteSpace(config.Device)) fields["device"] = config.Device;
        if (!string.IsNullOrWhiteSpace(config.Sound)) fields["sound"] = config.Sound;
        if (priority == 2)
        {
            fields["retry"] = config.EmergencyRetrySeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
            fields["expire"] = config.EmergencyExpireSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        using var response = await http.PostAsync("1/messages.json", new FormUrlEncodedContent(fields), ct);
        var payload = await response.Content.ReadFromJsonAsync<PushoverResponse>(cancellationToken: ct);
        if (!response.IsSuccessStatusCode || payload?.Status != 1)
        {
            var detail = payload?.Errors is { Count: > 0 } errors
                ? string.Join("; ", errors)
                : $"HTTP {(int)response.StatusCode}";
            throw new HttpRequestException($"Pushover rejected the notification: {detail}");
        }
    }

    private static string Truncate(string value, int maxLength)
        => value.Length <= maxLength ? value : value[..maxLength];

    private sealed record PushoverResponse
    {
        [JsonPropertyName("status")]
        public int Status { get; init; }

        [JsonPropertyName("errors")]
        public IReadOnlyList<string>? Errors { get; init; }
    }
}
