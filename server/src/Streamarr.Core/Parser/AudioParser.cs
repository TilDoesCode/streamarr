using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>Parsed audio attributes: codec, channel layout and Atmos flag.</summary>
public sealed record AudioResult
{
    public string? Codec { get; init; }
    public string? Channels { get; init; }
    public bool Atmos { get; init; }
}

/// <summary>
/// Parses audio codec + channel layout (BRIEF §7.1) from a release name.
/// Streamarr-original; ordered most-specific-first so DTS-HD MA wins over DTS, and
/// DD+ / E-AC3 map to DDP.
/// </summary>
public static class AudioParser
{
    // Ordered: the first match wins, so more specific codecs are listed first.
    // Tokens may be immediately followed by a channel count (DDP5.1, AAC2.0), so a
    // trailing digit is allowed; the boundaries only forbid trailing letters.
    private static readonly (string Codec, Regex Regex)[] CodecRegexes =
    {
        ("TrueHD", new Regex(@"(?<![A-Za-z])(?:TrueHD|True[-_. ]HD|Dolby[-_. ]?TrueHD)(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("DTS-HD MA", new Regex(@"(?<![A-Za-z])DTS[-_. ]?HD[-_. ]?MA(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("DTS-HD", new Regex(@"(?<![A-Za-z])DTS[-_. ]?HD(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("DTS-X", new Regex(@"(?<![A-Za-z])DTS[:\- ]?X(?![A-Za-z0-9])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("DTS-ES", new Regex(@"(?<![A-Za-z])DTS[-_. ]?ES(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("DTS", new Regex(@"(?<![A-Za-z])DTS(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("DDP", new Regex(@"(?<![A-Za-z])(?:DDP|DD\+|E[-_. ]?AC[-_. ]?3|EAC3|DDPlus|Dolby[-_. ]?Digital[-_. ]?Plus)(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("DD", new Regex(@"(?<![A-Za-z])(?:DD|AC3|AC-3|Dolby[-_. ]?Digital)(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("FLAC", new Regex(@"(?<![A-Za-z])FLAC(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("Opus", new Regex(@"(?<![A-Za-z])Opus(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("AAC", new Regex(@"(?<![A-Za-z])AAC(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("MP3", new Regex(@"(?<![A-Za-z])MP3(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
        ("LPCM", new Regex(@"(?<![A-Za-z])(?:LPCM|PCM)(?![A-Za-z])", RegexOptions.Compiled | RegexOptions.IgnoreCase)),
    };

    // Channel layouts like 5.1, 7.1, 2.0, DDP5.1, DD5 1, TrueHD 7.1
    private static readonly Regex ChannelsRegex = new(
        @"(?<!\d)(?<front>[1-9])[. ](?<rear>[0-4])(?!\d)",
        RegexOptions.Compiled);

    private static readonly Regex AtmosRegex = new(@"\bAtmos\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static AudioResult Parse(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return new AudioResult();
        }

        string? codec = null;
        foreach (var (candidate, regex) in CodecRegexes)
        {
            if (regex.IsMatch(name))
            {
                codec = candidate;
                break;
            }
        }

        var atmos = AtmosRegex.IsMatch(name);
        var channels = ParseChannels(name);

        return new AudioResult
        {
            Codec = codec,
            Channels = channels,
            Atmos = atmos,
        };
    }

    private static string? ParseChannels(string name)
    {
        // Prefer a channel token that sits next to an audio codec, but any plausible
        // "N.N" layout in the name works for typical scene naming.
        foreach (Match match in ChannelsRegex.Matches(name))
        {
            var front = match.Groups["front"].Value;
            var rear = match.Groups["rear"].Value;

            // Only accept realistic surround layouts.
            if ((front is "1" or "2" or "5" or "7") && (rear is "0" or "1"))
            {
                return $"{front}.{rear}";
            }
        }

        return null;
    }
}
