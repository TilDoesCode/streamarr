using Streamarr.Usenet.Exceptions;

namespace Streamarr.Usenet.Nntp;

public enum NntpProviderAttemptOutcome
{
    Success,
    Missing,
    Error,
    Rejected,
}

public sealed record NntpProviderAttempt(
    string Provider,
    string Operation,
    NntpProviderAttemptOutcome Outcome,
    double DurationMs,
    int? ResponseCode = null,
    string? ErrorType = null,
    string? ErrorMessage = null);

public static class NntpProviderAttemptMetadata
{
    public const string ExceptionDataKey = "Streamarr.Usenet.Nntp.ProviderAttempts";
    private const int MaxErrorMessageLength = 512;

    public static IReadOnlyList<NntpProviderAttempt> GetAttempts(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        return exception.Data[ExceptionDataKey] as IReadOnlyList<NntpProviderAttempt> ?? [];
    }

    internal static void SetAttempts(Exception exception, IReadOnlyCollection<NntpProviderAttempt> attempts)
    {
        exception.Data[ExceptionDataKey] = attempts.ToArray();
    }

    internal static NntpProviderAttempt FromException(
        string provider,
        string operation,
        double durationMs,
        Exception exception)
    {
        var missing = exception is UsenetArticleNotFoundException;
        return new NntpProviderAttempt(
            provider,
            operation,
            missing ? NntpProviderAttemptOutcome.Missing : NntpProviderAttemptOutcome.Error,
            durationMs,
            missing ? (int)NntpResponseType.NoArticleWithThatMessageId : FindResponseCode(exception),
            exception.GetType().Name,
            NormalizeErrorMessage(exception.Message));
    }

    private static int? FindResponseCode(Exception exception)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (current is UsenetConnectionException { ResponseCode: > 0 } connectionException)
                return connectionException.ResponseCode;
        }

        return null;
    }

    internal static string? NormalizeErrorMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
            return null;

        var normalized = string.Join(' ', message.Split(
            (char[]?)null,
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        return normalized.Length <= MaxErrorMessageLength
            ? normalized
            : normalized[..MaxErrorMessageLength];
    }
}
