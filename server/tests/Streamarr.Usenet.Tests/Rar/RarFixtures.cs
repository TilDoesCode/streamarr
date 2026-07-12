using Streamarr.Usenet.Tests.Yenc;

namespace Streamarr.Usenet.Tests.Rar;

public static class RarFixtures
{
    public static string Dir => Path.Combine(AppContext.BaseDirectory, "Fixtures", "rar");

    public static string PathOf(string name) => Path.Combine(Dir, name);

    /// <summary>Same LCG as generate_fixtures.py — the exact bytes inside the archives.</summary>
    public static byte[] Payload => YencTestEncoder.LcgBytes(42, 96 * 1024);

    public static byte[] Notes => File.ReadAllBytes(PathOf("notes.txt"));

    public static readonly string[] MultiRar4Parts = ["multi-rar4.rar", "multi-rar4.r00", "multi-rar4.r01"];
    public static readonly string[] MultiRar5Parts = ["multi-rar5.part1.rar", "multi-rar5.part2.rar", "multi-rar5.part3.rar"];
}
