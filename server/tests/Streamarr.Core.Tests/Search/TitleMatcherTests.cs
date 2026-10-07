using Streamarr.Core.Search;

namespace Streamarr.Core.Tests.Search;

public sealed class TitleMatcherTests
{
    [Theory]
    [InlineData("Ligh", "The Lighthouse Logs")]
    [InlineData("lighthouse lo", "The Lighthouse Logs")]
    [InlineData("logs light", "The Lighthouse Logs")]
    [InlineData("Leucht", "Die Leuchtturm-Chroniken")]
    [InlineData("Chron", "Die Leuchtturm-Chroniken")]
    [InlineData("leuchtturm chro", "Die Leuchtturm-Chroniken")]
    [InlineData("o'b", "Brother Where Art Thou O'Brien")]
    [InlineData("brien", "Brother Where Art Thou O'Brien")]
    [InlineData("STAR", "Star Wars: Episode IV")]
    [InlineData("amel", "Die fabelhafte Welt der Amélie")]
    [InlineData("Ämel", "Die fabelhafte Welt der Amélie")]
    [InlineData("Wäch", "Die Wächter")]
    [InlineData("Waech", "Die Wächter")]
    [InlineData("Wach", "Die Wächter")]
    [InlineData("strass", "Die Straße")]
    [InlineData("straß", "Die Strasse")]
    [InlineData("2001 od", "2001: A Space Odyssey")]
    public void EveryQueryWordStartingATitleWord_Matches(string query, string title)
        => Assert.NotEqual(TitleMatch.None, TitleMatcher.Match(query, title));

    [Theory]
    [InlineData("ight", "The Lighthouse Logs")]
    [InlineData("lighthouse x", "The Lighthouse Logs")]
    [InlineData("turm", "Die Leuchtturm-Chroniken")]
    [InlineData("logs lighthouses", "The Lighthouse Logs")]
    [InlineData("", "The Lighthouse Logs")]
    [InlineData("  -  ", "The Lighthouse Logs")]
    public void A_WordThatOnlyContainsTheQuery_OrAMissingWord_DoesNotMatch(string query, string title)
        => Assert.Equal(TitleMatch.None, TitleMatcher.Match(query, title));

    [Theory]
    [InlineData("the lighthouse logs", TitleMatch.Exact)]
    [InlineData("The Lighthouse-Logs", TitleMatch.Exact)]
    [InlineData("the light", TitleMatch.Prefix)]
    [InlineData("the lighthouse l", TitleMatch.Prefix)]
    [InlineData("lighthouse", TitleMatch.WordPrefix)]
    [InlineData("logs", TitleMatch.WordPrefix)]
    public void Exact_BeatsPrefix_BeatsWordPrefix(string query, TitleMatch expected)
        => Assert.Equal(expected, TitleMatcher.Match(query, "The Lighthouse Logs"));

    [Fact]
    public void The_Best_Name_Wins_Localized_Original_Or_Alternative()
    {
        Assert.Equal(TitleMatch.Prefix, TitleMatcher.Match("leucht", "The Lighthouse Logs", "Leuchtturm-Chroniken", null));
        Assert.Equal(TitleMatch.Exact, TitleMatcher.Match("die leuchtturm chroniken", "Die Leuchtturm-Chroniken", "The Lighthouse Logs"));
        Assert.Equal(TitleMatch.WordPrefix, TitleMatcher.Match("chron", "Die Leuchtturm-Chroniken", "The Lighthouse Logs"));
        Assert.Equal(TitleMatch.Exact, TitleMatcher.Match("die waechter", "Die Wächter"));
    }

    [Theory]
    [InlineData("istanbul", "İstanbul", TitleMatch.Exact)]
    [InlineData("İSTANBUL", "istanbul", TitleMatch.Exact)]
    [InlineData("ıstan", "Istanbul", TitleMatch.Prefix)]
    [InlineData("ist", "Kedi: İstanbul Sokakları", TitleMatch.WordPrefix)]
    public void Turkish_Dotted_And_Dotless_I_Fold_To_i(string query, string title, TitleMatch expected)
        => Assert.Equal(expected, TitleMatcher.Match(query, title));

    [Fact]
    public void Unpaired_Surrogates_In_Query_Or_Title_Never_Throw()
    {
        // Built in code: xUnit replaces unpaired surrogates in [InlineData] strings during discovery.
        var cases = new (string Query, string Title, TitleMatch Expected)[]
        {
            ("ab\uD800", "abc", TitleMatch.Prefix),
            ("\uDC00lig", "The Lighthouse Logs", TitleMatch.WordPrefix),
            ("lig", "The \uDC00Lighthouse Logs\uD800", TitleMatch.WordPrefix),
            ("\uD800", "The Lighthouse Logs", TitleMatch.None),
            ("😀 lig", "The 😀 Lighthouse", TitleMatch.WordPrefix),
        };
        Assert.Equal(4, cases.Count(c => (c.Query + c.Title).Any(char.IsSurrogate) && !(c.Query + c.Title).Contains("😀", StringComparison.Ordinal)));
        foreach (var (query, title, expected) in cases)
            Assert.Equal(expected, TitleMatcher.Match(query, title));
    }

    [Fact]
    public void WellFormed_Replaces_Only_Unpaired_Surrogates()
    {
        Assert.Equal("a\uFFFDb\uFFFD", TitleMatcher.WellFormed("a\uDC00b\uD800"));
        Assert.Equal("😀x", TitleMatcher.WellFormed("😀x"));
    }
}
