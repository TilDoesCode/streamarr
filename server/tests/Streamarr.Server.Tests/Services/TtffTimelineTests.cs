using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class TtffTimelineTests
{
    [Fact]
    public void Add_RecordsSpan_WithSourceAndDetail()
    {
        var timeline = TtffTimeline.Start("release01");

        timeline.Add("nzb-fetch", "nzb", startMs: 0, durationMs: 12.5, detail: "cache");
        timeline.Add("jellyfin-open", "client", startMs: 5, durationMs: 100, detail: "ready", source: "client");

        var spans = timeline.Snapshot();
        Assert.Equal(2, spans.Count);
        var nzb = spans[0];
        Assert.Equal("nzb-fetch", nzb.Name);
        Assert.Equal("nzb", nzb.Category);
        Assert.Equal("server", nzb.Source);
        Assert.Equal("cache", nzb.Detail);
        Assert.Equal("client", spans[1].Source);
    }

    [Fact]
    public void Snapshot_IsOrderedByStartMs()
    {
        var timeline = TtffTimeline.Start("r");
        timeline.Add("late", "stream", startMs: 900, durationMs: 10);
        timeline.Add("early", "nzb", startMs: 5, durationMs: 10);
        timeline.Add("middle", "probe", startMs: 400, durationMs: 10);

        var names = timeline.Snapshot().Select(s => s.Name).ToArray();
        Assert.Equal(["early", "middle", "late"], names);
    }

    [Fact]
    public void Add_ClampsNegativeAndNonFiniteValues()
    {
        var timeline = TtffTimeline.Start("r");
        timeline.Add("neg", "x", startMs: -50, durationMs: double.NaN);

        var span = Assert.Single(timeline.Snapshot());
        Assert.Equal(0, span.StartMs);
        Assert.Equal(0, span.DurationMs);
    }

    [Fact]
    public void Add_IsBoundedByMaxSpans()
    {
        var timeline = TtffTimeline.Start("r");
        for (var i = 0; i < TtffTimeline.MaxSpans + 50; i++)
            timeline.Add($"s{i}", "stream", startMs: i, durationMs: 1);

        Assert.Equal(TtffTimeline.MaxSpans, timeline.Snapshot().Count);
    }

    [Fact]
    public void Measure_RecordsAnOrderedSpanOnDispose()
    {
        var timeline = TtffTimeline.Start("r");
        using (timeline.Measure("stage", "probe"))
        {
            // no-op body; disposal records the span with a non-negative duration
        }

        var span = Assert.Single(timeline.Snapshot());
        Assert.Equal("stage", span.Name);
        Assert.Equal("probe", span.Category);
        Assert.True(span.DurationMs >= 0);
    }

    [Fact]
    public void Add_TruncatesOverlongNameAndDetail()
    {
        var timeline = TtffTimeline.Start("r");
        timeline.Add(new string('n', 500), "cat", 0, 1, detail: new string('d', 500));

        var span = Assert.Single(timeline.Snapshot());
        Assert.True(span.Name.Length <= TtffTimeline.MaxNameChars);
        Assert.True(span.Detail!.Length <= TtffTimeline.MaxDetailChars);
    }
}
