using System.Globalization;
using System.Xml.Linq;

namespace Streamarr.Core.Indexers;

/// <summary>
/// Parses Newznab RSS/XML into <see cref="NewznabSearchResponse"/> and
/// <see cref="NewznabCapabilities"/> (BRIEF §6.1 module 1). Malformed feeds throw
/// <see cref="NewznabParseException"/>; individual malformed <c>&lt;item&gt;</c>s are
/// skipped so one bad row never discards a whole indexer's results.
/// </summary>
public static class NewznabXmlParser
{
    private static readonly XNamespace Newznab = "http://www.newznab.com/DTD/2010/feeds/attributes/";

    public static NewznabSearchResponse ParseSearch(string xml)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(xml);
        }
        catch (System.Xml.XmlException e)
        {
            throw new NewznabParseException("Newznab response was not well-formed XML.", e);
        }

        var channel = doc.Root?.Element("channel");
        if (channel is null)
            throw new NewznabParseException("Newznab response had no <channel> element.");

        int? total = null;
        var responseEl = channel.Element(Newznab + "response");
        if (responseEl is not null && int.TryParse(responseEl.Attribute("total")?.Value, out var t))
            total = t;

        var items = new List<NewznabItem>();
        foreach (var itemEl in channel.Elements("item"))
        {
            var item = TryParseItem(itemEl);
            if (item is not null)
                items.Add(item);
        }

        return new NewznabSearchResponse { Items = items, Total = total };
    }

    private static NewznabItem? TryParseItem(XElement itemEl)
    {
        var title = itemEl.Element("title")?.Value?.Trim();
        if (string.IsNullOrWhiteSpace(title))
            return null;

        var attrs = ReadAttributes(itemEl);

        var guid = FirstAttr(attrs, "guid")
            ?? itemEl.Element("guid")?.Value?.Trim();
        if (string.IsNullOrWhiteSpace(guid))
            return null;

        var enclosure = itemEl.Element("enclosure");
        var nzbUrl = enclosure?.Attribute("url")?.Value?.Trim();
        if (string.IsNullOrWhiteSpace(nzbUrl))
            nzbUrl = itemEl.Element("link")?.Value?.Trim();

        long size = 0;
        if (TryParseLong(FirstAttr(attrs, "size"), out var attrSize))
            size = attrSize;
        else if (TryParseLong(enclosure?.Attribute("length")?.Value, out var encLength))
            size = encLength;

        var categories = attrs
            .Where(a => a.Name.Equals("category", StringComparison.OrdinalIgnoreCase))
            .Select(a => int.TryParse(a.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var c) ? c : (int?)null)
            .Where(c => c is not null)
            .Select(c => c!.Value)
            .Distinct()
            .ToArray();

        var grabs = 0;
        if (int.TryParse(FirstAttr(attrs, "grabs"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var g))
            grabs = g;

        return new NewznabItem
        {
            Title = title!,
            Guid = guid!,
            NzbUrl = string.IsNullOrWhiteSpace(nzbUrl) ? null : nzbUrl,
            SizeBytes = size,
            Categories = categories,
            Grabs = grabs,
            PublishDate = ParseDate(itemEl.Element("pubDate")?.Value),
            UsenetDate = ParseDate(FirstAttr(attrs, "usenetdate")),
        };
    }

    public static NewznabCapabilities ParseCapabilities(string xml)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(xml);
        }
        catch (System.Xml.XmlException e)
        {
            throw new NewznabParseException("Newznab caps response was not well-formed XML.", e);
        }

        var root = doc.Root;
        if (root is null || !root.Name.LocalName.Equals("caps", StringComparison.OrdinalIgnoreCase))
            throw new NewznabParseException("Newznab caps response had no <caps> root element.");

        var server = root.Element("server");
        var limits = root.Element("limits");
        var searching = root.Element("searching");

        return new NewznabCapabilities
        {
            ServerTitle = server?.Attribute("title")?.Value,
            ServerVersion = server?.Attribute("version")?.Value,
            LimitMax = ParseIntAttr(limits, "max"),
            LimitDefault = ParseIntAttr(limits, "default"),
            SearchAvailable = IsAvailable(searching?.Element("search")),
            MovieSearchAvailable = IsAvailable(searching?.Element("movie-search")),
            TvSearchAvailable = IsAvailable(searching?.Element("tv-search")),
            Categories = ParseCategories(root.Element("categories")),
        };
    }

    private static IReadOnlyList<NewznabCategory> ParseCategories(XElement? categoriesEl)
    {
        if (categoriesEl is null)
            return [];

        var result = new List<NewznabCategory>();
        foreach (var catEl in categoriesEl.Elements("category"))
        {
            if (!int.TryParse(catEl.Attribute("id")?.Value, out var id))
                continue;

            var subs = new List<NewznabCategory>();
            foreach (var subEl in catEl.Elements("subcat"))
            {
                if (int.TryParse(subEl.Attribute("id")?.Value, out var subId))
                    subs.Add(new NewznabCategory { Id = subId, Name = subEl.Attribute("name")?.Value ?? string.Empty });
            }

            result.Add(new NewznabCategory
            {
                Id = id,
                Name = catEl.Attribute("name")?.Value ?? string.Empty,
                Subcategories = subs,
            });
        }

        return result;
    }

    private static List<(string Name, string Value)> ReadAttributes(XElement itemEl)
        => itemEl.Elements(Newznab + "attr")
            .Select(a => (
                Name: a.Attribute("name")?.Value ?? string.Empty,
                Value: a.Attribute("value")?.Value ?? string.Empty))
            .Where(a => a.Name.Length > 0)
            .ToList();

    private static string? FirstAttr(List<(string Name, string Value)> attrs, string name)
        => attrs.FirstOrDefault(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Value is { Length: > 0 } v
            ? v
            : null;

    private static bool IsAvailable(XElement? el)
        => string.Equals(el?.Attribute("available")?.Value, "yes", StringComparison.OrdinalIgnoreCase);

    private static int? ParseIntAttr(XElement? el, string attr)
        => int.TryParse(el?.Attribute(attr)?.Value, out var v) ? v : null;

    private static bool TryParseLong(string? s, out long value)
        => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);

    private static DateTimeOffset? ParseDate(string? s)
    {
        if (string.IsNullOrWhiteSpace(s))
            return null;

        // Newznab dates are RFC 1123 ("Wed, 30 Jun 2021 12:00:00 +0000"); fall back
        // to a lenient parse for indexers that deviate slightly.
        if (DateTimeOffset.TryParseExact(s.Trim(), "ddd, dd MMM yyyy HH:mm:ss zzz",
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var exact))
            return exact;

        return DateTimeOffset.TryParse(s.Trim(), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out var loose)
            ? loose
            : null;
    }
}
