using Streamarr.Server.Options;

namespace Streamarr.Server.Tests.Services;

public sealed class StreamarrOptionsValidatorTests
{
    [Fact]
    public void ApiKeyRejectsNonWhitespaceControlCharacters()
    {
        var options = new StreamarrOptions
        {
            ApiKey = new string('a', 32) + '\0',
        };

        var result = new StreamarrOptionsValidator().Validate(null, options);

        Assert.True(result.Failed);
        Assert.Contains(result.Failures, failure => failure.Contains("ApiKey", StringComparison.Ordinal));
    }

    [Fact]
    public void DefaultsAreValid_AndUnsafeTmdbOrCapacityOptionsAreRejected()
    {
        var validator = new StreamarrOptionsValidator();
        Assert.True(validator.Validate(null, new StreamarrOptions()).Succeeded);

        var invalid = new StreamarrOptions
        {
            ApiKey = "too short",
            MaxConcurrentResolves = 0,
            MaxConcurrentSearches = 0,
            MaxWatchEvents = 0,
            EphemeralCacheSizeMb = 0,
        };
        invalid.Tmdb.BaseUrl = "file:///tmp/tmdb";
        invalid.Tmdb.ImageBaseUrl = "https://user:pass@images.example";
        invalid.Tmdb.ApiKey = "secret\r\nheader";
        invalid.Tmdb.Language = new string('x', 33);
        invalid.Tmdb.PosterSize = "../original";
        invalid.Tmdb.MaxResponseBytes = 1;
        invalid.Tmdb.RequestTimeoutSeconds = 0;
        invalid.Tmdb.MaxConcurrentRequests = 0;

        var result = validator.Validate(null, invalid);
        Assert.True(result.Failed);
        var errors = string.Join('\n', result.Failures);
        Assert.Contains("MaxConcurrentResolves", errors);
        Assert.Contains("ApiKey", errors);
        Assert.Contains("MaxConcurrentSearches", errors);
        Assert.Contains("MaxWatchEvents", errors);
        Assert.Contains("EphemeralCacheSizeMb", errors);
        Assert.Contains("Tmdb.BaseUrl", errors);
        Assert.Contains("Tmdb.ImageBaseUrl", errors);
        Assert.Contains("Tmdb.ApiKey", errors);
        Assert.Contains("Tmdb.Language", errors);
        Assert.Contains("image sizes", errors);
        Assert.Contains("Tmdb.MaxResponseBytes", errors);
        Assert.Contains("Tmdb.RequestTimeoutSeconds", errors);
        Assert.Contains("Tmdb.MaxConcurrentRequests", errors);
    }

    [Fact]
    public void TrustedProxiesAcceptExactAddresses_AndRejectHostnamesOrDuplicates()
    {
        var validator = new StreamarrOptionsValidator();
        var valid = new StreamarrOptions
        {
            TrustedProxies = ["192.0.2.10", "2001:db8::10"],
        };

        Assert.True(validator.Validate(null, valid).Succeeded);

        valid.TrustedProxies = ["proxy.internal"];
        var hostnameResult = validator.Validate(null, valid);
        Assert.True(hostnameResult.Failed);
        Assert.Contains(
            hostnameResult.Failures!,
            failure => failure.Contains("TrustedProxies", StringComparison.Ordinal));

        valid.TrustedProxies = ["192.0.2.10", "192.0.2.10"];
        var duplicateResult = validator.Validate(null, valid);
        Assert.True(duplicateResult.Failed);
        Assert.Contains(
            duplicateResult.Failures!,
            failure => failure.Contains("duplicate", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void TrustedOriginsAcceptAbsoluteHttpOrigins_IgnoreBlanks_AndRejectBadOrDuplicateValues()
    {
        var validator = new StreamarrOptionsValidator();
        var valid = new StreamarrOptions
        {
            // Blank entries model env-var injection (Streamarr__TrustedOrigins__0=${CODECRAFT_URL_WEB})
            // resolving to empty when unset; they must be ignored rather than fail startup.
            TrustedOrigins = ["https://ui.example.test", "http://localhost:5173", "  "],
        };
        Assert.True(validator.Validate(null, valid).Succeeded);

        valid.TrustedOrigins = ["not-a-url"];
        var invalidResult = validator.Validate(null, valid);
        Assert.True(invalidResult.Failed);
        Assert.Contains(
            invalidResult.Failures!,
            failure => failure.Contains("TrustedOrigins", StringComparison.Ordinal));

        valid.TrustedOrigins = ["https://ui.example.test", "https://ui.example.test"];
        var duplicateResult = validator.Validate(null, valid);
        Assert.True(duplicateResult.Failed);
        Assert.Contains(
            duplicateResult.Failures!,
            failure => failure.Contains("duplicate", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("")]
    [InlineData("http://gluetun:8888")]
    [InlineData("http://127.0.0.1:8888/")]
    public void IndexerProxyAcceptsEmptyOrHttpProxyOrigins(string value)
    {
        var options = new StreamarrOptions { IndexerProxy = value };

        Assert.True(new StreamarrOptionsValidator().Validate(null, options).Succeeded);
    }

    [Theory]
    [InlineData("https://gluetun:8888")]
    [InlineData("http://user:password@gluetun:8888")]
    [InlineData("http://gluetun:8888/path")]
    [InlineData("not-a-url")]
    [InlineData(" ")]
    public void IndexerProxyRejectsUnsupportedOrAmbiguousUrls(string value)
    {
        var options = new StreamarrOptions { IndexerProxy = value };

        var result = new StreamarrOptionsValidator().Validate(null, options);

        Assert.True(result.Failed);
        Assert.Contains(result.Failures!, failure => failure.Contains("IndexerProxy", StringComparison.Ordinal));
    }

    [Fact]
    public void AggregateMemoryBudgetsRejectIndividuallyValidButUnsafeConcurrency()
    {
        var options = new StreamarrOptions
        {
            MaxNzbBytes = 512 * 1024 * 1024,
            MaxConcurrentResolves = 3,
        };
        options.Search.MaxResponseBytes = 128 * 1024 * 1024;
        options.Search.MaxConcurrentIndexerRequests = 5;
        options.Tmdb.MaxResponseBytes = 16 * 1024 * 1024;
        options.Tmdb.MaxConcurrentRequests = 9;

        var result = new StreamarrOptionsValidator().Validate(null, options);
        Assert.True(result.Failed);
        var errors = string.Join('\n', result.Failures!);

        Assert.Contains("1 GiB", errors);
        Assert.Contains("512 MiB", errors);
        Assert.Contains("128 MiB", errors);
    }

    [Fact]
    public void LegacyReadAheadAboveNewStartupDefault_RemainsValid()
    {
        var options = new StreamarrOptions
        {
            ArticleReadAheadCount = 100,
        };

        var result = new StreamarrOptionsValidator().Validate(null, options);

        Assert.True(result.Succeeded);
    }

    [Fact]
    public void NullNestedConfigurationFailsValidationWithoutThrowing()
    {
        var options = new StreamarrOptions { Search = null! };

        var result = new StreamarrOptionsValidator().Validate(null, options);

        Assert.True(result.Failed);
        Assert.Contains(result.Failures!, failure => failure.Contains("must not be null", StringComparison.Ordinal));
    }
}
