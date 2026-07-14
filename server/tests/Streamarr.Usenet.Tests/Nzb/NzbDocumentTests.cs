using Streamarr.Usenet.Nzb;

namespace Streamarr.Usenet.Tests.Nzb;

public class NzbDocumentTests
{
    private static string FixturePath =>
        Path.Combine(AppContext.BaseDirectory, "Fixtures", "example.nzb");

    private static async Task<NzbDocument> LoadFixture()
    {
        await using var stream = File.OpenRead(FixturePath);
        return await NzbDocument.LoadAsync(stream);
    }

    [Fact]
    public async Task Parses_HeadMetadata()
    {
        var document = await LoadFixture();

        Assert.Equal("Example.Movie.2021.1080p.WEB-DL.x265-GROUP", document.Metadata["title"]);
        Assert.Equal("Movies > HD", document.Metadata["category"]);
        Assert.Equal("", document.Metadata["password"]);
    }

    [Fact]
    public async Task Parses_AllFilesWithAttributes()
    {
        var document = await LoadFixture();

        Assert.Equal(3, document.Files.Count);

        var first = document.Files[0];
        Assert.StartsWith("[1/3]", first.Subject);
        Assert.Equal("poster@example.com (Uploader)", first.Poster);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1751328000), first.Date);
        Assert.Equal(["alt.binaries.movies", "alt.binaries.hdtv"], first.Groups);
    }

    [Fact]
    public async Task Parses_SegmentsInOrder_WithBytesAndNumbers()
    {
        var document = await LoadFixture();
        var segments = document.Files[0].Segments;

        Assert.Equal(4, segments.Count);
        Assert.Equal([1, 2, 3, 4], segments.Select(x => x.Number));
        Assert.Equal("part1of4.AbCdEf123456@news.example.com", segments[0].MessageId);
        Assert.Equal(768000, segments[0].Bytes);
        Assert.Equal("part4of4.AbCdEf123459@news.example.com", segments[3].MessageId);
        Assert.Equal(696000, segments[3].Bytes);
    }

    [Fact]
    public async Task GetTotalYencodedSize_SumsSegmentBytes()
    {
        var document = await LoadFixture();
        Assert.Equal(768000L * 3 + 696000, document.Files[0].GetTotalYencodedSize());
    }

    [Fact]
    public async Task GetSubjectFileName_ExtractsQuotedName()
    {
        var document = await LoadFixture();

        Assert.Equal("example.movie.2021.1080p.web-dl.x265-group.r00", document.Files[0].GetSubjectFileName());
        Assert.Equal("example.movie.2021.1080p.web-dl.x265-group.rar", document.Files[1].GetSubjectFileName());
        Assert.Equal("example.movie.2021.1080p.web-dl.x265-group.par2", document.Files[2].GetSubjectFileName());
    }

    [Fact]
    public void GetSubjectFileName_FallsBackToSabnzbdRegex()
    {
        var file = new NzbFile { Subject = "my.great.file.mkv yEnc (1/10)" };
        Assert.Equal("my.great.file.mkv", file.GetSubjectFileName());
    }

    [Fact]
    public async Task GetSegmentIds_ReturnsMessageIds()
    {
        var document = await LoadFixture();
        var ids = document.Files[2].GetSegmentIds();
        Assert.Equal(["par2main.QwErTy135790@news.example.com"], ids);
    }

    [Fact]
    public async Task MalformedXml_ThrowsInvalidData()
    {
        using var stream = new MemoryStream("<nzb><file"u8.ToArray());
        await Assert.ThrowsAsync<InvalidDataException>(() => NzbDocument.LoadAsync(stream));
    }

    [Fact]
    public async Task CommandInjectingMessageId_IsRejected()
    {
        const string xml = """
            <nzb><file subject="video.mkv"><segments>
            <segment bytes="123" number="1">safe@example.test&#13;&#10;DATE</segment>
            </segments></file></nzb>
            """;
        await using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(xml));
        await Assert.ThrowsAsync<InvalidDataException>(() => NzbDocument.LoadAsync(stream));
    }

    [Theory]
    [InlineData("0", "1")]
    [InlineData("-1", "1")]
    [InlineData("123", "0")]
    [InlineData("123", "-1")]
    [InlineData("1073741825", "1")]
    public async Task InvalidSegmentArithmetic_IsRejected(string bytes, string number)
    {
        var xml = $"<nzb><file subject=\"video.mkv\"><segments><segment bytes=\"{bytes}\" number=\"{number}\">part@example.test</segment></segments></file></nzb>";
        await using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(xml));
        await Assert.ThrowsAsync<InvalidDataException>(() => NzbDocument.LoadAsync(stream));
    }

    [Fact]
    public async Task ConfiguredFileLimit_IsEnforced()
    {
        const string xml = "<nzb><file subject=\"one\"/><file subject=\"two\"/></nzb>";
        await using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(xml));
        await Assert.ThrowsAsync<InvalidDataException>(() => NzbDocument.LoadAsync(
            stream, limits: NzbDocumentLimits.Default with { MaxFiles = 1 }));
    }
}
