namespace Streamarr.Core.Indexers;

/// <summary>Base type for every recoverable Newznab indexer failure. The fan-out
/// isolates these so one broken indexer never fails a search (BRIEF §6.1 module 1).</summary>
public class NewznabException : Exception
{
    public NewznabException(string message) : base(message) { }
    public NewznabException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>The indexer returned a non-success HTTP status or a Newznab &lt;error&gt;.</summary>
public sealed class NewznabRequestException : NewznabException
{
    public NewznabRequestException(
        string message,
        bool isTransient = true,
        TimeSpan? retryAfter = null) : base(message)
    {
        IsTransient = isTransient;
        RetryAfter = retryAfter;
    }

    public NewznabRequestException(
        string message,
        Exception inner,
        bool isTransient = true,
        TimeSpan? retryAfter = null) : base(message, inner)
    {
        IsTransient = isTransient;
        RetryAfter = retryAfter;
    }

    public bool IsTransient { get; }
    public TimeSpan? RetryAfter { get; }
}

/// <summary>The response body could not be parsed as Newznab XML.</summary>
public sealed class NewznabParseException : NewznabException
{
    public NewznabParseException(string message) : base(message) { }
    public NewznabParseException(string message, Exception inner) : base(message, inner) { }
}
