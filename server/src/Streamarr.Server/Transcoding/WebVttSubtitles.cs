using System.Globalization;
using System.Text;

namespace Streamarr.Server.Transcoding;

public sealed record WebVttCue(double Start, double End, string Settings, string Text);

/// <summary>Cues of one text subtitle stream of a remux session, collected from every ffmpeg run's <c>-f webvtt</c> output.</summary>
public sealed class SubtitleTrackStore(int streamIndex)
{
    private readonly object _lock = new();
    private readonly List<WebVttCue> _cues = [];
    private readonly HashSet<(long, long, string)> _seen = [];
    private readonly Dictionary<string, long> _consumed = new(StringComparer.Ordinal);

    public int StreamIndex { get; } = streamIndex;

    public string FileName(string runTag) => string.Create(CultureInfo.InvariantCulture, $"sub-{StreamIndex}-{runTag}.vtt");

    /// <summary>Reads the complete cue blocks ffmpeg appended since the last call.</summary>
    public void Refresh(string directory)
    {
        if (!Directory.Exists(directory))
            return;
        lock (_lock)
        {
            foreach (var path in Directory.EnumerateFiles(directory, $"sub-{StreamIndex}-*.vtt"))
            {
                var offset = _consumed.GetValueOrDefault(path);
                byte[] data;
                try
                {
                    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    if (stream.Length <= offset)
                        continue;
                    stream.Seek(offset, SeekOrigin.Begin);
                    data = new byte[stream.Length - offset];
                    stream.ReadExactly(data);
                }
                catch (IOException)
                {
                    continue;
                }
                var complete = LastBlockEnd(data);
                if (complete <= 0)
                    continue;
                foreach (var cue in WebVttSubtitles.ParseCues(Encoding.UTF8.GetString(data, 0, complete)))
                {
                    if (_seen.Add(((long)Math.Round(cue.Start * 1000), (long)Math.Round(cue.End * 1000), cue.Text)))
                        _cues.Add(cue);
                }
                _consumed[path] = offset + complete;
            }
        }
    }

    public IReadOnlyList<WebVttCue> Between(double start, double end)
    {
        lock (_lock)
            return _cues.Where(c => c.End > start && c.Start < end).OrderBy(c => c.Start).ThenBy(c => c.End).ToList();
    }

    /// <summary>ffmpeg writes each cue as one flushed packet and the blank separator before the next, so data ending in cue text is complete.</summary>
    private static int LastBlockEnd(byte[] data)
    {
        var text = Encoding.UTF8.GetString(data);
        if (text.EndsWith('\n') && text.TrimEnd('\n').Split('\n')[^1] is { Length: > 0 } last && !last.Contains("-->", StringComparison.Ordinal))
            return data.Length;
        for (var i = data.Length - 1; i >= 1; i--)
        {
            if (data[i] == '\n' && data[i - 1] == '\n')
                return i + 1;
        }
        return 0;
    }
}

/// <summary>WebVTT parsing and HLS segment rendering; cue times stay on the media timeline (MPEGTS 0 = LOCAL 0).</summary>
public static class WebVttSubtitles
{
    public const string ContentType = "text/vtt; charset=utf-8";

