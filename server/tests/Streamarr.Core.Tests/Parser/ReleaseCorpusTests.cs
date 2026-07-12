using System.Text.Json;
using Streamarr.Core.Parser;

namespace Streamarr.Core.Tests.Parser;

/// <summary>
/// Runs <see cref="ReleaseParser"/> over the real-shaped release-name corpus at
/// <c>tests/fixtures/release-names.json</c> (BRIEF §7.1). Each fixture asserts only the
/// fields it declares under <c>expected</c>, so cases stay focused and readable.
/// </summary>
public class ReleaseCorpusTests
{
    private static readonly IReadOnlyList<CorpusCase> Cases = CorpusLoader.Load();

    public static IEnumerable<object[]> CorpusData =>
        Cases.Select((c, i) => new object[] { i, c.Name });

    [Fact]
    public void Corpus_HasAtLeast150RealShapedNames()
    {
        Assert.True(Cases.Count >= 150, $"Corpus must contain 150+ names; found {Cases.Count}.");
    }

    [Fact]
    public void Corpus_NamesAreUnique()
    {
        var dupes = Cases.GroupBy(c => c.Name).Where(g => g.Count() > 1).Select(g => g.Key).ToList();
        Assert.True(dupes.Count == 0, "Duplicate corpus names: " + string.Join(", ", dupes));
    }

    [Theory]
    [MemberData(nameof(CorpusData))]
    public void Corpus_ParsesAsExpected(int index, string name)
    {
        var testCase = Cases[index];
        var parsed = ReleaseParser.Parse(name);
        var actual = ToComparable(parsed);

        foreach (var (field, expected) in testCase.Expected)
        {
            Assert.True(actual.ContainsKey(field), $"Unknown expected field '{field}' for '{name}'.");
            AssertField(name, field, expected, actual[field]);
        }
    }

    private static void AssertField(string name, string field, JsonElement expected, object? actual)
    {
        var context = $"[{name}] field '{field}'";

        if (expected.ValueKind == JsonValueKind.Null)
        {
            Assert.True(actual is null, $"{context}: expected null, got '{Render(actual)}'.");
            return;
        }

        switch (actual)
        {
            case null:
                Assert.Fail($"{context}: expected '{expected}', got null.");
                break;
            case bool b:
                Assert.Equal(expected.GetBoolean(), b);
                break;
            case int i:
                Assert.Equal(expected.GetInt32(), i);
                break;
            case string s:
                Assert.Equal(expected.GetString(), s);
                break;
            case IReadOnlyList<string> stringList:
            {
                var expectedList = expected.EnumerateArray().Select(e => e.GetString()!).OrderBy(x => x).ToList();
                var actualList = stringList.OrderBy(x => x).ToList();
                Assert.True(expectedList.SequenceEqual(actualList),
                    $"{context}: expected [{string.Join(",", expectedList)}], got [{string.Join(",", actualList)}].");
                break;
            }
            case IReadOnlyList<int> intList:
            {
                var expectedList = expected.EnumerateArray().Select(e => e.GetInt32()).ToList();
                Assert.True(expectedList.SequenceEqual(intList),
                    $"{context}: expected [{string.Join(",", expectedList)}], got [{string.Join(",", intList)}].");
                break;
            }
            default:
                Assert.Fail($"{context}: unhandled actual type {actual.GetType()}.");
                break;
        }
    }

    private static string Render(object? value) => value switch
    {
        null => "null",
        IReadOnlyList<string> l => "[" + string.Join(",", l) + "]",
        IReadOnlyList<int> l => "[" + string.Join(",", l) + "]",
        _ => value.ToString() ?? "null",
    };

    private static Dictionary<string, object?> ToComparable(ParsedReleaseInfo p) => new()
    {
        ["title"] = p.Title,
        ["year"] = p.Year,
        ["mediaType"] = p.MediaType switch
        {
            ParsedMediaType.Movie => "movie",
            ParsedMediaType.Tv => "tv",
            _ => "unknown",
        },
        ["resolution"] = p.Resolution,
        ["source"] = p.Source,
        ["videoCodec"] = p.VideoCodec,
        ["hdr"] = p.Hdr,
        ["audioCodec"] = p.AudioCodec,
        ["audioChannels"] = p.AudioChannels,
        ["atmos"] = p.Atmos,
        ["releaseGroup"] = p.ReleaseGroup,
        ["edition"] = p.Edition,
        ["proper"] = p.Proper,
        ["repack"] = p.Repack,
        ["version"] = p.Version,
        ["languages"] = (IReadOnlyList<string>)p.Languages,
        ["multiLanguage"] = p.MultiLanguage,
        ["dualAudio"] = p.DualAudio,
        ["season"] = p.Season,
        ["episodes"] = (IReadOnlyList<int>)p.Episodes,
        ["absoluteEpisodes"] = (IReadOnlyList<int>)p.AbsoluteEpisodes,
        ["seasonPack"] = p.SeasonPack,
        ["seasonEnd"] = p.SeasonEnd,
        ["airDate"] = p.AirDate,
        ["isDaily"] = p.IsDaily,
    };
}

internal sealed record CorpusCase(string Name, string? Category, IReadOnlyDictionary<string, JsonElement> Expected);

internal static class CorpusLoader
{
    internal static IReadOnlyList<CorpusCase> Load()
    {
        var path = FindCorpusFile();
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var cases = new List<CorpusCase>();

        foreach (var element in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            var name = element.GetProperty("name").GetString()!;
            var category = element.TryGetProperty("category", out var cat) ? cat.GetString() : null;
            var expected = new Dictionary<string, JsonElement>();

            if (element.TryGetProperty("expected", out var exp))
            {
                foreach (var prop in exp.EnumerateObject())
                {
                    expected[prop.Name] = prop.Value.Clone();
                }
            }

            cases.Add(new CorpusCase(name, category, expected));
        }

        return cases;
    }

    private static string FindCorpusFile()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "tests", "fixtures", "release-names.json");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new FileNotFoundException("Could not locate tests/fixtures/release-names.json by walking up from " + AppContext.BaseDirectory);
    }
}
