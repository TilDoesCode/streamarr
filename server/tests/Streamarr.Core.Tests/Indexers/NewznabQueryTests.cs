using Streamarr.Core.Indexers;

namespace Streamarr.Core.Tests.Indexers;

public class NewznabQueryTests
{
    [Theory]
    [InlineData("The.Matrix.1999", "the matrix 1999")]
    [InlineData("  Example   Movie!! ", "example movie")]
    [InlineData("A.B-C_D", "a b c d")]
    [InlineData(null, "")]
    public void NormalizeTerm_LowercasesAndCollapsesSeparators(string? input, string expected)
        => Assert.Equal(expected, NewznabQuery.NormalizeTerm(input));

    [Theory]
    [InlineData("tt0133093", "0133093")]
    [InlineData("TT0133093", "0133093")]
    [InlineData("0133093", "0133093")]
    [InlineData(null, "")]
    public void NormalizeImdb_StripsTtPrefix(string? input, string expected)
        => Assert.Equal(expected, NewznabQuery.NormalizeImdb(input));

    [Theory]
    [InlineData(NewznabSearchKind.Search, "search")]
    [InlineData(NewznabSearchKind.Movie, "movie")]
    [InlineData(NewznabSearchKind.Tv, "tvsearch")]
    public void Function_MapsKindToNewznabFunction(NewznabSearchKind kind, string expected)
        => Assert.Equal(expected, new NewznabQuery { Kind = kind }.Function);

    [Fact]
    public void CacheKey_IsWhitespaceInsensitiveForTheTerm()
    {
        var a = new NewznabQuery { Term = "The  Matrix" };
        var b = new NewznabQuery { Term = "the matrix" };
        Assert.Equal(a.CacheKey(), b.CacheKey());
    }

    [Fact]
    public void CacheKey_DiffersByKindSeasonEpisodeAndIds()
    {
        var baseQuery = new NewznabQuery { Term = "show", Kind = NewznabSearchKind.Tv, Season = 1, Episode = 1 };
        Assert.NotEqual(baseQuery.CacheKey(), (baseQuery with { Episode = 2 }).CacheKey());
        Assert.NotEqual(baseQuery.CacheKey(), (baseQuery with { Season = 2 }).CacheKey());
        Assert.NotEqual(baseQuery.CacheKey(), (baseQuery with { Kind = NewznabSearchKind.Search }).CacheKey());
        Assert.NotEqual(baseQuery.CacheKey(), (baseQuery with { ImdbId = "tt1" }).CacheKey());
    }

    [Fact]
    public void CacheKey_CategoryOrderDoesNotMatter()
    {
        var a = new NewznabQuery { Term = "x", Categories = [2040, 2000] };
        var b = new NewznabQuery { Term = "x", Categories = [2000, 2040] };
        Assert.Equal(a.CacheKey(), b.CacheKey());
    }
}
