namespace Streamarr.Server.Services;

public sealed class NzbUnexpectedContentException()
    : IOException(SafeMessage)
{
    public const string SafeMessage =
        "The indexer returned an HTML page instead of an NZB document. " +
        "Review the indexer's access requirements and usage policy, or use a compatible indexer.";
}
