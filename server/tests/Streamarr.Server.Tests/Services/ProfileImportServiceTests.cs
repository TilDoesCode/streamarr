using System.Net;
using System.Text;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Services;

public sealed class ProfileImportServiceTests
{
    [Fact]
    public async Task RadarrPreview_MapsQualityOrderScopeAndCustomFormatScores()
    {
        var handler = new ArrHandler();
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2) };
        var service = new ProfileImportService(http, TimeProvider.System);

        var result = await service.PreviewAsync(new ProfileImportPreviewRequest
        {
            Source = "radarr",
            BaseUrl = "http://radarr.test/base",
            ApiKey = "secret-key",
        }, default);

        Assert.Equal("Cinema", result.InstanceName);
        var candidate = Assert.Single(result.Profiles);
        Assert.Equal("movies", candidate.SuggestedAppliesTo);
        Assert.Equal(["2160p", "1080p"], candidate.Profile.PreferredResolutions);
        Assert.Equal(["Remux", "WEB-DL"], candidate.Profile.PreferredSources);
        Assert.Equal(1, candidate.ScoredFormatCount);
        Assert.Equal(2, candidate.SupportedConditionCount);
        Assert.Equal(-500, Assert.Single(candidate.Profile.CustomFormats).Score);
        Assert.Equal(0, candidate.Profile.MinimumCustomFormatScore);
        Assert.All(handler.Requests, request => Assert.Equal("secret-key", request.ApiKey));
        Assert.All(handler.Requests, request => Assert.StartsWith("/base/api/v3/", request.Path));
    }

    [Fact]
    public async Task Import_UsesOperatorScopeAndNeverReturnsTheApiKey()
    {
        using var http = new HttpClient(new ArrHandler());
        var service = new ProfileImportService(http, TimeProvider.System);
        var imported = await service.BuildImportsAsync(new ProfileImportRequest
        {
            Source = "radarr",
            BaseUrl = "http://radarr.test",
            ApiKey = "do-not-store",
            Profiles = [new ProfileImportSelection { ExternalId = 7, AppliesTo = "both" }],
        }, default);

        var profile = Assert.Single(imported);
        Assert.Equal("both", profile.AppliesTo);
        Assert.Equal("radarr", profile.ImportedFrom);
        Assert.Equal(7, profile.ImportedProfileId);
        Assert.NotNull(profile.ImportedAtUtc);
        Assert.DoesNotContain("do-not-store", ProfileConfigService.Serialize(profile));
    }

    [Fact]
    public async Task Preview_RejectsEmbeddedCredentialsBeforeSendingARequest()
    {
        var handler = new ArrHandler();
        using var http = new HttpClient(handler);
        var service = new ProfileImportService(http, TimeProvider.System);

        var exception = await Assert.ThrowsAsync<ProfileImportException>(() => service.PreviewAsync(
            new ProfileImportPreviewRequest
            {
                Source = "sonarr",
                BaseUrl = "http://user:password@sonarr.test",
                ApiKey = "key",
            },
            default));

        Assert.True(exception.RequestError);
        Assert.Empty(handler.Requests);
    }

    private sealed class ArrHandler : HttpMessageHandler
    {
        public List<(string Path, string? ApiKey)> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request.RequestUri!.AbsolutePath, request.Headers.GetValues("X-Api-Key").Single()));
            var json = request.RequestUri.AbsolutePath switch
            {
                var path when path.EndsWith("/system/status", StringComparison.Ordinal) =>
                    """{"instanceName":"Cinema","version":"5.2.0"}""",
                var path when path.EndsWith("/qualityprofile", StringComparison.Ordinal) => QualityProfiles,
                var path when path.EndsWith("/customformat", StringComparison.Ordinal) => CustomFormats,
                _ => "{}",
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            });
        }

        private const string QualityProfiles = """
            [{
              "id": 7,
              "name": "Remux + WEB",
              "minFormatScore": 0,
              "language": { "id": 1, "name": "English" },
              "items": [
                { "name": "WEBDL-1080p", "allowed": true, "quality": { "name": "WEBDL-1080p" }, "items": [] },
                { "name": "Remux-2160p", "allowed": true, "quality": { "name": "Remux-2160p" }, "items": [] }
              ],
              "formatItems": [{ "format": 11, "name": "Avoid LQ", "score": -500 }]
            }]
            """;

        private const string CustomFormats = """
            [{
              "id": 11,
              "name": "Avoid LQ",
              "specifications": [
                { "name": "LQ title", "implementation": "ReleaseTitleSpecification", "required": false, "negate": false, "fields": { "value": "\\bLQ\\b" } },
                { "name": "WEB", "implementation": "SourceSpecification", "required": true, "negate": false, "fields": { "value": 7 } }
              ]
            }]
            """;
    }
}