    private static readonly Dictionary<string, (string Code, string Name)> Languages = new(StringComparer.OrdinalIgnoreCase)
    {
        ["eng"] = ("en", "English"), ["ger"] = ("de", "German"), ["deu"] = ("de", "German"), ["fre"] = ("fr", "French"),
        ["fra"] = ("fr", "French"), ["spa"] = ("es", "Spanish"), ["ita"] = ("it", "Italian"), ["por"] = ("pt", "Portuguese"),
        ["dut"] = ("nl", "Dutch"), ["nld"] = ("nl", "Dutch"), ["swe"] = ("sv", "Swedish"), ["nor"] = ("no", "Norwegian"),
        ["nob"] = ("nb", "Norwegian Bokmål"), ["dan"] = ("da", "Danish"), ["fin"] = ("fi", "Finnish"), ["pol"] = ("pl", "Polish"),
        ["cze"] = ("cs", "Czech"), ["ces"] = ("cs", "Czech"), ["hun"] = ("hu", "Hungarian"), ["gre"] = ("el", "Greek"),
        ["ell"] = ("el", "Greek"), ["tur"] = ("tr", "Turkish"), ["rus"] = ("ru", "Russian"), ["ukr"] = ("uk", "Ukrainian"),
        ["jpn"] = ("ja", "Japanese"), ["chi"] = ("zh", "Chinese"), ["zho"] = ("zh", "Chinese"), ["kor"] = ("ko", "Korean"),
        ["ara"] = ("ar", "Arabic"), ["heb"] = ("he", "Hebrew"), ["hin"] = ("hi", "Hindi"), ["tha"] = ("th", "Thai"),
        ["rum"] = ("ro", "Romanian"), ["ron"] = ("ro", "Romanian"), ["bul"] = ("bg", "Bulgarian"), ["hrv"] = ("hr", "Croatian"),
        ["srp"] = ("sr", "Serbian"), ["slv"] = ("sl", "Slovenian"), ["slo"] = ("sk", "Slovak"), ["slk"] = ("sk", "Slovak"),
        ["ice"] = ("is", "Icelandic"), ["isl"] = ("is", "Icelandic"), ["vie"] = ("vi", "Vietnamese"), ["ind"] = ("id", "Indonesian"),
    };

    /// <summary>RFC 5646 tag for an ISO 639 code; null for undetermined or malformed values.</summary>
    public static string? Bcp47(string? language)
    {
        if (string.IsNullOrWhiteSpace(language))
            return null;
        var value = language.Trim();
        if (value is "und" or "zxx" or "mis" or "mul")
            return null;
        if (Languages.TryGetValue(value, out var known))
            return known.Code;
        return value.Length is 2 or 3 && value.All(char.IsAsciiLetter) ? value.ToLowerInvariant() : null;
    }

    public static string? LanguageName(string? language)
        => language is not null && Languages.TryGetValue(language.Trim(), out var known) ? known.Name
            : Bcp47(language) is { } code ? code : null;

    public static IEnumerable<WebVttCue> ParseCues(string text)
    {
        foreach (var block in text.Replace("\r\n", "\n", StringComparison.Ordinal).Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            var lines = block.Split('\n');
            var timing = Array.FindIndex(lines, l => l.Contains("-->", StringComparison.Ordinal));
            if (timing < 0)
                continue;
            var parts = lines[timing].Split("-->", 2, StringSplitOptions.TrimEntries);
            var endParts = parts[1].Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
            if (endParts.Length == 0 || ParseTimestamp(parts[0]) is not { } start || ParseTimestamp(endParts[0]) is not { } end || end <= start)
                continue;
            var body = string.Join('\n', lines.Skip(timing + 1)).Trim('\n');
            if (body.Length > 0)
                yield return new WebVttCue(start, end, endParts.Length > 1 ? endParts[1] : string.Empty, body);
        }
    }

    public static double? ParseTimestamp(string value)
    {
        var parts = value.Trim().Split(':');
        if (parts.Length is < 2 or > 3)
            return null;
        double total = 0;
        for (var i = 0; i < parts.Length; i++)
        {
            if (!double.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var part) || part < 0)
                return null;
            total = total * 60 + part;
        }
        return total;
    }

    public static string Timestamp(double seconds)
    {
        var ms = (long)Math.Round(Math.Max(0, seconds) * 1000);
        return string.Create(CultureInfo.InvariantCulture, $"{ms / 3_600_000:00}:{ms / 60_000 % 60:00}:{ms / 1000 % 60:00}.{ms % 1000:000}");
    }

    /// <summary>One HLS WebVTT segment; cues overlapping several segments are repeated in each, as players expect.</summary>
    public static string Segment(IEnumerable<WebVttCue> cues)
    {
        var builder = new StringBuilder("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n");
        foreach (var cue in cues)
        {
            builder.Append('\n').Append(Timestamp(cue.Start)).Append(" --> ").Append(Timestamp(cue.End));
            if (cue.Settings.Length > 0)
                builder.Append(' ').Append(cue.Settings);
            builder.Append('\n').Append(cue.Text).Append('\n');
        }
        return builder.ToString();
    }
}
