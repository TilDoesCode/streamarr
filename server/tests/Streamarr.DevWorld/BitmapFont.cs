namespace Streamarr.DevWorld;

/// <summary>Built-in 5x7 bitmap font for the burned-in panel (the Homebrew ffmpeg has no drawtext).</summary>
public static class BitmapFont
{
    private const int GlyphWidth = 5;
    private const int GlyphHeight = 7;
    private const int CellWidth = 6;
    private const int LineHeight = 9;

    private static readonly Dictionary<char, string[]> Glyphs = new()
    {
        ['A'] = [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
        ['B'] = ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
        ['C'] = [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
        ['D'] = ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
        ['E'] = ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
        ['F'] = ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
        ['G'] = [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
        ['H'] = ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
        ['I'] = [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
        ['J'] = ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
        ['K'] = ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
        ['L'] = ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
        ['M'] = ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
        ['N'] = ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
        ['O'] = [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
        ['P'] = ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
        ['Q'] = [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
        ['R'] = ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
        ['S'] = [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
        ['T'] = ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
        ['U'] = ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
        ['V'] = ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
        ['W'] = ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
        ['X'] = ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
        ['Y'] = ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
        ['Z'] = ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
        ['0'] = [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
        ['1'] = ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
        ['2'] = [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
        ['3'] = ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
        ['4'] = ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
        ['5'] = ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
        ['6'] = ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
        ['7'] = ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
        ['8'] = [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
        ['9'] = [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
        [' '] = [".....", ".....", ".....", ".....", ".....", ".....", "....."],
        ['.'] = [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
        [','] = [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
        [':'] = [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
        ['-'] = [".....", ".....", ".....", "#####", ".....", ".....", "....."],
        ['/'] = [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."],
        ['('] = ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
        [')'] = [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
        ['+'] = [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
        ['\''] = ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
        ['&'] = [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
        ['!'] = ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
        ['?'] = [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
        ['|'] = ["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
        ['='] = [".....", ".....", "#####", ".....", "#####", ".....", "....."],
        ['_'] = [".....", ".....", ".....", ".....", ".....", ".....", "#####"],
        ['#'] = [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
        ['['] = [".###.", ".#...", ".#...", ".#...", ".#...", ".#...", ".###."],
        [']'] = [".###.", "...#.", "...#.", "...#.", "...#.", "...#.", ".###."],
    };

    /// <summary>Upper-cases, transliterates umlauts and replaces unsupported characters.</summary>
    public static string Sanitize(string text)
    {
        var upper = text.ToUpperInvariant()
            .Replace("Ä", "AE", StringComparison.Ordinal)
            .Replace("Ö", "OE", StringComparison.Ordinal)
            .Replace("Ü", "UE", StringComparison.Ordinal)
            .Replace("ß", "SS", StringComparison.Ordinal);
        return new string(upper.Select(c => Glyphs.ContainsKey(c) ? c : c == '·' ? '|' : ' ').ToArray());
    }

    /// <summary>Glyph scale for a panel spanning <paramref name="width"/> pixels.</summary>
    public static int ScaleFor(int width) => Math.Max(2, width / 360);

    /// <summary>Panel height for a given frame width.</summary>
    public static int PanelHeight(int width) => ScaleFor(width) * 20;

    /// <summary>Renders one gray8 panel frame: title and label left, timecode right, progress bar at the bottom.</summary>
    public static void RenderPanel(Span<byte> frame, int width, string title, string label, TimeSpan position, TimeSpan duration, byte textLevel)
    {
        var s = ScaleFor(width);
        var height = PanelHeight(width);
        frame[..(width * height)].Clear();

        var timecode = $"{(int)position.TotalHours:00}:{position.Minutes:00}:{position.Seconds:00}";
        var timecodeWidth = timecode.Length * CellWidth * 2 * s;
        var maxChars = Math.Max(1, (width - timecodeWidth - 3 * s) / (CellWidth * s));

        DrawText(frame, width, s, s, Clip(title, maxChars), s, textLevel);
        DrawText(frame, width, s, s + LineHeight * s, Clip(label, maxChars), s, (byte)(textLevel * 3 / 4));
        DrawText(frame, width, width - timecodeWidth - s, s + s, timecode, 2 * s, textLevel);

        var barHeight = Math.Max(2, s / 2);
        var filled = duration > TimeSpan.Zero ? (int)(width * Math.Clamp(position / duration, 0, 1)) : 0;
        for (var y = height - barHeight; y < height; y++)
        {
            var row = frame.Slice(y * width, width);
            row[..filled].Fill((byte)(textLevel * 2 / 3));
            row[filled..].Fill(40);
        }
    }

    private static string Clip(string text, int maxChars) => text.Length <= maxChars ? text : text[..maxChars];

    private static void DrawText(Span<byte> frame, int width, int x0, int y0, string text, int scale, byte level)
    {
        var frameHeight = frame.Length / width;
        for (var i = 0; i < text.Length; i++)
        {
            if (!Glyphs.TryGetValue(text[i], out var glyph))
                continue;
            var cellX = x0 + i * CellWidth * scale;
            for (var gy = 0; gy < GlyphHeight; gy++)
            {
                for (var gx = 0; gx < GlyphWidth; gx++)
                {
                    if (glyph[gy][gx] != '#')
                        continue;
                    for (var dy = 0; dy < scale; dy++)
                    {
                        var y = y0 + gy * scale + dy;
                        if (y < 0 || y >= frameHeight)
                            continue;
                        var x = cellX + gx * scale;
                        if (x < 0 || x + scale > width)
                            continue;
                        frame.Slice(y * width + x, scale).Fill(level);
                    }
                }
            }
        }
    }
}
